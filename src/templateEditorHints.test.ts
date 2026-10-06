import { afterEach, describe, expect, it } from 'vitest'
import {
  CHECK_PHASE_NAMES_MESSAGE,
  NO_REQUESTED_TEXTS,
  buildTemplateEditorPool,
  decideTemplateSave,
  evaluateEditorRows,
  exemptNamesOf,
  forgetHintFor,
  hintsToShow,
  requestHintsFor,
  undecidedRowIndexes,
} from './templateEditorHints'
import { buildPhaseNamePool } from './phaseNamePool'
import {
  __resetPhaseNameDecisionsForTests,
  rememberPhaseNameKeptAsTyped,
} from './phaseNameDecisions'

afterEach(() => {
  __resetPhaseNameDecisionsForTests()
})

function saved(names: string[], n = 1) {
  return Array.from({ length: n }, () => ({
    procedureId: 'rct',
    phaseRecords: names.map(name => ({ name, skipped: false })),
  }))
}

function template(id: string, names: string[]) {
  return { id, phases: names.map(name => ({ name })) }
}

/* Access is established: used by 12 saved treatments. */
const pool = buildPhaseNamePool({
  savedTreatments: saved(['Access', 'Shaping', 'Obturation'], 12),
  templates: [],
  activeTreatments: [],
})

const kinds = (hints: ReturnType<typeof evaluateEditorRows>) => hints.map(hint => hint.kind)

describe('buildTemplateEditorPool - leaves the template being edited out', () => {

  it('does not let a row be flagged against its own template\'s stored spelling', () => {
    const withTemplate = buildTemplateEditorPool({
      savedTreatments: [],
      templates: [template('t1', ['Acesss']), template('t2', ['Shaping'])],
      activeTreatments: [],
      editedTemplateId: 't1',
    })
    expect(withTemplate.map(entry => entry.name)).toEqual(['Shaping'])
  })

  it('keeps saved treatments and the active ones', () => {
    const result = buildTemplateEditorPool({
      savedTreatments: saved(['Access']),
      templates: [],
      activeTreatments: [{ phases: [{ name: 'Rinse' }] }],
      editedTemplateId: 'x',
    })
    expect(result.map(entry => entry.name)).toEqual(['Access', 'Rinse'])
  })

})

describe('exemptNamesOf', () => {

  it('trims, drops blanks and repeats', () => {
    expect(exemptNamesOf([' Access ', 'Access', '', '  ', 'Shaping'])).toEqual(['Access', 'Shaping'])
  })

})

describe('evaluateEditorRows - flagged rows', () => {

  it('flags a near-spelling of a known name, row by row, in order', () => {
    const hints = evaluateEditorRows(['Access', 'Acesss', 'Shaping'], pool, [])
    expect(kinds(hints)).toEqual(['none', 'suggest', 'none'])
    expect(hints[1]).toMatchObject({ kind: 'suggest', suggestion: 'Access', usedTimes: 12 })
  })

  it('a brand-new name and a blank row are not flagged', () => {
    expect(kinds(evaluateEditorRows(['Bleaching', '', '   '], pool, []))).toEqual(['none', 'none', 'none'])
  })

  it('evaluates every row, whether or not it was ever left', () => {
    // No "requested" state is involved at all in this function.
    expect(kinds(evaluateEditorRows(['Acesss', 'Obturaton'], pool, []))).toEqual(['suggest', 'suggest'])
  })

})

describe('evaluateEditorRows - an unchanged template', () => {

  it('names the template already had when the editor opened get no hint, even a misspelled one', () => {
    const original = ['Acesss', 'Shaping', 'Obturation']
    const hints = evaluateEditorRows(original, pool, exemptNamesOf(original))
    expect(kinds(hints)).toEqual(['none', 'none', 'none'])
    expect(decideTemplateSave(hints)).toEqual({ allowed: true })
  })

  it('a new typo added to an existing template is still flagged', () => {
    const original = ['Access', 'Shaping']
    const hints = evaluateEditorRows([...original, 'Obturaton'], pool, exemptNamesOf(original))
    expect(kinds(hints)).toEqual(['none', 'none', 'suggest'])
  })

  it('a duplicated template (which keeps the original names) opens clean', () => {
    const copy = ['Access', 'Acesss']
    expect(decideTemplateSave(evaluateEditorRows(copy, pool, exemptNamesOf(copy)))).toEqual({ allowed: true })
  })

  it('a brand-new template starts with nothing exempt', () => {
    expect(kinds(evaluateEditorRows(['Acesss'], pool, []))).toEqual(['suggest'])
  })

})

