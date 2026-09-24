import { useEffect, useState, useSyncExternalStore } from 'react'
import logo from './assets/logo.png'
import { getActiveAccount, signIn, subscribeToActiveAccount } from './auth'
import {
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  getLastSyncOutcome,
  subscribeLastSyncOutcome,
  requestCloudSync,
} from './cloudSyncScheduler'
import { reconcileSyncedAccount } from './cloudSyncEngine'
import { describeSyncOutcome } from './syncOutcome'
import {
  reduceStartupGateState,
  markStartupGatePassed,
  computeStartupGateView,
  INITIAL_STARTUP_GATE_STATE,
  type StartupGateState,
} from './startupGate'

/*
  STARTUP SIGN-IN / SYNC GATE (Phase 6.5)

  A full-screen screen shown at app startup, before the patient list
  is reachable - replaces StartupSyncOverlay.tsx (removed by this
  phase; see startupGate.ts's own header comment for why this is a
  fresh component rather than an extension of it).

  Rendered as a sibling of <App/> in main.tsx, same mounting position
  StartupSyncOverlay used, and for the same reason
  SyncStatusIndicator.tsx is: it needs to sit on top of App.tsx's
  whole screen-switching chain, not inside it. Unlike that overlay,
  this one actually BLOCKS the app underneath (full-viewport, opaque,
  not pointer-events: none) for as long as it's shown - but <App/>
  itself stays mounted the whole time. App.tsx's own on-mount effects
  (the schema migration, then the sync this gate watches - see its
  "AUTOMATIC SYNC ON APP LOAD" effect) already run in the right order
  regardless of whether this gate is covering the screen; reimplementing
  that ordering here would only duplicate it.

  NEVER A HARD GATE (Phase 6.5 requirement): every branch below has an
  always-enabled way out - "Continue without signing in" when signed
  out, and "Continue without syncing" alongside "Retry" when a sync
  fails - none of them ever get disabled while busy, so a slow popup
  or a stuck sync can never trap the dentist outside the app. The only
  path with no manual exit is a successful sync, which proceeds on its
  own; there is deliberately no automatic timeout-based proceed on
  failure (Phase 6.5 requirement 4) - only Retry or Continue moves
  past an error.
*/

const RESULT_VISIBLE_MS = 1000
const FADE_MS = 400

export default function StartupGateScreen() {

  const account = useSyncExternalStore(
    subscribeToActiveAccount,
    getActiveAccount
  )

  const status = useSyncExternalStore(
    subscribeCloudSyncStatus,
    getCloudSyncStatus
  )

  const outcome = useSyncExternalStore(
    subscribeLastSyncOutcome,
    getLastSyncOutcome
  )

  const [state, setState] = useState<StartupGateState>(
    INITIAL_STARTUP_GATE_STATE
  )

  const [fading, setFading] = useState(false)

  const [signInBusy, setSignInBusy] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)

  useEffect(() => {
    setState(current => reduceStartupGateState(current, status))
  }, [status])

  /*
    Auto-proceed once a gating sync succeeds: same brief-checkmark-
    then-fade timing StartupSyncOverlay used, ending in
    markStartupGatePassed() rather than just clearing a display flag -
    this is the ONE automatic transition this screen makes (Phase 6.5
    requirement 3), and it's deliberately restricted to the success
    phase only (a failed gating attempt never times out on its own -
    see this file's header comment).
  */
  useEffect(() => {

    setFading(false)

    if (state.phase !== 'success') {
      return
    }

    const fadeTimer = setTimeout(
      () => setFading(true),
      RESULT_VISIBLE_MS - FADE_MS
    )

    const passTimer = setTimeout(
      () => setState(current => markStartupGatePassed(current)),
      RESULT_VISIBLE_MS
    )

    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(passTimer)
    }

  }, [state.phase])

  async function handleSignIn() {

    setSignInError(null)
    setSignInBusy(true)

    const result = await signIn()

    setSignInBusy(false)

    if (result.error) {
      setSignInError(result.error)
      return
    }

    if (result.account) {

      /*
        Same account-switch guard and immediate-sync trigger
        MicrosoftAccountSection.tsx's own handleSignIn() uses - see
        that file's comment for the full reasoning on both.
      */
      if (
        reconcileSyncedAccount(result.account.homeAccountId) === 'switched-account'
      ) {
        window.location.reload()
        return
      }

      requestCloudSync()

    }

  }

  function handleContinueWithoutSigningIn() {
    setState(current => markStartupGatePassed(current))
  }

  function handleRetry() {
    requestCloudSync()
  }

  function handleContinueWithoutSyncing() {
    setState(current => markStartupGatePassed(current))
  }

  const view = computeStartupGateView(Boolean(account), state, outcome)

  if (view.kind === 'passed') {
    return null
  }

  return (

    <div className="startup-gate-overlay">

      <div className="startup-gate-card">

        {view.kind === 'sign-in-prompt' && (

          <>

            <img
              src={logo}
              alt="ToothTarget"
              className="startup-gate-logo"
            />

            <p>
              Sign in with Microsoft to keep your data backed up to
              OneDrive automatically.
            </p>

            <div className="startup-gate-actions">

              <button
                type="button"
                onClick={handleSignIn}
                disabled={signInBusy}
              >
                {signInBusy ? 'Signing In…' : 'Sign in with Microsoft OneDrive'}
              </button>

              <button
                type="button"
                className="startup-gate-secondary-button"
                onClick={handleContinueWithoutSigningIn}
              >
                Continue without signing in
              </button>

            </div>

            {signInError && (
              <p className="settings-error-message">
                {signInError}
              </p>
            )}

          </>

        )}

        {view.kind === 'syncing' && (

          <>

            <span
              className="startup-gate-icon startup-gate-icon-spinner"
              role="img"
              aria-hidden="true"
            />

            <p className="startup-gate-status-label">
              Syncing your data…
            </p>

          </>

        )}

        {view.kind === 'success' && (

          <div
            className={
              'startup-gate-result' +
              (fading ? ' startup-gate-result-fading' : '')
            }
          >

            <span
              className="startup-gate-icon startup-gate-icon-success"
              role="img"
              aria-hidden="true"
            />

            <p className="startup-gate-status-label startup-gate-status-success">
              Synced
            </p>

          </div>

        )}

        {view.kind === 'error' && (

          <>

            <span
              className="startup-gate-icon startup-gate-icon-error"
              role="img"
              aria-hidden="true"
            />

            <h2 className="startup-gate-status-error">
              {view.outcome
                ? describeSyncOutcome(view.outcome).label
                : 'Sync error'}
            </h2>

            <p>
              {view.outcome
                ? describeSyncOutcome(view.outcome).detail
                : "Something went wrong while syncing. Your existing data on this device is safe."}
            </p>

            <div className="startup-gate-actions">

              <button type="button" onClick={handleRetry}>
                Retry
              </button>

              <button
                type="button"
                className="startup-gate-secondary-button"
                onClick={handleContinueWithoutSyncing}
              >
                Continue without syncing
              </button>

            </div>

          </>

        )}

      </div>

    </div>

  )

}
