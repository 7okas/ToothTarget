import { useEffect, useSyncExternalStore } from 'react'
import {
  getResolutionScreenOpen,
  subscribeResolutionScreen,
} from './syncResolutionStore'
import {
  applyNow,
  backToDeciding,
  chooseNumberKeeper,
  closeFinished,
  decideLater,
  getControllerState,
  goToSummary,
  keepCreatedSinceLastSync,
  keepPatientForTreatments,
  leaveOutTreatments,
  markInSyncNow,
  openController,
  setAcknowledged,
  setChoice,
  setManualPatientNumber,
  subscribeController,
  chooseAllFromCloud,
  chooseAllFromDevice,
} from './syncResolutionController'
import {
  CREATED_SINCE_BUTTON_LABEL,
  type OutcomeMessage,
  type RowViewModel,
  type SectionViewModel,
} from './syncResolutionViewModel'

/*
  RESOLUTION SCREEN (Phase 6, steps 7-8)

  A full-viewport screen, mounted beside <App/> in main.tsx (same
  position and reasoning as StartupGateScreen.tsx / SyncStatusIndicator.tsx:
  it has to sit above App.tsx's whole screen-switching chain without
  touching it). It is a thin rendering of syncResolutionController.ts -
  every rule (nothing is written until Apply, what each button does,
  when Review summary unlocks) lives there and is unit-tested; this file
  only draws the controller's state and forwards button presses.

  Layout, for iPad and phone width:
    - a sticky header (title, plain explanation, "Decide later")
    - a scrolling body - long lists scroll INSIDE the screen, never the
      page, and nothing ever scrolls sideways
    - a sticky footer with the decided-count and "Review summary", so
      progress and the next step are always visible
  Every tap target is at least 44px tall; the two sides of a "both,
  but different" row sit side by side on wide screens and stack on a
  phone.
*/

function formatLastSync(iso: string | null): string {

  if (!iso) {
    return 'an unknown time'
  }

  const ms = Date.parse(iso)

  if (Number.isNaN(ms)) {
    return 'an unknown time'
  }

  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

}

function Banner({ message }: { message: OutcomeMessage }) {

  return (
    <div className={`res-banner res-banner-${message.tone}`} role="status">
      <strong>{message.title}</strong>
      <span>{message.message}</span>
    </div>
  )

}

