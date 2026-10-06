import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./cloudSyncEngine', () => ({
  syncCloudNow: vi.fn(),
  pullCloudSnapshot: vi.fn(),
  markLocalDataDirty: vi.fn(),
}))

/*
  Phase 9 - cloudBackupRotation.ts's own module chain reaches
  cloudStorage.ts -> ./auth -> authConfig.ts, which touches
  `window.location` at module scope (same MSAL/window issue every
  other test file mocking a cloud module already documents) -
  mocked here purely to keep loading this file crash-free, not
  because its own rotation logic is under test here (see
  cloudBackupRotation.test.ts for that).
*/
vi.mock('./cloudBackupRotation', () => ({
  maybeRotateBackup: vi.fn(),
}))

import { syncCloudNow, pullCloudSnapshot } from './cloudSyncEngine'
import { maybeRotateBackup } from './cloudBackupRotation'
import {
  requestCloudSync,
  requestCloudSyncIfSignedIn,
  requestCloudPullIfSignedIn,
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  getLastSyncOutcome,
  subscribeLastSyncOutcome,
  getLocalDataVersion,
  subscribeLocalDataVersion,
  notifyLocalDataReplaced,
  reportResolutionApplied,
  __resetCloudSyncSchedulerForTests,
} from './cloudSyncScheduler'

const mockedSyncCloudNow = vi.mocked(syncCloudNow)
const mockedPullCloudSnapshot = vi.mocked(pullCloudSnapshot)
const mockedMaybeRotateBackup = vi.mocked(maybeRotateBackup)

/*
  Flushes pending microtasks - requestCloudSync() schedules work via
  queueMicrotask(), so tests need to yield back to the microtask queue
  (a plain `await` does this) before asserting on what the scheduler
  did. Awaiting a couple of times is enough to drain both the
  "schedule a flush" microtask and the .then()/.finally() chain
  syncCloudNow()'s own mocked promise resolves through.
*/
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  __resetCloudSyncSchedulerForTests()
  mockedSyncCloudNow.mockReset()
  mockedSyncCloudNow.mockResolvedValue({ status: 'synced' })
  mockedPullCloudSnapshot.mockReset()
  mockedPullCloudSnapshot.mockResolvedValue({ status: 'synced' })
  mockedMaybeRotateBackup.mockReset()
  mockedMaybeRotateBackup.mockResolvedValue(undefined)
})

describe('requestCloudSync - coalescing', () => {

  it('collapses multiple calls in the same synchronous turn into one sync', async () => {

    requestCloudSync()
    requestCloudSync()
    requestCloudSync()

    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

  })

  it('collapses multiple requests representing related mutation steps into one sync', async () => {

    // Simulates eg. patient-deletion's several synchronous writes,
    // each followed by its own requestCloudSync() call.
    function simulateMultiStepMutation() {
      requestCloudSync() // after removing the patient
      requestCloudSync() // after cleaning up saved treatments
      requestCloudSync() // after the tombstone is recorded
    }

    simulateMultiStepMutation()

    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

  })

  it('never calls syncCloudNow synchronously - it always defers to a microtask', () => {

    requestCloudSync()

    expect(mockedSyncCloudNow).not.toHaveBeenCalled()

  })

})

describe('requestCloudSync - changes during an active sync', () => {

  it('a second request while a sync is running causes exactly one follow-up sync', async () => {

    let resolveFirstSync: (value: Awaited<ReturnType<typeof syncCloudNow>>) => void =
      () => {}

    mockedSyncCloudNow.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirstSync = resolve
        })
    )

    requestCloudSync()

    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

    // A meaningful mutation happens while the first sync is in flight.
    requestCloudSync()

    // The first sync is still running - no second call yet.
    await flushMicrotasks()
    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

    resolveFirstSync({ status: 'synced' })

    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(2)

  })

  it('does not start two overlapping syncCloudNow calls', async () => {

    let resolveFirstSync: (value: Awaited<ReturnType<typeof syncCloudNow>>) => void =
      () => {}

    let concurrentCallCount = 0
    let maxConcurrentCalls = 0

    mockedSyncCloudNow.mockImplementation(() => {

      concurrentCallCount++
      maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCallCount)

      return new Promise(resolve => {
        resolveFirstSync = value => {
          concurrentCallCount--
          resolve(value)
        }
      })

    })

    requestCloudSync()
    await flushMicrotasks()

    requestCloudSync()
    requestCloudSync()
    await flushMicrotasks()

    resolveFirstSync({ status: 'synced' })
    await flushMicrotasks()

    expect(maxConcurrentCalls).toBe(1)

  })

})

