import type { CloudSyncStatus } from './cloudSyncScheduler'
import type { SyncOutcomeReason } from './syncOutcome'

/*
  STARTUP SIGN-IN / SYNC GATE (Phase 6.5)

  Pure, standalone decision logic (same reasoning as syncOutcome.ts/
  staleRecordReview.ts's own extraction: directly unit-testable, no
  React/DOM) behind StartupGateScreen.tsx, the full-screen gate shown
  at app startup, before the patient list is reachable.

  Supersedes StartupSyncOverlay.tsx/reduceStartupSyncOverlayState()
  (removed by this phase): that component only ever showed a small,
  temporary, non-blocking cue for the first sync of a session and had
  nothing to say when the dentist wasn't signed in at all, or when
  that first sync failed (it just faded an "error" pill after a fixed
  timeout with no way to act on it). This phase's requirements - a
  real sign-in prompt, a classified failure reason with a manual
  Retry, and an explicit "continue anyway" that's always available -
  don't fit that component's "briefly flash a status, then get out of
  the way" design, so rather than bolt three new states onto it, this
  is a fresh, purpose-built state machine that reuses only what
  genuinely carries over: the same "track the first sync attempt this
  session, ignore everything after" shape.

  ============================================================
  WHY THE APP ITSELF STAYS MOUNTED UNDERNEATH
  ============================================================

  App.tsx already has its own on-mount effects - migrating old
  localStorage data to the current schema, then (only once that's
  done) requesting the very sync this gate is watching (see its
  "AUTOMATIC SYNC ON APP LOAD" effect). Delaying <App/>'s own mount
  until this gate is dismissed would mean reimplementing that
  ordering here, or the sync this gate watches would never even
  start. Instead, main.tsx mounts this gate as a full-screen,
  pointer-events-blocking cover ON TOP of <App/> (same sibling
  position StartupSyncOverlay used), so App's existing effects run
  exactly as before and this gate simply hides/blocks that screen
  until it's dismissed - see StartupGateScreen.tsx.

  ============================================================
  STATE
  ============================================================

  `passed` latches true once the dentist reaches the app via any of
  the always-available exits (continue without signing in, continue
  without syncing, or a sync that completes successfully) and never
  resets - once passed, later sync attempts this session are entirely
  the small persistent badge's business (SyncStatusIndicator.tsx),
  same as they always were.

  `phase` tracks the CURRENTLY-GATING sync attempt only (there is at
  most one at a time from this gate's point of view - a Retry simply
  starts a new one, which this reduces exactly the same way):
    - 'idle': nothing to show yet, or waiting for a not-yet-started
      first attempt.
    - 'syncing': the gating attempt is in flight.
    - 'success': it just resolved cleanly.
    - 'error': it just resolved to any non-success outcome (offline,
      auth failure, corrupted cloud data, an unresolved patient-number
      conflict, etc - see syncOutcome.ts, which is exhaustive).
*/

export type StartupGatePhase = 'idle' | 'syncing' | 'success' | 'error'

export type StartupGateState = {
  passed: boolean
  phase: StartupGatePhase
}

export const INITIAL_STARTUP_GATE_STATE: StartupGateState = {
  passed: false,
  phase: 'idle',
}

export function reduceStartupGateState(
  previous: StartupGateState,
  currentStatus: CloudSyncStatus
): StartupGateState {

  if (previous.passed) {
    return previous
  }

  const isActive = currentStatus === 'pending' || currentStatus === 'syncing'

  if (isActive) {
    return previous.phase === 'syncing'
      ? previous
      : { ...previous, phase: 'syncing' }
  }

  if (previous.phase === 'syncing') {
    return {
      ...previous,
      phase: currentStatus === 'idle' ? 'success' : 'error',
    }
  }

  return previous

}

/*
  Shared by both "continue anyway" exits (not-signed-in, and sync
  failed) AND the automatic proceed once a gating sync succeeds - all
  three are the same action: stop gating, let App become reachable,
  permanently for this session.
*/

export function markStartupGatePassed(
  previous: StartupGateState
): StartupGateState {
  return previous.passed ? previous : { ...previous, passed: true }
}

/*
  What the gate should actually show, as one function of its own
  state plus the two facts it can't derive on its own (whether a
  Microsoft account is currently active, and the most recently
  classified outcome, for the 'error' case's specific reason).
  Kept separate from the reducer above so each half - "what happened"
  vs. "what does that mean on screen" - is independently testable.
*/

export type StartupGateView =
  | { kind: 'passed' }
  | { kind: 'sign-in-prompt' }
  | { kind: 'syncing' }
  | { kind: 'success' }
  | { kind: 'error'; outcome: SyncOutcomeReason | null }

export function computeStartupGateView(
  hasAccount: boolean,
  state: StartupGateState,
  outcome: SyncOutcomeReason | null
): StartupGateView {

  if (state.passed) {
    return { kind: 'passed' }
  }

  if (!hasAccount) {
    return { kind: 'sign-in-prompt' }
  }

  if (state.phase === 'success') {
    return { kind: 'success' }
  }

  if (state.phase === 'error') {
    return { kind: 'error', outcome }
  }

  return { kind: 'syncing' }

}
