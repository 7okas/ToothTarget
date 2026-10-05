import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  closeSafetyCopiesScreen,
  getSafetyCopiesScreenOpen,
  subscribeSafetyCopiesScreen,
} from './syncResolutionStore'
import {
  buildSafetyCopyGroups,
  loadCopyDocument,
  restoreDocumentToDevice,
  type CopyRef,
  type SafetyCopyGroup,
} from './syncResolutionRestore'
import {
  listCloudSafetyCopies,
  readLocalSafetyCopies,
  type LocalSafetyCopyEntry,
} from './syncResolutionSafetyCopy'
import { notifyLocalDataReplaced, requestCloudSync } from './cloudSyncScheduler'
import type { CloudSyncDocument } from './cloudSync'

/*
  SAFETY COPIES + RESTORE (Phase 6, step 10)

  Lists the safety copies saved before each resolution (and before each
  restore) and lets the dentist put one back on THIS device. Restore is
  deliberately a two-step action: pick a copy, read a plain-language
  warning with the copy's real numbers, then confirm. All the actual
  work lives in syncResolutionRestore.ts (unit-tested); this file only
  draws the list and forwards button presses.

  After a restore, local data is marked as having unsynced changes and
  an ordinary sync is requested - it either pushes the restored data (if
  OneDrive hasn't moved) or lands in 'diverged', which opens the
  resolution screen from the badge as usual. This screen never writes to
  OneDrive itself.
*/

function formatWhen(iso: string): string {

  const ms = Date.parse(iso)

  if (Number.isNaN(ms)) {
    return iso
  }

  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

}

type FetchedGroups = { groups: SafetyCopyGroup[]; note: string | null }

/* Asks OneDrive for its copies and merges them with this device's. Never throws. */
async function fetchGroups(local: LocalSafetyCopyEntry[]): Promise<FetchedGroups> {

  try {

    const cloud = await listCloudSafetyCopies()

    return { groups: buildSafetyCopyGroups(local, cloud), note: null }

  } catch {

    return {
      groups: buildSafetyCopyGroups(local, []),
      note:
        "Couldn't list the copies on OneDrive (you may be offline or signed out). " +
        'Showing the copies saved on this device.',
    }

  }

}

type PendingRestore = {
  group: SafetyCopyGroup
  ref: CopyRef
  document: CloudSyncDocument
}

/*
  The outer component only decides whether the screen is open; the body
  is mounted fresh on every open, so its state (a half-finished confirm,
  an old error) never survives a close.
*/
export default function SafetyCopiesScreen() {

  const open = useSyncExternalStore(subscribeSafetyCopiesScreen, getSafetyCopiesScreenOpen, getSafetyCopiesScreenOpen)

  return open ? <SafetyCopiesBody /> : null

}

