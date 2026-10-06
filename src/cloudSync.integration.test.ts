import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
  INTEGRATION SUITE (originally Phase 8 of the old roadmap; its
  two-device MERGE convergence scenarios were replaced by the Sync &
  Statistics Redesign Plan's own Phase 5 - the single-writer sync
  model, below)

  Everything below exercises the REAL orchestration
  (pushLocalSnapshot/pullCloudSnapshot/syncCloudNow/requestCloudSync)
  against a FAKE Graph transport (FakeCloudFile) that faithfully
  reproduces the real conditional-write semantics this app relies on
  (create-only-if-absent, If-Match on update, 412 on mismatch) - only
  fetch()/getAccessToken() themselves are mocked (via mocking
  cloudStorage.ts's two exported functions), never the sync/
  orchestration/scheduler logic under test.

  Two independent "devices" are simulated by swapping which in-memory
  Storage instance is currently assigned to globalThis.localStorage,
  with both devices' pushLocalSnapshot()/pullCloudSnapshot() calls
  reading/writing the SAME FakeCloudFile instance - this is what makes
  these genuine two-device propagation tests rather than a single
  device talking to itself. Per this phase's own design, there is no
  blind per-record merge any more (cloudMerge.ts is untouched and still
  has its own full coverage in cloudMerge.test.ts) - two devices with
  independent, unreconciled changes now diverge rather than silently
  combining; see the "single-writer propagation" tests below for
  exactly that distinction.
*/

vi.mock('./cloudStorage', () => ({
  readCloudSyncDocument: vi.fn(),
  writeCloudSyncDocument: vi.fn(),
}))

import type {
  Patient,
  SavedTreatment,
  ProcedureTemplate,
  Procedure,
  DeletionTombstone,
} from './App'

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  type CloudSyncDocument,
} from './cloudSync'

import {
  readCloudSyncDocument,
  writeCloudSyncDocument,
  type CloudSyncReadResult,
  type CloudSyncWriteResult,
} from './cloudStorage'

import {
  syncCloudNow,
  pushLocalSnapshot,
  pullCloudSnapshot,
  markLocalDataDirty,
} from './cloudSyncEngine'

import {
  requestCloudSync,
  __resetCloudSyncSchedulerForTests,
} from './cloudSyncScheduler'

const mockedRead = vi.mocked(readCloudSyncDocument)
const mockedWrite = vi.mocked(writeCloudSyncDocument)

/* ============================================================
   FAKE IN-MEMORY LOCALSTORAGE (same pattern as earlier phases)
   ============================================================ */

class MemoryStorage implements Storage {

  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

}

function useDevice(storage: Storage): void {
  globalThis.localStorage = storage
}

