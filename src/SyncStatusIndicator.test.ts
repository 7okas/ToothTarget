import { describe, expect, it, vi } from 'vitest'

/*
  Only computeSyncStatusDisplay() - the pure decision function - is
  tested here, not the component itself. This project has no
  React-rendering test harness (no jsdom/testing-library dependency;
  see cloudSyncEngine.ts's/cloudStorage.test.ts's own comments on why
  auth.ts in particular can't load under Vitest's default 'node'
  environment), so the meaningful, non-trivial logic - "given the
  previous and current scheduler status, what should the indicator
  show" - is kept as a plain function specifically so it can be tested
  without one. The actual wiring (useSyncExternalStore, the 10s
  auto-hide timers, the signed-in gate) is thin glue over this.

  SyncStatusIndicator.tsx still imports the real auth.ts/
  cloudSyncScheduler.ts at the top of the file (for its default
  component export), so importing it here at all - even just to reach
  computeSyncStatusDisplay() - needs the same vi.mock('./auth', ...)
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

import { computeSyncStatusDisplay } from './SyncStatusIndicator'

describe('computeSyncStatusDisplay', () => {

  it('shows "Syncing…" while pending', () => {
    expect(computeSyncStatusDisplay('idle', 'pending')).toEqual({
      label: 'Syncing…',
      autoHide: false,
      tone: 'neutral',
    })
  })

  it('shows "Syncing…" while actively syncing', () => {
    expect(computeSyncStatusDisplay('pending', 'syncing')).toEqual({
      label: 'Syncing…',
      autoHide: false,
      tone: 'neutral',
    })
  })

  it('shows "Synced" (auto-hiding) on a fresh pending/syncing -> idle transition', () => {

    expect(computeSyncStatusDisplay('syncing', 'idle')).toEqual({
      label: 'Synced',
      autoHide: true,
      tone: 'success',
    })

    expect(computeSyncStatusDisplay('pending', 'idle')).toEqual({
      label: 'Synced',
      autoHide: true,
      tone: 'success',
    })

  })

  it('shows nothing for idle that was not just reached from pending/syncing', () => {

    // The common, long-settled case, including the very first render
    // of a session that has never synced yet.
    expect(computeSyncStatusDisplay('idle', 'idle')).toBeNull()

    // Also covers an 'idle' reached from 'unavailable', which is not
    // a "sync just succeeded" transition either.
    expect(computeSyncStatusDisplay('unavailable', 'idle')).toBeNull()

  })

  it('shows "Sync error" (auto-hiding) on a fresh pending/syncing -> unavailable transition', () => {

    expect(computeSyncStatusDisplay('syncing', 'unavailable')).toEqual({
      label: 'Sync error',
      autoHide: true,
      tone: 'error',
    })

    expect(computeSyncStatusDisplay('pending', 'unavailable')).toEqual({
      label: 'Sync error',
      autoHide: true,
      tone: 'error',
    })

  })

  it('never re-shows "Sync error" for an unavailable status that is just sitting there (no permanent banner)', () => {
    expect(computeSyncStatusDisplay('unavailable', 'unavailable')).toBeNull()
  })

})
