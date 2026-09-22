import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getActiveAccount, subscribeToActiveAccount } from './auth'
import {
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  type CloudSyncStatus,
} from './cloudSyncScheduler'

/*
  PERSISTENT SYNC STATUS INDICATOR

  A small circular icon + text shown in the top-right corner on every
  screen - unlike MicrosoftAccountSection.tsx's own status line, which
  only exists on the Settings screen. Rendered once, as a sibling of
  <App /> in main.tsx (see that file), so it survives every screen
  switch inside App() untouched - App.tsx's own screen-switching logic
  (a long chain of early `if (screen === ...) return (...)`
  statements, not a single shared layout) is never touched by this
  addition.

  Purely a display of state that already exists elsewhere
  (cloudSyncScheduler.ts's status store, auth.ts's active account) -
  this component never calls requestCloudSync() or anything else that
  could influence sync behavior itself.

  Always shows SOMETHING relevant once mounted (no more "shows nothing
  if signed out"): "Sign in needed" (signed out), a spinner (syncing),
  or a checkmark/X icon, optionally with fading "Synced"/persistent
  "Sync error" text (signed in, at least one sync attempt has
  completed this session).
*/

/*
  DISPLAY DECISION (pure, no React/DOM - see SyncStatusIndicator.test.ts)

  A small reducer: (previous state, previous status, current status)
  -> next state. Threading the previous state through (rather than
  computing from `currentStatus` alone) is what lets `hasCompletedOnce`
  latch permanently true the first time a sync attempt resolves, and
  stay true for the rest of the session even as `status` later cycles
  back through 'pending'/'syncing' for a later attempt - the icon must
  never regress to "nothing shown" just because a retry started.

  icon is a plain function of (currentStatus, hasCompletedOnce):
    - 'pending'/'syncing' -> 'spinner', unconditionally - a spinner
      claims nothing about any past outcome, so it doesn't need one.
    - 'idle'/'unavailable' before any attempt has ever completed this
      session -> no icon yet (there's nothing to report).
    - 'idle' once at least one attempt has completed -> 'success'.
    - 'unavailable' once at least one attempt has completed ->
      'failure'.
  This alone satisfies "success/failure icon persists indefinitely,
  and only flips on an actual subsequent success" - between one
  failure and the next success, any retries only ever pass back
  through the unconditional 'spinner' case; the icon only ever
  becomes 'success' when a `currentStatus === 'idle'` is actually
  reached again, never merely because a new attempt started.

  text is keyed off the TRANSITION (previousStatus was 'pending'/
  'syncing', current status just resolved), same reasoning as the
  original text-only version of this component: 'idle' or
  'unavailable' reached any other way (the long-settled case, or a
  failure just sitting there from before) must not re-show text that
  was already shown and has since been dismissed/faded.
*/

export type SyncIconState = 'spinner' | 'success' | 'failure' | null

export type SyncTextState =
  | { label: 'Syncing…'; autoHide: false }
  | { label: 'Synced'; autoHide: true }
  | { label: 'Sync error'; autoHide: false }
  | null

export type SyncIndicatorState = {
  icon: SyncIconState
  text: SyncTextState
  hasCompletedOnce: boolean
}

export const INITIAL_SYNC_INDICATOR_STATE: SyncIndicatorState = {
  icon: null,
  text: null,
  hasCompletedOnce: false,
}

export function reduceSyncIndicatorState(
  previous: SyncIndicatorState,
  previousStatus: CloudSyncStatus,
  currentStatus: CloudSyncStatus
): SyncIndicatorState {

  if (currentStatus === 'syncing' || currentStatus === 'pending') {
    return {
      hasCompletedOnce: previous.hasCompletedOnce,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    }
  }

  const justFinished =
    previousStatus === 'syncing' || previousStatus === 'pending'

  const hasCompletedOnce = previous.hasCompletedOnce || justFinished

  if (currentStatus === 'idle') {
    return {
      hasCompletedOnce,
      icon: hasCompletedOnce ? 'success' : null,
      text: justFinished ? { label: 'Synced', autoHide: true } : null,
    }
  }

  // currentStatus === 'unavailable'
  return {
    hasCompletedOnce,
    icon: hasCompletedOnce ? 'failure' : null,
    text: justFinished ? { label: 'Sync error', autoHide: false } : null,
  }

}

const AUTO_HIDE_MS = 10000
const FADE_MS = 400

const ICON_LABEL: Record<Exclude<SyncIconState, null>, string> = {
  spinner: 'Syncing',
  success: 'Synced',
  failure: 'Sync error',
}

export default function SyncStatusIndicator() {

  /*
    Same read-external-state pattern MicrosoftAccountSection.tsx
    already uses for both of these stores.
  */

  const account = useSyncExternalStore(
    subscribeToActiveAccount,
    getActiveAccount
  )

  const status = useSyncExternalStore(
    subscribeCloudSyncStatus,
    getCloudSyncStatus
  )

  const previousStatusRef = useRef<CloudSyncStatus>(status)

  const [state, setState] = useState<SyncIndicatorState>(
    INITIAL_SYNC_INDICATOR_STATE
  )

  const [fading, setFading] = useState(false)

  useEffect(() => {

    const previousStatus = previousStatusRef.current

    previousStatusRef.current = status

    setState(current => reduceSyncIndicatorState(current, previousStatus, status))

  }, [status])

  /*
    Only the TEXT auto-hides (and only when autoHide is true, ie. only
    "Synced" - "Sync error" and "Syncing…" both have autoHide: false)
    - the icon itself is never touched here and is left exactly as the
    reducer above set it, so it keeps persisting after the text fades.
  */
  useEffect(() => {

    setFading(false)

    if (!state.text || !state.text.autoHide) {
      return
    }

    const fadeTimer = setTimeout(
      () => setFading(true),
      AUTO_HIDE_MS - FADE_MS
    )

    const clearTimer = setTimeout(
      () => setState(current => ({ ...current, text: null })),
      AUTO_HIDE_MS
    )

    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(clearTimer)
    }

  }, [state.text])

  /*
    Not signed in: a persistent, gentle reminder rather than the old
    "show nothing" behavior - no icon, just red text (see this file's
    header comment).
  */
  if (!account) {
    return (
      <div className="sync-status-indicator-rail">
        <div className="sync-status-badge">
          <span className="sync-status-text sync-status-text-error">
            Sign in needed
          </span>
        </div>
      </div>
    )
  }

  if (!state.icon && !state.text) {
    return null
  }

  return (

    <div className="sync-status-indicator-rail">

      <div className="sync-status-badge">

        {state.icon && (
          <span
            className={`sync-status-icon sync-status-icon-${state.icon}`}
            role="img"
            aria-label={ICON_LABEL[state.icon]}
          />
        )}

        {state.text && (
          <span
            className={
              'sync-status-text' +
              (state.text.label === 'Sync error' ? ' sync-status-text-error' : '') +
              (fading ? ' sync-status-text-fading' : '')
            }
          >
            {state.text.label}
          </span>
        )}

      </div>

    </div>

  )

}