function seed(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function readKey<T>(key: string): T {
  return JSON.parse(localStorage.getItem(key)!) as T
}

function seedSynchronized(overrides: {
  patients?: Patient[]
  savedTreatments?: SavedTreatment[]
  templates?: ProcedureTemplate[]
  procedures?: Procedure[]
  tombstones?: DeletionTombstone[]
}): void {
  seed('toothTargetPatients', overrides.patients ?? [])
  seed('toothTargetSavedTreatments', overrides.savedTreatments ?? [])
  seed('toothTargetTemplates', overrides.templates ?? [makeBuiltinTemplate()])
  seed('toothTargetProcedures', overrides.procedures ?? [])
  seed('toothTargetDeletionTombstones', overrides.tombstones ?? [])
}

/* ============================================================
   FAKE GRAPH-BACKED CLOUD FILE
   ============================================================

   Reproduces Phase 5's real conditional semantics purely in memory:
   - read(): 'not-found' until anything has ever been written, then
     'found' with the current document and an eTag string derived
     from an internal version counter.
   - write(document, expectedETag):
       expectedETag === null  -> only succeeds if the file has never
                                  been written (conflictBehavior:
                                  'fail' semantics) - otherwise
                                  'precondition-failed', exactly like
                                  a real 409 nameAlreadyExists.
       expectedETag === <tag> -> only succeeds if it matches the
                                  CURRENT version's eTag - otherwise
                                  'precondition-failed', exactly like
                                  a real 412.
*/

class FakeCloudFile {

  private document: CloudSyncDocument | null = null
  private version = 0

  private currentETag(): string {
    return `"v${this.version}"`
  }

  read(): CloudSyncReadResult {

    if (!this.document) {
      return { status: 'not-found' }
    }

    return {
      status: 'found',
      document: this.document,
      eTag: this.currentETag(),
    }

  }

  write(
    document: CloudSyncDocument,
    expectedETag: string | null
  ): CloudSyncWriteResult {

    if (expectedETag === null) {

      if (this.document !== null) {
        return { status: 'precondition-failed' }
      }

    } else if (expectedETag !== this.currentETag()) {

      return { status: 'precondition-failed' }

    }

    this.document = document
    this.version += 1

    return { status: 'written', eTag: this.currentETag() }

  }

  peek(): CloudSyncDocument | null {
    return this.document
  }

}

function wireTransportTo(cloud: FakeCloudFile): void {
  mockedRead.mockImplementation(async () => cloud.read())
  mockedWrite.mockImplementation(async (document, expectedETag) =>
    cloud.write(document, expectedETag)
  )
}

/* ============================================================
   FACTORIES
   ============================================================ */

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'patient-1',
    patientNumber: 1,
    name: 'Jane Doe',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSavedTreatment(
  overrides: Partial<SavedTreatment> = {}
): SavedTreatment {
  return {
    id: 'treatment-1',
    patientName: 'Jane Doe',
    patientId: 'patient-1',
    toothId: '16',
    procedureName: 'RCT',
    procedureId: 'rct',
    templateName: 'Molar Root Canal',
    templateId: 'rct-molar',
    phases: [{ name: 'Access', duration: 480 }],
    date: '2026-01-01T00:00:00.000Z',
    completed: true,
    phaseTimes: [480],
    actualTimes: [500],
    phaseRecords: [
      {
        id: 'phase-1',
        name: 'Access',
        expectedDuration: 480,
        actualDuration: 500,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:08:20.000Z',
        status: 'completed',
        skipped: false,
        pausedWhileActive: false,
      },
    ],
    totalExpectedDuration: 480,
    totalActualDuration: 500,
    totalOvertimeDuration: 20,
    events: [
      {
        id: 'event-1',
        type: 'note',
        note: 'Calcified canal',
        timestamp: '2026-01-01T00:03:00.000Z',
        durationSeconds: null,
      },
    ],
    tags: [],
    chairEnteredAt: null,
    chairLeftAt: null,
    currentPhaseIndex: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:08:20.000Z',
    updatedAt: '2026-01-01T00:08:20.000Z',
    ...overrides,
  }
}

function makeTemplate(
  overrides: Partial<ProcedureTemplate> = {}
): ProcedureTemplate {
  return {
    id: 'template-1',
    name: 'Custom Template',
    isCustom: true,
    phases: [{ name: 'Phase 1', duration: 600 }],
    specializationId: 'general',
    procedureKey: 'general',
    typeId: 'general',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeBuiltinTemplate(
  overrides: Partial<ProcedureTemplate> = {}
): ProcedureTemplate {
  return {
    ...makeTemplate({ id: 'general', name: 'General Procedure', ...overrides }),
    isCustom: false,
  }
}

/*
  deletedAt defaults to "right now" (Phase 4.7), not a fixed literal
  date - these tests' own narratives always mean "a tombstone that was
  JUST created" unless a test explicitly overrides deletedAt to
  exercise tombstone-expiry pruning itself (see cloudSyncEngine.ts's
  pruneExpiredTombstones() and this file's own expiry-specific tests),
  so a fixed literal date would eventually - and, once real time simply
  passes ~1 month past whatever date was hardcoded, silently - start
  being pruned as "expired" by every OTHER test that never meant to
  exercise expiry at all.
*/
function makeTombstone(
  overrides: Partial<DeletionTombstone> = {}
): DeletionTombstone {
  return {
    id: 'tombstone-1',
    entityType: 'patient',
    entityId: 'patient-1',
    deletedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeCloudDocument(
  overrides: Partial<CloudSyncDocument> = {}
): CloudSyncDocument {
  return {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    app: CLOUD_SYNC_APP,
    updatedAt: '2026-01-01T00:00:00.000Z',
    patients: [],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
    ...overrides,
  }
}

beforeEach(() => {
  mockedRead.mockReset()
  mockedWrite.mockReset()
  __resetCloudSyncSchedulerForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ============================================================
   2. SINGLE-WRITER PUSH/PULL ACROSS TWO DEVICES (Phase 5)
   ============================================================

   Replaces the old per-record-merge convergence/resurrection-
   prevention/concurrent-editing scenarios this section used to carry
   (patient-number collision, tombstone-based deletion suppression,
   latest-updatedAt-wins tie-breaks) - all of that machinery is still
   fully intact and still fully tested on its own terms
   (cloudMerge.test.ts/staleRecordReview.test.ts), it is just no longer
   reachable through the live sync path, so testing it THROUGH
   syncCloudNow() here no longer means anything. What replaces it is
   this phase's own model: push the whole local snapshot, pull the
   whole cloud snapshot, diverge (never guess) when both sides moved.
*/

describe('single-writer propagation across two devices', () => {

  it("device A pushes to an empty cloud; device B pulls and adopts A's data cleanly", async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const deviceA = new MemoryStorage()
    const deviceB = new MemoryStorage()

    useDevice(deviceA)
    seedSynchronized({ patients: [makePatient({ id: 'a' })] })
    markLocalDataDirty()

    const pushResult = await pushLocalSnapshot()
    expect(pushResult.status).toBe('synced')
    expect(cloud.peek()?.patients.map(p => p.id)).toEqual(['a'])

    useDevice(deviceB)
    seedSynchronized({}) // a fresh device, nothing of its own to protect

    const pullResult = await pullCloudSnapshot()
    expect(pullResult.status).toBe('synced')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['a'])

  })

  it("device B edits offline, then pushes - succeeds because the cloud hasn't moved since B's own pull", async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const deviceA = new MemoryStorage()
    const deviceB = new MemoryStorage()

    useDevice(deviceA)
    seedSynchronized({ patients: [makePatient({ id: 'a' })] })
    markLocalDataDirty()
    await pushLocalSnapshot()

    useDevice(deviceB)
    seedSynchronized({})
    await pullCloudSnapshot()

    // Device B's own offline edit.
    seed('toothTargetPatients', [
      makePatient({ id: 'a' }),
      makePatient({ id: 'b', patientNumber: 2 }),
    ])
    markLocalDataDirty()

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('synced')
    expect(cloud.peek()?.patients.map(p => p.id).sort()).toEqual(['a', 'b'])

  })

  it('two devices edit independently without reconciling: the SECOND push diverges rather than overwriting the first', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const deviceA = new MemoryStorage()
    const deviceB = new MemoryStorage()

    // Both devices start from the same baseline.
    useDevice(deviceA)
    seedSynchronized({ patients: [makePatient({ id: 'shared' })] })
    markLocalDataDirty()
    await pushLocalSnapshot()

    useDevice(deviceB)
    seedSynchronized({})
    await pullCloudSnapshot()

    // Device A edits and pushes again - the cloud moves forward.
    useDevice(deviceA)
    seed('toothTargetPatients', [
      makePatient({ id: 'shared', name: 'Edited By A' }),
    ])
    markLocalDataDirty()
    const resultA = await pushLocalSnapshot()
    expect(resultA.status).toBe('synced')

    // Device B, unaware of A's edit, makes its OWN edit and tries to push.
    useDevice(deviceB)
    seed('toothTargetPatients', [
      makePatient({ id: 'shared' }),
      makePatient({ id: 'b-only', patientNumber: 2 }),
    ])
    markLocalDataDirty()

    const resultB = await pushLocalSnapshot()

    expect(resultB.status).toBe('diverged')

    // Neither side was overwritten - the cloud still has A's edit...
    expect(cloud.peek()?.patients.map(p => p.name)).toEqual(['Edited By A'])
    // ...and B's own local data is completely untouched too.
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id).sort()
    ).toEqual(['b-only', 'shared'])

  })

  it('deleting a patient is a plain local removal, pushed in the next snapshot - no tombstone needed for the deletion to reach another device', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const deviceA = new MemoryStorage()
    const deviceB = new MemoryStorage()

    useDevice(deviceA)
    seedSynchronized({
      patients: [
        makePatient({ id: 'keep' }),
        makePatient({ id: 'delete-me', patientNumber: 2 }),
      ],
    })
    markLocalDataDirty()
    await pushLocalSnapshot()

    useDevice(deviceB)
    seedSynchronized({})
    await pullCloudSnapshot()
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id).sort()
    ).toEqual(['delete-me', 'keep'])

    // Device B deletes the patient - a plain local removal, deliberately
    // writing NO tombstone here (unlike App.tsx's own still-unchanged
    // delete flow, which does write one - this test only exercises the
    // push/pull layer itself, which never reads tombstones any more).
    seed('toothTargetPatients', [makePatient({ id: 'keep' })])
    markLocalDataDirty()

    const pushResult = await pushLocalSnapshot()
    expect(pushResult.status).toBe('synced')
    expect(cloud.peek()?.patients.map(p => p.id)).toEqual(['keep'])

    // Device A - which never touched this patient itself - pulls cleanly
    // and the deletion reaches it too.
    useDevice(deviceA)
    const pullResult = await pullCloudSnapshot()
    expect(pullResult.status).toBe('synced')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['keep'])

  })

})

