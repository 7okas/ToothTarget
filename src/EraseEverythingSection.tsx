import { useState } from 'react'
import {
  ERASE_CONFIRMATION_TEXT,
  SYNC_FILE_NAME,
  executeErase,
  isEraseConfirmed,
  prepareErase,
  type ErasePlan,
} from './eraseEverything'
import { realEraseDeps } from './eraseEverythingDeps'

/*
  TEMPORARY - "Erase everything" (Settings, red section).

  Nothing here runs by itself: every step is behind an explicit button
  press. Step 1 only checks and lists; step 2 (the red button) is the
  only thing that deletes anything. See eraseEverything.ts.
*/

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ready'; plan: ErasePlan }
  | { kind: 'erasing' }
  | { kind: 'error'; message: string }
  | { kind: 'failedFiles'; failed: string[] }

export default function EraseEverythingSection() {

  const [typed, setTyped] = useState('')

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const confirmed = isEraseConfirmed(typed)

  const busy = phase.kind === 'checking' || phase.kind === 'erasing'

  async function check() {

    setPhase({ kind: 'checking' })

    const result = await prepareErase(typed, realEraseDeps())

    setPhase(
      result.status === 'ready'
        ? { kind: 'ready', plan: result.plan }
        : { kind: 'error', message: result.message }
    )

  }

  async function erase(plan: ErasePlan) {

    setPhase({ kind: 'erasing' })

    const result = await executeErase(typed, plan, realEraseDeps())

    if (result.status === 'refused') {
      setPhase({ kind: 'error', message: result.message })
      return
    }

    if (result.failedFiles.length > 0) {

      /* Local data is already cleared; show what is left, then reload on tap. */
      setPhase({
        kind: 'failedFiles',
        failed: result.failedFiles.map(
          file => `${file.fileName} (${file.detail})`
        ),
      })

      return

    }

    window.location.reload()

  }

  return (

    <section className="erase-section">

      <h2 className="settings-section-title erase-title">
        Danger zone: Erase everything
      </h2>

      <p className="settings-section-description">
        Permanently deletes ALL patients, treatments and templates on
        this device, empties the OneDrive sync file, and deletes the
        OneDrive backup files. This cannot be undone. Export a backup
        first if you want one.
      </p>

      <label className="erase-label">
        Type {ERASE_CONFIRMATION_TEXT} to unlock
        <input
          type="text"
          value={typed}
          onChange={event => {
            setTyped(event.target.value)
            setPhase({ kind: 'idle' })
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
        />
      </label>

      <div className="options-menu-list settings-actions">

        <button
          type="button"
          className="button-danger"
          disabled={!confirmed || busy}
          onClick={check}
        >
          {phase.kind === 'checking'
            ? 'Checking...'
            : 'Step 1: Sync and list what will be deleted'}
        </button>

      </div>

      {phase.kind === 'error' && (
        <p className="erase-error" role="alert">
          {phase.message}
        </p>
      )}

      {phase.kind === 'ready' && (

        <div className="erase-plan">

          <p>
            Ready. This will overwrite <strong>{SYNC_FILE_NAME}</strong>{' '}
            with an empty one (it is never deleted), clear this device,
            and delete these OneDrive files:
          </p>

          {phase.plan.filesToDelete.length === 0 ? (
            <p><em>No other toothtarget files found.</em></p>
          ) : (
            <ul>
              {phase.plan.filesToDelete.map(name => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}

          <div className="options-menu-list settings-actions">

            <button
              type="button"
              className="button-danger"
              disabled={!confirmed}
              onClick={() => erase(phase.plan)}
            >
              Step 2: ERASE EVERYTHING NOW
            </button>

            <button
              type="button"
              onClick={() => setPhase({ kind: 'idle' })}
            >
              Cancel
            </button>

          </div>

        </div>

      )}

      {phase.kind === 'erasing' && (
        <p role="status">Erasing... do not close the app.</p>
      )}

      {phase.kind === 'failedFiles' && (

        <div className="erase-plan" role="alert">

          <p>
            This device and the sync file are erased, but these backup
            files could not be deleted:
          </p>

          <ul>
            {phase.failed.map(entry => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => window.location.reload()}
          >
            Reload the app
          </button>

        </div>

      )}

    </section>

  )

}
