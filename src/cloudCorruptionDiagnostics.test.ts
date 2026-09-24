import { beforeEach, describe, expect, it } from 'vitest'

import {
  captureCloudCorruptionDiagnostics,
  readCloudCorruptionDiagnostics,
} from './cloudCorruptionDiagnostics'

/*
  Minimal in-memory Storage - same pattern used throughout this
  project's own test suite (see cloudSyncEngine.test.ts's own comment).
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

describe('captureCloudCorruptionDiagnostics / readCloudCorruptionDiagnostics', () => {

  it('round-trips raw content, error, and timestamp', () => {

    captureCloudCorruptionDiagnostics({
      rawContent: '{ not valid json',
      error: 'toothtarget-sync.json was downloaded but could not be parsed as JSON.',
      capturedAt: '2026-09-24T12:00:00.000Z',
    })

    expect(readCloudCorruptionDiagnostics()).toEqual({
      rawContent: '{ not valid json',
      error: 'toothtarget-sync.json was downloaded but could not be parsed as JSON.',
      capturedAt: '2026-09-24T12:00:00.000Z',
    })

  })

  it('overwrites the previous occurrence rather than accumulating a log', () => {

    captureCloudCorruptionDiagnostics({
      rawContent: 'first bad content',
      error: 'first error',
      capturedAt: '2026-09-01T00:00:00.000Z',
    })

    captureCloudCorruptionDiagnostics({
      rawContent: 'second bad content',
      error: 'second error',
      capturedAt: '2026-09-24T00:00:00.000Z',
    })

    const record = readCloudCorruptionDiagnostics()

    expect(record?.rawContent).toBe('second bad content')
    expect(record?.error).toBe('second error')

    // Only a single localStorage key is used - never a growing array/log.
    expect(localStorage.length).toBe(1)

  })

  it('returns null when nothing has ever been captured', () => {
    expect(readCloudCorruptionDiagnostics()).toBeNull()
  })

  it('returns null rather than throwing on a corrupted diagnostics entry itself', () => {

    localStorage.setItem('toothTargetCloudCorruptionDiagnostics', '{ not json')

    expect(readCloudCorruptionDiagnostics()).toBeNull()

  })

  it('does not throw when localStorage itself is unavailable/throws', () => {

    globalThis.localStorage = {
      getItem: () => { throw new Error('unavailable') },
      setItem: () => { throw new Error('unavailable') },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as Storage

    expect(() =>
      captureCloudCorruptionDiagnostics({
        rawContent: 'x',
        error: 'y',
        capturedAt: '2026-01-01T00:00:00.000Z',
      })
    ).not.toThrow()

    expect(readCloudCorruptionDiagnostics()).toBeNull()

  })

})
