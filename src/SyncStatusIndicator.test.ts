import { describe, expect, it } from 'vitest'

/*
  Only reduceSyncIndicatorState() - the pure decision function - is
  tested here, not the component itself. This project has no
  React-rendering test harness (no jsdom/testing-library dependency),
  so the meaningful, non-trivial logic - "given the previous indicator
  state, the previous/current scheduler status, and the most recently
  classified sync outcome, what should the indicator show now" - is
  kept as a plain reducer specifically so it can be tested without
  one. The actual wiring (useSyncExternalStore, the 10s auto-hide
  timer for the TEXT only, the signed-out "Sign in needed" branch) is
  thin glue over this, lives in SyncStatusIndicator.tsx itself, and is
  not covered here.

  Phase 6 note: these tests deliberately assert against
  describeSyncOutcome(outcome).label/needsAttention rather than
  hardcoded copy strings - the actual WORDING for each outcome type is
  syncOutcome.test.ts's job to verify; this file only verifies that
  reduceSyncIndicatorState() wires that wording/needsAttention flag
  into the right icon/autoHide/persistence behavior.

  Imported from syncStatusIndicatorState.ts, not SyncStatusIndicator.tsx
  itself - that extraction (so the component file only ever exports
  its default component, for Fast Refresh) also means this file no
  longer needs to mock auth.ts/cloudSyncScheduler.ts at all: the pure
  module has no runtime dependency on either.
*/

import {
  reduceSyncIndicatorState,
  canTriggerManualSync,
  canReviewDifferencesFromBadge,
  canShowDetailFromBadge,
  INITIAL_SYNC_INDICATOR_STATE,
  type SyncIndicatorState,
} from './syncStatusIndicatorState'

import {
  describeSyncOutcome,
  type SyncOutcomeReason,
  classifySyncOutcome,
} from './syncOutcome'
import type { CloudSyncResult } from './cloudSyncEngine'

/*
  Every CloudSyncResult the engine can produce, classified for real - the
  outcomes below are what the scheduler would actually store.
*/
const ALL_RESULTS: CloudSyncResult[] = [
  { status: 'synced' },
  { status: 'cloud-committed-locally-pending', detail: 'x' },
  { status: 'cloud-invalid', detail: 'x' },
  { status: 'validation-failed', detail: 'x' },
  { status: 'diverged', detail: 'x' },
  { status: 'auth-failed' },
  { status: 'permission-denied', detail: 'x' },
  { status: 'network-unreachable', detail: 'x' },
  { status: 'graph-error', detail: 'x' },
]

const SYNCED: SyncOutcomeReason = classifySyncOutcome({ status: 'synced' })
const NOT_SIGNED_IN: SyncOutcomeReason = classifySyncOutcome({ status: 'auth-failed' })
const OFFLINE: SyncOutcomeReason = classifySyncOutcome({ status: 'network-unreachable', detail: 'x' })
const DIVERGED: SyncOutcomeReason = classifySyncOutcome({ status: 'diverged', detail: 'x' })

describe('reduceSyncIndicatorState - while syncing', () => {

  it('shows the spinner icon + "Syncing…" text while pending, from the initial state', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'synced', 'pending', null)
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
        'synced',
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
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'synced', 'synced', null)
    ).toEqual({
      hasCompletedOnce: false,
      icon: null,
      text: null,
    })

  })

  it('shows nothing for a settled unavailable status reached with no prior pending/syncing', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'synced', 'offline', null)
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
      'synced',
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
      'offline',
      null
    )

    expect(result.hasCompletedOnce).toBe(true)
    expect(result.icon).toBe('failure')
    expect(result.text).toBeNull()

  })

  it('an outcome needing attention on a failed sync shows the attention icon, not the plain failure icon', () => {

    const result = reduceSyncIndicatorState(
      INITIAL_SYNC_INDICATOR_STATE,
      'syncing',
      'needs-input',
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
      'offline',
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
    Exhaustive over every CloudSyncResult status (see syncOutcome.ts) - this
    is the test that would fail if a future outcome type were added to
    syncOutcome.ts without ever being reachable from a real sync
    transition, or if needsAttention/autoHide ever silently disagreed.
  */
  it.each(ALL_RESULTS.map(result => [result.status, result] as const))(
    'result "%s": autoHide is always the exact opposite of needsAttention',
    (_status, result) => {

      const outcome = classifySyncOutcome(result)
      const copy = describeSyncOutcome(outcome)

      const reduced = reduceSyncIndicatorState(
        INITIAL_SYNC_INDICATOR_STATE,
        'syncing',
        outcome.state,
        outcome
      )

      expect(reduced.text?.autoHide).toBe(!copy.needsAttention)
      expect(reduced.icon).toBe(
        copy.needsAttention
          ? 'attention'
          : outcome.state === 'synced'
            ? 'success'
            : 'failure'
      )
      expect(reduced.text?.label).toBe(copy.label)

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

    expect(reduceSyncIndicatorState(settled, 'synced', 'synced', SYNCED)).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: null,
    })

  })

  it('keeps showing the red X, with no re-shown text, for a failure just sitting there', () => {

    expect(
      reduceSyncIndicatorState(afterAFailure, 'offline', 'offline', OFFLINE)
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
        'offline',
        'needs-input',
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
      reduceSyncIndicatorState(afterAFailure, 'offline', 'pending', OFFLINE)
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
      reduceSyncIndicatorState(midRetry, 'syncing', 'synced', SYNCED)
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
      reduceSyncIndicatorState(midRetry, 'syncing', 'offline', OFFLINE)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'failure',
      text: { label: describeSyncOutcome(OFFLINE).label, autoHide: true },
    })

  })

  it('a fresh success after a failure clears the error text and shows a fading "Synced" instead', () => {

    expect(
      reduceSyncIndicatorState(afterAFailure, 'syncing', 'synced', SYNCED)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: describeSyncOutcome(SYNCED).label, autoHide: true },
    })

  })

  it('an attention item resolving into a clean success switches the icon from amber to green', () => {

    expect(
      reduceSyncIndicatorState(afterAttentionNeeded, 'syncing', 'synced', SYNCED)
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: describeSyncOutcome(SYNCED).label, autoHide: true },
    })

  })

})