function ChoiceButtons({ row }: { row: RowViewModel }) {

  return (
    <div className="res-choices" role="group" aria-label="Your choice">
      {row.options.map(option => (
        <button
          key={option.choice}
          type="button"
          className={
            'res-choice-button' +
            (row.choice === option.choice ? ' res-choice-selected' : '')
          }
          aria-pressed={row.choice === option.choice}
          onClick={() => setChoice(row.key, option.choice)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )

}

function Row({ row, changed }: { row: RowViewModel; changed: boolean }) {

  return (
    <div
      className={
        'res-row' +
        (row.undecided ? ' res-row-undecided' : '') +
        (changed ? ' res-row-changed' : '')
      }
    >

      {changed && (
        <p className="res-changed-note">
          Changed while you were deciding - please choose again.
        </p>
      )}

      {row.kind === 'different' ? (

        <div className="res-compare">
          <div className="res-side">
            <span className="res-side-title">This device</span>
            <span>{row.deviceSummary}</span>
          </div>
          <div className="res-side">
            <span className="res-side-title">OneDrive</span>
            <span>{row.cloudSummary}</span>
          </div>
        </div>

      ) : (

        <p className="res-summary">{row.summary}</p>

      )}

      {row.changes && (
        <p className="res-changes">
          Changed: {row.changes.join('; ')}
        </p>
      )}

      {row.hint && (
        <p className={'res-hint' + (row.warn ? ' res-hint-warn' : '')}>
          {row.warn ? '⚠ ' : ''}{row.hint}
        </p>
      )}

      <ChoiceButtons row={row} />

    </div>
  )

}

function Section({
  section,
  changedKeys,
}: {
  section: SectionViewModel
  changedKeys: string[]
}) {

  const groups = [
    section.groups.deviceOnly,
    section.groups.cloudOnly,
    section.groups.different,
  ]

  return (
    <section className="res-section">

      <h3 className="res-section-title">
        {section.label}
        <span className="res-section-count">
          {section.decided} of {section.total} decided
        </span>
      </h3>

      {section.createdSinceUndecided > 0 && (
        <button
          type="button"
          className="res-bulk-button"
          onClick={() => keepCreatedSinceLastSync(section.entity)}
        >
          {CREATED_SINCE_BUTTON_LABEL}
        </button>
      )}

      {groups.map(group =>
        group.rows.length === 0 ? null : (
          <div key={group.title} className="res-group">

            <h4 className="res-group-title">
              {group.title} ({group.rows.length})
            </h4>

            <div className="res-list">
              {group.rows.map((row, index) => {

                const previous = group.rows[index - 1]

                return (
                  <div key={row.key} className="res-row-wrap">
                    {row.groupLabel &&
                      row.groupLabel !== previous?.groupLabel && (
                        <p className="res-patient-heading">
                          Patient: {row.groupLabel}
                        </p>
                      )}
                    <Row row={row} changed={changedKeys.includes(row.key)} />
                  </div>
                )

              })}
            </div>

          </div>
        )
      )}

    </section>
  )

}

function Deciding() {

  const state = useSyncExternalStore(subscribeController, getControllerState, getControllerState)

  if (!state.view || !state.session || !state.base || !state.final) {
    return null
  }

  const needsPatientProblems = state.final.problems.filter(
    problem => problem.kind === 'treatment-needs-patient'
  )

  const stillTaken = state.final.problems.some(
    problem => problem.kind === 'number-collision'
  )

  const patientsById = new Map(
    state.final.candidatePatients.map(patient => [patient.id, patient])
  )

  const nameOf = (patientId: string): string => {

    const fromCandidates = patientsById.get(patientId)?.name

    if (fromCandidates) {
      return fromCandidates
    }

    const record = [...state.session!.device.patients, ...state.session!.cloud.patients].find(
      patient => patient.id === patientId
    )

    return record?.name ?? 'this patient'

  }

  const unlockReason = !state.view.allDecided
    ? 'Decide every row to continue.'
    : !state.final.canApply
      ? 'Fix the items marked in red to continue.'
      : null

  return (
    <>

      <div className="res-body">

        {state.message && <Banner message={state.message} />}

        <div className="res-shortcuts">
          <button type="button" onClick={chooseAllFromDevice}>
            Use everything from this device
          </button>
          <button type="button" onClick={chooseAllFromCloud}>
            Use everything from OneDrive
          </button>
        </div>

        <p className="res-help">
          These buttons only fill in the choices below. Nothing changes
          until you review the summary and press Apply.
        </p>

        {needsPatientProblems.map(problem =>
          problem.kind === 'treatment-needs-patient' ? (
            <div key={problem.patientId} className="res-problem" role="alert">
              <p>
                {problem.treatmentIds.length === 1
                  ? '1 treatment is kept'
                  : `${problem.treatmentIds.length} treatments are kept`}
                , but you left out their patient, {nameOf(problem.patientId)}.
                A treatment can't exist without its patient.
              </p>
              <div className="res-problem-actions">
                {problem.patientExistsOn.length > 0 && (
                  <button
                    type="button"
                    onClick={() => keepPatientForTreatments(problem.patientId)}
                  >
                    Keep the patient
                  </button>
                )}
                <button
                  type="button"
                  className="res-secondary"
                  onClick={() => leaveOutTreatments(problem.treatmentIds)}
                >
                  Leave the treatments out too
                </button>
              </div>
            </div>
          ) : null
        )}

        {state.base.collisions.map(collision => {

          const keeperId =
            state.keepers[collision.patientNumber] ?? collision.patients[0].id

          return (
            <div key={collision.patientNumber} className="res-problem" role="alert">

              <p>
                Two different patients both have the number{' '}
                <strong>#{collision.patientNumber}</strong>. Choose who keeps
                it - the other gets a new number.
              </p>

              <ul className="res-collision-list">
                {collision.patients.map(patient => {

                  const isKeeper = patient.id === keeperId

                  return (
                    <li key={patient.id} className="res-collision-patient">

                      <span>
                        {patient.name} ({patient.treatmentCount}{' '}
                        {patient.treatmentCount === 1 ? 'treatment' : 'treatments'})
                      </span>

                      {isKeeper ? (

                        <span className="res-keeps">
                          Keeps #{collision.patientNumber}
                        </span>

                      ) : (

                        <label className="res-number-field">
                          New number
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            value={state.numberFixes[patient.id] ?? ''}
                            onChange={event => {
                              const value = Number(event.target.value)
                              if (Number.isInteger(value) && value > 0) {
                                setManualPatientNumber(patient.id, value)
                              }
                            }}
                          />
                        </label>

                      )}

                      {!isKeeper && (
                        <button
                          type="button"
                          className="res-secondary"
                          onClick={() =>
                            chooseNumberKeeper(collision.patientNumber, patient.id)
                          }
                        >
                          Let this patient keep #{collision.patientNumber}
                        </button>
                      )}

                    </li>
                  )

                })}
              </ul>

              {stillTaken && (
                <p className="res-hint-warn">
                  A number you typed is still used by another patient.
                </p>
              )}

            </div>
          )

        })}

        {state.view.sections.map(section => (
          <Section
            key={section.entity}
            section={section}
            changedKeys={state.changedKeys}
          />
        ))}

      </div>

      <footer className="res-footer">

        <span className="res-progress">{state.view.progressLabel}</span>

        {unlockReason && (
          <span className="res-unlock-reason">{unlockReason}</span>
        )}

        <button
          type="button"
          disabled={!state.canReviewSummary}
          onClick={goToSummary}
        >
          Review summary →
        </button>

      </footer>

    </>
  )

}

function Summary() {

  const state = useSyncExternalStore(subscribeController, getControllerState, getControllerState)

  const summary = state.summary

  if (!summary) {
    return null
  }

  const mustTick = summary.requiresAcknowledgement && !state.acknowledged

  return (
    <>

      <div className="res-body">

        <h3 className="res-summary-title">Here is exactly what will happen</h3>

        {state.message && <Banner message={state.message} />}

        <ul className="res-summary-lines">
          {summary.lines.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {summary.autoIncluded.length > 0 && (
          <div className="res-note">
            <strong>Also included automatically:</strong>
            <ul>
              {summary.autoIncluded.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        {summary.renumbered.length > 0 && (
          <div className="res-note">
            <strong>Patient numbers that change:</strong>
            <ul>
              {summary.renumbered.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        {summary.resurrectedWarning && (
          <div className="res-banner res-banner-warning">
            <strong>⚠ {summary.resurrectedWarning}</strong>
            <ul>
              {summary.resurrectedNames.map(name => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <label className="res-ack">
              <input
                type="checkbox"
                checked={state.acknowledged}
                onChange={event => setAcknowledged(event.target.checked)}
              />
              <span>I understand these deleted records will come back.</span>
            </label>
          </div>
        )}

        {summary.maybeResurrectedNote && (
          <p className="res-help">{summary.maybeResurrectedNote}</p>
        )}

        <p className="res-help">{summary.safetyNote}</p>

      </div>

      <footer className="res-footer">

        <button type="button" className="res-secondary" onClick={backToDeciding}>
          ← Back
        </button>

        <button type="button" disabled={mustTick} onClick={() => void applyNow()}>
          Apply and sync
        </button>

      </footer>

    </>
  )

}

function CenteredCard({
  message,
  children,
}: {
  message: OutcomeMessage | null
  children: React.ReactNode
}) {

  return (
    <div className="res-body res-centered">
      {message && <Banner message={message} />}
      <div className="res-center-actions">{children}</div>
    </div>
  )

}

export default function SyncResolutionScreen() {

  const open = useSyncExternalStore(subscribeResolutionScreen, getResolutionScreenOpen, getResolutionScreenOpen)

  const state = useSyncExternalStore(subscribeController, getControllerState, getControllerState)

  useEffect(() => {

    if (open) {
      void openController()
    }

  }, [open])

  if (!open) {
    return null
  }

  const subtitle = state.session
    ? `You last synced with OneDrive on ${formatLastSync(state.session.lastSyncAt)}. ` +
      'Since then, both this device and OneDrive changed. Nothing has been changed yet.'
    : 'Comparing this device with OneDrive…'

  return (
    <div className="res-screen" role="dialog" aria-modal="true" aria-label="Resolve differences with OneDrive">

      <header className="res-header">

        <div className="res-header-text">
          <h2>Resolve differences with OneDrive</h2>
          <p>{subtitle}</p>
        </div>

        <button
          type="button"
          className="res-secondary"
          disabled={state.phase === 'applying'}
          onClick={decideLater}
        >
          Decide later
        </button>

      </header>

      {state.phase === 'loading' && (
        <div className="res-body res-centered">
          <span className="startup-gate-icon startup-gate-icon-spinner" role="img" aria-hidden="true" />
          <p>Comparing your data…</p>
        </div>
      )}

      {state.phase === 'applying' && (
        <div className="res-body res-centered">
          <span className="startup-gate-icon startup-gate-icon-spinner" role="img" aria-hidden="true" />
          <p>Saving safety copies and syncing - please keep this open…</p>
        </div>
      )}

      {state.phase === 'message' && (
        <CenteredCard message={state.message}>
          {state.message?.retryable && (
            <button type="button" onClick={() => void openController()}>
              Try again
            </button>
          )}
          <button type="button" className="res-secondary" onClick={closeFinished}>
            Close
          </button>
        </CenteredCard>
      )}

      {state.phase === 'identical' && (
        <CenteredCard message={state.message}>
          <button type="button" onClick={() => void markInSyncNow()}>
            Mark this device as in sync
          </button>
          <button type="button" className="res-secondary" onClick={decideLater}>
            Decide later
          </button>
        </CenteredCard>
      )}

      {state.phase === 'done' && (
        <CenteredCard message={state.message}>
          <button type="button" onClick={closeFinished}>
            Done
          </button>
        </CenteredCard>
      )}

      {state.phase === 'deciding' && <Deciding />}

      {state.phase === 'summary' && <Summary />}

    </div>
  )

}
