import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getActiveAccount, subscribeToActiveAccount } from './auth'
import {
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  getLastSyncOutcome,
  subscribeLastSyncOutcome,
  requestCloudSync,
  type CloudSyncStatus,
} from './cloudSyncScheduler'
import { describeSyncOutcome } from './syncOutcome'
import { getDeviceLastSyncAt } from './deviceSyncTracking'
import { describeLastSync } from './syncAgeText'
import { openResolutionScreen } from './syncResolutionStore'
import {
  reduceSyncIndicatorState,
  canTriggerManualSync,
  canReviewDifferencesFromBadge,
  canShowDetailFromBadge,
  INITIAL_SYNC_INDICATOR_STATE,
  type SyncIndicatorState,
  type SyncIconState,
} from './syncStatusIndicatorState'

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
  active account) - the one exception (Phase 8) is the manual
  "tap the badge to sync now" affordance below (the whole badge is
  the tap target, not just the checkmark - easier to hit on a touch
  device), which calls requestCloudSync() itself rather than defining
  any sync logic of its own; every other branch here still only ever
  renders what already exists elsewhere.

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

  PHASE 7 - FOUR STATES, DETAIL BY TAP
  ------------------------------------------------------------
  The badge text is one of four state headings (Synced / Offline, will
  retry / Sync conflict / Needs your input). The specific reason is the
  outcome's one-line detail, reachable by TAP (iPad: nothing is
  hover-only): tapping the offline/needs-input badge opens a small
  panel with it, the conflict badge opens the resolution screen, and
  the Settings sync section always shows the same line.
*/

