import { describe, expect, it, vi } from 'vitest'

/*
  Only reduceSyncIndicatorState() - the pure decision function - is
  tested here, not the component itself. This project has no
  React-rendering test harness (no jsdom/testing-library dependency;
  see cloudSyncEngine.ts's/cloudStorage.test.ts's own comments on why
  auth.ts in particular can't load under Vitest's default 'node'
  environment), so the meaningful, non-trivial logic - "given the
  previous indicator state and the previous/current scheduler status,
  what should the indicator show now" - is kept as a plain reducer
  specifically so it can be tested without one. The actual wiring
  (useSyncExternalStore, the 10s auto-hide timer for the TEXT only,
  the signed-out "Sign in needed" branch) is thin glue over this and
  is not covered here - see this file's own header note in the report
  for that limitation.

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
}))

import {
  reduceSyncIndicatorState,
  INITIAL_SYNC_INDICATOR_STATE,
  type SyncIndicatorState,
} from './SyncStatusIndicator'

describe('reduceSyncIndicatorState - while syncing', () => {

  it('shows the spinner icon + "Syncing…" text while pending, from the initial state', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'idle', 'pending')
    ).toEqual({
      hasCompletedOnce: false,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    })

  })

  it('shows the spinner icon + "Syncing…" text while actively syncing', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'pending', 'syncing')
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
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'idle', 'idle')
    ).toEqual({
      hasCompletedOnce: false,
      icon: null,
      text: null,
    })

  })

  it('shows nothing for a settled unavailable status reached with no prior pending/syncing', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'idle', 'unavailable')
    ).toEqual({
      hasCompletedOnce: false,
      icon: null,
      text: null,
    })

  })

})

describe('reduceSyncIndicatorState - a sync attempt just completed (fresh transition)', () => {

  it('on success: green checkmark icon + "Synced" text that auto-hides', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'syncing', 'idle')
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: 'Synced', autoHide: true },
    })

  })

  it('on failure: red X icon + "Sync error" text that does NOT auto-hide', () => {

    expect(
      reduceSyncIndicatorState(INITIAL_SYNC_INDICATOR_STATE, 'syncing', 'unavailable')
    ).toEqual({
      hasCompletedOnce: true,
      icon: 'failure',
      text: { label: 'Sync error', autoHide: false },
    })

  })

})

describe('reduceSyncIndicatorState - the icon persists indefinitely once a sync has completed', () => {

  const afterASuccess: SyncIndicatorState = {
    hasCompletedOnce: true,
    icon: 'success',
    text: { label: 'Synced', autoHide: true },
  }

  const afterAFailure: SyncIndicatorState = {
    hasCompletedOnce: true,
    icon: 'failure',
    text: { label: 'Sync error', autoHide: false },
  }

  it('keeps showing the checkmark, with no text, for a long-settled idle status', () => {

    // Simulates the component's own text-autohide timer having
    // already cleared `text` back to null well before this later,
    // unrelated idle->idle re-render.
    const settled: SyncIndicatorState = { ...afterASuccess, text: null }

    expect(reduceSyncIndicatorState(settled, 'idle', 'idle')).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: null,
    })

  })

  it('keeps showing the red X, with no re-shown text, for a failure just sitting there', () => {

    expect(reduceSyncIndicatorState(afterAFailure, 'unavailable', 'unavailable')).toEqual({
      hasCompletedOnce: true,
      icon: 'failure',
      text: null,
    })

  })

  it('a retry after a failure shows the spinner (temporarily) rather than the red X', () => {

    expect(
      reduceSyncIndicatorState(afterAFailure, 'unavailable', 'pending')
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

    expect(reduceSyncIndicatorState(midRetry, 'syncing', 'idle')).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: 'Synced', autoHide: true },
    })

  })

  it('a retry that fails again keeps the icon on red X (never regresses to no icon)', () => {

    const midRetry: SyncIndicatorState = {
      hasCompletedOnce: true,
      icon: 'spinner',
      text: { label: 'Syncing…', autoHide: false },
    }

    expect(reduceSyncIndicatorState(midRetry, 'syncing', 'unavailable')).toEqual({
      hasCompletedOnce: true,
      icon: 'failure',
      text: { label: 'Sync error', autoHide: false },
    })

  })

  it('a fresh success after a failure clears the error text and shows a fading "Synced" instead', () => {

    expect(reduceSyncIndicatorState(afterAFailure, 'syncing', 'idle')).toEqual({
      hasCompletedOnce: true,
      icon: 'success',
      text: { label: 'Synced', autoHide: true },
    })

  })

})
