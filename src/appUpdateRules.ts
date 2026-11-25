/*
  Pure rules for the "new version" UI, kept apart from the browser
  plumbing in appUpdate.ts so they can be tested directly.
*/

export type UpdateBannerKind = 'none' | 'update' | 'load-error'

/*
  - A failed chunk/file load is always worth telling the user about (the
    screen would otherwise be blank), but it never acts on its own.
  - A waiting new version is announced everywhere EXCEPT the timer screen
    with an active treatment, where the page must never be nudged toward
    a reload. It appears as soon as the user leaves that state.
*/
export function bannerKind(state: {
  updateReady: boolean
  timerActive: boolean
  loadFailed: boolean
}): UpdateBannerKind {

  if (state.loadFailed) {
    return 'load-error'
  }

  if (state.updateReady && !state.timerActive) {
    return 'update'
  }

  return 'none'

}

/*
  Browsers word the failure of a lazy-loaded file differently
  (Chrome/Edge, Firefox, Safari).
*/
export function isChunkLoadFailure(reason: unknown): boolean {

  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : ''

  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message)

}

export const LOAD_ERROR_TEXT = 'Reload to get the latest version.'

export const UPDATE_TEXT = 'Update available - reload'