describe('requestCloudSync - failure handling', () => {

  it('does not throw when syncCloudNow resolves with auth-failed', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'auth-failed' })

    expect(() => requestCloudSync()).not.toThrow()

    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

  })

  it('does not throw when syncCloudNow rejects unexpectedly', async () => {

    mockedSyncCloudNow.mockRejectedValueOnce(new Error('unexpected'))

    expect(() => requestCloudSync()).not.toThrow()

    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

    // The scheduler recovers cleanly - a later request still works.
    requestCloudSync()
    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(2)

  })

  it('a later meaningful mutation can retry after any failure status', async () => {

    for (const status of [
      { status: 'graph-error', detail: 'x' } as const,
      { status: 'validation-failed', detail: 'x' } as const,
      { status: 'permission-denied', detail: 'x' } as const,
    ]) {

      __resetCloudSyncSchedulerForTests()
      mockedSyncCloudNow.mockReset()
      mockedSyncCloudNow.mockResolvedValueOnce(status)
      mockedSyncCloudNow.mockResolvedValueOnce({ status: 'synced' })

      requestCloudSync()
      await flushMicrotasks()

      expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

      requestCloudSync()
      await flushMicrotasks()

      expect(mockedSyncCloudNow).toHaveBeenCalledTimes(2)

    }

  })

  it('does not retry on its own after a failure - no infinite loop, no repeated immediate calls', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({
      status: 'graph-error',
      detail: 'offline',
    })

    requestCloudSync()

    await flushMicrotasks(10)

    // No further requestCloudSync() call was made - syncCloudNow must
    // have been called exactly once, with nothing scheduling a retry
    // on a timer.
    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

  })

})

describe('requestCloudSync - success', () => {

  it('clears pending state after a successful sync (no dangling extra sync)', async () => {

    requestCloudSync()

    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

    await flushMicrotasks(10)

    // Nothing else requested a sync - it must still be exactly one.
    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

  })

  it('returns void synchronously and never blocks the caller', () => {

    const returnValue = requestCloudSync()

    expect(returnValue).toBeUndefined()

  })

})

describe('requestCloudSync - dated backup rotation hook (Phase 9)', () => {

  it('fires maybeRotateBackup() after a successful sync', async () => {

    requestCloudSync()

    await flushMicrotasks()

    expect(mockedMaybeRotateBackup).toHaveBeenCalledTimes(1)

  })

  it('does not fire maybeRotateBackup() after a failed sync', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({
      status: 'auth-failed',
    })

    requestCloudSync()

    await flushMicrotasks()

    expect(mockedMaybeRotateBackup).not.toHaveBeenCalled()

  })

})

describe('requestCloudSyncIfSignedIn - automatic triggers (Phase 2)', () => {

  it('starts a sync when already signed in (eg. app load with a cached account)', async () => {

    requestCloudSyncIfSignedIn(true)

    await flushMicrotasks()

    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

  })

  it('does not start, or even schedule, a sync when signed out', async () => {

    requestCloudSyncIfSignedIn(false)

    await flushMicrotasks(10)

    expect(mockedSyncCloudNow).not.toHaveBeenCalled()
    expect(getCloudSyncStatus()).toBe('synced')

  })

  it('a fresh sign-in (isSignedIn: true) behaves exactly like requestCloudSync()', async () => {

    expect(getCloudSyncStatus()).toBe('synced')

    requestCloudSyncIfSignedIn(true)

    expect(getCloudSyncStatus()).toBe('pending')

    await flushMicrotasks()

    expect(getCloudSyncStatus()).toBe('synced')
    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

  })

})