/*
  DISPLAY DECISION + MANUAL SYNC-ON-CLICK GUARD

  reduceSyncIndicatorState()/canTriggerManualSync() (and the
  SyncIconState/SyncTextState/SyncIndicatorState types and
  INITIAL_SYNC_INDICATOR_STATE they use) now live in
  syncStatusIndicatorState.ts, not here - a pure, no-React/DOM module
  this component imports from, same as syncOutcome.ts/startupGate.ts's
  own extraction. This file exporting only its default component (and
  no plain functions/constants alongside it) is what lets Vite's Fast
  Refresh reliably hot-reload it; see that module's own header comment
  for the full reasoning and for reduceSyncIndicatorState()'s own
  documented behavior.
*/

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

  /*
    Tap-to-open detail panel. Remembers WHICH outcome it was opened for
    (by identity) rather than a plain boolean, so the panel closes by
    itself the moment a new outcome arrives, with no effect needed.
  */
  const [detailOpenFor, setDetailOpenFor] = useState<typeof outcome>(null)

  const detailOpen = outcome !== null && detailOpenFor === outcome

  /*
    RELATIVE LAST-SYNC TIME

    Purely a re-render tick so "Synced 5 minutes ago" keeps advancing
    while the badge just sits there with no other state change - the
    actual timestamp still comes from deviceSyncTracking.ts's
    getDeviceLastSyncAt() on every render, never stored here, and the
    wording comes from syncAgeText.ts. Besides the 60-second timer the
    time is refreshed the moment the app becomes visible again: iPad
    timers are paused while the app is in the background, so without
    this the text could stay stale for up to a minute after returning.
  */
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {

    const interval = setInterval(() => setNow(new Date()), 60000)

    function refreshIfVisible() {
      if (document.visibilityState === 'visible') {
        setNow(new Date())
      }
    }

    document.addEventListener('visibilitychange', refreshIfVisible)
    window.addEventListener('focus', refreshIfVisible)
    window.addEventListener('pageshow', refreshIfVisible)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.removeEventListener('focus', refreshIfVisible)
      window.removeEventListener('pageshow', refreshIfVisible)
    }

  }, [])

  const deviceLastSyncAt = getDeviceLastSyncAt()

  const lastSync = describeLastSync(deviceLastSyncAt, now, {
    synced: status === 'synced',
    labelShown: state.text !== null,
  })

  function handleManualSync() {

    if (!canTriggerManualSync(status)) {
      return
    }

    requestCloudSync()

  }

  useEffect(() => {

    const previousStatus = previousStatusRef.current

    previousStatusRef.current = status

    setState(current =>
      reduceSyncIndicatorState(current, previousStatus, status, outcome)
    )

  }, [status, outcome])

  /*
    Only the TEXT auto-hides (and only when autoHide is true - see
    syncStatusIndicatorState.ts's own DISPLAY DECISION comment for
    which outcomes that is) - the icon itself is never touched here
    and is left exactly as the reducer set it, so it keeps persisting
    after the text fades.

    Resetting `fading` back to false whenever state.text actually
    changes is done directly during render just below (not inside the
    effect) - see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
    Calling a state setter synchronously at an effect's own top level
    triggers an extra, avoidable render pass (react-hooks/
    set-state-in-effect); doing it in the render body instead, guarded
    by a comparison against the last text this reset for, lets React
    fold the correction into the same render/commit rather than
    scheduling a second one. The effect below keeps only the genuine
    side effect - scheduling/cancelling the fade and clear timers.
  */
  const [textAtLastFadeReset, setTextAtLastFadeReset] = useState(state.text)

  if (state.text !== textAtLastFadeReset) {
    setTextAtLastFadeReset(state.text)
    setFading(false)
  }

  useEffect(() => {

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
    header comment). Distinct from a 'needs-input' sign-in-expired outcome
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

  if (!state.icon && !state.text && !lastSync) {
    return null
  }

  const badgeContent = (

    <>

      {state.icon && (
        <span
          className={`sync-status-icon sync-status-icon-${state.icon}`}
          role="img"
          aria-label={state.text?.label ?? ICON_LABEL[state.icon]}
        />
      )}

      {state.text && (
        <span
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

      {lastSync && (
        <span
          className={
            'sync-status-relative-time' +
            (lastSync.stale ? ' sync-status-relative-time-stale' : '')
          }
        >
          {/* Both forms are in the page; CSS shows the short one on narrow screens. */}
          <span className="sync-status-age-long">{lastSync.long}</span>
          <span className="sync-status-age-short">{lastSync.short}</span>
        </span>
      )}

    </>

  )

  /*
    Phase 6 - while this device and OneDrive disagree ('diverged', the
    attention icon), the whole badge opens the resolution screen
    instead. Same widened tap target as the manual-sync button below,
    for the same reason; it never starts a sync itself.
  */
  if (canReviewDifferencesFromBadge(state.icon, outcome)) {
    return (
      <button
        type="button"
        className="sync-status-badge sync-status-badge-clickable"
        aria-label="Review differences with OneDrive"
        title="Review differences with OneDrive"
        onClick={openResolutionScreen}
      >
        {state.icon && (
          <span
            className="sync-status-icon sync-status-icon-attention"
            role="img"
            aria-label="Needs attention"
          />
        )}
        <span className="sync-status-text sync-status-text-attention">
          {state.text?.label ?? 'Sync paused'} - tap to review
        </span>
      </button>
    )
  }

  /*
    Offline / needs-input: the whole badge is a button that opens the
    detail line - by tap, so it works on an iPad (nothing is hover-only).
  */
  if (outcome && canShowDetailFromBadge(state.icon, outcome)) {

    const copy = describeSyncOutcome(outcome)

    return (
      <button
        type="button"
        className="sync-status-badge sync-status-badge-clickable"
        aria-expanded={detailOpen}
        aria-label={`${copy.label}. ${detailOpen ? 'Hide' : 'Show'} details`}
        onClick={() => setDetailOpenFor(detailOpen ? null : outcome)}
      >
        {badgeContent}
        {detailOpen && (
          <span className="sync-status-detail" role="status">
            <strong>{copy.label}</strong>
            <span>{copy.detail}</span>
          </span>
        )}
      </button>
    )

  }

  /*
    Phase 8 (widened tap target) - the ENTIRE badge is the manual-sync
    button while the icon shows 'success', not just the small
    checkmark glyph - a bigger, easier target on a touch device. Every
    other state (spinner/attention/failure, or no icon at all) still
    renders as the original plain, non-interactive <div>.
  */
  if (state.icon === 'success') {
    return (
      <button
        type="button"
        className="sync-status-badge sync-status-badge-clickable"
        aria-label="Sync now"
        title="Sync now"
        onClick={handleManualSync}
      >
        {badgeContent}
      </button>
    )
  }

  return (
    <div className="sync-status-badge">
      {badgeContent}
    </div>
  )

}
