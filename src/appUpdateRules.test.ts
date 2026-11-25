import { describe, expect, it } from 'vitest'
import { bannerKind, isChunkLoadFailure } from './appUpdateRules'

describe('bannerKind', () => {

  const idle = { updateReady: false, timerActive: false, loadFailed: false }

  it('shows nothing when there is nothing to say', () => {
    expect(bannerKind(idle)).toBe('none')
  })

  it('announces a waiting version on ordinary screens', () => {
    expect(bannerKind({ ...idle, updateReady: true })).toBe('update')
  })

  it('stays hidden while the timer screen has an active treatment', () => {
    expect(bannerKind({ ...idle, updateReady: true, timerActive: true })).toBe('none')
  })

  it('appears as soon as the treatment ends / the user leaves the timer', () => {
    expect(bannerKind({ updateReady: true, timerActive: true, loadFailed: false })).toBe('none')
    expect(bannerKind({ updateReady: true, timerActive: false, loadFailed: false })).toBe('update')
  })

  it('always reports a failed file load, even on the timer screen', () => {
    expect(bannerKind({ ...idle, loadFailed: true, timerActive: true })).toBe('load-error')
  })

})

describe('isChunkLoadFailure', () => {

  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/a-OLD.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/a.css',
  ])('recognises the browser wording: %s', message => {
    expect(isChunkLoadFailure(new Error(message))).toBe(true)
    expect(isChunkLoadFailure(message)).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isChunkLoadFailure(new Error('Something else broke'))).toBe(false)
    expect(isChunkLoadFailure(undefined)).toBe(false)
    expect(isChunkLoadFailure(42)).toBe(false)
  })

})