describe('requestCloudPullIfSignedIn - app open / fresh sign-in / gate retry (Phase 5)', () => {

  it('calls pullCloudSnapshot(), not syncCloudNow(), when signed in', async () => {

    requestCloudPullIfSignedIn(true)

    await flushMicrotasks()

    expect(mockedPullCloudSnapshot).toHaveBeenCalledTimes(1)
    expect(mockedSyncCloudNow).not.toHaveBeenCalled()

  })

  it('does not start, or even schedule, a pull when signed out', async () => {

    requestCloudPullIfSignedIn(false)

    await flushMicrotasks(10)

    expect(mockedPullCloudSnapshot).not.toHaveBeenCalled()
    expect(mockedSyncCloudNow).not.toHaveBeenCalled()
    expect(getCloudSyncStatus()).toBe('synced')

  })

  it('a pull request always wins over an already-pending push', async () => {

    requestCloudSync() // queues a push
    requestCloudPullIfSignedIn(true) // upgrades the pending operation to a pull

    await flushMicrotasks()

    expect(mockedPullCloudSnapshot).toHaveBeenCalledTimes(1)
    expect(mockedSyncCloudNow).not.toHaveBeenCalled()

  })

  it('a push requested while a pull is still only PENDING (not yet started) does not downgrade it back to a push', async () => {

    requestCloudPullIfSignedIn(true)
    requestCloudSync()

    await flushMicrotasks()

    expect(mockedPullCloudSnapshot).toHaveBeenCalledTimes(1)
    expect(mockedSyncCloudNow).not.toHaveBeenCalled()

  })

})

describe('cloud sync status', () => {

  it('reports idle, pending, syncing, then idle again for a successful sync', async () => {

    expect(getCloudSyncStatus()).toBe('synced')

    let resolveSync: (value: Awaited<ReturnType<typeof syncCloudNow>>) => void =
      () => {}

    mockedSyncCloudNow.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveSync = resolve
        })
    )

    requestCloudSync()

    expect(getCloudSyncStatus()).toBe('pending')

    await flushMicrotasks()

    expect(getCloudSyncStatus()).toBe('syncing')

    resolveSync({ status: 'synced' })

    await flushMicrotasks()

    expect(getCloudSyncStatus()).toBe('synced')

  })

  it('starts as synced before any attempt has run (no outcome yet)', () => {

    expect(getCloudSyncStatus()).toBe('synced')
    expect(getLastSyncOutcome()).toBeNull()

  })

  it.each([
    ['auth-failed', { status: 'auth-failed' } as const, 'needs-input'],
    ['permission-denied', { status: 'permission-denied', detail: 'x' } as const, 'needs-input'],
    ['validation-failed', { status: 'validation-failed', detail: 'x' } as const, 'needs-input'],
    ['network-unreachable', { status: 'network-unreachable', detail: 'x' } as const, 'offline'],
    ['graph-error', { status: 'graph-error', detail: 'x' } as const, 'offline'],
    ['cloud-committed-locally-pending', { status: 'cloud-committed-locally-pending', detail: 'x' } as const, 'offline'],
    ['diverged', { status: 'diverged', detail: 'x' } as const, 'conflict'],
    ['synced', { status: 'synced' } as const, 'synced'],
  ])('a %s result sets the status to %s', async (_name, result, expected) => {

    mockedSyncCloudNow.mockResolvedValueOnce(result)

    requestCloudSync()
    await flushMicrotasks()

    expect(getCloudSyncStatus()).toBe(expected)

  })

  it('notifies subscribers when a failed sync changes the status', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'auth-failed' })

    const listener = vi.fn()
    const unsubscribe = subscribeCloudSyncStatus(listener)

    requestCloudSync()
    await flushMicrotasks()

    expect(getCloudSyncStatus()).toBe('needs-input')
    expect(listener).toHaveBeenCalled()

    unsubscribe()

  })

})

