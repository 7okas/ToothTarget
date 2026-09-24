import { describe, expect, it, vi } from 'vitest'

/*
  Only reduceSyncIndicatorState() - the pure decision function - is
  tested here, not the component itself. This project has no
  React-rendering test harness (no jsdom/testing-library dependency;
  see cloudSyncEngine.ts's/cloudStorage.test.ts's own comments on why
  auth.ts in particular can't load under Vitest's default 'node'
  environment), so the meaningful, non-trivial logic - "given the
  previous indicator state, the previous/current scheduler status, and
  the most recently classified sync outcome, what should the indicator
  show now" - is kept as a plain reducer specifically so it can be
  tested without one. The actual wiring (useSyncExternalStore, the 10s
  auto-hide timer for the TEXT only, the signed-out "Sign in needed"
  branch) is thin glue over this and is not covered here.

  Phase 6 note: these tests deliberately assert against
  describeSyncOutcome(outcome).label/needsAttention rather than
  hardcoded copy strings - the actual WORDING for each outcome type is
  syncOutcome.test.ts's job to verify; this file only verifies that
  reduceSyncIndicatorState() wires that wording/needsAttention flag
  into the right icon/autoHide/persistence behavior.

  SyncStatusIndicator.tsx still imports the real auth.ts/
  cloudSyncScheduler.ts at the top of the file (for its default
  component export), so importing it here at all - even just to reach
  reduceSyncIndicatorState() - needs the same vi.mock('./auth', ...)
  used by cloudStorage.test.ts/cloudSyncOnlineRetry.test.ts, for the
  same reason: the real auth.ts instantiates MSAL (via authConfig.ts,
  which touches `window.location`) at module load time, crashing
  under Vitest's default 'node' environment.
*/

vi.mock('./auth', () => ({
  getActiveAccount: vi.fn(),
  subscribeToActiveAccount: vi.fn(),
}))

vi.mock('./cloudSyncScheduler', () => ({
  getCloudSyncStatus: vi.fn(),
  subscribeCloudSyncStatus: vi.fn(),
  getLastSyncOutcome: vi.fn(),
  subscribeLastSyncOutcome: vi.fn(),
}))

import {
  reduceSyncIndicatorState,
  INITIAL_SYNC_INDICATOR_STATE,
  type SyncIndicatorState,
} from './SyncStatusIndicator'

import {
  describeSyncOutcome,
  type SyncOutcomeReason,
  type SyncOutcomeType,
} from './syncOutcome'

const SYNCED: SyncOutcomeReason = { type: 'synced' }
const SYNCED_AFTER_CONFLICT: SyncOutcomeReason = { type: 'synced-after-conflict' }
const PATIENT_NUMBER_CONFLICTS: SyncOutcomeReason = { type: 'patient-number-conflicts' }
const NOT_SIGNED_IN: SyncOutcomeReason = { type: 'not-signed-in' }
const OFFLINE: SyncOutcomeReason = { type: 'offline' }

describe('reduceSyncIndicatorState - while syncing', () => {

  it('shows the spinner icon + "Syncing…" text while pending, from the initial state', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'idle', 'pending', null)
    ).toEqual({
      hasCompletedOnce: false,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    })

  })

  it('shows the spinner icon + "Syncing…" text while actively syncing', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'pending', 'syncing', null)
    ).toEqual({
      hasCompletedOnce: false,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    })

  })

  it('shows the spinner regardless of what the last outcome was', () => {

    expect(
      reduceSyncIndicatorState(
        INITIAL_SYNC_INDICATOR_STATE,
        'idle',
        'pending',
        OFFLINE
      )
    ).toEqual({
      hasCompletedOnce: false,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    })

  })

})

