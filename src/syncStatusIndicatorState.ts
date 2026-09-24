import { describeSyncOutcome, type SyncOutcomeReason } from './syncOutcome'
import type { CloudSyncStatus } from './cloudSyncScheduler'

/*
  SYNC STATUS INDICATOR - DISPLAY DECISION (pure, no React/DOM)

  Extracted out of SyncStatusIndicator.tsx itself (rather than defined
  inline in that component, where it started) so the component file
  only ever exports its default component - mixing a component export
  with plain function/constant exports breaks Vite's Fast Refresh for
  that file (react-refresh/only-export-components), and this project's
  own established convention is already to keep pure, directly-
  testable decision logic in its own standalone module, separate from
  the component that renders it (see syncOutcome.ts/startupGate.ts/
  staleRecordReview.ts for the same pattern). SyncStatusIndicator.test.ts
  now imports straight from here, with no need to mock auth.ts/
  cloudSyncScheduler.ts at all - this module has no runtime dependency
  on either (CloudSyncStatus below is a type-only import, erased at
  compile time).

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

/*
  MANUAL SYNC-ON-CLICK GUARD (Phase 8)

  Pure, same reasoning as reduceSyncIndicatorState() above. The
  clickable badge only ever renders while the icon shows 'success'
  (see SyncStatusIndicator.tsx's own render), which itself already
  implies currentStatus === 'idle' - but this re-checks the live
  status directly rather than trusting that derived icon state, so a
  tap can never queue a duplicate/conflicting sync on top of one
  already running or about to run. Also used by
  MicrosoftAccountSection.tsx's own "Sync Now" button, for the exact
  same guard.
*/
export function canTriggerManualSync(status: CloudSyncStatus): boolean {
  return status !== 'syncing' && status !== 'pending'
}