describe('lastSyncOutcome (Phase 6 - failure differentiation)', () => {

  it('is null before any sync attempt has ever resolved', () => {
    expect(getLastSyncOutcome()).toBeNull()
  })

  it('classifies a clean success as "synced"', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'synced' })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLastSyncOutcome()).toEqual({ state: 'synced', detail: 'Synced' })

  })

  it('classifies auth-failed as "not-signed-in", not a generic failure', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'auth-failed' })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLastSyncOutcome()).toEqual({ state: 'needs-input', detail: 'Your Microsoft sign-in has expired — please sign in again' })

  })

  it('classifies network-unreachable as "offline"', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({
      status: 'network-unreachable',
      detail: 'Failed to fetch',
    })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLastSyncOutcome()).toEqual({ state: 'offline', detail: "No internet connection — will sync once you're back online" })

  })

  it('classifies graph-error as "onedrive-unavailable" - distinct from offline', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({
      status: 'graph-error',
      detail: '503',
    })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLastSyncOutcome()).toEqual({ state: 'offline', detail: "Couldn't reach OneDrive — will try again automatically" })

  })

  it('updates on every resolved attempt, overwriting the previous outcome', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'auth-failed' })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLastSyncOutcome()).toEqual({ state: 'needs-input', detail: 'Your Microsoft sign-in has expired — please sign in again' })

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'synced' })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLastSyncOutcome()).toEqual({ state: 'synced', detail: 'Synced' })

  })

  it('notifies subscribers whenever the outcome changes', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({
      status: 'permission-denied',
      detail: 'accessDenied',
    })

    const listener = vi.fn()
    const unsubscribe = subscribeLastSyncOutcome(listener)

    requestCloudSync()
    await flushMicrotasks()

    expect(listener).toHaveBeenCalled()
    expect(getLastSyncOutcome()).toEqual({ state: 'needs-input', detail: 'OneDrive access was denied — please sign in again' })

    unsubscribe()

  })

  it('is reset to null by __resetCloudSyncSchedulerForTests', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'auth-failed' })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLastSyncOutcome()).not.toBeNull()

    __resetCloudSyncSchedulerForTests()

    expect(getLastSyncOutcome()).toBeNull()

  })

})

describe('localDataVersion (UI refresh signal)', () => {

  it('starts at 0', () => {
    expect(getLocalDataVersion()).toBe(0)
  })

  it('bumps on a clean "synced" result', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'synced' })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLocalDataVersion()).toBe(1)

  })

  it('does NOT bump on failure statuses - nothing was committed locally', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'auth-failed' })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLocalDataVersion()).toBe(0)

  })

  it('does NOT bump on cloud-committed-locally-pending - the local commit itself failed', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({
      status: 'cloud-committed-locally-pending',
      detail: 'quota exceeded',
    })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLocalDataVersion()).toBe(0)

  })

  it('bumps once per successful attempt, not once per requestCloudSync() call coalesced into it', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'synced' })

    requestCloudSync()
    requestCloudSync()
    requestCloudSync()
    await flushMicrotasks()

    expect(getLocalDataVersion()).toBe(1)

  })

  it('notifies subscribers exactly when it bumps', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'synced' })

    const listener = vi.fn()
    const unsubscribe = subscribeLocalDataVersion(listener)

    requestCloudSync()
    await flushMicrotasks()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getLocalDataVersion()).toBe(1)

    unsubscribe()

  })

  it('does not notify subscribers on a failed attempt', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'network-unreachable', detail: 'offline' })

    const listener = vi.fn()
    const unsubscribe = subscribeLocalDataVersion(listener)

    requestCloudSync()
    await flushMicrotasks()

    expect(listener).not.toHaveBeenCalled()

    unsubscribe()

  })

  it('is reset to 0 by __resetCloudSyncSchedulerForTests', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'synced' })

    requestCloudSync()
    await flushMicrotasks()

    expect(getLocalDataVersion()).toBe(1)

    __resetCloudSyncSchedulerForTests()

    expect(getLocalDataVersion()).toBe(0)

  })

})

describe('Phase 6 resolution hooks (not called by anything yet)', () => {

  it('notifyLocalDataReplaced bumps the local data version and nothing else', () => {

    const listener = vi.fn()
    const unsubscribe = subscribeLocalDataVersion(listener)

    notifyLocalDataReplaced()

    expect(getLocalDataVersion()).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getLastSyncOutcome()).toBeNull()
    expect(mockedMaybeRotateBackup).not.toHaveBeenCalled()
    expect(mockedSyncCloudNow).not.toHaveBeenCalled()

    unsubscribe()

  })

  it('reportResolutionApplied records a clean synced outcome, idle status, refreshes data, rotates the backup, and starts no sync', () => {

    mockedMaybeRotateBackup.mockResolvedValue(undefined)

    reportResolutionApplied()

    expect(getLastSyncOutcome()).toEqual({ state: 'synced', detail: 'Synced' })
    expect(getCloudSyncStatus()).toBe('synced')
    expect(getLocalDataVersion()).toBe(1)
    expect(mockedMaybeRotateBackup).toHaveBeenCalledTimes(1)
    expect(mockedSyncCloudNow).not.toHaveBeenCalled()
    expect(mockedPullCloudSnapshot).not.toHaveBeenCalled()

  })

})
