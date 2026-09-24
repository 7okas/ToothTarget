import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  getActiveAccount,
  initializeMsal,
  signIn,
  signOut,
  subscribeToActiveAccount,
} from './auth'
import {
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  requestCloudSync,
} from './cloudSyncScheduler'
import { reconcileSyncedAccount, syncCloudNow } from './cloudSyncEngine'
import { signOutWithBestEffortSync } from './cloudSyncSignOut'
import { canTriggerManualSync } from './SyncStatusIndicator'

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
  cloud sync active (see cloudSyncEngine.ts/cloudSyncScheduler.ts).

  Phase 8 - "Sync Now" replaces the old separate "Backup to Cloud"/
  "Load from Cloud" one-way snapshot actions with a single button that
  triggers the SAME automatic two-way sync as every other trigger in
  the app (requestCloudSync(), guarded by the same
  canTriggerManualSync() SyncStatusIndicator.tsx's own manual-sync
  affordance uses) - not a new sync mechanism. The underlying one-way
  backup/restore functions (cloudBackup.ts, cloudStorage.ts's
  readCloudData/writeCloudData) were left in place, just no longer
  wired to any UI here.

  Reuses the existing settings-section-title / settings-section-
  description / settings-actions / settings-error-message classes
  already used by Data Export above it, so this looks like a natural
  second section rather than a bolted-on widget.
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

  /*
    Phase 8 - "Sync Now": the same guard SyncStatusIndicator.tsx's own
    clickable checkmark badge uses, re-checked here against the live
    cloudSyncStatus rather than trusting the button's disabled state
    alone, so this can never queue a duplicate/conflicting sync on top
    of one already running or about to run.
  */
  function handleSyncNow() {

    if (!canTriggerManualSync(cloudSyncStatus)) {
      return
    }

    requestCloudSync()

  }

  return (

    <>

      <h2 className="settings-section-title">
        Microsoft Account
      </h2>

      <p className="settings-section-description">
        Stay signed in to keep your data backed up to OneDrive
        automatically.
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
              onClick={handleSyncNow}
              disabled={!canTriggerManualSync(cloudSyncStatus)}
            >
              {cloudSyncStatus === 'syncing' || cloudSyncStatus === 'pending'
                ? 'Syncing…'
                : 'Sync Now'}
            </button>

          </div>

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

    </>

  )

}
