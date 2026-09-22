import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  cloudStorage.ts is mocked entirely (per this phase's own instruction
  to mock readCloudSyncDocument/writeCloudSyncDocument and test
  orchestration separately) - this also means the real cloudStorage.ts
  never loads, so its own runtime import of ./auth (MSAL/window at
  module scope) never executes either. No separate ./auth mock is
  needed here.
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
} from './cloudStorage'

import {
  syncCloudNow,
  reconcileSyncedAccount,
  __resetAccountSyncGuardForTests,
} from './cloudSyncEngine'

import { readPersistedPatientNumberConflicts } from './patientNumberConflicts'

const mockedRead = vi.mocked(readCloudSyncDocument)
const mockedWrite = vi.mocked(writeCloudSyncDocument)

/*
  Minimal, fully-typed in-memory Storage - see cloudMerge.test.ts/
  patientNumberConflicts.test.ts for the same pattern used elsewhere
  in this project's test suite.
*/

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

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage()
  mockedRead.mockReset()
  mockedWrite.mockReset()
})

function seed(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function readKey<T>(key: string): T {
  return JSON.parse(localStorage.getItem(key)!) as T
}

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'patient-1',
    patientNumber: 1,
    name: 'Jane Doe',
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
    events: [],
    tags: [],
    chairEnteredAt: null,
    chairLeftAt: null,
    currentPhaseIndex: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:08:20.000Z',
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

function seedLocalSynchronizedData(overrides: {
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

describe('syncCloudNow - initial cloud creation', () => {

  it('creates the cloud document when local has data and the cloud is absent', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockResolvedValueOnce({ status: 'not-found' })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e1"' })

    const result = await syncCloudNow()

    expect(result.status).toBe('synced')
    expect(mockedWrite).toHaveBeenCalledTimes(1)

    const [writtenDocument, expectedETag] = mockedWrite.mock.calls[0]

    expect(expectedETag).toBeNull()
    expect(writtenDocument.patients.map(p => p.id)).toEqual(['a'])

  })

  it('re-reads/merges/retries when another device wins the creation race', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    const remotePatient = makePatient({ id: 'b', patientNumber: 2 })

    mockedRead
      .mockResolvedValueOnce({ status: 'not-found' })
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({ patients: [remotePatient] }),
        eTag: '"e-remote"',
      })

    mockedWrite
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    const result = await syncCloudNow()

    expect(result.status).toBe('synced')
    expect(mockedRead).toHaveBeenCalledTimes(2)
    expect(mockedWrite).toHaveBeenCalledTimes(2)

    const [, firstETag] = mockedWrite.mock.calls[0]
    const [secondDocument, secondETag] = mockedWrite.mock.calls[1]

    expect(firstETag).toBeNull()
    expect(secondETag).toBe('"e-remote"')
    expect(secondDocument.patients.map(p => p.id).sort()).toEqual(['a', 'b'])

  })

  it('can create a valid cloud document from empty local state', async () => {

    seedLocalSynchronizedData({})

    mockedRead.mockResolvedValueOnce({ status: 'not-found' })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e1"' })

    const result = await syncCloudNow()

    expect(result.status).toBe('synced')

    const [writtenDocument] = mockedWrite.mock.calls[0]

    expect(writtenDocument.patients).toEqual([])
    expect(writtenDocument.customTemplates).toEqual([])

  })

})

