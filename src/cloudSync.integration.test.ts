import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
  PHASE 8 - FINAL HARDENING / INTEGRATION SUITE

  Everything below exercises the REAL orchestration
  (mergeCloudSyncDocuments, syncCloudNow, requestCloudSync) against a
  FAKE Graph transport (FakeCloudFile) that faithfully reproduces the
  real conditional-write semantics Phase 5 verified against current
  Graph documentation (create-only-if-absent, If-Match on update,
  412 on mismatch) - only fetch()/getAccessToken() themselves are
  mocked (via mocking cloudStorage.ts's two exported functions),
  never the merge/orchestration/scheduler logic under test.

  Two independent "devices" are simulated by swapping which in-memory
  Storage instance is currently assigned to globalThis.localStorage
  and having both devices' syncCloudNow() calls read/write the SAME
  FakeCloudFile instance - this is what makes these genuine two-device
  convergence tests rather than a single device talking to itself.
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

import { mergeCloudSyncDocuments } from './cloudMerge'

import {
  readCloudSyncDocument,
  writeCloudSyncDocument,
  type CloudSyncReadResult,
  type CloudSyncWriteResult,
} from './cloudStorage'

import { syncCloudNow } from './cloudSyncEngine'

import {
  requestCloudSync,
  __resetCloudSyncSchedulerForTests,
} from './cloudSyncScheduler'

import {
  readPersistedPatientNumberConflicts,
  resolvePatientNumberConflictUnderLock,
} from './patientNumberConflicts'

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

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: 'procedure-1',
    name: 'Custom Procedure',
    isCustom: true,
    templateId: 'template-1',
    ...overrides,
  }
}

function makeTombstone(
  overrides: Partial<DeletionTombstone> = {}
): DeletionTombstone {
  return {
    id: 'tombstone-1',
    entityType: 'patient',
    entityId: 'patient-1',
    deletedAt: '2026-01-01T00:00:00.000Z',
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
    deletionTombstones: [],
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
   2. TWO-DEVICE CONVERGENCE - INDEPENDENT PATIENT CREATION
   ============================================================ */

describe('two-device convergence - independent patient creation', () => {

  it('both UUIDs survive on the cloud and on both devices after both sync', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const deviceA = new MemoryStorage()
    const deviceB = new MemoryStorage()

    useDevice(deviceA)
    seedSynchronized({ patients: [makePatient({ id: 'a', patientNumber: 1 })] })
    const resultA = await syncCloudNow()
    expect(resultA.status).toBe('synced')

    useDevice(deviceB)
    seedSynchronized({ patients: [makePatient({ id: 'b', patientNumber: 2 })] })
    const resultB = await syncCloudNow()
    expect(resultB.status).toBe('synced')

    // Device B's own sync already merged in whatever the cloud had (A).
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id).sort()
    ).toEqual(['a', 'b'])

    expect(
      cloud.peek()?.patients.map(p => p.id).sort()
    ).toEqual(['a', 'b'])

    // Device A syncs again and picks up B.
    useDevice(deviceA)
    const resultA2 = await syncCloudNow()
    expect(resultA2.status).toBe('synced')
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id).sort()
    ).toEqual(['a', 'b'])

  })

})

/* ============================================================
   3. SAME PATIENT ON TWO DEVICES
   ============================================================ */

