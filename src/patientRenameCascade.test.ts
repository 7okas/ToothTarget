import { describe, expect, it } from 'vitest'
import { applyPatientRenameToSavedTreatments } from './patientRenameCascade'

type Treatment = {
  id: string
  patientId: string
  patientName: string
  updatedAt: string
}

function makeTreatment(overrides: Partial<Treatment> = {}): Treatment {
  return {
    id: 'treatment-1',
    patientId: 'patient-1',
    patientName: 'Jane Doe',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('applyPatientRenameToSavedTreatments', () => {

  it('updates patientName and bumps updatedAt for every treatment belonging to the renamed patient', () => {

    const own1 = makeTreatment({ id: 't1' })
    const own2 = makeTreatment({ id: 't2' })

    const result = applyPatientRenameToSavedTreatments(
      [own1, own2],
      'patient-1',
      'Jane Smith',
      '2026-02-01T00:00:00.000Z'
    )

    expect(result).toEqual([
      { ...own1, patientName: 'Jane Smith', updatedAt: '2026-02-01T00:00:00.000Z' },
      { ...own2, patientName: 'Jane Smith', updatedAt: '2026-02-01T00:00:00.000Z' },
    ])

  })

  it('leaves treatments belonging to OTHER patients completely untouched', () => {

    const own = makeTreatment({ id: 't1' })
    const other = makeTreatment({
      id: 't2',
      patientId: 'patient-2',
      patientName: 'John Smith',
      updatedAt: '2025-06-01T00:00:00.000Z',
    })

    const result = applyPatientRenameToSavedTreatments(
      [own, other],
      'patient-1',
      'Jane Renamed',
      '2026-02-01T00:00:00.000Z'
    )

    expect(result[1]).toEqual(other)
    expect(result[0].patientName).toBe('Jane Renamed')

  })

  it('handles a patient with no saved treatments without error', () => {

    const result = applyPatientRenameToSavedTreatments(
      [],
      'patient-1',
      'Jane Renamed',
      '2026-02-01T00:00:00.000Z'
    )

    expect(result).toEqual([])

  })

  it('does not mutate the input array or its treatment objects', () => {

    const own = makeTreatment({ id: 't1' })
    const original = { ...own }

    applyPatientRenameToSavedTreatments(
      [own],
      'patient-1',
      'Jane Renamed',
      '2026-02-01T00:00:00.000Z'
    )

    expect(own).toEqual(original)

  })

})