describe('syncCloudNow - normal merge', () => {

  it('a local-only patient reaches the cloud document', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'local-only' })] })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument(),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    const [writtenDocument] = mockedWrite.mock.calls[0]

    expect(writtenDocument.patients.map(p => p.id)).toEqual(['local-only'])

  })

  it('a cloud-only patient reaches the local registry', async () => {

    seedLocalSynchronizedData({})

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({
        patients: [makePatient({ id: 'cloud-only' })],
      }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    const result = await syncCloudNow()

    expect(result.status).toBe('synced')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual([
      'cloud-only',
    ])

  })

  it('preserves both sides saved treatments', async () => {

    const localTreatment = makeSavedTreatment({ id: 'local-t', patientId: 'p1' })
    const cloudTreatment = makeSavedTreatment({ id: 'cloud-t', patientId: 'p2' })

    seedLocalSynchronizedData({ savedTreatments: [localTreatment] })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ savedTreatments: [cloudTreatment] }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    const committed = readKey<SavedTreatment[]>('toothTargetSavedTreatments')

    expect(committed.map(t => t.id).sort()).toEqual(['cloud-t', 'local-t'])

  })

  it('custom template latest-wins comes from cloudMerge.ts, and updatedAt is preserved exactly', async () => {

    const olderLocal = makeTemplate({
      id: 'tmpl-a',
      name: 'Old content',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const newerCloud = makeTemplate({
      id: 'tmpl-a',
      name: 'New content',
      updatedAt: '2026-06-01T00:00:00.000Z',
    })

    seedLocalSynchronizedData({
      templates: [makeBuiltinTemplate(), olderLocal],
    })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ customTemplates: [newerCloud] }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    const committedTemplates =
      readKey<ProcedureTemplate[]>('toothTargetTemplates')

    const custom = committedTemplates.filter(t => t.isCustom)
    const builtins = committedTemplates.filter(t => !t.isCustom)

    expect(custom).toEqual([newerCloud])
    expect(builtins.map(t => t.id)).toEqual(['general'])

  })

  it('merges custom procedures by id and preserves built-in procedures untouched', async () => {

    const localProcedure = makeProcedure({ id: 'proc-local' })
    const cloudProcedure = makeProcedure({ id: 'proc-cloud' })
    const builtinProcedure: Procedure = {
      id: 'rct',
      name: 'RCT',
      isCustom: false,
      templateId: 'rct-molar',
    }

    seedLocalSynchronizedData({
      procedures: [builtinProcedure, localProcedure],
    })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ customProcedures: [cloudProcedure] }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    const committed = readKey<Procedure[]>('toothTargetProcedures')

    expect(committed.find(p => p.id === 'rct')).toEqual(builtinProcedure)
    expect(
      committed.filter(p => p.isCustom).map(p => p.id).sort()
    ).toEqual(['proc-cloud', 'proc-local'])

  })

  it('a cloud tombstone prevents a stale locally-present patient from returning', async () => {

    const patient = makePatient({ id: 'deleted-elsewhere' })

    seedLocalSynchronizedData({ patients: [patient] })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({
        deletionTombstones: [
          makeTombstone({ entityType: 'patient', entityId: 'deleted-elsewhere' }),
        ],
      }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    expect(readKey<Patient[]>('toothTargetPatients')).toEqual([])
    expect(
      readKey<DeletionTombstone[]>('toothTargetDeletionTombstones')
    ).toHaveLength(1)

  })

})

describe('syncCloudNow - patient-number conflicts', () => {

  it('detects a conflict, persists it, and still reports success', async () => {

    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a', patientNumber: 12 })],
    })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({
        patients: [makePatient({ id: 'b', patientNumber: 12 })],
      }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    const result = await syncCloudNow()

    expect(result.status).toBe('synced-with-conflicts')

    if (result.status !== 'synced-with-conflicts') {
      throw new Error('expected synced-with-conflicts')
    }

    expect(result.patientNumberConflicts).toEqual([
      { patientNumber: 12, patientIds: ['a', 'b'] },
    ])

    expect(readPersistedPatientNumberConflicts()).toEqual([
      { patientNumber: 12, patientIds: ['a', 'b'] },
    ])

    // Neither patient was renumbered or dropped - resolution stays separate.
    const committedPatients = readKey<Patient[]>('toothTargetPatients')

    expect(
      committedPatients.map(p => p.patientNumber).sort()
    ).toEqual([12, 12])
    expect(committedPatients.map(p => p.id).sort()).toEqual(['a', 'b'])

  })

})

