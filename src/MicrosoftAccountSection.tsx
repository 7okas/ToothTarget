import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  getActiveAccount,
  initializeMsal,
  signIn,
  signOut,
  subscribeToActiveAccount,
} from './auth'
import { readCloudData, writeCloudData } from './cloudStorage'
import {
  createCloudBackup,
  validateCloudBackup,
  applyCloudRestore,
  type CloudBackup,
} from './cloudBackup'
import {
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  requestCloudSync,
} from './cloudSyncScheduler'
import { reconcileSyncedAccount, syncCloudNow } from './cloudSyncEngine'
import { signOutWithBestEffortSync } from './cloudSyncSignOut'
import { formatDate } from './format'

/*
  Plain, non-technical copy only - never a raw Graph/ETag error (those
  stay in the console via cloudSyncScheduler.ts's own safe-status
  logging). This is a read-only reflection of automatic background
  sync (Phase 7) - it has no buttons and cannot itself start, stop, or
  retry anything.

  Phase 6 deliberately leaves this coarse 4-value mapping as-is: the
  persistent top-right badge (SyncStatusIndicator.tsx) is where a
  failure now gets its own specific, plain-language reason (see
  syncOutcome.ts) - this simpler status line on the Settings screen
  stays a one-line summary of whether a sync is in progress, pending,
  or not currently succeeding, which "Cloud sync unavailable" already
  honestly says without needing to enumerate every reason why.
*/
const CLOUD_SYNC_STATUS_LABEL: Record<
  ReturnType<typeof getCloudSyncStatus>,
  string
> = {
  idle: 'Synced',
  pending: 'Sync pending…',
  syncing: 'Syncing…',
  unavailable: 'Cloud sync unavailable',
}

/*
  MICROSOFT ACCOUNT (Settings)

  Self-contained - it owns its own sign-in/sign-out/loading/error
  state and reads/writes nothing in App.tsx's state or localStorage
  keys directly. Signing in here is what makes automatic, multi-device
  cloud sync active (see cloudSyncEngine.ts/cloudSyncScheduler.ts) and
  enables the manual "Backup to Cloud"/"Load from Cloud" actions below
  - both are real, in-production OneDrive features, not previews.

  Reuses the existing settings-section-title / settings-section-
  description / settings-actions / settings-error-message classes
  already used by Data Export and Privacy Lock above it, so this
  looks like a natural third section rather than a bolted-on widget.
*/

