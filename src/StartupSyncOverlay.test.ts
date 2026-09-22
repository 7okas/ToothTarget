import { describe, expect, it, vi } from 'vitest'

/*
  Only reduceStartupSyncOverlayState() - the pure decision function -
  is tested here, not the component itself. Same constraint as
  SyncStatusIndicator.test.ts: this project has no React-rendering
  test harness, and importing StartupSyncOverlay.tsx at all (even just
  for this one export) pulls in the real auth.ts/cloudSyncScheduler.ts
  unless mocked - auth.ts instantiates MSAL (via authConfig.ts, which
  touches `window.location`) at module load time, crashing under
  Vitest's default 'node' environment.
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
  reduceStartupSyncOverlayState,
  INITIAL_STARTUP_SYNC_OVERLAY_STATE,
  type StartupSyncOverlayState,
} from './StartupSyncOverlay'

describe('reduceStartupSyncOverlayState - claims only the first sync attempt', () => {

  it('shows the syncing phase the first time status becomes pending', () => {

    expect(
      reduceStartupSyncOverlayState(INITIAL_STARTUP_SYNC_OVERLAY_STATE, 'pending')
    ).toEqual({ hasClaimedFirstAttempt: true, display: 'syncing' })

  })

  it('shows the syncing phase the first time status becomes syncing directly', () => {

    expect(
      reduceStartupSyncOverlayState(INITIAL_STARTUP_SYNC_OVERLAY_STATE, 'syncing')
    ).toEqual({ hasClaimedFirstAttempt: true, display: 'syncing' })

  })

  it('stays untouched while status is idle/unavailable before any attempt has started', () => {

    expect(
      reduceStartupSyncOverlayState(INITIAL_STARTUP_SYNC_OVERLAY_STATE, 'idle')
    ).toEqual(INITIAL_STARTUP_SYNC_OVERLAY_STATE)

    expect(
      reduceStartupSyncOverlayState(INITIAL_STARTUP_SYNC_OVERLAY_STATE, 'unavailable')
    ).toEqual(INITIAL_STARTUP_SYNC_OVERLAY_STATE)

  })

  it('resolves the claimed first attempt to success when it reaches idle', () => {

    const midFirstAttempt: StartupSyncOverlayState = {
      hasClaimedFirstAttempt: true,
      display: 'syncing',
    }

    expect(reduceStartupSyncOverlayState(midFirstAttempt, 'idle')).toEqual({
      hasClaimedFirstAttempt: true,
      display: 'success',
    })

  })

  it('resolves the claimed first attempt to error when it reaches unavailable', () => {

    const midFirstAttempt: StartupSyncOverlayState = {
      hasClaimedFirstAttempt: true,
      display: 'syncing',
    }

    expect(reduceStartupSyncOverlayState(midFirstAttempt, 'unavailable')).toEqual({
      hasClaimedFirstAttempt: true,
      display: 'error',
    })

  })

  it('never reacts to a second sync attempt this session, even after the first one is fully dismissed', () => {

    // The component's own auto-dismiss timer has already cleared
    // `display` back to null after the first attempt's brief
    // success/error phase.
    const afterFirstAttemptDismissed: StartupSyncOverlayState = {
      hasClaimedFirstAttempt: true,
      display: null,
    }

    // A second, later sync starts and resolves - the overlay must
    // stay untouched throughout (only the small badge reacts to this).
    const duringSecondAttempt = reduceStartupSyncOverlayState(
      afterFirstAttemptDismissed,
      'pending'
    )

    expect(duringSecondAttempt).toBe(afterFirstAttemptDismissed)

    const afterSecondAttemptResolves = reduceStartupSyncOverlayState(
      duringSecondAttempt,
      'idle'
    )

    expect(afterSecondAttemptResolves).toBe(afterFirstAttemptDismissed)

  })

  it('never reacts to a second attempt even if triggered before the first one\'s result phase is dismissed', () => {

    // Edge case: display is still 'success'/'error' (not yet cleared
    // by the timer) when something else changes status again -
    // should still never re-arm 'syncing' for a later attempt.
    const showingFirstAttemptResult: StartupSyncOverlayState = {
      hasClaimedFirstAttempt: true,
      display: 'success',
    }

    expect(
      reduceStartupSyncOverlayState(showingFirstAttemptResult, 'pending')
    ).toBe(showingFirstAttemptResult)

  })

})
