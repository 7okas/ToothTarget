import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getResolutionScreenOpen,
  subscribeResolutionScreen,
  openResolutionScreen,
  closeResolutionScreen,
  subscribeResolutionResolved,
  notifyResolutionResolved,
  getSafetyCopiesScreenOpen,
  subscribeSafetyCopiesScreen,
  openSafetyCopiesScreen,
  closeSafetyCopiesScreen,
  __resetResolutionStoreForTests,
} from './syncResolutionStore'

beforeEach(() => {
  __resetResolutionStoreForTests()
})

describe('resolution screen open/close store', () => {

  it('starts closed; open and close toggle it and notify', () => {

    const listener = vi.fn()
    const unsubscribe = subscribeResolutionScreen(listener)

    expect(getResolutionScreenOpen()).toBe(false)

    openResolutionScreen()
    expect(getResolutionScreenOpen()).toBe(true)

    closeResolutionScreen()
    expect(getResolutionScreenOpen()).toBe(false)

    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()

  })

  it('does not notify when the state does not change', () => {

    const listener = vi.fn()
    subscribeResolutionScreen(listener)

    closeResolutionScreen()
    openResolutionScreen()
    openResolutionScreen()

    expect(listener).toHaveBeenCalledTimes(1)

  })

  it('unsubscribe stops notifications', () => {

    const listener = vi.fn()
    const unsubscribe = subscribeResolutionScreen(listener)

    unsubscribe()
    openResolutionScreen()

    expect(listener).not.toHaveBeenCalled()

  })

})

describe('resolution resolved event', () => {

  it('notifies each subscriber once per event, and not after unsubscribe', () => {

    const a = vi.fn()
    const b = vi.fn()

    const unsubscribeA = subscribeResolutionResolved(a)
    subscribeResolutionResolved(b)

    notifyResolutionResolved()

    unsubscribeA()

    notifyResolutionResolved()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)

  })

  it('opening or closing the screen is not a "resolved" event', () => {

    const resolved = vi.fn()
    subscribeResolutionResolved(resolved)

    openResolutionScreen()
    closeResolutionScreen()

    expect(resolved).not.toHaveBeenCalled()

  })

})

describe('safety-copies screen store', () => {

  it('opens and closes independently of the resolution screen, notifying only on change', () => {

    const listener = vi.fn()
    subscribeSafetyCopiesScreen(listener)

    expect(getSafetyCopiesScreenOpen()).toBe(false)

    openSafetyCopiesScreen()
    openSafetyCopiesScreen()

    expect(getSafetyCopiesScreenOpen()).toBe(true)
    expect(getResolutionScreenOpen()).toBe(false)

    closeSafetyCopiesScreen()

    expect(getSafetyCopiesScreenOpen()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

  })

})