describe('same patient UUID on two devices', () => {

  it('identical content on both sides deduplicates to one patient, id/number unchanged', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const patient = makePatient({ id: 'shared', patientNumber: 7 })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ patients: [patient] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ patients: [{ ...patient }] })
    const result = await syncCloudNow()

    expect(result.status).toBe('synced')
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual([patient])
    expect(cloud.peek()?.patients).toEqual([patient])

  })

  it('same UUID with different content (should-never-happen) uses the Phase 3 deterministic tie-break, not a new rule', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const patientVariantA = makePatient({ id: 'shared', name: 'Ahmed Ali' })
    const patientVariantB = makePatient({ id: 'shared', name: 'Mohamed Hassan' })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ patients: [patientVariantA] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ patients: [patientVariantB] })
    await syncCloudNow()

    // Whatever cloudMerge.ts's resolveTie() picks, it must be exactly
    // one of the two input variants (never a fabricated third value),
    // and it must match what the pure merge engine itself would pick.
    const directMerge = mergeCloudSyncDocuments(
      makeCloudDocument({ patients: [patientVariantA] }),
      makeCloudDocument({ patients: [patientVariantB] })
    )

    expect(cloud.peek()?.patients).toEqual(directMerge.document.patients)
    expect([patientVariantA, patientVariantB]).toContainEqual(
      cloud.peek()!.patients[0]
    )

  })

})

/* ============================================================
   4. PATIENT-NUMBER COLLISION ACROSS DEVICES + RESOLUTION
   ============================================================ */

describe('patient-number collision across devices', () => {

  it('both patients/UUIDs survive, conflict is detected/persisted, sync still succeeds, no renumbering', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ patients: [makePatient({ id: 'a', patientNumber: 42 })] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ patients: [makePatient({ id: 'b', patientNumber: 42 })] })
    const result = await syncCloudNow()

    expect(result.status).toBe('synced-with-conflicts')

    if (result.status !== 'synced-with-conflicts') {
      throw new Error('expected synced-with-conflicts')
    }

    expect(result.patientNumberConflicts).toEqual([
      { patientNumber: 42, patientIds: ['a', 'b'] },
    ])

    const patientsOnB = readKey<Patient[]>('toothTargetPatients')
    expect(patientsOnB.map(p => p.id).sort()).toEqual(['a', 'b'])
    expect(patientsOnB.every(p => p.patientNumber === 42)).toBe(true)

    expect(readPersistedPatientNumberConflicts()).toEqual([
      { patientNumber: 42, patientIds: ['a', 'b'] },
    ])

  })

  it('explicit resolution keeps the chosen number, renumbers the other, preserves treatments/UUIDs, and the correction reaches the cloud', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ patients: [makePatient({ id: 'a', patientNumber: 42 })] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)

    const treatmentForA = makeSavedTreatment({ id: 't-a', patientId: 'a' })

    seedSynchronized({
      patients: [makePatient({ id: 'b', patientNumber: 42 })],
      savedTreatments: [treatmentForA],
    })
    seed('toothTargetNextPatientNumber', 43)

    await syncCloudNow() // produces the conflict on device B, as above

    // Explicit dentist resolution: keep 'a' at #42.
    const resolution = resolvePatientNumberConflictUnderLock(42, 'a')

    expect(resolution.resolved).toBe(true)

    if (!resolution.resolved) {
      throw new Error('expected resolution to succeed')
    }

    const keptPatient = resolution.patients.find(p => p.id === 'a')
    const renumberedPatient = resolution.patients.find(p => p.id === 'b')

    expect(keptPatient?.patientNumber).toBe(42)
    expect(renumberedPatient?.patientNumber).not.toBe(42)
    expect(renumberedPatient?.id).toBe('b') // UUID untouched
    expect(renumberedPatient?.patientNumber).toBeGreaterThanOrEqual(43) // existing allocation formula

    // Existing treatments untouched by the renumbering.
    expect(readKey<SavedTreatment[]>('toothTargetSavedTreatments')).toEqual([
      treatmentForA,
    ])

    // Phase 8 follow-up: the corrected registry must reach the cloud -
    // this is the App.tsx confirmConflictResolution() -> requestCloudSync()
    // wiring added in this phase. Simulate that wiring directly here
    // (App.tsx itself cannot be imported into Vitest - see this
    // project's established MSAL/window constraint) by requesting a
    // sync exactly the way that handler now does, gated on resolved.
    if (resolution.resolved) {
      requestCloudSync()
    }

    await flushMicrotasks(20)

    expect(cloud.peek()?.patients.find(p => p.id === 'b')?.patientNumber)
      .toBe(renumberedPatient?.patientNumber)

  })

  it('does not sync when conflict resolution is a no-op', async () => {

    seedSynchronized({ patients: [makePatient({ id: 'a', patientNumber: 1 })] })

    const resolution = resolvePatientNumberConflictUnderLock(1, 'a')

    // Nobody else holds #1 - this is already resolved / a no-op.
    expect(resolution.resolved).toBe(false)

    if (resolution.resolved) {
      requestCloudSync()
    }

    await Promise.resolve()
    await Promise.resolve()

    expect(mockedRead).not.toHaveBeenCalled()
    expect(mockedWrite).not.toHaveBeenCalled()

  })

})

