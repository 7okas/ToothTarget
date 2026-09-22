import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
  Same reasoning as cloudStorage.test.ts's own header comment: the real
  auth.ts instantiates MSAL (via authConfig.ts, which touches
  `window.location`) at module load time, which would crash under
  Vitest's default 'node' environment. vi.mock hoists above imports and
  replaces both modules entirely before cloudSyncOnlineRetry.ts ever
  evaluates its own imports of them.
*/

vi.mock('./auth', () => ({
  getActiveAccount: vi.fn(),
}))

vi.mock('./cloudSyncScheduler', () => ({
  requestCloudSyncIfSignedIn: vi.fn(),
}))

import { getActiveAccount } from './auth'
import { requestCloudSyncIfSignedIn } from './cloudSyncScheduler'
import { attachOnlineRetryListener } from './cloudSyncOnlineRetry'

const mockedGetActiveAccount = vi.mocked(getActiveAccount)
const mockedRequestCloudSyncIfSignedIn = vi.mocked(requestCloudSyncIfSignedIn)

/*
  attachOnlineRetryListener() attaches to the browser's `window` global
  - Vitest's default 'node' environment has none (same constraint noted
  above), so each test stands up a real EventTarget as `window` for its
  duration, rather than pulling in jsdom for the one DOM API this
  module actually uses. It's a genuine EventTarget, not a mock, so
  addEventListener/removeEventListener/dispatchEvent behave exactly as
  the browser's would for a plain 'online' Event.
*/

let originalWindow: unknown

beforeEach(() => {

  originalWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = new EventTarget()

  mockedGetActiveAccount.mockReset()
  mockedRequestCloudSyncIfSignedIn.mockReset()

})

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow
})

function fakeWindow(): EventTarget {
  return (globalThis as unknown as { window: EventTarget }).window
}

function dispatchOnline(): void {
  fakeWindow().dispatchEvent(new Event('online'))
}

describe('attachOnlineRetryListener', () => {

  it("requests a sync (signed in) when the browser's online event fires", () => {

    mockedGetActiveAccount.mockReturnValue(
      { homeAccountId: 'dentist-1' } as never
    )

    attachOnlineRetryListener()

    dispatchOnline()

    expect(mockedRequestCloudSyncIfSignedIn).toHaveBeenCalledTimes(1)
    expect(mockedRequestCloudSyncIfSignedIn).toHaveBeenCalledWith(true)

  })

  it('does not request a sync (still passes false through the same gate) when signed out', () => {

    mockedGetActiveAccount.mockReturnValue(null)

    attachOnlineRetryListener()

    dispatchOnline()

    expect(mockedRequestCloudSyncIfSignedIn).toHaveBeenCalledTimes(1)
    expect(mockedRequestCloudSyncIfSignedIn).toHaveBeenCalledWith(false)

  })

  it('fires once per online event, not once per listener call site', () => {

    mockedGetActiveAccount.mockReturnValue(
      { homeAccountId: 'dentist-1' } as never
    )

    attachOnlineRetryListener()

    dispatchOnline()
    dispatchOnline()
    dispatchOnline()

    expect(mockedRequestCloudSyncIfSignedIn).toHaveBeenCalledTimes(3)

  })

  it('stops listening once the returned cleanup function runs', () => {

    mockedGetActiveAccount.mockReturnValue(
      { homeAccountId: 'dentist-1' } as never
    )

    const detach = attachOnlineRetryListener()

    detach()

    dispatchOnline()

    expect(mockedRequestCloudSyncIfSignedIn).not.toHaveBeenCalled()

  })

})
