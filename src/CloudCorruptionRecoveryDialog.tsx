import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  getLastSyncOutcome,
  subscribeLastSyncOutcome,
} from './cloudSyncScheduler'
import {
  isCorruptedSyncOutcome,
  findNewestValidBackup,
  type NewestValidBackup,
} from './cloudCorruptionRecovery'
import { applyCloudRestore } from './cloudBackup'
import { formatDate } from './format'

/*
  CLOUD CORRUPTION RECOVERY DIALOG (Phase 9)

  Mounted once, as a sibling of <App/> in main.tsx (same reasoning as
  StartupGateScreen.tsx/SyncStatusIndicator.tsx - it needs to appear
  on top of whichever screen is showing, not be threaded through
  App.tsx's own long screen-switching chain).

  NEVER a silent auto-fallback: this only ever SHOWS a choice. Loading
  a backup locally happens exclusively inside handleConfirmRestore(),
  which only runs from the dentist's own click on the button below -
  there is no code path here that calls applyCloudRestore() any other
  way. Declining ("Not Now") does nothing but hide this dialog for the
  current corruption episode; it never deletes, overwrites, or
  "fixes" anything on its own.
*/

export default function CloudCorruptionRecoveryDialog() {

  const outcome = useSyncExternalStore(
    subscribeLastSyncOutcome,
    getLastSyncOutcome
  )

  const [dismissed, setDismissed] = useState(false)

  const [lookup, setLookup] = useState<
    | { status: 'idle' }
    | { status: 'searching' }
    | { status: 'found'; result: NewestValidBackup }
    | { status: 'none-found' }
  >({ status: 'idle' })

  const [restoreBusy, setRestoreBusy] = useState(false)

  /*
    A brand-new corruption outcome (a fresh object from
    classifySyncOutcome(), see that function's own reasoning) always
    re-arms this dialog, even if an EARLIER corruption episode was
    dismissed - "declined" only ever means "not for THIS episode",
    never "stop telling me forever".
  */
  const previousOutcomeRef = useRef(outcome)

  useEffect(() => {

    if (outcome !== previousOutcomeRef.current) {
      previousOutcomeRef.current = outcome
      setDismissed(false)
      setLookup({ status: 'idle' })
    }

  }, [outcome])

  useEffect(() => {

    if (!isCorruptedSyncOutcome(outcome) || dismissed) {
      return
    }

    if (lookup.status !== 'idle') {
      return
    }

    let cancelled = false

    setLookup({ status: 'searching' })

    findNewestValidBackup()
      .then(result => {

        if (cancelled) {
          return
        }

        setLookup(
          result
            ? { status: 'found', result }
            : { status: 'none-found' }
        )

      })
      .catch(() => {

        if (!cancelled) {
          setLookup({ status: 'none-found' })
        }

      })

    return () => {
      cancelled = true
    }

  }, [outcome, dismissed, lookup.status])

  if (!isCorruptedSyncOutcome(outcome) || dismissed) {
    return null
  }

  function handleDecline() {
    setDismissed(true)
  }

  function handleConfirmRestore() {

    if (lookup.status !== 'found') {
      return
    }

    setRestoreBusy(true)

    applyCloudRestore(lookup.result.backup)

  }

  return (

    <div className="modal-overlay">

      <div className="modal-card">

        <h2>
          Synced Data Couldn't Be Read
        </h2>

        {lookup.status === 'searching' && (
          <p>
            Your synced data couldn't be read. Checking for a good
            backup…
          </p>
        )}

        {lookup.status === 'found' && (

          <>

            <p>
              Your synced data couldn't be read. The most recent good
              backup is from{' '}
              <strong>{formatDate(lookup.result.file.date)}</strong>.
              Restore it?
            </p>

            <p className="settings-section-description">
              This only changes this device's local data - nothing on
              OneDrive is deleted or modified. The next sync will send
              the restored data back to the cloud as usual.
            </p>

            <div className="modal-actions">

              <button
                type="button"
                className="modal-cancel-button"
                onClick={handleDecline}
                disabled={restoreBusy}
              >
                Not Now
              </button>

              <button
                type="button"
                onClick={handleConfirmRestore}
                disabled={restoreBusy}
              >
                {restoreBusy ? 'Restoring…' : 'Restore This Backup'}
              </button>

            </div>

          </>

        )}

        {lookup.status === 'none-found' && (

          <>

            <p>
              Your synced data couldn't be read, and no valid backup
              was found either. Your device's own local data has not
              been changed.
            </p>

            <div className="modal-actions">

              <button
                type="button"
                className="modal-cancel-button"
                onClick={handleDecline}
              >
                Dismiss
              </button>

            </div>

          </>

        )}

      </div>

    </div>

  )

}
