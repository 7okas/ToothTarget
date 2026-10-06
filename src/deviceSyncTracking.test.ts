import { beforeEach, describe, expect, it } from 'vitest'

import {
  recordDeviceSyncSuccess,
  getDeviceLastSyncAt,
} from './deviceSyncTracking'

/*
  Minimal, fully-typed in-memory Storage - same pattern used throughout
  this project's test suite (see cloudSyncEngine.test.ts).
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
