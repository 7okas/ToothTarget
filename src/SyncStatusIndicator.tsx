import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getActiveAccount, subscribeToActiveAccount } from './auth'
import {
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  getLastSyncOutcome,
  subscribeLastSyncOutcome,
  type CloudSyncStatus,
} from './cloudSyncScheduler'
import { describeSyncOutcome, type SyncOutcomeReason } from './syncOutcome'

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
  (cloudSyncScheduler.ts's status/lastSyncOutcome stores, auth.ts's
  active account) - this component never calls requestCloudSync() or
  anything else that could influence sync behavior itself.

  Always shows SOMETHING relevant once mounted (no more "shows nothing
  if signed out"): "Sign in needed" (signed out), a spinner (syncing),
  or an icon reflecting the most recent sync outcome, with matching
  text that fades for outcomes needing no action and persists for ones
  that do (Phase 6 - see this file's own DISPLAY DECISION comment).

  ============================================================
  PHASE 6 - FAILURE DIFFERENTIATION
  ============================================================

  Before this phase, every non-success outcome (auth failure, offline,
  a genuine OneDrive error, an unresolved patient-number conflict, a
  corrupted cloud document - anything at all) collapsed into the same
  two hardcoded strings: "Synced" or "Sync error". syncOutcome.ts's
  classifySyncOutcome()/describeSyncOutcome() is now the one place that
  decides both the plain-language label AND whether a given outcome
  needs the dentist's attention or will simply resolve itself - this
  component only ever renders whatever that returns, it never
  re-interprets a CloudSyncResult or a CloudSyncStatus itself.
*/

/*
  DISPLAY DECISION (pure, no React/DOM - see SyncStatusIndicator.test.ts)

  A small reducer: (previous state, previous status, current status,
  last known sync outcome) -> next state. Threading the previous state
  through (rather than computing from `currentStatus` alone) is what
  lets `hasCompletedOnce` latch permanently true the first time a sync
  attempt resolves, and stay true for the rest of the session even as
  `status` later cycles back through 'pending'/'syncing' for a later
  attempt - the icon must never regress to "nothing shown" just because
  a retry started.

  icon is a plain function of (currentStatus, hasCompletedOnce, the
  outcome's own needsAttention flag):
    - 'pending'/'syncing' -> 'spinner', unconditionally - a spinner
      claims nothing about any past outcome, so it doesn't need one.
    - before any attempt has ever completed this session -> no icon yet
      (there's nothing to report).
    - once at least one attempt has completed, and the most recent
      outcome needs attention (regardless of whether the coarse status
      is 'idle' or 'unavailable' - eg. a successful sync that still
      left an unresolved patient-number conflict) -> 'attention'.
    - otherwise, 'idle' -> 'success', 'unavailable' -> 'failure'.
  This alone satisfies "success/attention/failure icon persists
  indefinitely, and only flips on an actual subsequent status
  transition" - between one outcome and the next, any retries only ever
  pass back through the unconditional 'spinner' case; the icon only
  ever changes when a `currentStatus` transition is actually reached
  again, never merely because a new attempt started.

  text is keyed off the TRANSITION (previousStatus was 'pending'/
  'syncing', current status just resolved), same reasoning as before
  this phase: 'idle' or 'unavailable' reached any other way (the
  long-settled case, or a failure just sitting there from before) must
  not re-show text that was already shown and has since been
  dismissed/faded. autoHide is now driven by needsAttention rather than
  being fixed per coarse status - an outcome the app will resolve on
  its own (offline, a transient OneDrive error, a self-resolved sync
  conflict) fades exactly like a plain "Synced" message; one that
  genuinely needs the dentist's attention (expired sign-in, corrupted
  cloud data, an unresolved patient-number conflict) stays visible
  until the next sync attempt changes it, the same persistence "Sync
  error" always had.
*/

export type SyncIconState = 'spinner' | 'success' | 'attention' | 'failure' | null

export type SyncTextState =
  | { label: string; autoHide: boolean }
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
  currentStatus: CloudSyncStatus,
  outcome: SyncOutcomeReason | null
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

  const copy = outcome ? describeSyncOutcome(outcome) : null

  const icon: SyncIconState =
    !hasCompletedOnce
      ? null
      : copy?.needsAttention
        ? 'attention'
        : currentStatus === 'idle'
          ? 'success'
          : 'failure'

  return {
    hasCompletedOnce,
    icon,
    text:
      justFinished && copy
        ? { label: copy.label, autoHide: !copy.needsAttention }
        : null,
  }

}

const AUTO_HIDE_MS = 10000
const FADE_MS = 400

const ICON_LABEL: Record<Exclude<SyncIconState, null>, string> = {
  spinner: 'Syncing',
  success: 'Synced',
  attention: 'Needs attention',
  failure: 'Sync issue',
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

  const outcome = useSyncExternalStore(
    subscribeLastSyncOutcome,
    getLastSyncOutcome
  )

  const previousStatusRef = useRef<CloudSyncStatus>(status)

  const [state, setState] = useState<SyncIndicatorState>(
    INITIAL_SYNC_INDICATOR_STATE
  )

  const [fading, setFading] = useState(false)

  useEffect(() => {

    const previousStatus = previousStatusRef.current

    previousStatusRef.current = status

    setState(current =>
      reduceSyncIndicatorState(current, previousStatus, status, outcome)
    )

  }, [status, outcome])

  /*
    Only the TEXT auto-hides (and only when autoHide is true - see this
    file's own DISPLAY DECISION comment for which outcomes that is) -
    the icon itself is never touched here and is left exactly as the
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
    header comment). Distinct from a 'not-signed-in' sync outcome
    (syncOutcome.ts) - that one means a sign-in EXPIRED after a sync was
    attempted; this branch means no Microsoft account is active at all,
    so no sync has been (or will be) attempted in the first place.
  */
  if (!account) {
    return (
      <div className="sync-status-badge">
        <span className="sync-status-text sync-status-text-error">
          Sign in needed
        </span>
      </div>
    )
  }

  if (!state.icon && !state.text) {
    return null
  }

  return (

    <div className="sync-status-badge">

      {state.icon && (
        <span
          className={`sync-status-icon sync-status-icon-${state.icon}`}
          role="img"
          aria-label={state.text?.label ?? ICON_LABEL[state.icon]}
        />
      )}

      {state.text && (
        <span
          title={outcome ? describeSyncOutcome(outcome).detail : undefined}
          className={
            'sync-status-text' +
            (state.icon === 'attention' ? ' sync-status-text-attention' : '') +
            (state.icon === 'failure' ? ' sync-status-text-error' : '') +
            (fading ? ' sync-status-text-fading' : '')
          }
        >
          {state.text.label}
        </span>
      )}

    </div>

  )

}
