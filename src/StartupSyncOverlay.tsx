import { useEffect, useState, useSyncExternalStore } from 'react'
import { getActiveAccount, subscribeToActiveAccount } from './auth'
import {
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  type CloudSyncStatus,
} from './cloudSyncScheduler'

/*
  STARTUP SYNC OVERLAY (Phase 4, Part B)

  A more prominent, TEMPORARY cue shown only for the very first sync
  attempt of a page-load session (a normal app load per Phase 2, or
  the reload that follows an account switch - see cloudSyncEngine.ts's
  reconcileSyncedAccount()) - so the app doesn't look blank/broken
  while that first data pull is happening. Every sync attempt AFTER
  the first one continues to use only the existing small top-right
  badge (SyncStatusIndicator.tsx) - this component deliberately never
  reacts to them.

  Rendered once, as its own sibling of <App /> and <SyncStatusIndicator
  /> in main.tsx, for the same reason SyncStatusIndicator.tsx is: it
  needs to survive every screen switch inside App() untouched, and
  App.tsx's screen-switching logic is a long chain of early
  `if (screen === ...) return (...)` statements, not a single shared
  layout.

  "This session" is tracked with plain component state (useState,
  reset by definition on every fresh mount/page load - see the
  reducer below) rather than sessionStorage/localStorage - the
  requirement is specifically "reset on every fresh page load,
  including the account-switch reload", which a fresh mount already
  guarantees with no extra persistence needed.
*/

/*
  TRACKING (pure, no React/DOM - see StartupSyncOverlay.test.ts)

  hasClaimedFirstAttempt latches true the FIRST time status ever
  becomes 'pending'/'syncing' and never resets - this is what
  guarantees every later sync attempt this session is ignored
  entirely by this component, per its own scope (only the first
  attempt gets the overlay).

  display tracks what's currently shown ('syncing' while the claimed
  first attempt is in flight, 'success'/'error' briefly once it
  resolves, then null once dismissed - see the component's own
  auto-dismiss timer below). Whether the FIRST attempt is still being
  tracked is inferred from `display === 'syncing'` rather than a
  separate flag - that's the only way `display` can ever be 'syncing'
  in the first place, since it's set that way exactly once, by the
  branch above.
*/

export type StartupSyncOverlayDisplay = 'syncing' | 'success' | 'error' | null

export type StartupSyncOverlayState = {
  hasClaimedFirstAttempt: boolean
  display: StartupSyncOverlayDisplay
}

export const INITIAL_STARTUP_SYNC_OVERLAY_STATE: StartupSyncOverlayState = {
  hasClaimedFirstAttempt: false,
  display: null,
}

export function reduceStartupSyncOverlayState(
  previous: StartupSyncOverlayState,
  currentStatus: CloudSyncStatus
): StartupSyncOverlayState {

  const isActive = currentStatus === 'pending' || currentStatus === 'syncing'

  if (!previous.hasClaimedFirstAttempt) {

    return isActive
      ? { hasClaimedFirstAttempt: true, display: 'syncing' }
      : previous

  }

  if (previous.display === 'syncing' && !isActive) {

    return {
      hasClaimedFirstAttempt: true,
      display: currentStatus === 'idle' ? 'success' : 'error',
    }

  }

  return previous

}

const RESULT_VISIBLE_MS = 1000
const FADE_MS = 400

export default function StartupSyncOverlay() {

  /*
    Same read-external-state pattern SyncStatusIndicator.tsx already
    uses for both of these stores.
  */

  const account = useSyncExternalStore(
    subscribeToActiveAccount,
    getActiveAccount
  )

  const status = useSyncExternalStore(
    subscribeCloudSyncStatus,
    getCloudSyncStatus
  )

  const [state, setState] = useState<StartupSyncOverlayState>(
    INITIAL_STARTUP_SYNC_OVERLAY_STATE
  )

  const [fading, setFading] = useState(false)

  useEffect(() => {
    setState(current => reduceStartupSyncOverlayState(current, status))
  }, [status])

  /*
    Auto-dismiss only applies to the brief 'success'/'error' result
    phases - 'syncing' has no timer of its own and stays until the
    reducer above reacts to the next real status change.
  */
  useEffect(() => {

    setFading(false)

    if (state.display !== 'success' && state.display !== 'error') {
      return
    }

    const fadeTimer = setTimeout(
      () => setFading(true),
      RESULT_VISIBLE_MS - FADE_MS
    )

    const clearTimer = setTimeout(
      () => setState(current => ({ ...current, display: null })),
      RESULT_VISIBLE_MS
    )

    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(clearTimer)
    }

  }, [state.display])

  /*
    No cloud UI at all until the dentist has actually signed in - same
    rule the rest of the cloud feature set already follows. In
    practice status can never leave 'idle' while signed out anyway
    (nothing triggers a sync), so this is a defensive/explicit guard
    more than something expected to change behavior on its own.
  */
  if (!account || !state.display) {
    return null
  }

  const label =
    state.display === 'syncing'
      ? 'Syncing…'
      : state.display === 'success'
        ? 'Sync successful'
        : 'Sync error'

  return (

    <div
      className={
        'startup-sync-overlay' +
        (state.display === 'success' ? ' startup-sync-overlay-success' : '') +
        (state.display === 'error' ? ' startup-sync-overlay-error' : '') +
        (fading ? ' startup-sync-overlay-fading' : '')
      }
    >

      <span
        className={`startup-sync-icon startup-sync-icon-${
          state.display === 'syncing' ? 'spinner' : state.display
        }`}
        role="img"
        aria-hidden="true"
      />

      <span>{label}</span>

    </div>

  )

}
