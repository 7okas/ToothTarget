import { afterEach, describe, expect, it } from 'vitest'
import { evaluatePhaseName } from './phaseNameCheck'
import { buildPhaseNamePool } from './phaseNamePool'
import {
  __resetPhaseNameDecisionsForTests,
  rememberPhaseNameKeptAsTyped,
} from './phaseNameDecisions'

afterEach(() => {
  __resetPhaseNameDecisionsForTests()
})

function saved(procedureId: string, names: string[]) {
  return { procedureId, phaseRecords: names.map(name => ({ name, skipped: false })) }
}

/* n saved treatments in a procedure, each containing these phase names. */
function many(n: number, procedureId: string, names: string[]) {
  return Array.from({ length: n }, () => saved(procedureId, names))
}

function pool(
  savedTreatments: ReturnType<typeof saved>[],
  templateNames: string[][] = []
) {
  return buildPhaseNamePool({
    savedTreatments,
    templates: templateNames.map(names => ({ phases: names.map(name => ({ name })) })),
    activeTreatments: [],
  })
}

const rctPool = pool(
  [
    ...many(12, 'rct', ['Access', 'Shaping', 'Obturation']),
    ...many(3, 'rct', ['Working Length']),
  ],
  [['Access', 'Glide Path', 'Irrigation']]
)

describe('evaluatePhaseName - no hint', () => {

  it('blank input', () => {
    expect(evaluatePhaseName('', rctPool)).toEqual({ kind: 'none' })
    expect(evaluatePhaseName('   ', rctPool)).toEqual({ kind: 'none' })
  })

  it('a name that is already known exactly, however it resembles another', () => {
    expect(evaluatePhaseName('Access', rctPool)).toEqual({ kind: 'none' })
    expect(evaluatePhaseName('  Access ', rctPool)).toEqual({ kind: 'none' })
    const withBoth = pool([...many(5, 'rct', ['Access']), ...many(1, 'rct', ['access'])])
    expect(evaluatePhaseName('access', withBoth)).toEqual({ kind: 'none' })
  })

  it('a genuinely new name', () => {
    expect(evaluatePhaseName('Bleaching', rctPool)).toEqual({ kind: 'none' })
  })

  it('synonyms are not caught', () => {
    expect(evaluatePhaseName('Irrigant activation', rctPool)).toEqual({ kind: 'none' })
  })

  it('the guard cases from the plan stay quiet', () => {
    const small = pool([...many(4, 'x', ['Rinses', 'Coat 2', 'Seat'])])
    expect(evaluatePhaseName('Rinse', small)).toEqual({ kind: 'none' })
    expect(evaluatePhaseName('Coat 1', small)).toEqual({ kind: 'none' })
    expect(evaluatePhaseName('Seal', small)).toEqual({ kind: 'none' })
  })

  it('an empty pool never warns', () => {
    expect(evaluatePhaseName('Acesss', [])).toEqual({ kind: 'none' })
  })

})

describe('evaluatePhaseName - suggestions', () => {

  it('the example from the plan: "Acesss" -> "Access", used 12 times', () => {
    expect(evaluatePhaseName('Acesss', rctPool)).toEqual({
      kind: 'suggest',
      typed: 'Acesss',
      suggestion: 'Access',
      tier: 1,
      reason: 'spelling',
      usedTimes: 12,
      inTemplates: 1,
      inActiveTreatments: 0,
    })
  })

  it('"Acces" (a missing double "s") suggests "Access"', () => {
    expect(evaluatePhaseName('Acces', rctPool)).toMatchObject({
      kind: 'suggest',
      suggestion: 'Access',
      tier: 1,
      usedTimes: 12,
    })
  })

  it('a different case is "case-or-spacing"', () => {
    const hint = evaluatePhaseName('access', rctPool)
    expect(hint).toMatchObject({ kind: 'suggest', suggestion: 'Access', tier: 0, reason: 'case-or-spacing' })
  })

  it('"&" and "and" are the same name', () => {
    const p = pool(many(5, 'rct', ['Cleaning & Shaping']))
    expect(evaluatePhaseName('Cleaning and Shaping', p)).toMatchObject({
      kind: 'suggest',
      suggestion: 'Cleaning & Shaping',
      tier: 0,
    })
  })

  it('trims what was typed', () => {
    expect(evaluatePhaseName('  Acesss  ', rctPool)).toMatchObject({ typed: 'Acesss' })
  })

  it('can suggest a template-only name that has never been used (usedTimes 0)', () => {
    const hint = evaluatePhaseName('Glide Pth', rctPool)
    expect(hint).toMatchObject({ kind: 'suggest', suggestion: 'Glide Path', usedTimes: 0, inTemplates: 1 })
  })

  it('suggests the name exactly as already written (never the normalised form)', () => {
    const hint = evaluatePhaseName('working lenght', rctPool)
    expect(hint).toMatchObject({ suggestion: 'Working Length', usedTimes: 3 })
  })

})

