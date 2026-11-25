import { describe, expect, it } from 'vitest'
import {
  NO_PATIENT_MESSAGE,
  NO_PROCEDURE_MESSAGE,
  NO_TEMPLATE_MESSAGE,
  NO_TOOTH_MESSAGE,
  startTreatmentBlocker,
  withBuiltinTemplates,
} from './startTreatmentGuard'

const ok = {
  patientName: 'Sam',
  hasProcedure: true,
  toothId: '11',
  hasUsableTemplate: true,
}

describe('startTreatmentBlocker', () => {

  it('allows a fully filled-in start', () => {
    expect(startTreatmentBlocker(ok)).toBeNull()
  })

  it('reports an empty or blank patient name', () => {
    expect(startTreatmentBlocker({ ...ok, patientName: '   ' }))
      .toBe(NO_PATIENT_MESSAGE)
  })

  it('reports a missing procedure', () => {
    expect(startTreatmentBlocker({ ...ok, hasProcedure: false }))
      .toBe(NO_PROCEDURE_MESSAGE)
  })

  it('reports a missing tooth', () => {
    expect(startTreatmentBlocker({ ...ok, toothId: null }))
      .toBe(NO_TOOTH_MESSAGE)
  })

  it('reports a missing template (the empty-templates case)', () => {
    expect(startTreatmentBlocker({ ...ok, hasUsableTemplate: false }))
      .toBe(NO_TEMPLATE_MESSAGE)
    expect(NO_TEMPLATE_MESSAGE).toBe(
      'No procedure template found. Create one in Manage Procedure Templates.'
    )
  })

})

describe('withBuiltinTemplates', () => {

  const builtins = [{ id: 'general' }, { id: 'rct' }]

  it('restores every built-in when the persisted list is empty', () => {
    expect(withBuiltinTemplates([], builtins)).toEqual(builtins)
  })

  it('puts missing built-ins before the custom ones', () => {
    expect(withBuiltinTemplates([{ id: 'mine' }], builtins))
      .toEqual([{ id: 'general' }, { id: 'rct' }, { id: 'mine' }])
  })

  it('leaves a complete list untouched, keeping edits and order', () => {
    const persisted = [{ id: 'rct', edited: true }, { id: 'general' }]
    expect(withBuiltinTemplates(persisted, builtins)).toBe(persisted)
  })

})