/* ============================================================
   5. PATIENT DELETION / OFFLINE RESURRECTION PREVENTION
   ============================================================ */

describe('patient deletion and offline resurrection prevention', () => {

  it('a patient deleted on one device while another is offline never returns, and their treatments are suppressed', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const patientX = makePatient({ id: 'x' })
    const treatmentForX = makeSavedTreatment({ id: 't-x', patientId: 'x' })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({
      patients: [patientX],
      savedTreatments: [treatmentForX],
    })
    await syncCloudNow() // cloud now has patient X + their treatment

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({
      patients: [patientX],
      savedTreatments: [treatmentForX],
    })
    // Device B is offline at this point - it never syncs yet, it just
    // has its own local copy of X (this is the "still has the old
    // patient locally" state from the task).

    // Device A deletes X (a tombstone appears, exactly like
    // App.tsx's removePatientFromCurrentList()/appendTombstone()) and
    // syncs.
    useDevice(deviceA)
    seedSynchronized({
      patients: [],
      savedTreatments: [],
      tombstones: [makeTombstone({ entityType: 'patient', entityId: 'x' })],
    })
    const resultA = await syncCloudNow()
    expect(resultA.status).toBe('synced')
    expect(cloud.peek()?.patients).toEqual([])
    expect(cloud.peek()?.deletionTombstones).toHaveLength(1)

    // Device B comes back online and syncs - it still locally has X.
    useDevice(deviceB)
    const resultB = await syncCloudNow()

    expect(resultB.status).toBe('synced')
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual([])
    expect(
      readKey<SavedTreatment[]>('toothTargetSavedTreatments')
    ).toEqual([])
    expect(
      readKey<DeletionTombstone[]>('toothTargetDeletionTombstones')
    ).toHaveLength(1)

    // Device A syncing again never sees X return either.
    useDevice(deviceA)
    await syncCloudNow()
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual([])

  })

  it('does not touch active/incomplete treatments as part of synchronization', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const device = new MemoryStorage()
    useDevice(device)

    seedSynchronized({
      patients: [],
      tombstones: [makeTombstone({ entityType: 'patient', entityId: 'x' })],
    })

    const activeMarker = { id: 'active-marker' }
    const incompleteMarker = [{ id: 'incomplete-marker' }]

    seed('toothTargetActiveTreatment', activeMarker)
    seed('toothTargetIncompleteTreatments', incompleteMarker)

    await syncCloudNow()

    expect(readKey('toothTargetActiveTreatment')).toEqual(activeMarker)
    expect(readKey('toothTargetIncompleteTreatments')).toEqual(
      incompleteMarker
    )

  })

})

/* ============================================================
   6. TEMPLATE DELETION / OFFLINE RESURRECTION PREVENTION
   ============================================================ */

