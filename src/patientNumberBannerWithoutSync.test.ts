import { beforeEach, describe, expect, it } from 'vitest'

import type { Patient } from './App'

/*
  The local patient-number collision banner must keep working with NO
  sync involved. Only patientNumberConflicts.ts is imported here - no
  cloud engine, scheduler, transport or sync outcome module - and
  nothing below produces a sync result. These are the exact calls
  App.tsx makes: detect after an edit/allocation, record, reconcile on
  load and after a delete, and resolve from the conflict browser.
*/

import {
  PATIENT_NUMBER_CONFLICTS_KEY,
  detectPatientNumberConflict,
  readPersistedPatientNumberConflicts,
  recordAndReconcilePatientNumberConflicts,
  reconcileAndPersistPatientNumberConflicts,
  resolvePatientNumberConflict,
} from './patientNumberConflicts'

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

function makePatient(id: string, patientNumber: number): Patient {
  return {
    id,
    patientNumber,
    name: `Patient ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function seed(patients: Patient[], nextNumber: number): void {
  localStorage.setItem('toothTargetPatients', JSON.stringify(patients))
  localStorage.setItem('toothTargetNextPatientNumber', JSON.stringify(nextNumber))
}

describe('patient-number collision banner - works with no sync involved', () => {

  it('detects a collision, records it, and persists it for the banner', () => {

    const patients = [makePatient('a', 5), makePatient('b', 5), makePatient('c', 6)]
    seed(patients, 7)

    const detected = detectPatientNumberConflict(patients, 5)

    expect(detected).toEqual({ patientNumber: 5, patientIds: ['a', 'b'] })
    expect(detectPatientNumberConflict(patients, 6)).toBeNull()

    const recorded = recordAndReconcilePatientNumberConflicts([detected!], patients)

    expect(recorded).toEqual([{ patientNumber: 5, patientIds: ['a', 'b'] }])
    expect(readPersistedPatientNumberConflicts()).toEqual(recorded)

  })

  it('reconcile on load keeps a still-genuine conflict', () => {

    const patients = [makePatient('a', 5), makePatient('b', 5)]
    seed(patients, 6)
    localStorage.setItem(
      PATIENT_NUMBER_CONFLICTS_KEY,
      JSON.stringify([{ patientNumber: 5, patientIds: ['a', 'b'] }])
    )

    expect(reconcileAndPersistPatientNumberConflicts(patients)).toEqual([
      { patientNumber: 5, patientIds: ['a', 'b'] },
    ])

  })

  it('reconcile after deleting one of the two patients clears the banner', () => {

    const patients = [makePatient('a', 5), makePatient('b', 5)]
    seed(patients, 6)
    recordAndReconcilePatientNumberConflicts(
      [{ patientNumber: 5, patientIds: ['a', 'b'] }],
      patients
    )

    const afterDelete = patients.filter(patient => patient.id !== 'b')
    localStorage.setItem('toothTargetPatients', JSON.stringify(afterDelete))

    expect(reconcileAndPersistPatientNumberConflicts(afterDelete)).toEqual([])
    expect(readPersistedPatientNumberConflicts()).toEqual([])

  })

  it('resolving keeps the chosen patient on the number and gives the other a fresh one', async () => {

    const patients = [makePatient('a', 5), makePatient('b', 5), makePatient('c', 6)]
    seed(patients, 7)
    recordAndReconcilePatientNumberConflicts(
      [{ patientNumber: 5, patientIds: ['a', 'b'] }],
      patients
    )

    const result = await resolvePatientNumberConflict(5, 'a')

    expect(result.resolved).toBe(true)
    expect(result.conflicts).toEqual([])
    expect(readPersistedPatientNumberConflicts()).toEqual([])

    const byId = new Map(result.patients.map(patient => [patient.id, patient.patientNumber]))
    expect(byId.get('a')).toBe(5)
    expect(byId.get('c')).toBe(6)
    expect(byId.get('b')).not.toBe(5)
    expect(new Set(byId.values()).size).toBe(3)

  })

})