describe('reduceSyncIndicatorState - before any sync has ever completed this session', () => {

  it('shows nothing for a settled idle status reached with no prior pending/syncing', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'idle', 'idle', null)
    ).toEqual({
      hasCompletedOnce: false,
      icon: null,
      text: null,
    })

  })

  it('shows nothing for a settled unavailable status reached with no prior pending/syncing', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'idle', 'unavailable', null)
    ).toEqual({
      hasCompletedOnce: false,
      icon: null,
      text: null,
    })

  })

})

describe('reduceSyncIndicatorState - a sync attempt just completed (fresh transition)', () => {

  it('on a clean success: green checkmark icon + "Synced" text that auto-hides', () => {

    const result = reduceSyncIndicatorState(
      INITIAL_SYNC_INDICATOR_STATE,
      'syncing',
      'idle',
      SYNCED
    )

    expect(result).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: describeSyncOutcome(SYNCED).label, autoHide: true },
    })

  })

  it('on a generic failure with no outcome classified yet: no text (defensive fallback)', () => {

    // Should not normally happen (lastSyncOutcome is always set in the
    // same tick status changes) - covered anyway as a safety net.
    const result = reduceSyncIndicatorState(
      INITIAL_SYNC_INDICATOR_STATE,
      'syncing',
      'unavailable',
      null
    )

    expect(result.hasCompletedOnce).toBe(true)
    expect(result.icon).toBe('failure')
    expect(result.text).toBeNull()

  })

  it('a self-resolved sync conflict still shows success styling (auto-hide, no attention)', () => {

    const result = reduceSyncIndicatorState(
      INITIAL_SYNC_INDICATOR_STATE,
      'syncing',
      'idle',
      SYNCED_AFTER_CONFLICT
    )

    expect(result.icon).toBe('success')
    expect(result.text).toEqual({
      label: describeSyncOutcome(SYNCED_AFTER_CONFLICT).label,
      autoHide: true,
    })

  })

  it('an outcome needing attention on an otherwise-successful sync shows the attention icon, not success', () => {

    const result = reduceSyncIndicatorState(
      INITIAL_SYNC_INDICATOR_STATE,
      'syncing',
      'idle',
      PATIENT_NUMBER_CONFLICTS
    )

    expect(result.icon).toBe('attention')
    expect(result.text).toEqual({
      label: describeSyncOutcome(PATIENT_NUMBER_CONFLICTS).label,
      autoHide: false,
    })

  })

  it('an outcome needing attention on a failed sync shows the attention icon, not the plain failure icon', () => {

    const result = reduceSyncIndicatorState(
      INITIAL_SYNC_INDICATOR_STATE,
      'syncing',
      'unavailable',
      NOT_SIGNED_IN
    )

    expect(result.icon).toBe('attention')
    expect(result.text).toEqual({
      label: describeSyncOutcome(NOT_SIGNED_IN).label,
      autoHide: false,
    })

  })

  it('an auto-recoverable failure (eg. offline) uses the plain failure icon and auto-hides its text', () => {

    const result = reduceSyncIndicatorState(
      INITIAL_SYNC_INDICATOR_STATE,
      'syncing',
      'unavailable',
      OFFLINE
    )

    expect(result.icon).toBe('failure')
    expect(result.text).toEqual({
      label: describeSyncOutcome(OFFLINE).label,
      autoHide: true,
    })

  })

})

describe('reduceSyncIndicatorState - every classified outcome maps to a distinct, correctly-flagged entry', () => {

  /*
    Exhaustive over every SyncOutcomeType (see syncOutcome.ts) - this
    is the test that would fail if a future outcome type were added to
    syncOutcome.ts without ever being reachable from a real sync
    transition, or if needsAttention/autoHide ever silently disagreed.
  */
  const ALL_OUTCOME_TYPES: SyncOutcomeType[] = [
    'synced',
    'synced-after-conflict',
    'patient-number-conflicts',
    'review-needed',
    'save-incomplete',
    'sync-busy',
    'cloud-data-corrupted',
    'local-data-invalid',
    'not-signed-in',
    'sign-in-denied',
    'offline',
    'onedrive-unavailable',
  ]

  it.each(ALL_OUTCOME_TYPES)(
    'outcome "%s": autoHide is always the exact opposite of needsAttention',
    type => {

      const outcome: SyncOutcomeReason = { type }
      const copy = describeSyncOutcome(outcome)

      const result = reduceSyncIndicatorState(
        INITIAL_SYNC_INDICATOR_STATE,
        'syncing',
        'unavailable',
        outcome
      )

      expect(result.text?.autoHide).toBe(!copy.needsAttention)
      expect(result.icon).toBe(copy.needsAttention ? 'attention' : 'failure')
      expect(result.text?.label).toBe(copy.label)

    }
  )

})