function SafetyCopiesBody() {

  const [groups, setGroups] = useState<SafetyCopyGroup[]>(() =>
    buildSafetyCopyGroups(readLocalSafetyCopies(), [])
  )
  const [loading, setLoading] = useState(true)
  const [listNote, setListNote] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingRestore | null>(null)
  const [restored, setRestored] = useState<string | null>(null)

  /*
    Every state update happens in a callback AFTER OneDrive answers, so a
    failed or slow OneDrive never hides the copies already shown from
    this device.
  */
  function applyFetched(result: FetchedGroups) {

    setGroups(result.groups)
    setListNote(result.note)
    setLoading(false)

  }

  useEffect(() => {

    void fetchGroups(readLocalSafetyCopies()).then(applyFetched)

  }, [])

  async function chooseCopy(group: SafetyCopyGroup, ref: CopyRef) {

    const key = `${group.resolutionId}:${ref.side}`

    setBusyKey(key)
    setError(null)

    const loaded = await loadCopyDocument(ref)

    setBusyKey(null)

    if (loaded.status !== 'ok') {
      setError(loaded.detail)
      return
    }

    setPending({ group, ref, document: loaded.document })

  }

  async function confirmRestore() {

    if (!pending) {
      return
    }

    const result = restoreDocumentToDevice(pending.document)

    if (result.status === 'failed') {

      setError(
        result.reason === 'safety-copy-failed'
          ? "Couldn't save a copy of this device's current data first, so nothing was restored. This device may be out of storage."
          : result.reason === 'invalid-copy'
            ? "This safety copy couldn't be read, so nothing was restored."
            : "Couldn't finish restoring (this device may be out of storage). Nothing more was changed."
      )

      setPending(null)

      return

    }

    notifyLocalDataReplaced()
    requestCloudSync()

    setPending(null)

    setRestored(
      `Restored ${result.patients} ${result.patients === 1 ? 'patient' : 'patients'} and ` +
      `${result.treatments} ${result.treatments === 1 ? 'treatment' : 'treatments'} to this device. ` +
      'The app is now syncing normally. If OneDrive has changed since, you will be asked to review the differences.' +
      (result.warning ? ` ${result.warning}` : '')
    )

    const local = readLocalSafetyCopies()

    setGroups(buildSafetyCopyGroups(local, []))
    setLoading(true)

    applyFetched(await fetchGroups(local))

  }

  return (
    <div className="res-screen res-screen-top" role="dialog" aria-modal="true" aria-label="Safety copies">

      <header className="res-header">

        <div className="res-header-text">
          <h2>Safety copies</h2>
          <p>
            Before every resolution, a copy of both sides is saved so you
            can undo it. OneDrive keeps the last 5 resolutions and this
            device the last 2.
          </p>
        </div>

        <button type="button" className="res-secondary" onClick={closeSafetyCopiesScreen}>
          Close
        </button>

      </header>

      <div className="res-body">

        {restored && (
          <div className="res-banner res-banner-success" role="status">
            <strong>Restored</strong>
            <span>{restored}</span>
          </div>
        )}

        {error && (
          <div className="res-banner res-banner-error" role="alert">
            <strong>Couldn't do that</strong>
            <span>{error}</span>
          </div>
        )}

        {listNote && <p className="res-help">{listNote}</p>}

        {loading && groups.length === 0 && <p className="res-help">Looking for safety copies…</p>}

        {!loading && groups.length === 0 && (
          <p className="res-help">
            There are no safety copies yet. They appear here after you
            resolve a difference with OneDrive.
          </p>
        )}

        {pending && (
          <div className="res-banner res-banner-warning" role="alertdialog" aria-label="Confirm restore">

            <strong>Replace this device's data?</strong>

            <span>
              This puts{' '}
              {pending.ref.side === 'device' ? "this device's" : "OneDrive's"} data as it was on{' '}
              {formatWhen(pending.group.capturedAt)} back on this device:{' '}
              <strong>
                {pending.document.patients.length} patients and{' '}
                {pending.document.savedTreatments.length} treatments
              </strong>
              . Everything on this device right now will be replaced. A copy of
              what is on this device now is saved first, so you can undo this.
              Nothing is changed on OneDrive until the app syncs afterwards.
            </span>

            <div className="res-problem-actions">
              <button type="button" onClick={() => void confirmRestore()}>
                Replace this device's data
              </button>
              <button type="button" className="res-secondary" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>

          </div>
        )}

        <ul className="res-copy-list">
          {groups.map(group => (
            <li key={group.resolutionId} className="res-copy">

              <p className="res-summary">
                {group.kind === 'before-restore'
                  ? 'Before a restore on '
                  : 'Before a resolution on '}
                <strong>{formatWhen(group.capturedAt)}</strong>
              </p>

              <p className="res-help">
                Kept on:{' '}
                {group.heldOn
                  .map(place => (place === 'this-device' ? 'this device' : 'OneDrive'))
                  .join(' and ')}
              </p>

              <div className="res-choices">

                {group.device && (
                  <button
                    type="button"
                    className="res-choice-button"
                    disabled={busyKey !== null || pending !== null}
                    onClick={() => void chooseCopy(group, group.device!)}
                  >
                    {busyKey === `${group.resolutionId}:device`
                      ? 'Loading…'
                      : "Restore this device's data from before"}
                  </button>
                )}

                {group.cloud && (
                  <button
                    type="button"
                    className="res-choice-button"
                    disabled={busyKey !== null || pending !== null}
                    onClick={() => void chooseCopy(group, group.cloud!)}
                  >
                    {busyKey === `${group.resolutionId}:cloud`
                      ? 'Loading…'
                      : "Restore OneDrive's data from before"}
                  </button>
                )}

              </div>

            </li>
          ))}
        </ul>

      </div>

    </div>
  )

}
