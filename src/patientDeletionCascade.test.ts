import { describe, expect, it } from 'vitest'
import {
  planPatientDeletionCascade,
  ACTIVE_TREATMENT_BLOCKS_DELETION_MESSAGE,
} from './patientDeletionCascade'

type Treatment = {
  id: string
  patientId: string
  patientName: string
}

function makeTreatment(overrides: Partial<Treatment> = {}): Treatment {
  return {
    id: 'treatment-1',
    patientId: 'patient-1',
    patientName: 'Jane Doe',
    ...overrides,
  }
}

const patientToDelete = { id: 'patient-1', name: 'Jane Doe' }

describe('planPatientDeletionCascade - no treatments (no regression)', () => {

  it('is not blocked and returns empty results when the patient has no treatments at all', () => {

    const plan = planPatientDeletionCascade({
      patientToDelete,
      nameToDelete: 'jane doe',
      savedTreatments: [],
      incompleteTreatments: [],
      activeTreatment: null,
    })

    expect(plan.blocked).toBe(false)

    if (!plan.blocked) {
      expect(plan.survivingSavedTreatments).toEqual([])
      expect(plan.removedSavedTreatmentIds).toEqual([])
      expect(plan.survivingIncompleteTreatments).toEqual([])
    }

  })

  it('leaves other patients\' treatments completely untouched', () => {

    const otherTreatment = makeTreatment({
      id: 'treatment-other',
      patientId: 'patient-2',
      patientName: 'John Smith',
    })

    const plan = planPatientDeletionCascade({
      patientToDelete,
      nameToDelete: 'jane doe',
      savedTreatments: [otherTreatment],
      incompleteTreatments: [otherTreatment],
      activeTreatment: null,
    })

    expect(plan.blocked).toBe(false)

    if (!plan.blocked) {
      expect(plan.survivingSavedTreatments).toEqual([otherTreatment])
      expect(plan.removedSavedTreatmentIds).toEqual([])
      expect(plan.survivingIncompleteTreatments).toEqual([otherTreatment])
    }

  })

})

describe('planPatientDeletionCascade - saved treatments', () => {

  it('removes and reports the ids of every saved treatment belonging to the deleted patient', () => {

    const own1 = makeTreatment({ id: 't1' })
    const own2 = makeTreatment({ id: 't2' })
    const other = makeTreatment({ id: 't3', patientId: 'patient-2', patientName: 'Other' })

    const plan = planPatientDeletionCascade({
      patientToDelete,
      nameToDelete: 'jane doe',
      savedTreatments: [own1, other, own2],
      incompleteTreatments: [],
      activeTreatment: null,
    })

    expect(plan.blocked).toBe(false)

    if (!plan.blocked) {
      expect(plan.removedSavedTreatmentIds.sort()).toEqual(['t1', 't2'])
      expect(plan.survivingSavedTreatments).toEqual([other])
    }

  })

  it('falls back to a case-insensitive name match for a treatment with no patientId (legacy data)', () => {

    const legacyOwn = makeTreatment({ id: 't-legacy', patientId: '', patientName: 'Jane Doe' })

    const plan = planPatientDeletionCascade({
      patientToDelete,
      nameToDelete: 'jane doe',
      savedTreatments: [legacyOwn],
      incompleteTreatments: [],
      activeTreatment: null,
    })

    expect(plan.blocked).toBe(false)

    if (!plan.blocked) {
      expect(plan.removedSavedTreatmentIds).toEqual(['t-legacy'])
    }

  })

  it('matches by name alone when the patient was not found in the registry (patientToDelete undefined)', () => {

    const legacyOwn = makeTreatment({ id: 't-legacy', patientId: 'some-other-id', patientName: 'Jane Doe' })

    const plan = planPatientDeletionCascade({
      patientToDelete: undefined,
      nameToDelete: 'jane doe',
      savedTreatments: [legacyOwn],
      incompleteTreatments: [],
      activeTreatment: null,
    })

    expect(plan.blocked).toBe(false)

    if (!plan.blocked) {
      // No patientToDelete means every treatment is matched by name only.
      expect(plan.removedSavedTreatmentIds).toEqual(['t-legacy'])
    }

  })

})

describe('planPatientDeletionCascade - incomplete treatments', () => {

  it('removes incomplete treatments belonging to the deleted patient', () => {

    const ownIncomplete = makeTreatment({ id: 'incomplete-1' })
    const otherIncomplete = makeTreatment({
      id: 'incomplete-2',
      patientId: 'patient-2',
      patientName: 'Other',
    })

    const plan = planPatientDeletionCascade({
      patientToDelete,
      nameToDelete: 'jane doe',
      savedTreatments: [],
      incompleteTreatments: [ownIncomplete, otherIncomplete],
      activeTreatment: null,
    })

    expect(plan.blocked).toBe(false)

    if (!plan.blocked) {
      expect(plan.survivingIncompleteTreatments).toEqual([otherIncomplete])
    }

  })

})

describe('planPatientDeletionCascade - active-treatment guard', () => {

  it('blocks the deletion when the active treatment belongs to this patient', () => {

    const plan = planPatientDeletionCascade({
      patientToDelete,
      nameToDelete: 'jane doe',
      savedTreatments: [makeTreatment({ id: 't1' })],
      incompleteTreatments: [],
      activeTreatment: makeTreatment({ id: 'active-1' }),
    })

    expect(plan).toEqual({
      blocked: true,
      reason: ACTIVE_TREATMENT_BLOCKS_DELETION_MESSAGE,
    })

  })

  it('does not block, and proceeds normally, when the active treatment belongs to a DIFFERENT patient', () => {

    const own = makeTreatment({ id: 't1' })

    const plan = planPatientDeletionCascade({
      patientToDelete,
      nameToDelete: 'jane doe',
      savedTreatments: [own],
      incompleteTreatments: [],
      activeTreatment: makeTreatment({
        id: 'active-1',
        patientId: 'patient-2',
        patientName: 'Other',
      }),
    })

    expect(plan.blocked).toBe(false)

    if (!plan.blocked) {
      expect(plan.removedSavedTreatmentIds).toEqual(['t1'])
    }

  })

  it('does not block when there is no active treatment at all', () => {

    const plan = planPatientDeletionCascade({
      patientToDelete,
      nameToDelete: 'jane doe',
      savedTreatments: [],
      incompleteTreatments: [],
      activeTreatment: null,
    })

    expect(plan.blocked).toBe(false)

  })

})
