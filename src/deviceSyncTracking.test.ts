import { beforeEach, describe, expect, it } from 'vitest'

import {
  recordDeviceSyncSuccess,
  getDeviceLastSyncAt,
  isDeviceSyncStale,
  STALE_DEVICE_THRESHOLD_MS,
} from './deviceSyncTracking'

/*
  Minimal, fully-typed in-memory Storage - same pattern used throughout
  this project's test suite (see cloudSyncEngine.test.ts/
  cloudMerge.test.ts).
*/
class MemoryStorage implements Storage {

  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage()
})

const NOW = '2026-06-15T12:00:00.000Z'

describe('recordDeviceSyncSuccess / getDeviceLastSyncAt', () => {

  it('returns null before any sync has ever been recorded', () => {
    expect(getDeviceLastSyncAt()).toBeNull()
  })

  it('returns exactly the timestamp last recorded', () => {

    recordDeviceSyncSuccess('2026-01-01T00:00:00.000Z')
    expect(getDeviceLastSyncAt()).toBe('2026-01-01T00:00:00.000Z')

    recordDeviceSyncSuccess('2026-02-01T00:00:00.000Z')
    expect(getDeviceLastSyncAt()).toBe('2026-02-01T00:00:00.000Z')

  })

  it('is device-local storage, not part of any synchronized entity array', () => {

    recordDeviceSyncSuccess(NOW)

    // Confirms this lives under its own dedicated key, never mixed into
    // one of the five cloud-synchronized keys.
    expect(localStorage.getItem('toothTargetPatients')).toBeNull()
    expect(localStorage.getItem('toothTargetDeviceLastSyncAt')).toBe(NOW)

  })

})

describe('isDeviceSyncStale', () => {

  it('is never stale when this device has never recorded a successful sync (first-ever sync is normal onboarding, not staleness)', () => {
    expect(isDeviceSyncStale(NOW)).toBe(false)
  })

  it('is not stale immediately after a sync', () => {
    recordDeviceSyncSuccess(NOW)
    expect(isDeviceSyncStale(NOW)).toBe(false)
  })

  it('is not stale for a device that syncs regularly (well within the threshold, repeatedly)', () => {

    let simulatedNow = Date.parse('2026-01-01T00:00:00.000Z')

    for (let week = 0; week < 12; week++) {

      const nowIso = new Date(simulatedNow).toISOString()

      // Each check happens BEFORE that week's sync updates the marker -
      // a device that has been syncing weekly must never see staleness
      // fire on any of these checks.
      expect(isDeviceSyncStale(nowIso)).toBe(false)

      recordDeviceSyncSuccess(nowIso)

      simulatedNow += 7 * 24 * 60 * 60 * 1000 // +1 week

    }

  })

  it('is not stale exactly at the threshold boundary', () => {

    const lastSync = '2026-01-01T00:00:00.000Z'
    recordDeviceSyncSuccess(lastSync)

    const atThreshold =
      new Date(Date.parse(lastSync) + STALE_DEVICE_THRESHOLD_MS).toISOString()

    expect(isDeviceSyncStale(atThreshold)).toBe(false)

  })

  it('is stale once more than the threshold has passed since the last successful sync', () => {

    const lastSync = '2026-01-01T00:00:00.000Z'
    recordDeviceSyncSuccess(lastSync)

    const justOverThreshold =
      new Date(
        Date.parse(lastSync) + STALE_DEVICE_THRESHOLD_MS + 1
      ).toISOString()

    expect(isDeviceSyncStale(justOverThreshold)).toBe(true)

  })

  it('respects a custom threshold override', () => {

    recordDeviceSyncSuccess('2026-01-01T00:00:00.000Z')

    const twoDaysLater = '2026-01-03T00:00:00.000Z'

    expect(isDeviceSyncStale(twoDaysLater, 24 * 60 * 60 * 1000)).toBe(true)
    expect(isDeviceSyncStale(twoDaysLater, 30 * 24 * 60 * 60 * 1000)).toBe(false)

  })

})