describe('evaluatePhaseName - choosing between several candidates', () => {

  it('prefers the lowest tier (case/spacing before typos)', () => {
    const p = pool([
      ...many(2, 'rct', ['Access']),
      ...many(30, 'rct', ['Acces']),
    ])
    // "access" is Tier 0 to "Access" but Tier 1 to "Acces".
    expect(evaluatePhaseName('access', p)).toMatchObject({ suggestion: 'Access', tier: 0 })
  })

  it('then the smallest edit distance', () => {
    const p = pool([
      ...many(5, 'rct', ['Obturation']),
      ...many(50, 'rct', ['Obturating']),
    ])
    // "Obturaton": distance 1 to Obturation, 3 to Obturating (not even close).
    expect(evaluatePhaseName('Obturaton', p)).toMatchObject({ suggestion: 'Obturation' })
  })

  it('when equally close, prefers the name used in the same procedure', () => {
    const p = pool([
      ...many(40, 'filling', ['Preparation']),
      ...many(3, 'rct', ['Preparatiom']),
    ])
    // "Preparatiom" vs "Preparation": same tier/distance as typed "Preparatian"? use a typed name equally near both:
    const typed = 'Preparatioh'
    const inFilling = evaluatePhaseName(typed, p, { currentProcedureId: 'filling' })
    const inRct = evaluatePhaseName(typed, p, { currentProcedureId: 'rct' })
    expect(inFilling).toMatchObject({ suggestion: 'Preparation' })
    expect(inRct).toMatchObject({ suggestion: 'Preparatiom' })
  })

  it('without a procedure, the more used name wins a tie', () => {
    const p = pool([
      ...many(40, 'filling', ['Preparation']),
      ...many(3, 'rct', ['Preparatiom']),
    ])
    expect(evaluatePhaseName('Preparatioh', p)).toMatchObject({ suggestion: 'Preparation' })
  })

  it('a final tie is broken alphabetically, so the answer never changes', () => {
    const p = pool([
      ...many(4, 'rct', ['Preparatiob']),
      ...many(4, 'rct', ['Preparatioa']),
    ])
    expect(evaluatePhaseName('Preparatioh', p)).toMatchObject({ suggestion: 'Preparatioa' })
  })

})

describe('evaluatePhaseName - names typed elsewhere in the same editor', () => {

  it('counts a name from another row, not saved yet, as known', () => {
    const hint = evaluatePhaseName('Bleachng', [], { extraKnownNames: ['Bleaching'] })
    expect(hint).toMatchObject({ kind: 'suggest', suggestion: 'Bleaching', usedTimes: 0 })
  })

  it('an exact match with another row is fine', () => {
    expect(evaluatePhaseName('Bleaching', [], { extraKnownNames: ['Bleaching'] })).toEqual({ kind: 'none' })
  })

  it('ignores blank extra names', () => {
    expect(evaluatePhaseName('Bleaching', [], { extraKnownNames: ['', '  '] })).toEqual({ kind: 'none' })
  })

})

describe('evaluatePhaseName - "Save as typed" memory', () => {

  it('stops warning for a pair the dentist already chose to keep as typed', () => {
    expect(evaluatePhaseName('Acesss', rctPool).kind).toBe('suggest')
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(evaluatePhaseName('Acesss', rctPool)).toEqual({ kind: 'none' })
  })

  it('a kept pair does not silence a different suggestion for the same typed name', () => {
    const p = pool([...many(5, 'rct', ['Preparation', 'Preparatiom'])])
    rememberPhaseNameKeptAsTyped('Preparatioh', 'Preparation')
    expect(evaluatePhaseName('Preparatioh', p)).toMatchObject({ suggestion: 'Preparatiom' })
  })

  it('a different typed name still warns', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(evaluatePhaseName('Acess', rctPool).kind).toBe('suggest')
  })

  it('the memory can be supplied by the caller', () => {
    expect(evaluatePhaseName('Acesss', rctPool, { isKeptAsTyped: () => true })).toEqual({ kind: 'none' })
    expect(evaluatePhaseName('Acesss', rctPool, { isKeptAsTyped: () => false }).kind).toBe('suggest')
  })

})

describe('evaluatePhaseName - does not change its inputs', () => {

  it('leaves the pool and the extra names untouched', () => {
    const extra = ['Bleaching']
    const before = JSON.stringify([rctPool, extra])
    evaluatePhaseName('Acesss', rctPool, { extraKnownNames: extra })
    expect(JSON.stringify([rctPool, extra])).toBe(before)
  })

})