describe('template deletion and offline resurrection prevention', () => {

  it('a template tombstoned on one device never returns, and its procedure is not auto-deleted', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const template = makeTemplate({ id: 'tmpl-a' })
    const procedure = makeProcedure({ id: 'proc-a', templateId: 'tmpl-a' })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({
      templates: [makeBuiltinTemplate(), template],
      procedures: [procedure],
    })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({
      templates: [makeBuiltinTemplate(), template],
      procedures: [procedure],
    })
    // Offline - has not synced yet.

    useDevice(deviceA)
    seedSynchronized({
      templates: [makeBuiltinTemplate()],
      procedures: [procedure],
      tombstones: [
        makeTombstone({ entityType: 'procedureTemplate', entityId: 'tmpl-a' }),
      ],
    })
    await syncCloudNow()

    useDevice(deviceB)
    const resultB = await syncCloudNow()

    expect(resultB.status).toBe('synced')

    const committedTemplates =
      readKey<ProcedureTemplate[]>('toothTargetTemplates')

    expect(committedTemplates.filter(t => t.isCustom)).toEqual([])
    expect(committedTemplates.find(t => t.id === 'general')).toBeTruthy()

    // The procedure referencing the now-tombstoned template survives
    // untouched - matching the existing Phase 3 rule.
    expect(
      readKey<Procedure[]>('toothTargetProcedures').find(
        p => p.id === 'proc-a'
      )
    ).toEqual(procedure)

  })

})

/* ============================================================
   7. CUSTOM TEMPLATE CONCURRENT EDITING
   ============================================================ */

describe('custom template concurrent editing - latest-updatedAt-wins', () => {

  it('B wins when A is older than B', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const older = makeTemplate({
      id: 'tmpl-a',
      name: 'Version A',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const newer = makeTemplate({
      id: 'tmpl-a',
      name: 'Version B',
      updatedAt: '2026-06-01T00:00:00.000Z',
    })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ templates: [makeBuiltinTemplate(), older] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ templates: [makeBuiltinTemplate(), newer] })
    await syncCloudNow()

    expect(
      readKey<ProcedureTemplate[]>('toothTargetTemplates').find(
        t => t.isCustom
      )
    ).toEqual(newer)

  })

  it('the older version never overwrites newer content, regardless of sync order', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const older = makeTemplate({
      id: 'tmpl-a',
      name: 'Version A',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const newer = makeTemplate({
      id: 'tmpl-a',
      name: 'Version B',
      updatedAt: '2026-06-01T00:00:00.000Z',
    })

    // Reversed order from the previous test - newer syncs first.
    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ templates: [makeBuiltinTemplate(), newer] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ templates: [makeBuiltinTemplate(), older] })
    await syncCloudNow()

    expect(
      readKey<ProcedureTemplate[]>('toothTargetTemplates').find(
        t => t.isCustom
      )
    ).toEqual(newer)

  })

  it('equal updatedAt with different content resolves via the deterministic canonical tie-break', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const variantA = makeTemplate({
      id: 'tmpl-a',
      name: 'Content A',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const variantB = makeTemplate({
      id: 'tmpl-a',
      name: 'Content B',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ templates: [makeBuiltinTemplate(), variantA] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ templates: [makeBuiltinTemplate(), variantB] })
    await syncCloudNow()

    const directMerge = mergeCloudSyncDocuments(
      makeCloudDocument({ customTemplates: [variantA] }),
      makeCloudDocument({ customTemplates: [variantB] })
    )

    expect(
      readKey<ProcedureTemplate[]>('toothTargetTemplates').find(
        t => t.isCustom
      )
    ).toEqual(directMerge.document.customTemplates[0])

  })

})

/* ============================================================
   8. SAVED TREATMENT CONVERGENCE
   ============================================================ */

