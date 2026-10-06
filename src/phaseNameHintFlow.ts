import { evaluatePhaseName, type EvaluatePhaseNameOptions, type PhaseNameHint } from './phaseNameCheck'
import type { PhaseNamePool } from './phaseNamePool'

/*
  WHEN THE PHASE-NAME HINT SHOWS (Phase 9) - pure decisions

  The hint is tied to a moment, not to every keystroke:
    - it appears when the field LOSES FOCUS (the screen then records the
      text as it was at that moment: `shownForText`), or when the dentist
      taps the save button with an undecided hint;
    - it disappears the instant the text changes again (the screen clears
      `shownForText` on every change; even if it did not, the text no
      longer equals it);
    - the session "Save as typed" memory (phaseNameDecisions.ts) is
      already inside evaluatePhaseName(), so a pair kept as typed never
      shows again until the app is closed.
*/

export function hintToShow(
  shownForText: string | null,
  currentText: string,
  pool: PhaseNamePool,
  options?: EvaluatePhaseNameOptions
): PhaseNameHint {

  if (shownForText === null || shownForText !== currentText) {
    return { kind: 'none' }
  }

  return evaluatePhaseName(currentText, pool, options)

}

/*
  What tapping the main save button ("Add Phase") does: with a hint the
  phase is NOT added - the hint is shown instead; with no hint it is
  added exactly as before.
*/

export function decideAddPhase(hint: PhaseNameHint): 'add' | 'show-hint' {
  return hint.kind === 'suggest' ? 'show-hint' : 'add'
}