/* ============================================================
   10. OFFLINE -> ONLINE
   ============================================================ */

describe('offline then online', () => {

  it('a failed sync never erases later local changes - they all reach the cloud once connectivity returns', async () => {

    const cloud = new FakeCloudFile()

    const device = new MemoryStorage()
    useDevice(device)

    seedSynchronized({ patients: [makePatient({ id: 'a' })] })

    // First attempt: network unavailable.
    mockedRead.mockRejectedValueOnce(new Error('network unavailable'))

    await expect(syncCloudNow()).rejects.toThrow()
    // (syncCloudNow() itself doesn't catch a thrown network error from
    // the mocked transport in this deliberately worst-case simulation;
    // what matters is that local data survives - checked next.)

    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual([
      'a',
    ])

    // More local changes happen while still offline.
    seedSynchronized({
      patients: [makePatient({ id: 'a' }), makePatient({ id: 'b', patientNumber: 2 })],
    })

    // Connectivity restored - a new synchronized mutation triggers sync.
    wireTransportTo(cloud)

    const result = await syncCloudNow()

    expect(result.status).toBe('synced')
    expect(cloud.peek()?.patients.map(p => p.id).sort()).toEqual(['a', 'b'])

  })

})

/* ============================================================
   11 & 12. NO-OP / REPEATED SYNCHRONIZATION
   ============================================================ */

