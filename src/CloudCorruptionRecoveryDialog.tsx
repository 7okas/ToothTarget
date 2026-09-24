import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  getLastSyncOutcome,
  subscribeLastSyncOutcome,
} from './cloudSyncScheduler'
import {
  isCorruptedSyncOutcome,
  findNewestValidBackup,
  checkAllBackupSlots,
  type NewestValidBackup,
  type BackupSlotValidity,
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

  /*
    'pending' covers both "hasn't started yet" and "in flight" - there
    is no separate 'idle'/'searching' pair. Collapsing those two into
    one resting value is what lets the fetch-kickoff effect below
    never need to call setLookup() synchronously at its own top level
    (which react-hooks/set-state-in-effect flags as a cascading-render
    anti-pattern) just to "enter" a loading state - 'pending' IS that
    loading state, entered for free via this initial value (and via
    the reset effect below, on a new corruption episode), never via a
    setState call made purely to kick off a fetch.
  */
  const [lookup, setLookup] = useState<
    | { status: 'pending' }
    | { status: 'found'; result: NewestValidBackup }
    | { status: 'none-found' }
  >({ status: 'pending' })

  /*
    A separate lookup from `lookup` above (which only ever cares about
    the single best backup to offer restoring) - this one reports
    pass/fail + date for ALL THREE slots (A/B/C), so the dentist can
    see the full picture of what's available, not just the newest
    valid one. Never blocks or delays the restore option above - if
    this fails/is still loading, `lookup`'s own outcome still renders
    independently.
  */
  const [backupSlots, setBackupSlots] = useState<
    | { status: 'pending' }
    | { status: 'checked'; slots: BackupSlotValidity[] }
    | { status: 'failed' }
  >({ status: 'pending' })

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
      setLookup({ status: 'pending' })
      setBackupSlots({ status: 'pending' })
    }

  }, [outcome])

  useEffect(() => {

    if (!isCorruptedSyncOutcome(outcome) || dismissed) {
      return
    }

    if (lookup.status !== 'pending') {
      return
    }

    let cancelled = false

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

    checkAllBackupSlots()
      .then(slots => {

        if (!cancelled) {
          setBackupSlots({ status: 'checked', slots })
        }

      })
      .catch(() => {

        if (!cancelled) {
          setBackupSlots({ status: 'failed' })
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

  const diagnosis = outcome.diagnosis

  return (

    <div className="modal-overlay">

      <div className="modal-card">

        <h2>
          Synced Data Couldn't Be Read
        </h2>

        {diagnosis ? (

          diagnosis.kind === 'unreadable' ? (

            <p>
              Your synced data couldn't be read: {diagnosis.reason}
            </p>

          ) : (

            <p>
              One specific record in your synced data is invalid:{' '}
              <strong>{diagnosis.recordDescription}</strong> —{' '}
              {diagnosis.reason}.
            </p>

          )

        ) : (

          /*
            Fallback for the (production-impossible, but type-allowed)
            case where diagnosis wasn't set - see syncOutcome.ts's own
            comment on why the field is optional rather than required.
          */
          <p>Your synced data couldn't be read.</p>

        )}

        {backupSlots.status === 'checked' && (

          <div className="settings-section-description">

            <p>Backup status:</p>

            <ul>
              {backupSlots.slots.map(slot => (
                <li key={slot.slot}>
                  Backup {slot.slot}:{' '}
                  {slot.status === 'missing' && 'no backup in this slot yet'}
                  {slot.status === 'valid' &&
                    `valid, from ${formatDate(slot.date)}`}
                  {slot.status === 'invalid' &&
                    `invalid (dated ${formatDate(slot.date)}) — ${slot.error}`}
                  {slot.status === 'unreadable' &&
                    `couldn't be read (dated ${formatDate(slot.date)}) — ${slot.error}`}
                </li>
              ))}
            </ul>

          </div>

        )}

        {diagnosis?.kind === 'invalid-record' && (

          <p className="settings-section-description">
            Instead of restoring from a backup, you can also find and
            fix (or delete) this specific record yourself in the app,
            then sync again normally.
          </p>

        )}

        {lookup.status === 'pending' && (
          <p>Checking for a good backup…</p>
        )}

        {lookup.status === 'found' && (

          <>

            <p>
              The most recent good backup is from{' '}
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
                {restoreBusy
                  ? 'Restoring…'
                  : `Restore from Backup ${lookup.result.file.slot}, ${formatDate(lookup.result.file.date)}`}
              </button>

            </div>

          </>

        )}

        {lookup.status === 'none-found' && (

          <>

            <p>
              No valid backup was found either. Your device's own
              local data has not been changed.
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