describe('reduceSyncIndicatorState - the icon persists indefinitely once a sync has completed', () => {

  const afterASuccess: SyncIndicatorState = {
    hasCompletedOnce: true,
    icon: 'success',
    text: { label: describeSyncOutcome(SYNCED).label, autoHide: true },
  }

  const afterAFailure: SyncIndicatorState = {
    hasCompletedOnce: true,
    icon: 'failure',
    text: { label: describeSyncOutcome(OFFLINE).label, autoHide: true },
  }

  const afterAttentionNeeded: SyncIndicatorState = {
    hasCompletedOnce: true,
    icon: 'attention',
    text: { label: describeSyncOutcome(NOT_SIGNED_IN).label, autoHide: false },
  }

  it('keeps showing the checkmark, with no text, for a long-settled idle status', () => {

    // Simulates the component's own text-autohide timer having
    // already cleared `text` back to null well before this later,
    // unrelated idle->idle re-render.
    const settled: SyncIndicatorState = { ...afterASuccess, text: null }

    expect(reduceSyncIndicatorState(settled, 'idle', 'idle', SYNCED)).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: null,
    })

  })

  it('keeps showing the red X, with no re-shown text, for a failure just sitting there', () => {

    expect(
      reduceSyncIndicatorState(afterAFailure, 'unavailable', 'unavailable', OFFLINE)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'failure',
      text: null,
    })

  })

  it('keeps showing the attention icon, with no re-shown text, for an unresolved attention item just sitting there', () => {

    expect(
      reduceSyncIndicatorState(
        afterAttentionNeeded,
        'unavailable',
        'unavailable',
        NOT_SIGNED_IN
      )
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'attention',
      text: null,
    })

  })

  it('a retry after a failure shows the spinner (temporarily) rather than the red X', () => {

    expect(
      reduceSyncIndicatorState(afterAFailure, 'unavailable', 'pending', OFFLINE)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    })

  })

  it('a retry that succeeds switches the icon from red X to green checkmark', () => {

    const midRetry: SyncIndicatorState = {
      hasCompletedOnce: true,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    }

    expect(
      reduceSyncIndicatorState(midRetry, 'syncing', 'idle', SYNCED)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: describeSyncOutcome(SYNCED).label, autoHide: true },
    })

  })

  it('a retry that fails again keeps the icon on red X (never regresses to no icon)', () => {

    const midRetry: SyncIndicatorState = {
      hasCompletedOnce: true,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    }

    expect(
      reduceSyncIndicatorState(midRetry, 'syncing', 'unavailable', OFFLINE)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'failure',
      text: { label: describeSyncOutcome(OFFLINE).label, autoHide: true },
    })

  })

  it('a fresh success after a failure clears the error text and shows a fading "Synced" instead', () => {

    expect(
      reduceSyncIndicatorState(afterAFailure, 'syncing', 'idle', SYNCED)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: describeSyncOutcome(SYNCED).label, autoHide: true },
    })

  })

  it('an attention item resolving into a clean success switches the icon from amber to green', () => {

    expect(
      reduceSyncIndicatorState(afterAttentionNeeded, 'syncing', 'idle', SYNCED)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: describeSyncOutcome(SYNCED).label, autoHide: true },
    })

  })

})