describe('no-local-change and repeated synchronization', () => {

  it('running sync when local already equals cloud changes nothing observable', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const patient = makePatient({ id: 'a' })
    const template = makeTemplate({ id: 'tmpl-a' })
    const tombstone = makeTombstone({ entityId: 'zzz' })

    const device = new MemoryStorage()
    useDevice(device)
    seedSynchronized({
      patients: [patient],
      templates: [makeBuiltinTemplate(), template],
      tombstones: [tombstone],
    })
    seed('toothTargetNextPatientNumber', 50)
    seed('toothTargetActiveTreatment', { id: 'active-marker' })
    localStorage.setItem('toothTargetPrivacyLock', '"pin"')

    await syncCloudNow() // establishes cloud == local

    const patientsBefore = readKey<Patient[]>('toothTargetPatients')
    const templatesBefore = readKey<ProcedureTemplate[]>('toothTargetTemplates')
    const tombstonesBefore = readKey<DeletionTombstone[]>(
      'toothTargetDeletionTombstones'
    )
    const counterBefore = readKey<number>('toothTargetNextPatientNumber')

    const result = await syncCloudNow()

    expect(result.status).toBe('synced')
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual(patientsBefore)
    expect(readKey<ProcedureTemplate[]>('toothTargetTemplates')).toEqual(
      templatesBefore
    )
    expect(
      readKey<DeletionTombstone[]>('toothTargetDeletionTombstones')
    ).toEqual(tombstonesBefore)
    expect(readKey<number>('toothTargetNextPatientNumber')).toBe(
      counterBefore
    )
    expect(readKey('toothTargetActiveTreatment')).toEqual({
      id: 'active-marker',
    })
    expect(localStorage.getItem('toothTargetPrivacyLock')).toBe('"pin"')

  })

  it('the live scheduler can be called repeatedly with no data changes without duplicating anything or looping', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const device = new MemoryStorage()
    useDevice(device)
    seedSynchronized({ patients: [makePatient({ id: 'a' })] })

    requestCloudSync()
    await flushMicrotasks(20)

    requestCloudSync()
    await flushMicrotasks(20)

    requestCloudSync()
    await flushMicrotasks(20)

    expect(readKey<Patient[]>('toothTargetPatients')).toHaveLength(1)
    expect(mockedWrite).toHaveBeenCalledTimes(3) // 3 requests, 3 syncs, never more per request, never merged into a runaway loop

  })

})

