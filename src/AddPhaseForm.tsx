import { useState } from 'react'
import PhaseNameHint from './PhaseNameHint'
import { evaluatePhaseName } from './phaseNameCheck'
import { rememberPhaseNameKeptAsTyped } from './phaseNameDecisions'
import { decideAddPhase, hintToShow } from './phaseNameHintFlow'
import {
  buildPhaseNamePool,
  type PoolActiveTreatment,
  type PoolSavedTreatment,
  type PoolTemplate,
} from './phaseNamePool'

/*
  ADD PHASE (inside a running treatment) - Phase 9

  The "Add Phase" view of the treatment options menu: a phase name, its
  minutes, and the Add Phase / Back buttons, plus the phase-name hint.

  This component owns nothing about the treatment itself. It never reads
  or changes the active treatment, the timer, the current phase or any
  saved data: it only shows fields and, when the dentist confirms, calls
  `onAdd(name, minutes)` - the very same call the button made before,
  which is where the phase is actually inserted. So the timer keeps
  running throughout and nothing about timing can be affected here.

  HINT BEHAVIOUR (all decisions come from the tested phaseName* modules):
    - the hint appears when the name field loses focus, and vanishes as
      soon as the text changes again;
    - tapping "Add Phase" while a hint applies does NOT add the phase: it
      shows the hint;
    - "Use <suggestion>" fills the box (the dentist then taps Add Phase);
    - "Save as typed" adds the phase right away with the name as typed and
      remembers the pair for this session, so it is not asked again;
    - with no hint (an exact known name, no close match, a blank name)
      everything is exactly as it was before.
  The existing rule stays: Add Phase is disabled while the name is blank
  or the minutes are not above zero.
*/

type AddPhaseFormProps = {
  /* What the phase-name pool is built from (the app's current data). */
  savedTreatments: readonly PoolSavedTreatment[]
  templates: readonly PoolTemplate[]
  /* The running treatment and any incomplete ones. */
  activeTreatments: readonly PoolActiveTreatment[]
  /* Only used to break ties between equally close suggestions. */
  currentProcedureId?: string
  name: string
  onNameChange: (name: string) => void
  minutes: string
  onMinutesChange: (minutes: string) => void
  onAdd: (name: string, minutes: number) => void
  onBack: () => void
}

function AddPhaseForm({
  savedTreatments,
  templates,
  activeTreatments,
  currentProcedureId,
  name,
  onNameChange,
  minutes,
  onMinutesChange,
  onAdd,
  onBack,
}: AddPhaseFormProps) {

  /* The text as it was when the hint was asked for (field left, or Add tapped); null = not asked. */
  const [hintShownFor, setHintShownFor] = useState<string | null>(null)

  /*
    Rebuilt on every render on purpose: the treatment timer re-renders the
    screen every second and the running treatment's own phases are part of
    the pool, so a memo would be rebuilt just as often. It is a few
    thousand string comparisons at most.
  */
  const pool = buildPhaseNamePool({ savedTreatments, templates, activeTreatments })

  const options = { currentProcedureId }

  const hint = hintToShow(hintShownFor, name, pool, options)

  const minutesAreValid = Number(minutes) > 0

  function handleAdd() {

    if (decideAddPhase(evaluatePhaseName(name, pool, options)) === 'show-hint') {
      setHintShownFor(name)
      return
    }

    onAdd(name, Number(minutes))

  }

  return (

    <>

      <h2>
        Add Phase
      </h2>

      <p>
        This phase is added to this treatment only - the
        procedure template is not changed.
      </p>

      <input
        type="text"
        className="template-name-input"
        placeholder="Phase name..."
        value={name}
        onChange={event => {
          onNameChange(event.target.value)
          setHintShownFor(null)
        }}
        onBlur={() => setHintShownFor(name)}
        autoFocus
      />

      <PhaseNameHint
        hint={hint}
        keepDisabled={!minutesAreValid}
        onUseSuggestion={() => {
          if (hint.kind === 'suggest') {
            onNameChange(hint.suggestion)
          }
          setHintShownFor(null)
        }}
        onKeepAsTyped={() => {
          if (hint.kind === 'suggest') {
            rememberPhaseNameKeptAsTyped(hint.typed, hint.suggestion)
            onAdd(name, Number(minutes))
          }
        }}
      />

      <div className="add-phase-duration-row">

        <label>
          Duration (minutes)
        </label>

        <input
          type="number"
          min={1}
          value={minutes}
          onChange={event => onMinutesChange(event.target.value)}
        />

      </div>

      <div className="modal-actions modal-actions-stacked">

        <button
          type="button"
          onClick={handleAdd}
          disabled={!name.trim() || !minutesAreValid}
        >
          Add Phase
        </button>

        <button
          type="button"
          className="modal-cancel-button"
          onClick={onBack}
        >
          Back
        </button>

      </div>

    </>

  )

}

export default AddPhaseForm