describe('canTriggerManualSync - the "click the checkmark to sync now" guard (Phase 8)', () => {

  it('allows triggering when idle (the only status the success icon actually shows for)', () => {
    expect(canTriggerManualSync('synced')).toBe(true)
  })

  it('allows triggering when unavailable (a click from the failure/attention icon path is still safe, even though the UI never wires one up)', () => {
    expect(canTriggerManualSync('offline')).toBe(true)
  })

  it('refuses to trigger while a sync is pending (about to start)', () => {
    expect(canTriggerManualSync('pending')).toBe(false)
  })

  it('refuses to trigger while a sync is actively running - no duplicate/conflicting sync queued on top of one in flight', () => {
    expect(canTriggerManualSync('syncing')).toBe(false)
  })

})

describe('canReviewDifferencesFromBadge (Phase 6) - when the badge opens the resolution screen', () => {

  it('true only for the attention icon with the diverged outcome', () => {

    expect(canReviewDifferencesFromBadge('attention', DIVERGED)).toBe(true)

  })

  it('false for every other attention outcome - they each have a different next step', () => {

    for (const result of ALL_RESULTS) {
      const outcome = classifySyncOutcome(result)
      expect(canReviewDifferencesFromBadge('attention', outcome)).toBe(
        outcome.state === 'conflict'
      )
    }

  })

  it('false for any other icon, even with a diverged outcome still stored', () => {

    for (const icon of ['spinner', 'success', 'failure', null] as const) {
      expect(canReviewDifferencesFromBadge(icon, DIVERGED)).toBe(false)
    }

  })

  it('false with no outcome', () => {

    expect(canReviewDifferencesFromBadge('attention', null)).toBe(false)

  })

  it('after a resolution the outcome becomes synced, so the badge stops being a review button', () => {

    const afterResolve = reduceSyncIndicatorState(
      { icon: 'attention', text: null, hasCompletedOnce: true },
      'synced',
      'synced',
      SYNCED
    )

    expect(afterResolve.icon).toBe('success')
    expect(canReviewDifferencesFromBadge(afterResolve.icon, SYNCED)).toBe(false)

  })

})

describe('canShowDetailFromBadge - the detail line is reachable by tap (iPad), not hover', () => {

  it('true for the offline and needs-input outcomes, with the matching failure/attention icon', () => {

    expect(canShowDetailFromBadge('failure', OFFLINE)).toBe(true)
    expect(canShowDetailFromBadge('attention', NOT_SIGNED_IN)).toBe(true)

  })

  it('true for every result that lands in offline or needs-input, and no other', () => {

    for (const result of ALL_RESULTS) {
      const outcome = classifySyncOutcome(result)
      const icon = outcome.state === 'needs-input' ? 'attention' : 'failure'
      expect(canShowDetailFromBadge(icon, outcome)).toBe(
        outcome.state === 'offline' || outcome.state === 'needs-input'
      )
    }

  })

  it('false for conflict (tap opens the resolution screen) and for synced (tap is Sync now)', () => {

    expect(canShowDetailFromBadge('attention', DIVERGED)).toBe(false)
    expect(canShowDetailFromBadge('success', SYNCED)).toBe(false)

  })

  it('false while spinning, with no icon, or with no outcome', () => {

    expect(canShowDetailFromBadge('spinner', OFFLINE)).toBe(false)
    expect(canShowDetailFromBadge(null, OFFLINE)).toBe(false)
    expect(canShowDetailFromBadge('failure', null)).toBe(false)

  })

})
