import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  Phase 5 (single-writer sync model) removed every OLD per-record-merge
  syncCloudNow() test this file used to carry - that whole orchestration
  (mergeCloudSyncDocuments(), the stale-review gate, 412-retry-and-
  re-merge, patient-number-conflict ingestion) is no longer reachable
  through syncCloudNow(), which now calls pushLocalSnapshot() instead
  (see cloudSyncEngine.singleWriter.test.ts for its own, current
  coverage). What's left here - reconcileSyncedAccount()'s per-account
  local-cache isolation - is completely UNCHANGED by this phase and
  still exactly as tested before.

  cloudStorage.ts is still mocked (even though nothing below calls
  readCloudSyncDocument/writeCloudSyncDocument directly) purely so the
  real cloudStorage.ts - which imports ./auth, touching `window.location`
  and instantiating MSAL at module scope - never loads when this file
  imports cloudSyncEngine.ts, which still imports cloudStorage.ts at its
  own module top level. No separate ./auth mock is needed either way.
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
} from './App'

import { reconcileSyncedAccount } from './cloudSyncEngine'

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
    events: [],
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
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function seedLocalSynchronizedData(overrides: {
  patients?: Patient[]
  savedTreatments?: SavedTreatment[]
  templates?: ProcedureTemplate[]
  procedures?: Procedure[]
}): void {
  seed('toothTargetPatients', overrides.patients ?? [])
  seed('toothTargetSavedTreatments', overrides.savedTreatments ?? [])
  seed('toothTargetTemplates', overrides.templates ?? [makeBuiltinTemplate()])
  seed('toothTargetProcedures', overrides.procedures ?? [])
}

describe('reconcileSyncedAccount - per-account local caches (Phase 4)', () => {

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

  })

  it('switching to an account this device has never seen before starts it empty', () => {

    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a' })],
      savedTreatments: [makeSavedTreatment()],
      templates: [makeBuiltinTemplate(), makeTemplate({ id: 'custom-t' })],
      procedures: [makeProcedure({ id: 'custom-p' })],
    })

    seed('toothTargetNextPatientNumber', 42)
    seed('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')

    reconcileSyncedAccount('account-1')

    const result = reconcileSyncedAccount('account-2')

    expect(result).toBe('switched-account')

    // The account-specific keys are all empty for the never-seen-before account.
    expect(readKey<Patient[]>('toothTargetPatients')).toEqual([])
    expect(readKey<SavedTreatment[]>('toothTargetSavedTreatments')).toEqual([])
    expect(localStorage.getItem('toothTargetDeletionTombstones')).toBeNull()
    expect(readKey<Procedure[]>('toothTargetProcedures')).toEqual([])

    // Built-in templates survive; the previous account's custom one does not.
    const remainingTemplates = readKey<ProcedureTemplate[]>('toothTargetTemplates')
    expect(remainingTemplates.map(t => t.id)).toEqual(['general'])
    expect(remainingTemplates.every(t => t.isCustom === false)).toBe(true)

    // Account-specific local-only metadata reset too.
    expect(localStorage.getItem('toothTargetCloudSyncUpdatedAt')).toBeNull()
    expect(localStorage.getItem('toothTargetNextPatientNumber')).toBeNull()

  })

  it('preserves the outgoing account\'s CURRENT state (including unsynced changes) into its own cache', () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    reconcileSyncedAccount('account-1')

    // A change happens AFTER account-1 became active but before it's
    // ever switched away from - simulating a completed treatment that
    // hasn't reached the cloud yet.
    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a' }), makePatient({ id: 'a2', patientNumber: 2 })],
    })
    seed('toothTargetNextPatientNumber', 3)

    reconcileSyncedAccount('account-2')

    // Switch back to account-1 - its cache must reflect the LATEST
    // state it had, not whatever it looked like right after its own
    // first reconcileSyncedAccount() call.
    const result = reconcileSyncedAccount('account-1')

    expect(result).toBe('switched-account')
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id).sort()
    ).toEqual(['a', 'a2'])
    expect(readKey<number>('toothTargetNextPatientNumber')).toBe(3)

  })

  it('switching back to a previously-seen account restores exactly what was cached for it', () => {

    /*
      Seeding happens AFTER each reconcileSyncedAccount() call, never
      before switching AWAY from the previous account - data written
      before a switch is still logically the OUTGOING account's
      current state (see captureCurrentAccountState()'s own comment:
      it reads whatever is currently in localStorage AT THE MOMENT OF
      THE SWITCH), not a preview of the incoming account's data.
    */

    reconcileSyncedAccount('account-1')
    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a1' })],
      templates: [makeBuiltinTemplate(), makeTemplate({ id: 'a1-template' })],
    })
    seed('toothTargetNextPatientNumber', 5)

    reconcileSyncedAccount('account-2')
    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'b1' })],
      templates: [makeBuiltinTemplate(), makeTemplate({ id: 'b1-template' })],
    })
    seed('toothTargetNextPatientNumber', 9)

    // account-2's own data is active now.
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['b1'])

    // Switching back to account-1 restores exactly what it had.
    reconcileSyncedAccount('account-1')

    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['a1'])

    const templates = readKey<ProcedureTemplate[]>('toothTargetTemplates')
    expect(templates.map(t => t.id).sort()).toEqual(['a1-template', 'general'])

    expect(readKey<number>('toothTargetNextPatientNumber')).toBe(5)

  })

  it('keeps at least 3 accounts fully isolated across repeated back-and-forth switches', () => {

    reconcileSyncedAccount('account-a')
    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a1' })] })

    reconcileSyncedAccount('account-b')
    seedLocalSynchronizedData({ patients: [makePatient({ id: 'b1' })] })

    reconcileSyncedAccount('account-c')
    seedLocalSynchronizedData({ patients: [makePatient({ id: 'c1' })] })

    // Round 1: back to a, then b, then c - each must see only its own data.
    reconcileSyncedAccount('account-a')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['a1'])

    reconcileSyncedAccount('account-b')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['b1'])

    reconcileSyncedAccount('account-c')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['c1'])

    // Add more data to 'a' from a non-adjacent switch, to confirm its
    // slot isn't disturbed by b/c being active in between.
    reconcileSyncedAccount('account-a')
    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a1' }), makePatient({ id: 'a2', patientNumber: 2 })],
    })

    reconcileSyncedAccount('account-b')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['b1'])

    reconcileSyncedAccount('account-c')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['c1'])

    reconcileSyncedAccount('account-a')
    expect(
      readKey<Patient[]>('toothTargetPatients').map(p => p.id).sort()
    ).toEqual(['a1', 'a2'])

    // b and c were never touched again and still hold exactly their
    // own single patient each.
    reconcileSyncedAccount('account-b')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['b1'])

    reconcileSyncedAccount('account-c')
    expect(readKey<Patient[]>('toothTargetPatients').map(p => p.id)).toEqual(['c1'])

  })

})
