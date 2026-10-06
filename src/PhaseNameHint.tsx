import type { PhaseNameHint as PhaseNameHintResult } from './phaseNameCheck'
import {
  KEEP_AS_TYPED_LABEL,
  hintQuestion,
  usageNote,
  suggestionButtonLabel,
} from './phaseNameHintWording'

/*
  PHASE-NAME HINT (Phase 9) - rendering only

  Shown under a phase-name field when the name looks like a near-spelling
  of one already in use. All decisions (whether to show it, which name to
  suggest, how often it is used, the wording) come from phaseNameCheck.ts,
  phaseNameHintFlow.ts and phaseNameHintWording.ts; this file only draws
  the answer and reports which button was tapped. Renders nothing when
  there is no hint.

  16px text and 44px buttons, so it works by touch on an iPad.
*/

type PhaseNameHintProps = {
  hint: PhaseNameHintResult
  onUseSuggestion: () => void
  onKeepAsTyped: () => void
  /* Disables "Save as typed" when the screen cannot save right now (eg. invalid minutes). */
  keepDisabled?: boolean
}

function PhaseNameHint({
  hint,
  onUseSuggestion,
  onKeepAsTyped,
  keepDisabled = false,
}: PhaseNameHintProps) {

  if (hint.kind !== 'suggest') {
    return null
  }

  return (

    <div className="phase-name-hint" role="status">

      <p className="phase-name-hint-text">
        {hintQuestion(hint)}{' '}
        <span className="phase-name-hint-usage">{usageNote(hint)}</span>
      </p>

      <div className="phase-name-hint-actions">

        <button
          type="button"
          className="phase-name-hint-button"
          onClick={onUseSuggestion}
        >
          {suggestionButtonLabel(hint)}
        </button>

        <button
          type="button"
          className="phase-name-hint-button phase-name-hint-secondary"
          onClick={onKeepAsTyped}
          disabled={keepDisabled}
        >
          {KEEP_AS_TYPED_LABEL}
        </button>

      </div>

    </div>

  )

}

export default PhaseNameHint
