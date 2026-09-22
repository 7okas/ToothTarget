import { describe, expect, it, vi } from 'vitest'
import { signOutWithBestEffortSync } from './cloudSyncSignOut'
import type { CloudSyncResult } from './cloudSyncEngine'

/*
  This module has zero real runtime imports (only a type-only one,
  erased at compile time), so unlike most other sync-related test
  files in this project, no vi.mock('./auth', ...) is needed here at
  all - both steps are passed in directly as plain mock functions.
*/

describe('signOutWithBestEffortSync', () => {

  it('attempts a sync before signing out', async () => {

    const callOrder: string[] = []

    const attemptSync = vi.fn<() => Promise<CloudSyncResult>>(async () => {
      callOrder.push('sync')
      return { status: 'synced', patientNumberConflicts: [] }
    })

    const performSignOut = vi.fn(async () => {
      callOrder.push('signOut')
    })

    await signOutWithBestEffortSync(attemptSync, performSignOut)

    expect(callOrder).toEqual(['sync', 'signOut'])
    expect(attemptSync).toHaveBeenCalledTimes(1)
    expect(performSignOut).toHaveBeenCalledTimes(1)

  })

  it('still signs out even when the sync attempt throws (eg. offline)', async () => {

    const attemptSync = vi.fn(async () => {
      throw new Error('offline')
    })

    const performSignOut = vi.fn(async () => {})

    await expect(
      signOutWithBestEffortSync(attemptSync, performSignOut)
    ).resolves.toBeUndefined()

    expect(performSignOut).toHaveBeenCalledTimes(1)

  })

  it('still signs out even when the sync attempt resolves with a failure status', async () => {

    const attemptSync = vi.fn(async () => ({ status: 'auth-failed' }) as const)
    const performSignOut = vi.fn(async () => {})

    await signOutWithBestEffortSync(attemptSync, performSignOut)

    expect(performSignOut).toHaveBeenCalledTimes(1)

  })

  it('never throws itself, even if signing out fails', async () => {

    const attemptSync = vi.fn<() => Promise<CloudSyncResult>>(
      async () => ({ status: 'synced', patientNumberConflicts: [] })
    )

    const performSignOut = vi.fn(async () => {
      throw new Error('logout popup blocked')
    })

    await expect(
      signOutWithBestEffortSync(attemptSync, performSignOut)
    ).rejects.toThrow('logout popup blocked')

    /*
      Unlike the sync attempt, a sign-out failure is NOT swallowed -
      this module only ever protects the sync step from blocking
      sign-out, not the other way around. (auth.ts's own signOut()
      already has its own internal fallback to still clear the local
      active account even if the logout popup itself fails - this
      module doesn't need to duplicate that.)
    */

  })

})
