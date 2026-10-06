import { evaluatePhaseName, type PhaseNameHint } from './phaseNameCheck'
import {
  buildPhaseNamePool,
  type PhaseNamePool,
  type PoolActiveTreatment,
  type PoolSavedTreatment,
  type PoolTemplate,
} from './phaseNamePool'

/*
  PHASE-NAME HINTS IN THE TEMPLATE EDITOR (Phase 9) - pure helpers

  Everything the template editor needs to decide about its phase rows,
  kept out of App.tsx: which rows are flagged, which hints are visible,
  and whether Save is allowed. The matching itself is phaseNameCheck.ts /
  phaseNameMatching.ts; this file only applies it to a list of rows.

  HOW ROWS STAY CORRECT WHEN ROWS ARE ADDED, DELETED OR MOVED
  ============================================================
  Nothing here is stored "on a row". A row's hint is always recomputed
  from that row's TEXT (plus the other rows' text), and the two things
  that are remembered are keyed by text, not by position:
    - "Save as typed" is remembered as a typed-name / suggestion PAIR in
      the session memory (phaseNameDecisions.ts), so it follows the name
      wherever the row ends up;
    - "a hint was asked for on this text" (the field was left, or Save
      was tapped) is a set of texts (RequestedTexts).
  So reordering rows moves the hints with their text, deleting a row
  forgets that row's text (see forgetHintFor), and adding a row adds an
  empty text that never has a hint. A hint can therefore never end up on
  a different row's text.

  WHICH NAMES A ROW IS COMPARED WITH
  ============================================================
    - the shared pool (saved treatments + templates + active/incomplete
      treatments), but WITHOUT the template being edited - its stored
      names would otherwise let a row be flagged against its own
      original spelling;
    - the names of the rows ABOVE it in this template (so "Acces" in
      row 4 is flagged when row 1 says "Access", while row 1 is not
      flagged against row 4; a row is never compared with itself or with
      rows below it);
    - exempt names: whatever the template already contained when the
      editor opened (editing an existing template, or a duplicate, which
      keeps the original's names) are exact known names and get NO hint,
      so opening and re-saving an unchanged template never warns or blocks.
*/

export const CHECK_PHASE_NAMES_MESSAGE = 'Check the highlighted phase names'

export function buildTemplateEditorPool(sources: {
  savedTreatments: readonly PoolSavedTreatment[]
  templates: readonly (PoolTemplate & { id: string })[]
  activeTreatments: readonly PoolActiveTreatment[]
  /* The template being edited: left out of the pool. */
  editedTemplateId: string
}): PhaseNamePool {

  return buildPhaseNamePool({
    savedTreatments: sources.savedTreatments,
    templates: sources.templates.filter(
      template => template.id !== sources.editedTemplateId
    ),
    activeTreatments: sources.activeTreatments,
  })

}

/* The names a template holds right now, trimmed and without blanks or repeats. */
export function exemptNamesOf(names: readonly string[]): string[] {

  return Array.from(
    new Set(names.map(name => name.trim()).filter(name => name !== ''))
  )

}

/*
  One hint per row (same order as `names`), computed for EVERY row
  whether or not it was ever left - the Save gate relies on that.
*/
export function evaluateEditorRows(
  names: readonly string[],
  pool: PhaseNamePool,
  exemptNames: readonly string[]
): PhaseNameHint[] {

  const exempt = new Set(exemptNames.map(name => name.trim()))

  return names.map((raw, index) => {

    const text = raw.trim()

    if (text === '' || exempt.has(text)) {
      return { kind: 'none' }
    }

    return evaluatePhaseName(text, pool, {
      extraKnownNames: names.slice(0, index),
    })

  })

}

export function undecidedRowIndexes(hints: readonly PhaseNameHint[]): number[] {

  const rows: number[] = []

  hints.forEach((hint, index) => {
    if (hint.kind === 'suggest') {
      rows.push(index)
    }
  })

  return rows

}

/*
  THE SAVE GATE: Save is allowed when no row still has an undecided
  hint. Rows with no hint, rows already decided ("Save as typed" is
  remembered, "Use suggestion" replaced the text) and blank rows never
  block. When blocked it says which rows, and which one to scroll to.
*/

export type TemplateSaveGate =
  | { allowed: true }
  | { allowed: false; rows: number[]; firstRow: number; message: string }

export function decideTemplateSave(
  hints: readonly PhaseNameHint[]
): TemplateSaveGate {

  const rows = undecidedRowIndexes(hints)

  if (rows.length === 0) {
    return { allowed: true }
  }

  return {
    allowed: false,
    rows,
    firstRow: rows[0],
    message: CHECK_PHASE_NAMES_MESSAGE,
  }

}

/* ---------------------------------------------------------------- */
/* "A hint was asked for on this text"                               */
/* ---------------------------------------------------------------- */

export type RequestedTexts = ReadonlySet<string>

export const NO_REQUESTED_TEXTS: RequestedTexts = new Set<string>()

/* The field was left, or Save was tapped: the hint for these texts may now show. */
export function requestHintsFor(
  requested: RequestedTexts,
  texts: readonly string[]
): RequestedTexts {

  if (texts.every(text => requested.has(text))) {
    return requested
  }

  const next = new Set(requested)

  texts.forEach(text => next.add(text))

  return next

}

/* The row's text changed (this is its old text) or the row was deleted. */
export function forgetHintFor(
  requested: RequestedTexts,
  text: string
): RequestedTexts {

  if (!requested.has(text)) {
    return requested
  }

  const next = new Set(requested)

  next.delete(text)

  return next

}

/* The hints to actually draw: a row's hint shows only once one was asked for on its current text. */
export function hintsToShow(
  names: readonly string[],
  hints: readonly PhaseNameHint[],
  requested: RequestedTexts
): PhaseNameHint[] {

  return hints.map((hint, index) =>
    requested.has(names[index]) ? hint : { kind: 'none' }
  )

}