describe('syncCloudNow - conditional writes and contention', () => {

  it('uses the exact ETag returned by the read that produced the merged document', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument(),
      eTag: '"exact-etag-value"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    const [, expectedETag] = mockedWrite.mock.calls[0]

    expect(expectedETag).toBe('"exact-etag-value"')

  })

  it('retries on 412 against an existing cloud document and commits the converged result', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a', patientNumber: 1 })] })

    mockedRead
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({
          patients: [makePatient({ id: 'b', patientNumber: 2 })],
        }),
        eTag: '"e1"',
      })
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({
          patients: [
            makePatient({ id: 'b', patientNumber: 2 }),
            makePatient({ id: 'c', patientNumber: 3 }),
          ],
        }),
        eTag: '"e2"',
      })

    mockedWrite
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValueOnce({ status: 'written', eTag: '"e3"' })

    const result = await syncCloudNow()

    expect(result.status).toBe('synced')

    const [, secondETag] = mockedWrite.mock.calls[1]
    expect(secondETag).toBe('"e2"')

    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id).sort()
    ).toEqual(['a', 'b', 'c'])

  })

  it('returns contention after exhausting the retry limit, without an unbounded loop', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

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

    // Local synchronized state is untouched by repeated contention.
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id)
    ).toEqual(['a'])

  })

})

describe('syncCloudNow - failure safety', () => {

  it('does not overwrite local state when the cloud document is malformed', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockResolvedValueOnce({
      status: 'malformed-json',
      detail: 'not json',
    })

    const result = await syncCloudNow()

    expect(result).toEqual({ status: 'cloud-invalid', detail: 'not json' })
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id)
    ).toEqual(['a'])

  })

  it('rejects an invalid local document before ever reading or writing the cloud', async () => {

    // A custom template missing `updatedAt` fails validateCloudSyncDocument().
    seedLocalSynchronizedData({
      templates: [
        {
          id: 'broken',
          name: 'Broken',
          isCustom: true,
          phases: [],
          specializationId: 'general',
          procedureKey: 'general',
          typeId: 'general',
        } as unknown as ProcedureTemplate,
      ],
    })

    const result = await syncCloudNow()

    expect(result.status).toBe('validation-failed')
    expect(mockedRead).not.toHaveBeenCalled()
    expect(mockedWrite).not.toHaveBeenCalled()

  })

  it('does not discard valid local data when the cloud write fails', async () => {

    const localPatients = [makePatient({ id: 'a' })]

    seedLocalSynchronizedData({ patients: localPatients })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument(),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({
      status: 'graph-error',
      detail: 'network blip',
    })

    const result = await syncCloudNow()

    expect(result).toEqual({ status: 'graph-error', detail: 'network blip' })
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual(localPatients)

  })

  it('does not modify local synchronized data on an auth/permission failure', async () => {

    const localPatients = [makePatient({ id: 'a' })]

    seedLocalSynchronizedData({ patients: localPatients })

    mockedRead.mockResolvedValueOnce({ status: 'auth-failed' })

    const result = await syncCloudNow()

    expect(result).toEqual({ status: 'auth-failed' })
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual(localPatients)

  })

})

describe('syncCloudNow - local-only state preservation', () => {

  it('leaves active treatment, incomplete treatments, and privacy lock untouched', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    const activeTreatmentMarker = { id: 'active-marker' }
    const incompleteMarker = [{ id: 'incomplete-marker' }]

    seed('toothTargetActiveTreatment', activeTreatmentMarker)
    seed('toothTargetIncompleteTreatments', incompleteMarker)
    localStorage.setItem('toothTargetPrivacyLock', '"1234"')

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument(),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    expect(readKey('toothTargetActiveTreatment')).toEqual(activeTreatmentMarker)
    expect(readKey('toothTargetIncompleteTreatments')).toEqual(incompleteMarker)
    expect(localStorage.getItem('toothTargetPrivacyLock')).toBe('"1234"')

  })

  it('never decreases the patient-number counter and never allocates a new number', async () => {

    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a', patientNumber: 5 })],
    })
    seed('toothTargetNextPatientNumber', 100)

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument(),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    expect(readKey<number>('toothTargetNextPatientNumber')).toBe(100)

  })

  it('raises the counter to stay above the highest merged patient number, never below', async () => {

    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a', patientNumber: 5 })],
    })
    seed('toothTargetNextPatientNumber', 3) // stale/low

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({
        patients: [makePatient({ id: 'b', patientNumber: 9 })],
      }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    await syncCloudNow()

    expect(readKey<number>('toothTargetNextPatientNumber')).toBe(10)

  })

})