describe('evaluateEditorRows - names in the same template', () => {

  const empty = buildPhaseNamePool({ savedTreatments: [], templates: [], activeTreatments: [] })

  it('flags "Acess" in a later row when an earlier row says "Access"', () => {
    const hints = evaluateEditorRows(['Access', 'Shaping', 'Obturation', 'Acess'], empty, [])
    expect(kinds(hints)).toEqual(['none', 'none', 'none', 'suggest'])
    expect(hints[3]).toMatchObject({ suggestion: 'Access', usedTimes: 0 })
  })

  it('the earlier, established row is NOT flagged against the later one', () => {
    const hints = evaluateEditorRows(['Access', 'Acess'], empty, [])
    expect(hints[0].kind).toBe('none')
  })

  it('NOTE: "Acces" (one missing s) is NOT flagged - it differs from "Access" only by a trailing "s", which the agreed plural guard suppresses', () => {
    expect(kinds(evaluateEditorRows(['Access', 'Acces'], empty, []))).toEqual(['none', 'none'])
  })

  it('a row never flags against itself', () => {
    expect(kinds(evaluateEditorRows(['Access'], empty, []))).toEqual(['none'])
  })

  it('two rows with exactly the same name are fine (a repeated step)', () => {
    expect(kinds(evaluateEditorRows(['Irrigation', 'Shaping', 'Irrigation'], empty, []))).toEqual(['none', 'none', 'none'])
  })

  it('rows are compared only with rows above them', () => {
    // "Acess" first, then "Access": the second row is the one flagged.
    const hints = evaluateEditorRows(['Acess', 'Access'], empty, [])
    expect(kinds(hints)).toEqual(['none', 'suggest'])
  })

})

describe('decided rows', () => {

  it('"Save as typed" (remembered for the pair) stops that row blocking Save', () => {
    const names = ['Acesss', 'Obturaton']
    expect(decideTemplateSave(evaluateEditorRows(names, pool, [])).allowed).toBe(false)
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    const gate = decideTemplateSave(evaluateEditorRows(names, pool, []))
    expect(gate).toMatchObject({ allowed: false, rows: [1], firstRow: 1 })
    rememberPhaseNameKeptAsTyped('Obturaton', 'Obturation')
    expect(decideTemplateSave(evaluateEditorRows(names, pool, []))).toEqual({ allowed: true })
  })

  it('"Use suggestion" (the row text replaced by the known name) is no longer flagged', () => {
    expect(kinds(evaluateEditorRows(['Access'], pool, []))).toEqual(['none'])
  })

})

describe('decideTemplateSave - the Save gate', () => {

  it('is allowed when no row is flagged', () => {
    expect(decideTemplateSave(evaluateEditorRows(['Access', 'Shaping'], pool, []))).toEqual({ allowed: true })
    expect(decideTemplateSave([])).toEqual({ allowed: true })
  })

  it('blocks on a flagged row that was never left (typed, then Save tapped directly)', () => {
    // Nothing was ever "requested" - the gate looks at all rows.
    const hints = evaluateEditorRows(['Access', 'Acesss'], pool, [])
    expect(hintsToShow(['Access', 'Acesss'], hints, NO_REQUESTED_TEXTS).every(hint => hint.kind === 'none')).toBe(true)
    expect(decideTemplateSave(hints)).toEqual({
      allowed: false,
      rows: [1],
      firstRow: 1,
      message: 'Check the highlighted phase names',
    })
  })

  it('lists every undecided row and points at the first', () => {
    const gate = decideTemplateSave(evaluateEditorRows(['Acesss', 'Shaping', 'Obturaton'], pool, []))
    expect(gate).toMatchObject({ allowed: false, rows: [0, 2], firstRow: 0 })
  })

  it('the message is the agreed wording', () => {
    expect(CHECK_PHASE_NAMES_MESSAGE).toBe('Check the highlighted phase names')
  })

  it('undecidedRowIndexes lists the flagged positions', () => {
    expect(undecidedRowIndexes(evaluateEditorRows(['Acesss', 'Shaping', 'Obturaton'], pool, []))).toEqual([0, 2])
  })

})

