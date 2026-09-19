import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  getActiveAccount,
  initializeMsal,
  signIn,
  signOut,
  subscribeToActiveAccount,
} from './auth'
import { testCloudStorage, type CloudStorageTestResult } from './graphTest'
import { testCloudDataFile, type CloudDataFileTestResult } from './cloudStorageTest'
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
} from './cloudSyncScheduler'
import { formatDate } from './format'

/*
  Plain, non-technical copy only - never a raw Graph/ETag error (those
  stay in the console via cloudSyncScheduler.ts's own safe-status
  logging). This is a read-only reflection of automatic background
  sync (Phase 7) - it has no buttons and cannot itself start, stop, or
  retry anything.
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
  keys. Dropping it into (or removing it from) the Settings screen
  never touches any existing patient/treatment/template behavior.
  Signing in only makes a Microsoft account available for a later,
  separate feature - it does not yet read or write anything on
  OneDrive.

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

  /*
    TEMPORARY - Microsoft Graph App Folder connectivity test. Isolated
    to these two pieces of state, handleTestCloudStorage(), and the
    one button/result block below - remove all three plus
    graphTest.ts to take this back out later.
  */

  const [cloudTestBusy, setCloudTestBusy] =
    useState(false)

  const [cloudTestResult, setCloudTestResult] =
    useState<CloudStorageTestResult | null>(null)

  /*
    TEMPORARY - cloudStorage.ts (readCloudData/writeCloudData)
    round-trip test. Same isolation as the block above: these two
    pieces of state, handleTestCloudDataFile(), and the one
    button/result block below - remove all three plus
    cloudStorageTest.ts to take this back out later.
  */

  const [cloudDataTestBusy, setCloudDataTestBusy] =
    useState(false)

  const [cloudDataTestResult, setCloudDataTestResult] =
    useState<CloudDataFileTestResult | null>(null)

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
    }

  }

  async function handleSignOut() {

    setError(null)
    setIsBusy(true)

    await signOut()

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

  /*
    TEMPORARY - see the state declarations above.
  */

  async function handleTestCloudStorage() {

    setCloudTestResult(null)
    setCloudTestBusy(true)

    const result = await testCloudStorage()

    setCloudTestBusy(false)
    setCloudTestResult(result)

  }

  /*
    TEMPORARY - see the state declarations above.
  */

  async function handleTestCloudDataFile() {

    setCloudDataTestResult(null)
    setCloudDataTestBusy(true)

    const result = await testCloudDataFile()

    setCloudDataTestBusy(false)
    setCloudDataTestResult(result)

  }

  return (

    <>

      <h2 className="settings-section-title">
        Microsoft Account
      </h2>

      <p className="settings-section-description">
        Sign in with Microsoft to back up your patients and completed
        treatments to your OneDrive App Folder, or restore them on
        another device. This is a manual snapshot, not automatic
        syncing - nothing is uploaded or changed until you press one
        of the buttons below.
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

          {/*
            TEMPORARY - Microsoft Graph App Folder connectivity test.
            See graphTest.ts. Safe to delete this block (and that
            file) once cloud sync is actually implemented.
          */}

          <div className="options-menu-list settings-actions">

            <button
              type="button"
              onClick={handleTestCloudStorage}
              disabled={cloudTestBusy}
            >
              {cloudTestBusy ? 'Testing Cloud Storage…' : 'Test Cloud Storage'}
            </button>

          </div>

          {cloudTestResult && (

            <p
              className={
                cloudTestResult.success
                  ? 'settings-section-description privacy-lock-status'
                  : 'settings-error-message'
              }
            >
              {cloudTestResult.message}
            </p>

          )}

          {/*
            TEMPORARY - cloudStorage.ts read/write round-trip test.
            See cloudStorageTest.ts. Safe to delete this block (and
            that file) once real backup/sync is actually implemented.
          */}

          <div className="options-menu-list settings-actions">

            <button
              type="button"
              onClick={handleTestCloudDataFile}
              disabled={cloudDataTestBusy}
            >
              {cloudDataTestBusy
                ? 'Testing Cloud Data File…'
                : 'Test Cloud Data File'}
            </button>

          </div>

          {cloudDataTestResult && (

            <p
              className={
                cloudDataTestResult.success
                  ? 'settings-section-description privacy-lock-status'
                  : 'settings-error-message'
              }
            >
              {cloudDataTestResult.message}
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