export default function MicrosoftAccountSection() {

  /*
    Read directly from MSAL's own live state (via the
    ACTIVE_ACCOUNT_CHANGED event) rather than copying it into this
    component's own state. This is what makes the signed-in/signed-
    out UI always correct - on first render (already-persisted
    account restored across a refresh or a full browser restart),
    immediately after signIn()/signOut() change it, and with no
    window where this component's own copy could fall out of sync
    with MSAL's - regardless of exactly when initialization, MSAL's
    internal events, and this component's mount happen to interleave.
  */

  const account = useSyncExternalStore(
    subscribeToActiveAccount,
    getActiveAccount
  )

  /*
    Same read-external-state pattern as `account` above, for Phase 7's
    automatic background sync status - this component never triggers
    a sync itself, it only displays whatever cloudSyncScheduler.ts's
    own module-level state currently is.
  */
  const cloudSyncStatus = useSyncExternalStore(
    subscribeCloudSyncStatus,
    getCloudSyncStatus
  )

  const [isReady, setIsReady] =
    useState(false)

  const [isBusy, setIsBusy] =
    useState(false)

  const [error, setError] =
    useState<string | null>(null)

  /*
    CLOUD BACKUP / RESTORE (snapshot, not sync)

    Backup: builds today's snapshot (createCloudBackup(), reading
    straight from localStorage) and uploads it - a plain write, no
    confirmation needed since it never touches anything on this
    device.

    Load: fetches + validates the cloud file first (cloudLoadError
    covers "not signed in" / "no backup yet" / "corrupted" /
    "unsupported schema version" - anything that means there is
    nothing safe to offer). Only once a VALID backup comes back does
    pendingCloudRestore hold it, which is what shows the explicit
    confirmation below - applyCloudRestore() itself only ever runs
    after the dentist presses that confirmation.
  */

  const [cloudBackupBusy, setCloudBackupBusy] =
    useState(false)

  const [cloudBackupResult, setCloudBackupResult] =
    useState<{ success: boolean; message: string } | null>(null)

  const [cloudLoadBusy, setCloudLoadBusy] =
    useState(false)

  const [cloudLoadError, setCloudLoadError] =
    useState<string | null>(null)

  const [pendingCloudRestore, setPendingCloudRestore] =
    useState<CloudBackup | null>(null)

  const [cloudRestoreBusy, setCloudRestoreBusy] =
    useState(false)

  useEffect(() => {

    let cancelled = false

    initializeMsal().then(() => {

      if (!cancelled) {
        setIsReady(true)
      }

    })

    return () => {
      cancelled = true
    }

  }, [])

  async function handleSignIn() {

    setError(null)
    setIsBusy(true)

    const result = await signIn()

    setIsBusy(false)

    /*
      No need to store result.account here - signIn() already called
      setActiveAccount() internally, which the subscription above
      already picked up and re-rendered from.
    */
    if (result.error) {

      setError(result.error)

    } else if (result.account) {

      /*
        Phase 4: reconcile which account this device's local synced
        data currently belongs to BEFORE requesting a sync, same
        reasoning and same reload-after-quarantine pattern as App.tsx's
        own app-load effect (see that effect's comment for the full
        explanation, and cloudSyncEngine.ts's reconcileSyncedAccount()
        for why a reload is needed at all here). A signed-in account is
        guaranteed by this branch (result.error is null), by construction
        - the `else if (result.account)` (rather than a plain `else`) is
        only here so TypeScript can narrow SignInResult's discriminated
        union itself, which it can't do from a truthiness check on
        result.error alone (that field's type is `string | null`, and an
        empty string would also be falsy without actually meaning
        "success").
      */
      if (
        reconcileSyncedAccount(result.account.homeAccountId) === 'switched-account'
      ) {
        window.location.reload()
        return
      }

      /*
        Phase 2: a fresh sign-in is one of the two new automatic sync
        triggers (the other is app load, see App.tsx) - reconcile with
        the cloud immediately rather than waiting for the next
        unrelated patient/treatment/template mutation.
      */
      requestCloudSync()

    }

  }

  async function handleSignOut() {

    setError(null)
    setIsBusy(true)

    /*
      Phase 4: a best-effort sync attempt while the outgoing account's
      token is still valid, before MSAL sign-out actually clears it -
      see cloudSyncSignOut.ts for the full reasoning. Never blocks or
      fails sign-out itself.
    */
    await signOutWithBestEffortSync(syncCloudNow, signOut)

    setIsBusy(false)

  }

  async function handleBackupToCloud() {

    setCloudBackupResult(null)
    setCloudBackupBusy(true)

    try {

      const backup = createCloudBackup()

      await writeCloudData(backup)

      setCloudBackupResult({
        success: true,
        message: `Backed up ${backup.patients.length} patient(s), ${backup.savedTreatments.length} treatment(s), ${backup.customTemplates.length} custom template(s), and ${backup.customProcedures.length} custom procedure(s) to OneDrive.`,
      })

    } catch (error) {

      const detail = error instanceof Error ? error.message : String(error)

      setCloudBackupResult({
        success: false,
        message: `Backup failed: ${detail}`,
      })

    }

    setCloudBackupBusy(false)

  }

  async function handleLoadFromCloud() {

    setCloudLoadError(null)
    setPendingCloudRestore(null)
    setCloudLoadBusy(true)

    try {

      const data = await readCloudData<unknown>()

      if (data === null) {

        setCloudLoadError(
          'No cloud backup was found yet. Use "Backup to Cloud" first.'
        )

      } else {

        const result = validateCloudBackup(data)

        if (result.valid) {
          setPendingCloudRestore(result.backup)
        } else {
          setCloudLoadError(result.error)
        }

      }

    } catch (error) {

      const detail = error instanceof Error ? error.message : String(error)

      setCloudLoadError(`Could not load the cloud backup: ${detail}`)

    }

    setCloudLoadBusy(false)

  }

  function cancelCloudRestore() {
    setPendingCloudRestore(null)
  }

  /*
    applyCloudRestore() reloads the page itself on success, so there
    is no matching setCloudRestoreBusy(false)/setPendingCloudRestore
    (null) after it - this component is about to unmount anyway.
  */
  function confirmCloudRestore() {

    if (!pendingCloudRestore) {
      return
    }

    setCloudRestoreBusy(true)

    applyCloudRestore(pendingCloudRestore)

  }

  return (

    <>

      <h2 className="settings-section-title">
        Microsoft Account
      </h2>

      <p className="settings-section-description">
        Sign in with Microsoft to keep your patients, treatments,
        templates, and procedures backed up automatically to your
        OneDrive App Folder in the background - no button needed.
        "Backup to Cloud" and "Load from Cloud" below are separate: a
        manual, full snapshot you can take any time, such as before a
        big change or just for extra peace of mind.
      </p>

      {!isReady && (

        <p className="settings-section-description">
          Checking sign-in status…
        </p>

      )}

      {isReady && account && (

        <>

          <p className="settings-section-description privacy-lock-status">
            Signed in as{' '}
            <strong>
              {account.name || account.username}
            </strong>
          </p>

          <p className="settings-section-description cloud-sync-status">
            {CLOUD_SYNC_STATUS_LABEL[cloudSyncStatus]}
          </p>

          <div className="options-menu-list settings-actions">

            <button
              type="button"
              onClick={handleSignOut}
              disabled={isBusy}
            >
              {isBusy ? 'Signing Out…' : 'Sign Out'}
            </button>

          </div>

          <div className="options-menu-list settings-actions">

            <button
              type="button"
              onClick={handleBackupToCloud}
              disabled={cloudBackupBusy}
            >
              {cloudBackupBusy ? 'Backing Up…' : 'Backup to Cloud'}
            </button>

            <button
              type="button"
              onClick={handleLoadFromCloud}
              disabled={cloudLoadBusy}
            >
              {cloudLoadBusy ? 'Checking Cloud…' : 'Load from Cloud'}
            </button>

          </div>

          {cloudBackupResult && (

            <p
              className={
                cloudBackupResult.success
                  ? 'settings-section-description privacy-lock-status'
                  : 'settings-error-message'
              }
            >
              {cloudBackupResult.message}
            </p>

          )}

          {cloudLoadError && (
            <p className="settings-error-message">
              {cloudLoadError}
            </p>
          )}

        </>

      )}

      {isReady && !account && (

        <div className="options-menu-list settings-actions">

          <button
            type="button"
            onClick={handleSignIn}
            disabled={isBusy}
          >
            {isBusy ? 'Signing In…' : 'Sign in with Microsoft'}
          </button>

        </div>

      )}

      {error && (
        <p className="settings-error-message">
          {error}
        </p>
      )}

      {pendingCloudRestore && (

        <div className="modal-overlay">

          <div className="modal-card">

            <h2>
              Restore from Cloud?
            </h2>

            <p>
              This device's <strong>patients</strong> (
              {pendingCloudRestore.patients.length}),{' '}
              <strong>completed treatments</strong> (
              {pendingCloudRestore.savedTreatments.length}), and{' '}
              <strong>custom templates/procedures</strong> will be
              replaced with the backup from{' '}
              {formatDate(pendingCloudRestore.exportedAt)}.
            </p>

            <p>
              Your active/incomplete treatments and Privacy Lock
              setting on this device will not be changed. A safety
              backup of this device's current data will download
              automatically before the restore happens - if anything
              looks wrong afterward, that file can be restored via
              the Import Backup option in Settings below.
            </p>

            <div className="modal-actions">

              <button
                type="button"
                className="modal-cancel-button"
                onClick={cancelCloudRestore}
                disabled={cloudRestoreBusy}
              >
                Cancel
              </button>

              <button
                type="button"
                className="button-danger"
                onClick={confirmCloudRestore}
                disabled={cloudRestoreBusy}
              >
                {cloudRestoreBusy ? 'Restoring…' : 'Restore from Cloud'}
              </button>

            </div>

          </div>

        </div>

      )}

    </>

  )

}