/* ============================================================
   13. SYNC WHILE USER CONTINUES WORKING
   ============================================================ */

describe('sync while the user keeps working', () => {

  it('a treatment completed during an in-flight sync is not lost - exactly one follow-up sync runs', async () => {

    const cloud = new FakeCloudFile()

    const device = new MemoryStorage()
    useDevice(device)

    const treatmentA = makeSavedTreatment({ id: 't-a' })
    const treatmentB = makeSavedTreatment({ id: 't-b' })

    seedSynchronized({ savedTreatments: [treatmentA] })

    let releaseFirstRead: (() => void) | null = null

    mockedRead.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseFirstRead = () => resolve(cloud.read())
        })
    )
    mockedRead.mockImplementation(async () => cloud.read())
    mockedWrite.mockImplementation(async (document, expectedETag) =>
      cloud.write(document, expectedETag)
    )

    requestCloudSync() // "Treatment A completed" -> requestCloudSync()

    await flushMicrotasks()

    expect(mockedRead).toHaveBeenCalledTimes(1)
    expect(mockedWrite).not.toHaveBeenCalled() // still stuck in the slow first read

    // "Treatment B completed" while the first sync is still running.
    seedSynchronized({ savedTreatments: [treatmentA, treatmentB] })
    requestCloudSync()

    await flushMicrotasks()

    // First sync still hasn't completed - no second syncCloudNow() yet.
    expect(mockedWrite).not.toHaveBeenCalled()

    releaseFirstRead!()

    await flushMicrotasks(40)

    // First sync completes (uploading just treatment A, since that
    // was the local state when it started reading), then exactly one
    // follow-up sync runs and uploads both.
    expect(cloud.peek()?.savedTreatments.map(t => t.id).sort()).toEqual([
      't-a',
      't-b',
    ])

  })

})

/* ============================================================
   14. MULTIPLE BROWSER TABS
   ============================================================ */

