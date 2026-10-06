import { describe, expect, it, vi } from 'vitest'
import { signInAgain, startSyncNow } from './badgePanelActions'

describe('startSyncNow - the "Sync now" button', () => {

  it.each(['synced', 'offline', 'conflict', 'needs-input'] as const)(
    'with status "%s" it starts a pull-first sync and says so',
    status => {
      const requestPull = vi.fn()
      expect(startSyncNow(status, { requestPull })).toBe('started')
      expect(requestPull).toHaveBeenCalledTimes(1)
      expect(requestPull).toHaveBeenCalledWith(true)
    }
  )

  it.each(['syncing', 'pending'] as const)(
    'does nothing while a sync is already running or queued ("%s"): no second sync',
    status => {
      const requestPull = vi.fn()
      expect(startSyncNow(status, { requestPull })).toBe('blocked')
      expect(requestPull).not.toHaveBeenCalled()
    }
  )

  it('a second tap right after the first is blocked once the sync has been queued', () => {
    // The first tap queues a pull; the status becomes "pending" immediately.
    const requestPull = vi.fn()
    expect(startSyncNow('offline', { requestPull })).toBe('started')
    expect(startSyncNow('pending', { requestPull })).toBe('blocked')
    expect(requestPull).toHaveBeenCalledTimes(1)
  })

})

describe('signInAgain - the "Sign in again" button', () => {

  function deps(overrides: Partial<Parameters<typeof signInAgain>[0]> = {}) {
    return {
      signIn: vi.fn(async () => ({ account: { homeAccountId: 'acct-1' }, error: null })),
      reconcileAccount: vi.fn(() => 'same-account'),
      requestPull: vi.fn(),
      ...overrides,
    }
  }

  it('signs in, checks the account, then requests a pull - the same steps as Settings and the gate', async () => {
    const calls: string[] = []
    const d = deps({
      signIn: vi.fn(async () => { calls.push('signIn'); return { account: { homeAccountId: 'acct-1' }, error: null } }),
      reconcileAccount: vi.fn(() => { calls.push('reconcile'); return 'same-account' }),
      requestPull: vi.fn(() => { calls.push('pull') }),
    })
    expect(await signInAgain(d)).toEqual({ kind: 'signed-in' })
    expect(calls).toEqual(['signIn', 'reconcile', 'pull'])
    expect(d.reconcileAccount).toHaveBeenCalledWith('acct-1')
    expect(d.requestPull).toHaveBeenCalledWith(true)
  })

  it('a first-ever account on this device is treated like a normal sign-in', async () => {
    const d = deps({ reconcileAccount: vi.fn(() => 'first-account') })
    expect(await signInAgain(d)).toEqual({ kind: 'signed-in' })
    expect(d.requestPull).toHaveBeenCalledTimes(1)
  })

  it('a different account asks the caller to reload, and does NOT request a sync first', async () => {
    const d = deps({ reconcileAccount: vi.fn(() => 'switched-account') })
    expect(await signInAgain(d)).toEqual({ kind: 'switched-account' })
    expect(d.requestPull).not.toHaveBeenCalled()
  })

  it('a failed or cancelled sign-in reports its message and starts no sync', async () => {
    const d = deps({
      signIn: vi.fn(async () => ({ account: null, error: 'The sign-in window was closed.' })),
    })
    expect(await signInAgain(d)).toEqual({ kind: 'failed', message: 'The sign-in window was closed.' })
    expect(d.reconcileAccount).not.toHaveBeenCalled()
    expect(d.requestPull).not.toHaveBeenCalled()
  })

  it('a result with neither an account nor an error is treated as a failure, never a silent success', async () => {
    const d = deps({
      signIn: vi.fn(async () => ({ account: null, error: '' })),
    })
    expect(await signInAgain(d)).toEqual({ kind: 'failed', message: 'Sign-in did not complete.' })
    expect(d.requestPull).not.toHaveBeenCalled()
  })

})