describe('syncCloudNow - idempotence', () => {

  it('running sync twice in a row with no changes produces no duplicates', async () => {

    const patient = makePatient({ id: 'a' })
    const template = makeTemplate({ id: 'tmpl-a' })
    const tombstone = makeTombstone({ entityId: 'zzz' })

    seedLocalSynchronizedData({
      patients: [patient],
      templates: [makeBuiltinTemplate(), template],
      tombstones: [tombstone],
    })

    const cloudDocument = makeCloudDocument({
      patients: [patient],
      customTemplates: [template],
      deletionTombstones: [tombstone],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    mockedRead.mockResolvedValue({
      status: 'found',
      document: cloudDocument,
      eTag: '"stable-etag"',
    })
    mockedWrite.mockResolvedValue({ status: 'written', eTag: '"stable-etag"' })

    await syncCloudNow()
    const secondResult = await syncCloudNow()

    expect(secondResult.status).toBe('synced')

    const committedPatients = readKey<Patient[]>('toothTargetPatients')
    const committedTemplates =
      readKey<ProcedureTemplate[]>('toothTargetTemplates').filter(
        t => t.isCustom
      )
    const committedTombstones =
      readKey<DeletionTombstone[]>('toothTargetDeletionTombstones')

    expect(committedPatients).toHaveLength(1)
    expect(committedTemplates).toHaveLength(1)
    expect(committedTombstones).toHaveLength(1)

    // Template content/updatedAt is byte-identical - never refreshed.
    expect(committedTemplates[0]).toEqual(template)

  })

})

describe('syncCloudNow - same-tab concurrency', () => {

  it('does not run two overlapping sync transactions in the same tab', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    let resolveRead: (value: Awaited<ReturnType<typeof readCloudSyncDocument>>) => void =
      () => {}

    mockedRead.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRead = resolve
        })
    )

    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    const firstCall = syncCloudNow()
    const secondCall = syncCloudNow()

    resolveRead({ status: 'found', document: makeCloudDocument(), eTag: '"e1"' })

    const [firstResult, secondResult] = await Promise.all([
      firstCall,
      secondCall,
    ])

    expect(mockedRead).toHaveBeenCalledTimes(1)
    expect(mockedWrite).toHaveBeenCalledTimes(1)
    expect(firstResult).toBe(secondResult)

  })

})

describe('syncCloudNow - crash safety', () => {

  it('reports cloud-committed-locally-pending when the cloud write succeeds but the local commit throws, and the next sync converges', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ patients: [makePatient({ id: 'b', patientNumber: 2 })] }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    const realSetItem = localStorage.setItem.bind(localStorage)

    localStorage.setItem = (key: string, value: string) => {
      if (key === 'toothTargetPatients') {
        throw new Error('quota exceeded (simulated)')
      }
      return realSetItem(key, value)
    }

    const firstResult = await syncCloudNow()

    expect(firstResult.status).toBe('cloud-committed-locally-pending')

    // Restore normal localStorage behavior for the recovery attempt.
    localStorage.setItem = realSetItem

    /*
      The cloud is now authoritatively the merged {a, b} document (the
      write succeeded even though the local commit didn't finish).
      Local storage still only has the stale pre-sync state ({a}
      only, and no tombstones/templates committed). The next sync must
      converge to the cloud state rather than losing it or blindly
      overwriting the cloud again.
    */

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({
        patients: [makePatient({ id: 'a' }), makePatient({ id: 'b', patientNumber: 2 })],
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
      eTag: '"e3"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e4"' })

    const secondResult = await syncCloudNow()

    expect(secondResult.status).toBe('synced')
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id).sort()
    ).toEqual(['a', 'b'])

  })

})