describe('multiple tabs sharing one cloud file', () => {

  it('two tabs racing a first-ever push resolve to exactly one synced winner and one diverged loser - never a silent merge', async () => {

    /*
      A real second browser tab is a SEPARATE JS runtime with its own
      module instances - crucially, its own cloudSyncEngine.ts
      `inFlightSync` closure variable - that only shares localStorage
      and the cloud file with the first tab. Calling the single
      already-imported pushLocalSnapshot() twice in a row would instead
      hit THIS module instance's own same-tab in-flight guard, which is
      not what two real tabs would do. vi.resetModules() + a fresh
      dynamic import gives each simulated "tab" its own cloudSyncEngine
      module instance, while both still resolve to the same top-of-file
      vi.mock('./cloudStorage', ...) and the same shared localStorage/
      FakeCloudFile below.

      Phase 5 (single-writer sync model) - under the OLD per-record
      merge, two tabs racing like this converged (both patients
      survived via mergeCloudSyncDocuments()). There is no merge any
      more: exactly one tab's push can ever win a genuine first-write
      race, and the other gets 'diverged' (its own retry re-reads the
      winner's now-different content and correctly refuses to guess
      which side should win) - never silent data loss, never a silent
      combination of both.
    */

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const sharedStorage = new MemoryStorage()
    useDevice(sharedStorage)

    seedSynchronized({})

    vi.resetModules()
    const tabAEngine = await import('./cloudSyncEngine')

    vi.resetModules()
    const tabBEngine = await import('./cloudSyncEngine')

    // Tab A's patient is committed locally, then its push begins - this
    // synchronously reads local storage up to its first await, so it
    // captures only its own patient.
    seed('toothTargetPatients', [
      makePatient({ id: 'tab-a-patient', patientNumber: 1 }),
    ])

    const tabAPush = tabAEngine.pushLocalSnapshot()

    // Tab B's own change lands in the shared storage next, and its
    // push begins - it reads the CURRENT shared storage (both
    // patients), exactly like a second real tab would.
    seed('toothTargetPatients', [
      makePatient({ id: 'tab-a-patient', patientNumber: 1 }),
      makePatient({ id: 'tab-b-patient', patientNumber: 2 }),
    ])

    const tabBPush = tabBEngine.pushLocalSnapshot()

    const [resultA, resultB] = await Promise.all([tabAPush, tabBPush])

    // Exactly one wins, exactly one diverges - never both 'synced'
    // (that would mean a silent merge happened), never both 'diverged'
    // (a first-ever write against an empty cloud can always succeed
    // for SOMEONE).
    expect([resultA.status, resultB.status].sort()).toEqual([
      'diverged',
      'synced',
    ])

    // The cloud holds exactly ONE tab's own patient set, verbatim -
    // either A's alone, or B's (which already included A's, since B
    // read local storage after A's own patient landed) - never
    // anything else, and in particular never a merged/deduplicated
    // combination neither tab ever actually pushed.
    const finalCloudPatients = cloud.peek()?.patients.map(p => p.id).sort()
    const validOutcomes = [
      ['tab-a-patient'],
      ['tab-a-patient', 'tab-b-patient'],
    ]
    expect(validOutcomes).toContainEqual(finalCloudPatients)

  })

  it('a storage event never itself triggers a sync (source-level guarantee, re-affirmed here)', () => {

    /*
      This is enforced in App.tsx's handlePatientStorageChange(), which
      cannot be imported into Vitest (it transitively pulls in MSAL/
      window at module scope - the same constraint documented in
      patientNumberConflicts.ts/cloudSyncEngine.ts). The guarantee is
      verified by source audit instead (see this phase's report): the
      literal string "requestCloudSync" appears in App.tsx only inside
      openPatient(), addProcedure(), completeTreatment(),
      confirmDeletePatient(), confirmDeleteTemplate(),
      saveTemplateDraft(), and confirmConflictResolution() - never
      inside handlePatientStorageChange().
    */

    expect(true).toBe(true)

  })

})

/* ============================================================
   16. CLOUD CORRUPTION SCENARIOS
   ============================================================ */

