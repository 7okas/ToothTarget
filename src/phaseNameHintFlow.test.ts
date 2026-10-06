import { afterEach, describe, expect, it } from 'vitest'
import { decideAddPhase, hintToShow } from './phaseNameHintFlow'
import { evaluatePhaseName } from './phaseNameCheck'
import { buildPhaseNamePool } from './phaseNamePool'
import {
  __resetPhaseNameDecisionsForTests,
  rememberPhaseNameKeptAsTyped,
} from './phaseNameDecisions'

afterEach(() => {
  __resetPhaseNameDecisionsForTests()
})

const pool = buildPhaseNamePool({
  savedTreatments: Array.from({ length: 12 }, () => ({
    procedureId: 'rct',
    phaseRecords: [{ name: 'Access', skipped: false }],
  })),
  templates: [],
  activeTreatments: [],
})

describe('hintToShow - the hint only exists at the moment it was asked for', () => {

  it('shows once the field has lost focus on a near-spelling', () => {
    expect(hintToShow('Acesss', 'Acesss', pool)).toMatchObject({
      kind: 'suggest',
      suggestion: 'Access',
    })
  })

  it('shows nothing while still typing (nothing has been asked for yet)', () => {
    expect(hintToShow(null, 'Acesss', pool)).toEqual({ kind: 'none' })
  })

  it('disappears as soon as the text changes again', () => {
    expect(hintToShow('Acesss', 'Acessss', pool)).toEqual({ kind: 'none' })
    expect(hintToShow('Acesss', 'Acesss ', pool)).toEqual({ kind: 'none' })
    expect(hintToShow('Acesss', '', pool)).toEqual({ kind: 'none' })
  })

  it('shows nothing for a name that is fine', () => {
    expect(hintToShow('Access', 'Access', pool)).toEqual({ kind: 'none' })
    expect(hintToShow('Bleaching', 'Bleaching', pool)).toEqual({ kind: 'none' })
  })

  it('never shows again for a pair already kept as typed this session', () => {
    expect(hintToShow('Acesss', 'Acesss', pool).kind).toBe('suggest')
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(hintToShow('Acesss', 'Acesss', pool)).toEqual({ kind: 'none' })
  })

  it('passes the procedure through to the tie-breaking', () => {
    const hint = hintToShow('Acesss', 'Acesss', pool, { currentProcedureId: 'rct' })
    expect(hint).toMatchObject({ kind: 'suggest', suggestion: 'Access' })
  })

})

describe('decideAddPhase - what tapping "Add Phase" does', () => {

  it('does not add when there is an undecided hint: it shows the hint', () => {
    expect(decideAddPhase(evaluatePhaseName('Acesss', pool))).toBe('show-hint')
  })

  it('adds exactly as before when there is no hint', () => {
    expect(decideAddPhase(evaluatePhaseName('Access', pool))).toBe('add')
    expect(decideAddPhase(evaluatePhaseName('Bleaching', pool))).toBe('add')
    expect(decideAddPhase(evaluatePhaseName('', pool))).toBe('add')
  })

  it('adds once the pair has been kept as typed', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(decideAddPhase(evaluatePhaseName('Acesss', pool))).toBe('add')
  })

  it('adds after "Use suggestion" has filled in the known name', () => {
    expect(decideAddPhase(evaluatePhaseName('Access', pool))).toBe('add')
  })

})
