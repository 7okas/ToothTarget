import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./cloudSyncEngine', () => ({
  syncCloudNow: vi.fn(),
}))

import { syncCloudNow } from './cloudSyncEngine'
import {
  requestCloudSync,
  requestCloudSyncIfSignedIn,
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  __resetCloudSyncSchedulerForTests,
} from './cloudSyncScheduler'

const mockedSyncCloudNow = vi.mocked(syncCloudNow)

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
  mockedSyncCloudNow.mockResolvedValue({
    status: 'synced',
    patientNumberConflicts: [],
  })
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

    resolveFirstSync({ status: 'synced', patientNumberConflicts: [] })

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

    resolveFirstSync({ status: 'synced', patientNumberConflicts: [] })
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
      { status: 'contention', attempts: 3 } as const,
      { status: 'validation-failed', detail: 'x' } as const,
      { status: 'permission-denied', detail: 'x' } as const,
    ]) {

      __resetCloudSyncSchedulerForTests()
      mockedSyncCloudNow.mockReset()
      mockedSyncCloudNow.mockResolvedValueOnce(status)
      mockedSyncCloudNow.mockResolvedValueOnce({
        status: 'synced',
        patientNumberConflicts: [],
      })

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
    expect(getCloudSyncStatus()).toBe('idle')

  })

  it('a fresh sign-in (isSignedIn: true) behaves exactly like requestCloudSync()', async () => {

    expect(getCloudSyncStatus()).toBe('idle')

    requestCloudSyncIfSignedIn(true)

    expect(getCloudSyncStatus()).toBe('pending')

    await flushMicrotasks()

    expect(getCloudSyncStatus()).toBe('idle')
    expect(mockedSyncCloudNow).toHaveBeenCalledTimes(1)

  })

})

describe('cloud sync status', () => {

  it('reports idle, pending, syncing, then idle again for a successful sync', async () => {

    expect(getCloudSyncStatus()).toBe('idle')

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

    resolveSync({ status: 'synced', patientNumberConflicts: [] })

    await flushMicrotasks()

    expect(getCloudSyncStatus()).toBe('idle')

  })

  it('reports unavailable after a failed sync, and notifies subscribers', async () => {

    mockedSyncCloudNow.mockResolvedValueOnce({ status: 'auth-failed' })

    const listener = vi.fn()
    const unsubscribe = subscribeCloudSyncStatus(listener)

    requestCloudSync()
    await flushMicrotasks()

    expect(getCloudSyncStatus()).toBe('unavailable')
    expect(listener).toHaveBeenCalled()

    unsubscribe()

  })

})