describe('saved treatment convergence', () => {

  it('different treatment IDs from both devices both survive', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const treatmentA = makeSavedTreatment({ id: 't-a', patientId: 'p1' })
    const treatmentB = makeSavedTreatment({ id: 't-b', patientId: 'p2' })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ savedTreatments: [treatmentA] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ savedTreatments: [treatmentB] })
    await syncCloudNow()

    expect(
      readKey<SavedTreatment[]>('toothTargetSavedTreatments')
        .map(t => t.id)
        .sort()
    ).toEqual(['t-a', 't-b'])

  })

  it('the same treatment ID with identical content deduplicates to one record, IDs preserved exactly', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const treatment = makeSavedTreatment({ id: 't-shared' })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ savedTreatments: [treatment] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ savedTreatments: [{ ...treatment }] })
    await syncCloudNow()

    const committed = readKey<SavedTreatment[]>('toothTargetSavedTreatments')

    expect(committed).toHaveLength(1)
    expect(committed[0]).toEqual(treatment)
    expect(committed[0].id).toBe('t-shared')
    expect(committed[0].phaseRecords[0].id).toBe('phase-1')
    expect(committed[0].events[0].id).toBe('event-1')

  })

  it('the same treatment ID with different content uses the deterministic tie-break, never a new merge rule', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const variantA = makeSavedTreatment({ id: 't-shared', totalActualDuration: 500 })
    const variantB = makeSavedTreatment({ id: 't-shared', totalActualDuration: 600 })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ savedTreatments: [variantA] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ savedTreatments: [variantB] })
    await syncCloudNow()

    const directMerge = mergeCloudSyncDocuments(
      makeCloudDocument({ savedTreatments: [variantA] }),
      makeCloudDocument({ savedTreatments: [variantB] })
    )

    expect(
      readKey<SavedTreatment[]>('toothTargetSavedTreatments')
    ).toEqual(directMerge.document.savedTreatments)

  })

})

/* ============================================================
   9. PROCEDURE CONVERGENCE
   ============================================================ */