describe('reconcileSyncedAccount - account-switch isolation (Phase 4)', () => {

  it('treats a first-ever sign-in (no prior account recorded) as normal - no clearing', () => {

    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a' })],
      savedTreatments: [makeSavedTreatment()],
    })

    const result = reconcileSyncedAccount('account-1')

    expect(result).toBe('first-account')

    // Local data is untouched.
    expect(readKey<Patient[]>('toothTargetPatients')).toHaveLength(1)
    expect(readKey<SavedTreatment[]>('toothTargetSavedTreatments')).toHaveLength(1)

    // The account is now recorded, so the SAME account next time is a no-op.
    expect(reconcileSyncedAccount('account-1')).toBe('same-account')

  })

  it('proceeds normally (no clearing) when the same account signs in again', () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    reconcileSyncedAccount('account-1')

    const result = reconcileSyncedAccount('account-1')

    expect(result).toBe('same-account')
    expect(readKey<Patient[]>('toothTargetPatients')).toHaveLength(1)
    expect(localStorage.getItem('toothTargetAccountSwitchBackup')).toBeNull()

  })

  it('quarantines local synced data (not the built-ins) when a different account signs in', () => {

    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a' })],
      savedTreatments: [makeSavedTreatment()],
      templates: [makeBuiltinTemplate(), makeTemplate({ id: 'custom-t' })],
      procedures: [makeProcedure({ id: 'custom-p' })],
      tombstones: [makeTombstone()],
    })

    seed('toothTargetNextPatientNumber', 42)
    seed('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')

    reconcileSyncedAccount('account-1')

    const result = reconcileSyncedAccount('account-2')

    expect(result).toBe('switched-account')

    // The four fully-account-specific keys are wiped.
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual([])
    expect(readKey<SavedTreatment[]>('toothTargetSavedTreatments')).toEqual([])
    expect(readKey<DeletionTombstone[]>('toothTargetDeletionTombstones')).toEqual([])

    // Templates/procedures: built-ins survive, customs are removed.
    const remainingTemplates = readKey<ProcedureTemplate[]>('toothTargetTemplates')
    expect(remainingTemplates.map(t => t.id)).toEqual(['general'])
    expect(remainingTemplates.every(t => t.isCustom === false)).toBe(true)

    expect(readKey<Procedure[]>('toothTargetProcedures')).toEqual([])

    // Local-only sync metadata reset too (see cloudSyncEngine.ts's own
    // reasoning for including toothTargetNextPatientNumber here).
    expect(localStorage.getItem('toothTargetCloudSyncUpdatedAt')).toBeNull()
    expect(localStorage.getItem('toothTargetNextPatientNumber')).toBeNull()

    // A backup of exactly what was cleared was preserved.
    const backup = readKey<{
      previousAccountId: string
      patients: Patient[]
      savedTreatments: SavedTreatment[]
      customTemplates: ProcedureTemplate[]
      customProcedures: Procedure[]
      deletionTombstones: DeletionTombstone[]
      nextPatientNumber: number
    }>('toothTargetAccountSwitchBackup')

    expect(backup.previousAccountId).toBe('account-1')
    expect(backup.patients.map(p => p.id)).toEqual(['a'])
    expect(backup.savedTreatments).toHaveLength(1)
    expect(backup.customTemplates.map(t => t.id)).toEqual(['custom-t'])
    expect(backup.customProcedures.map(p => p.id)).toEqual(['custom-p'])
    expect(backup.deletionTombstones).toHaveLength(1)
    expect(backup.nextPatientNumber).toBe(42)

    // The new account is now the recorded one - signing in with it
    // again is a normal, no-clearing 'same-account' pass.
    expect(reconcileSyncedAccount('account-2')).toBe('same-account')

  })

  it('overwrites (does not accumulate) the backup across repeated switches', () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    reconcileSyncedAccount('account-1')
    reconcileSyncedAccount('account-2')

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'b' })] })
    reconcileSyncedAccount('account-3')

    const backup = readKey<{ previousAccountId: string; patients: Patient[] }>(
      'toothTargetAccountSwitchBackup'
    )

    expect(backup.previousAccountId).toBe('account-2')
    expect(backup.patients.map(p => p.id)).toEqual(['b'])

  })

})