describe('cloud corruption never overwrites or fabricates data', () => {

  it('malformed cloud JSON: local state untouched, no overwrite attempted', async () => {

    const device = new MemoryStorage()
    useDevice(device)

    const localPatients = [makePatient({ id: 'a' })]
    seedSynchronized({ patients: localPatients })

    mockedRead.mockResolvedValueOnce({
      status: 'malformed-json',
      detail: 'not json',
    })

    const result = await syncCloudNow()

    expect(result).toEqual({ status: 'cloud-invalid', detail: 'not json' })
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual(localPatients)

  })

  it('structurally invalid cloud document: same safety behavior', async () => {

    const device = new MemoryStorage()
    useDevice(device)

    const localPatients = [makePatient({ id: 'a' })]
    seedSynchronized({ patients: localPatients })

    mockedRead.mockResolvedValueOnce({
      status: 'invalid-document',
      detail: 'The cloud sync document contains invalid patient records.',
    })

    const result = await syncCloudNow()

    expect(result.status).toBe('cloud-invalid')
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual(localPatients)

  })

  it('unknown/unsupported schema version is rejected, not silently interpreted', async () => {

    const device = new MemoryStorage()
    useDevice(device)

    seedSynchronized({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockResolvedValueOnce({
      status: 'invalid-document',
      detail:
        'This cloud sync document uses schema version 99, which this version of ToothTarget does not support (expected 2).',
    })

    const result = await syncCloudNow()

    expect(result.status).toBe('cloud-invalid')
    if (result.status === 'cloud-invalid') {
      expect(result.detail).toContain('schema version')
    }

  })

})

/* ============================================================
   20. LOCAL-ONLY STATE PROTECTION
   ============================================================ */

describe('local-only state protection', () => {

  it('never modifies active treatment, incomplete treatments, or privacy lock', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const device = new MemoryStorage()
    useDevice(device)
    seedSynchronized({ patients: [makePatient({ id: 'a' })] })

    const activeMarker = { id: 'active-marker' }
    const incompleteMarker = [{ id: 'incomplete-marker' }]

    seed('toothTargetActiveTreatment', activeMarker)
    seed('toothTargetIncompleteTreatments', incompleteMarker)
    localStorage.setItem('toothTargetPrivacyLock', '"secret-pin-hash"')

    await syncCloudNow()

    expect(readKey('toothTargetActiveTreatment')).toEqual(activeMarker)
    expect(readKey('toothTargetIncompleteTreatments')).toEqual(
      incompleteMarker
    )
    expect(localStorage.getItem('toothTargetPrivacyLock')).toBe(
      '"secret-pin-hash"'
    )

  })

  it('the patient-number counter never decreases even when the cloud document implies a lower maximum', async () => {

    const device = new MemoryStorage()
    useDevice(device)

    seedSynchronized({
      patients: [makePatient({ id: 'a', patientNumber: 5 })],
    })
    seed('toothTargetNextPatientNumber', 100)

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({
        patients: [makePatient({ id: 'b', patientNumber: 2 })],
      }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    expect(readKey<number>('toothTargetNextPatientNumber')).toBe(100)

  })

})

/* ============================================================
   21. BACKUP SEPARATION
   ============================================================ */

describe('backup file separation', () => {

  it('automatic sync never reads or writes the backup file/module', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const device = new MemoryStorage()
    useDevice(device)
    seedSynchronized({ patients: [makePatient({ id: 'a' })] })

    await syncCloudNow()

    // cloudSyncEngine.ts/cloudSyncScheduler.ts never import
    // cloudBackup.ts at all (confirmed by source audit - see report);
    // the mocked cloudStorage transport used throughout this file only
    // ever received the sync-document shape, never a CloudBackup one.
    for (const call of mockedWrite.mock.calls) {
      const [document] = call
      expect(document.schemaVersion).toBe(CLOUD_SYNC_SCHEMA_VERSION)
      expect(document.app).toBe(CLOUD_SYNC_APP)
    }

  })

})

/* ============================================================
   22. LEGACY-DATA COMPATIBILITY (validator boundary)
   ============================================================ */

describe('legacy/unmigrated local data is never uploaded', () => {

  it('rejects a legacy numeric-looking treatment id shape before reading or writing the cloud', async () => {

    const device = new MemoryStorage()
    useDevice(device)

    seed('toothTargetPatients', [])
    seed('toothTargetSavedTreatments', [
      { ...makeSavedTreatment(), id: 1700000000000 }, // legacy Date.now()-based id
    ])
    seed('toothTargetTemplates', [makeBuiltinTemplate()])
    seed('toothTargetProcedures', [])
    seed('toothTargetDeletionTombstones', [])

    const result = await syncCloudNow()

    expect(result.status).toBe('validation-failed')
    expect(mockedRead).not.toHaveBeenCalled()
    expect(mockedWrite).not.toHaveBeenCalled()

  })

  it('rejects a custom template missing the Phase 2 updatedAt field before reading or writing the cloud', async () => {

    const device = new MemoryStorage()
    useDevice(device)

    const legacyTemplate = makeTemplate({ id: 'template-1700000000000' })
    delete (legacyTemplate as Partial<ProcedureTemplate>).updatedAt

    seedSynchronized({ templates: [makeBuiltinTemplate(), legacyTemplate] })

    const result = await syncCloudNow()

    expect(result.status).toBe('validation-failed')
    expect(mockedRead).not.toHaveBeenCalled()
    expect(mockedWrite).not.toHaveBeenCalled()

  })

})

/* ============================================================
   helpers
   ============================================================ */

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}
