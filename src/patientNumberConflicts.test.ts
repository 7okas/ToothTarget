import { beforeEach, describe, expect, it } from 'vitest'

import type { Patient } from './App'
import type { PatientNumberConflict } from './cloudMerge'

import {
  PATIENT_NUMBER_CONFLICTS_KEY,
  isValidPatientNumberConflict,
  readPersistedPatientNumberConflicts,
  reconcilePatientNumberConflicts,
  reconcileAndPersistPatientNumberConflicts,
  resolvePatientNumberConflictUnderLock,
} from './patientNumberConflicts'

/*
  patientNumberConflicts.ts touches `localStorage` directly (by
  design - see its own header comment on why it can't import App.tsx
  at runtime). Vitest's default 'node' test environment has no
  browser globals, so a minimal, fully-typed in-memory Storage
  implementation stands in for it - reset fresh before every test so
  no test can see another's data.
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

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'patient-1',
    patientNumber: 1,
    name: 'Jane Doe',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function seedPatients(patients: Patient[]): void {
  localStorage.setItem('toothTargetPatients', JSON.stringify(patients))
}

function seedNextPatientNumber(value: number): void {
  localStorage.setItem(
    'toothTargetNextPatientNumber',
    JSON.stringify(value)
  )
}

function seedConflicts(conflicts: PatientNumberConflict[]): void {
  localStorage.setItem(
    PATIENT_NUMBER_CONFLICTS_KEY,
    JSON.stringify(conflicts)
  )
}

describe('patientNumberConflicts - persistence', () => {

  it('conflict state persists and reloads', () => {

    const conflicts: PatientNumberConflict[] = [
      { patientNumber: 12, patientIds: ['a', 'b'] },
    ]

    seedConflicts(conflicts)

    expect(readPersistedPatientNumberConflicts()).toEqual(conflicts)

  })

  it('malformed conflict records are ignored safely', () => {

    localStorage.setItem(
      PATIENT_NUMBER_CONFLICTS_KEY,
      JSON.stringify([
        { patientNumber: 12, patientIds: ['a', 'b'] },
        { patientNumber: 'not-a-number', patientIds: ['c', 'd'] },
        { patientNumber: 5, patientIds: 'not-an-array' },
        { patientNumber: -1, patientIds: ['e', 'f'] },
        null,
        'garbage',
        42,
      ])
    )

    expect(readPersistedPatientNumberConflicts()).toEqual([
      { patientNumber: 12, patientIds: ['a', 'b'] },
    ])

  })

  it('malformed JSON / non-array payloads never throw', () => {

    localStorage.setItem(PATIENT_NUMBER_CONFLICTS_KEY, '{not valid json')

    expect(() => readPersistedPatientNumberConflicts()).not.toThrow()
    expect(readPersistedPatientNumberConflicts()).toEqual([])

    localStorage.setItem(PATIENT_NUMBER_CONFLICTS_KEY, JSON.stringify({}))

    expect(readPersistedPatientNumberConflicts()).toEqual([])

  })

  it('isValidPatientNumberConflict rejects malformed shapes', () => {

    expect(isValidPatientNumberConflict(null)).toBe(false)
    expect(isValidPatientNumberConflict({})).toBe(false)
    expect(
      isValidPatientNumberConflict({ patientNumber: 1, patientIds: [] })
    ).toBe(true)
    expect(
      isValidPatientNumberConflict({ patientNumber: 0, patientIds: ['a'] })
    ).toBe(false)
    expect(
      isValidPatientNumberConflict({
        patientNumber: 1,
        patientIds: ['a', ''],
      })
    ).toBe(false)

  })

})

describe('patientNumberConflicts - reconciliation', () => {

  it('genuine unresolved conflicts remain', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
    ]

    const reconciled = reconcilePatientNumberConflicts(
      [{ patientNumber: 12, patientIds: ['a', 'b'] }],
      patients
    )

    expect(reconciled).toEqual([
      { patientNumber: 12, patientIds: ['a', 'b'] },
    ])

  })

  it('conflict cleanup removes stale patient IDs (deleted patient)', () => {

    const patients = [makePatient({ id: 'a', patientNumber: 12 })]

    const reconciled = reconcilePatientNumberConflicts(
      [{ patientNumber: 12, patientIds: ['a', 'b'] }],
      patients
    )

    // Only one of the two still exists/holds #12 -> not a genuine conflict.
    expect(reconciled).toEqual([])

  })

  it('conflict cleanup removes a record where neither patient remains', () => {

    const reconciled = reconcilePatientNumberConflicts(
      [{ patientNumber: 12, patientIds: ['a', 'b'] }],
      []
    )

    expect(reconciled).toEqual([])

  })

  it('conflict cleanup drops a record once a patient no longer holds that number', () => {

    // Patient 'b' was renumbered away from #12 by some other means.
    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 13 }),
    ]

    const reconciled = reconcilePatientNumberConflicts(
      [{ patientNumber: 12, patientIds: ['a', 'b'] }],
      patients
    )

    expect(reconciled).toEqual([])

  })

  it('two independent conflicts remain independent under reconciliation', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
      makePatient({ id: 'c', patientNumber: 15 }),
      makePatient({ id: 'd', patientNumber: 15 }),
    ]

    const reconciled = reconcilePatientNumberConflicts(
      [
        { patientNumber: 12, patientIds: ['a', 'b'] },
        { patientNumber: 15, patientIds: ['c', 'd'] },
      ],
      patients
    )

    expect(reconciled).toEqual([
      { patientNumber: 12, patientIds: ['a', 'b'] },
      { patientNumber: 15, patientIds: ['c', 'd'] },
    ])

  })

  it('reconciliation is idempotent (repeated storage events do not duplicate state)', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
    ]

    const conflicts: PatientNumberConflict[] = [
      { patientNumber: 12, patientIds: ['b', 'a'] },
    ]

    const first = reconcilePatientNumberConflicts(conflicts, patients)
    const second = reconcilePatientNumberConflicts(first, patients)
    const third = reconcilePatientNumberConflicts(second, patients)

    expect(first).toEqual([{ patientNumber: 12, patientIds: ['a', 'b'] }])
    expect(second).toEqual(first)
    expect(third).toEqual(first)

  })

  it('reconcileAndPersistPatientNumberConflicts only rewrites storage when something changed', () => {

    const patients = [makePatient({ id: 'a', patientNumber: 12 })]

    seedConflicts([{ patientNumber: 12, patientIds: ['a', 'b'] }])

    const reconciled = reconcileAndPersistPatientNumberConflicts(patients)

    expect(reconciled).toEqual([])
    expect(readPersistedPatientNumberConflicts()).toEqual([])

  })

})

describe('patientNumberConflicts - resolution', () => {

  it('resolving a conflict preserves the selected patient number, reassigns the other, and preserves UUIDs/names', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12, name: 'Ahmed Ali' }),
      makePatient({ id: 'b', patientNumber: 12, name: 'Mohamed Hassan' }),
    ]

    seedPatients(patients)
    seedNextPatientNumber(13)
    seedConflicts([{ patientNumber: 12, patientIds: ['a', 'b'] }])

    const result = resolvePatientNumberConflictUnderLock(12, 'a')

    expect(result.resolved).toBe(true)

    if (!result.resolved) {
      throw new Error('expected resolution to succeed')
    }

    const keptPatient = result.patients.find(patient => patient.id === 'a')
    const renumberedPatient =
      result.patients.find(patient => patient.id === 'b')

    // Selected patient keeps their number, id, and name.
    expect(keptPatient).toEqual({
      id: 'a',
      patientNumber: 12,
      name: 'Ahmed Ali',
      updatedAt: '2026-01-01T00:00:00.000Z', // completely unchanged - only the renumbered patient gets a fresh one
    })

    // The other patient gets a new number but keeps id and name.
    expect(renumberedPatient?.id).toBe('b')
    expect(renumberedPatient?.name).toBe('Mohamed Hassan')
    expect(renumberedPatient?.patientNumber).not.toBe(12)
    expect(renumberedPatient?.patientNumber).toBeGreaterThanOrEqual(13)

    // The renumbered patient's updatedAt IS refreshed (Phase 8) - this
    // is what lets cloudMerge.ts's patient merge prefer the correction
    // over a stale copy of the same UUID still sitting in the cloud.
    expect(renumberedPatient?.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')

    // The conflict is gone.
    expect(result.conflicts).toEqual([])

    // Persisted state matches the returned result.
    expect(
      JSON.parse(localStorage.getItem('toothTargetPatients')!)
    ).toEqual(result.patients)

  })

  it('never reuses a deleted/skipped number: uses the persisted counter, not just max+1', () => {

    // Registry only shows #1 and #12/#12, but the persisted counter
    // already advanced past a since-deleted #20 patient.
    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
    ]

    seedPatients(patients)
    seedNextPatientNumber(21)

    const result = resolvePatientNumberConflictUnderLock(12, 'a')

    if (!result.resolved) {
      throw new Error('expected resolution to succeed')
    }

    const renumberedPatient =
      result.patients.find(patient => patient.id === 'b')

    expect(renumberedPatient?.patientNumber).toBe(21)

  })

  it('toothTargetNextPatientNumber never decreases and reflects the higher of counter/highest+1', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
    ]

    seedPatients(patients)
    seedNextPatientNumber(3) // stale/low counter

    resolvePatientNumberConflictUnderLock(12, 'a')

    const persistedCounter = JSON.parse(
      localStorage.getItem('toothTargetNextPatientNumber')!
    )

    // highest assigned (12) + 1 = 13, one number handed out -> 14
    expect(persistedCounter).toBe(14)
    expect(persistedCounter).toBeGreaterThan(3)

  })

  it('existing higher counter is preserved over highest+1', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
    ]

    seedPatients(patients)
    seedNextPatientNumber(100)

    const result = resolvePatientNumberConflictUnderLock(12, 'a')

    if (!result.resolved) {
      throw new Error('expected resolution to succeed')
    }

    const renumberedPatient =
      result.patients.find(patient => patient.id === 'b')

    expect(renumberedPatient?.patientNumber).toBe(100)

    expect(
      JSON.parse(localStorage.getItem('toothTargetNextPatientNumber')!)
    ).toBe(101)

  })

  it('two independent conflicts stay independent through resolution', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
      makePatient({ id: 'c', patientNumber: 15 }),
      makePatient({ id: 'd', patientNumber: 15 }),
    ]

    seedPatients(patients)
    seedNextPatientNumber(16)
    seedConflicts([
      { patientNumber: 12, patientIds: ['a', 'b'] },
      { patientNumber: 15, patientIds: ['c', 'd'] },
    ])

    const result = resolvePatientNumberConflictUnderLock(12, 'a')

    if (!result.resolved) {
      throw new Error('expected resolution to succeed')
    }

    // #15's patients are completely untouched.
    const patientC = result.patients.find(patient => patient.id === 'c')
    const patientD = result.patients.find(patient => patient.id === 'd')

    expect(patientC?.patientNumber).toBe(15)
    expect(patientD?.patientNumber).toBe(15)

    // The #15 conflict record survives untouched.
    expect(result.conflicts).toEqual([
      { patientNumber: 15, patientIds: ['c', 'd'] },
    ])

  })

  it('is protected against a stale/current registry mismatch (keeper no longer holds the number)', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 13 }), // already renumbered elsewhere
      makePatient({ id: 'b', patientNumber: 12 }),
    ]

    seedPatients(patients)
    seedNextPatientNumber(14)

    const result = resolvePatientNumberConflictUnderLock(12, 'a')

    expect(result.resolved).toBe(false)

    // Nothing was mutated.
    expect(
      JSON.parse(localStorage.getItem('toothTargetPatients')!)
    ).toEqual(patients)

  })

  it('re-resolving an already-resolved conflict is a safe no-op', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
    ]

    seedPatients(patients)
    seedNextPatientNumber(13)
    seedConflicts([{ patientNumber: 12, patientIds: ['a', 'b'] }])

    const first = resolvePatientNumberConflictUnderLock(12, 'a')

    expect(first.resolved).toBe(true)

    const second = resolvePatientNumberConflictUnderLock(12, 'a')

    expect(second.resolved).toBe(false)

    // Patients/conflicts are unchanged by the redundant second call.
    expect(second.patients).toEqual(first.resolved ? first.patients : [])
    expect(second.conflicts).toEqual([])

  })

  it('does not touch unrelated localStorage keys (treatments are preserved)', () => {

    const patients = [
      makePatient({ id: 'a', patientNumber: 12 }),
      makePatient({ id: 'b', patientNumber: 12 }),
    ]

    const treatmentsMarker = JSON.stringify([{ id: 'treatment-1' }])

    seedPatients(patients)
    seedNextPatientNumber(13)
    localStorage.setItem('toothTargetSavedTreatments', treatmentsMarker)
    localStorage.setItem('toothTargetIncompleteTreatments', '[]')

    resolvePatientNumberConflictUnderLock(12, 'a')

    expect(localStorage.getItem('toothTargetSavedTreatments')).toBe(
      treatmentsMarker
    )
    expect(localStorage.getItem('toothTargetIncompleteTreatments')).toBe(
      '[]'
    )

  })

})
