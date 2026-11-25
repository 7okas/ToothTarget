import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('public/sw.kill.js (kill switch)', () => {

  it('clears every toothtarget-* cache, unregisters itself and leaves other data alone', async () => {

    const listeners: Record<string, (event: unknown) => void> = {}

    const stores = new Set(['toothtarget-a1', 'toothtarget-b2', 'unrelated-cache'])

    const unregister = vi.fn(async () => true)
    const navigate = vi.fn()
    const skipWaiting = vi.fn()

    const localStorageTouched = vi.fn()

    runInNewContext(readFileSync('public/sw.kill.js', 'utf-8'), {
      self: {
        addEventListener: (type: string, listener: (event: unknown) => void) => {
          listeners[type] = listener
        },
        skipWaiting,
        registration: { unregister },
        clients: {
          matchAll: async () => [{ url: 'https://example.test/ToothTarget/', navigate }],
        },
      },
      caches: {
        keys: async () => [...stores],
        delete: async (name: string) => stores.delete(name),
      },
      localStorage: new Proxy({}, { get: localStorageTouched, set: localStorageTouched }),
    })

    listeners.install({})

    expect(skipWaiting).toHaveBeenCalled()

    let pending: Promise<unknown> = Promise.resolve()

    listeners.activate({ waitUntil: (promise: Promise<unknown>) => { pending = promise } })

    await pending

    expect([...stores]).toEqual(['unrelated-cache'])
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('https://example.test/ToothTarget/')
    expect(localStorageTouched).not.toHaveBeenCalled()

  })

})