describe('requested hints - shown only once asked for, only for the current text', () => {

  const names = ['Access', 'Acesss']
  const hints = evaluateEditorRows(names, pool, [])

  it('nothing shows until a hint is asked for (field left or Save tapped)', () => {
    expect(kinds(hintsToShow(names, hints, NO_REQUESTED_TEXTS))).toEqual(['none', 'none'])
  })

  it('leaving a field shows that row\'s hint', () => {
    const requested = requestHintsFor(NO_REQUESTED_TEXTS, ['Acesss'])
    expect(kinds(hintsToShow(names, hints, requested))).toEqual(['none', 'suggest'])
  })

  it('a Save tap asks for every flagged row at once', () => {
    const gate = decideTemplateSave(hints)
    const rowsTexts = gate.allowed ? [] : gate.rows.map(row => names[row])
    const requested = requestHintsFor(NO_REQUESTED_TEXTS, rowsTexts)
    expect(kinds(hintsToShow(names, hints, requested))).toEqual(['none', 'suggest'])
  })

  it('the hint disappears when that row\'s text changes', () => {
    const requested = requestHintsFor(NO_REQUESTED_TEXTS, ['Acesss'])
    const afterEdit = forgetHintFor(requested, 'Acesss')
    const editedNames = ['Access', 'Acesss2']
    expect(kinds(hintsToShow(editedNames, evaluateEditorRows(editedNames, pool, []), afterEdit))).toEqual(['none', 'none'])
    expect(afterEdit.has('Acesss')).toBe(false)
  })

  it('returns the same set when nothing changed (nothing re-renders)', () => {
    const requested = requestHintsFor(NO_REQUESTED_TEXTS, ['Acesss'])
    expect(requestHintsFor(requested, ['Acesss'])).toBe(requested)
    expect(forgetHintFor(requested, 'never asked')).toBe(requested)
  })

  it('never changes the set it was given', () => {
    const start = requestHintsFor(NO_REQUESTED_TEXTS, ['a'])
    requestHintsFor(start, ['b'])
    forgetHintFor(start, 'a')
    expect(Array.from(start)).toEqual(['a'])
    expect(NO_REQUESTED_TEXTS.size).toBe(0)
  })

})

describe('adding, deleting and reordering rows - hints stay with their own text', () => {

  const requested = requestHintsFor(NO_REQUESTED_TEXTS, ['Acesss'])

  function shown(names: string[], req = requested) {
    return hintsToShow(names, evaluateEditorRows(names, pool, []), req).map(hint =>
      hint.kind === 'suggest' ? hint.typed : null
    )
  }

  it('moving a row moves its hint with it', () => {
    expect(shown(['Shaping', 'Acesss', 'Obturation'])).toEqual([null, 'Acesss', null])
    expect(shown(['Acesss', 'Shaping', 'Obturation'])).toEqual(['Acesss', null, null])
    expect(shown(['Shaping', 'Obturation', 'Acesss'])).toEqual([null, null, 'Acesss'])
  })

  it('deleting another row does not move the hint onto a different row', () => {
    expect(shown(['Shaping', 'Acesss', 'Obturation'])).toEqual([null, 'Acesss', null])
    expect(shown(['Shaping', 'Acesss'])).toEqual([null, 'Acesss'])
    expect(shown(['Acesss', 'Obturation'])).toEqual(['Acesss', null])
  })

  it('deleting the flagged row forgets its text, so the same typo typed later does not show before it is asked for', () => {
    const afterDelete = forgetHintFor(requested, 'Acesss')
    expect(shown(['Shaping'], afterDelete)).toEqual([null])
    expect(shown(['Shaping', 'Acesss'], afterDelete)).toEqual([null, null])
  })

  it('a newly added blank row never has a hint and does not disturb the others', () => {
    expect(shown(['Shaping', 'Acesss', ''])).toEqual([null, 'Acesss', null])
  })

  it('a Save-as-typed decision follows the name wherever its row is', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(kinds(evaluateEditorRows(['Shaping', 'Acesss'], pool, []))).toEqual(['none', 'none'])
    expect(kinds(evaluateEditorRows(['Acesss', 'Shaping'], pool, []))).toEqual(['none', 'none'])
  })

  it('moving rows can change which of two near-identical rows is flagged (the later one is), and never attaches to the wrong text', () => {
    const empty = buildPhaseNamePool({ savedTreatments: [], templates: [], activeTreatments: [] })
    const before = evaluateEditorRows(['Access', 'Acess'], empty, [])
    const after = evaluateEditorRows(['Acess', 'Access'], empty, [])
    expect(before[1]).toMatchObject({ kind: 'suggest', typed: 'Acess', suggestion: 'Access' })
    expect(after[1]).toMatchObject({ kind: 'suggest', typed: 'Access', suggestion: 'Acess' })
  })

})
