import { isChunkLoadFailure } from './appUpdateRules'

/*
  SERVICE WORKER UPDATE STATE (browser plumbing)

  A tiny external store the banner (UpdateBanner.tsx) and the Settings
  section (AppUpdateSettings.tsx) both read. Nothing in here ever
  reloads the page by itself: the only reload path is applyUpdate(),
  which is only called from a button press.

  Nothing in here reads or writes localStorage.
*/

export type AppUpdateState = {
  updateReady: boolean
  timerActive: boolean
  loadFailed: boolean
  versionLabel: string | null
}

let state: AppUpdateState = {
  updateReady: false,
  timerActive: false,
  loadFailed: false,
  versionLabel: null,
}

const listeners = new Set<() => void>()

function setState(patch: Partial<AppUpdateState>) {

  state = { ...state, ...patch }

  listeners.forEach(listener => listener())

}

export function subscribeAppUpdate(listener: () => void): () => void {

  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }

}

export function getAppUpdateState(): AppUpdateState {
  return state
}

export function setTimerActive(timerActive: boolean) {

  if (state.timerActive !== timerActive) {
    setState({ timerActive })
  }

}

let registration: ServiceWorkerRegistration | null = null

let reloadRequested = false

function trackRegistration(reg: ServiceWorkerRegistration) {

  registration = reg

  /*
    A worker that is already waiting, with a controller already in
    charge, is a NEW version (the very first install has no controller
    and must not be announced as an update).
  */
  if (reg.waiting && navigator.serviceWorker.controller) {
    setState({ updateReady: true })
  }

  reg.addEventListener('updatefound', () => {

    const installing = reg.installing

    installing?.addEventListener('statechange', () => {

      if (
        installing.state === 'installed' &&
        navigator.serviceWorker.controller
      ) {
        setState({ updateReady: true })
      }

    })

  })

}

async function loadVersionLabel() {

  try {

    const response = await fetch(
      `${import.meta.env.BASE_URL}version.json`,
      { cache: 'no-store' }
    )

    if (response.ok) {

      const data = await response.json()

      if (typeof data.label === 'string') {
        setState({ versionLabel: data.label })
      }

    }

  } catch {
    // Offline before anything is cached, or dev server: no label.
  }

}

export function startAppUpdates() {

  window.addEventListener('vite:preloadError', event => {
    event.preventDefault()
    setState({ loadFailed: true })
  })

  window.addEventListener('unhandledrejection', event => {

    if (isChunkLoadFailure(event.reason)) {
      setState({ loadFailed: true })
    }

  })

  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) {
    return
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {

    if (reloadRequested) {
      window.location.reload()
    }

  })

  window.addEventListener('load', () => {

    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .then(trackRegistration)
      .catch(error => {
        console.error('Service worker registration failed.', error)
      })
      .finally(loadVersionLabel)

  })

  /*
    An installed app can stay open for days; re-check for a new version
    whenever it comes back to the foreground. Checking only downloads
    sw.js - it never changes what is on screen.
  */
  document.addEventListener('visibilitychange', () => {

    if (document.visibilityState === 'visible') {
      registration?.update().catch(() => {})
    }

  })

}

/*
  The only way a new version takes over: the user pressed the button.
  The waiting worker is told to activate, and once it has taken control
  the page reloads exactly once.
*/
export function applyUpdate() {

  const waiting = registration?.waiting

  if (!waiting) {
    window.location.reload()
    return
  }

  reloadRequested = true

  waiting.postMessage({ type: 'SKIP_WAITING' })

}