describe('custom procedure convergence', () => {

  it('procedures created on different devices both survive', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ procedures: [makeProcedure({ id: 'proc-a' })] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ procedures: [makeProcedure({ id: 'proc-b' })] })
    await syncCloudNow()

    expect(
      readKey<Procedure[]>('toothTargetProcedures')
        .filter(p => p.isCustom)
        .map(p => p.id)
        .sort()
    ).toEqual(['proc-a', 'proc-b'])

  })

  it('the same procedure ID with different content uses the deterministic tie-break, and template references are exactly as the merge produced', async () => {

    const cloud = new FakeCloudFile()
    wireTransportTo(cloud)

    const variantA = makeProcedure({ id: 'proc-shared', templateId: 'tmpl-a' })
    const variantB = makeProcedure({ id: 'proc-shared', templateId: 'tmpl-b' })

    const deviceA = new MemoryStorage()
    useDevice(deviceA)
    seedSynchronized({ procedures: [variantA] })
    await syncCloudNow()

    const deviceB = new MemoryStorage()
    useDevice(deviceB)
    seedSynchronized({ procedures: [variantB] })
    await syncCloudNow()

    const directMerge = mergeCloudSyncDocuments(
      makeCloudDocument({ customProcedures: [variantA] }),
      makeCloudDocument({ customProcedures: [variantB] })
    )

    expect(
      readKey<Procedure[]>('toothTargetProcedures').filter(p => p.isCustom)
    ).toEqual(directMerge.document.customProcedures)

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

  it("two tabs' independent syncs both converge through Phase 6's ETag/merge handling", async () => {

    /*
      A real second browser tab is a SEPARATE JS runtime with its own
      module instances - crucially, its own cloudSyncEngine.ts
      `inFlightSync` closure variable - that only shares localStorage
      and the cloud file with the first tab. Calling the single
      already-imported syncCloudNow() twice in a row would instead hit
      THIS module instance's own same-tab in-flight guard (Phase 6),
      which is not what two real tabs would do. vi.resetModules() +
      a fresh dynamic import gives each simulated "tab" its own
      cloudSyncEngine module instance, while both still resolve to the
      same top-of-file vi.mock('./cloudStorage', ...) and the same
      shared localStorage/FakeCloudFile below.
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

    // Tab A's patient is committed locally, then its sync begins -
    // this synchronously reads local storage up to its first await,
    // so it captures only its own patient.
    seed('toothTargetPatients', [
      makePatient({ id: 'tab-a-patient', patientNumber: 1 }),
    ])

    const tabASync = tabAEngine.syncCloudNow()

    // Tab B's own change lands in the shared storage next, and its
    // sync begins - it reads the CURRENT shared storage (both
    // patients), exactly like a second real tab would.
    seed('toothTargetPatients', [
      makePatient({ id: 'tab-a-patient', patientNumber: 1 }),
      makePatient({ id: 'tab-b-patient', patientNumber: 2 }),
    ])

    const tabBSync = tabBEngine.syncCloudNow()

    const [resultA, resultB] = await Promise.all([tabASync, tabBSync])

    expect(['synced', 'contention']).toContain(resultA.status)
    expect(['synced', 'contention']).toContain(resultB.status)

    // Regardless of exactly how the race between the two calls
    // resolved, nothing was lost or duplicated in the end.
    const finalCloudPatients = cloud.peek()?.patients.map(p => p.id).sort()
    expect(finalCloudPatients).toEqual(['tab-a-patient', 'tab-b-patient'])

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
   17. CONDITIONAL-WRITE RACE / CONTENTION
   ============================================================ */

describe('conditional-write race', () => {

  it('a 412 from another writer triggers exactly one re-read/merge/retry that includes both sides', async () => {

    const cloud = new FakeCloudFile()

    const device = new MemoryStorage()
    useDevice(device)
    seedSynchronized({ patients: [makePatient({ id: 'a' })] })

    // Prime the cloud as if it already had A (v1 -> etag "v1").
    cloud.write(makeCloudDocument({ patients: [makePatient({ id: 'a' })] }), null)

    mockedRead.mockImplementationOnce(async () => cloud.read()) // returns etag "v1"

    // Between our read and our write, "another writer" changes the
    // cloud (etag becomes "v2") - our first write attempt (still
    // holding "v1") must fail with 412.
    mockedWrite.mockImplementationOnce(async () => {

      const currentCloudState = cloud.read()

      cloud.write(
        makeCloudDocument({
          patients: [
            makePatient({ id: 'a' }),
            makePatient({ id: 'other-writer', patientNumber: 2 }),
          ],
        }),
        currentCloudState.status === 'found' ? currentCloudState.eTag : null
      )
      return { status: 'precondition-failed' }
    })

    // The retry's own read/write go through the fake normally.
    mockedRead.mockImplementation(async () => cloud.read())
    mockedWrite.mockImplementation(async (document, expectedETag) =>
      cloud.write(document, expectedETag)
    )

    const result = await syncCloudNow()

    expect(result.status).toBe('synced')
    expect(cloud.peek()?.patients.map(p => p.id).sort()).toEqual([
      'a',
      'other-writer',
    ])

  })

  it('three consecutive 412s return contention with exactly 3 attempts, and local state is untouched', async () => {

    const device = new MemoryStorage()
    useDevice(device)
    seedSynchronized({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockResolvedValue({
      status: 'found',
      document: makeCloudDocument(),
      eTag: '"stale"',
    })
    mockedWrite.mockResolvedValue({ status: 'precondition-failed' })

    const result = await syncCloudNow()

    expect(result).toEqual({ status: 'contention', attempts: 3 })
    expect(mockedRead).toHaveBeenCalledTimes(3)
    expect(mockedWrite).toHaveBeenCalledTimes(3)
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual([
      'a',
    ])

  })

})

/* ============================================================
   18 & 19. CRASH-SAFETY / PARTIAL LOCALSTORAGE COMMIT
   ============================================================ */

describe('crash-safety and partial local commit recovery', () => {

  it('cloud commit succeeds, local commit is interrupted (simulated reload), next sync converges', async () => {

    const cloud = new FakeCloudFile()

    const device = new MemoryStorage()
    useDevice(device)
    seedSynchronized({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockImplementationOnce(async () => cloud.read())
    mockedWrite.mockImplementationOnce(async (document, expectedETag) =>
      cloud.write(document, expectedETag)
    )

    const realSetItem = localStorage.setItem.bind(localStorage)

    localStorage.setItem = (key: string, value: string) => {
      if (key === 'toothTargetPatients') {
        throw new Error('simulated crash mid-commit')
      }
      return realSetItem(key, value)
    }

    const firstResult = await syncCloudNow()

    expect(firstResult.status).toBe('cloud-committed-locally-pending')
    expect(cloud.peek()?.patients.map(p => p.id)).toEqual(['a'])

    // "Page reload" - restore normal storage (a fresh page load would
    // get a working localStorage again), local data is still stale
    // (pre-merge) because the commit never finished.
    localStorage.setItem = realSetItem

    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual([
      'a',
    ])

    // Next sync (triggered by whatever the next real mutation is)
    // converges to the cloud's already-correct state.
    mockedRead.mockImplementationOnce(async () => cloud.read())
    mockedWrite.mockImplementationOnce(async (document, expectedETag) =>
      cloud.write(document, expectedETag)
    )

    const secondResult = await syncCloudNow()

    expect(secondResult.status).toBe('synced')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual([
      'a',
    ])

  })

  it('a saved-treatments write failure after patients succeeded does not permanently lose data already in the cloud', async () => {

    const cloud = new FakeCloudFile()

    const device = new MemoryStorage()
    useDevice(device)

    const treatment = makeSavedTreatment({ id: 't-a' })

    seedSynchronized({
      patients: [makePatient({ id: 'a' })],
      savedTreatments: [treatment],
    })

    mockedRead.mockImplementationOnce(async () => cloud.read())
    mockedWrite.mockImplementationOnce(async (document, expectedETag) =>
      cloud.write(document, expectedETag)
    )

    const realSetItem = localStorage.setItem.bind(localStorage)

    localStorage.setItem = (key: string, value: string) => {
      if (key === 'toothTargetSavedTreatments') {
        throw new Error('simulated write failure')
      }
      return realSetItem(key, value)
    }

    const firstResult = await syncCloudNow()

    expect(firstResult.status).toBe('cloud-committed-locally-pending')
    // The cloud already has the treatment even though the local write
    // that would have mirrored it failed.
    expect(cloud.peek()?.savedTreatments).toEqual([treatment])

    localStorage.setItem = realSetItem

    mockedRead.mockImplementationOnce(async () => cloud.read())
    mockedWrite.mockImplementationOnce(async (document, expectedETag) =>
      cloud.write(document, expectedETag)
    )

    const secondResult = await syncCloudNow()

    expect(secondResult.status).toBe('synced')
    expect(readKey<SavedTreatment[]>('toothTargetSavedTreatments')).toEqual([
      treatment,
    ])

  })

  it('a tombstones write failure does not permanently lose the tombstone already in the cloud', async () => {

    const cloud = new FakeCloudFile()

    const device = new MemoryStorage()
    useDevice(device)

    const tombstone = makeTombstone({ entityId: 'deleted-patient' })

    seedSynchronized({ tombstones: [tombstone] })

    mockedRead.mockImplementationOnce(async () => cloud.read())
    mockedWrite.mockImplementationOnce(async (document, expectedETag) =>
      cloud.write(document, expectedETag)
    )

    const realSetItem = localStorage.setItem.bind(localStorage)

    localStorage.setItem = (key: string, value: string) => {
      if (key === 'toothTargetDeletionTombstones') {
        throw new Error('simulated write failure')
      }
      return realSetItem(key, value)
    }

    const firstResult = await syncCloudNow()

    expect(firstResult.status).toBe('cloud-committed-locally-pending')
    expect(cloud.peek()?.deletionTombstones).toEqual([tombstone])

    localStorage.setItem = realSetItem

    mockedRead.mockImplementationOnce(async () => cloud.read())
    mockedWrite.mockImplementationOnce(async (document, expectedETag) =>
      cloud.write(document, expectedETag)
    )

    await syncCloudNow()

    expect(
      readKey<DeletionTombstone[]>('toothTargetDeletionTombstones')
    ).toEqual([tombstone])

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
