import { isChunkLoadFailure } from './appUpdateRules'

/*
  SERVICE WORKER UPDATE STATE (browser plumbing)

  A tiny external store the banner (UpdateBanner.tsx) and the Settings
  section (AppUpdateSettings.tsx) both read. Nothing in here ever
  reloads the page by itself: the only reload paths are applyUpdate()
  and resetAppCache(), and both are only called from a button press.

  Nothing in here reads or writes localStorage.
*/

export type UpdateCheckStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-ready'
  | 'error'

export type AppUpdateState = {
  updateReady: boolean
  timerActive: boolean
  loadFailed: boolean
  checkStatus: UpdateCheckStatus
  versionLabel: string | null
}

let state: AppUpdateState = {
  updateReady: false,
  timerActive: false,
  loadFailed: false,
  checkStatus: 'idle',
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

export async function checkForUpdates(): Promise<void> {

  if (!registration) {
    setState({ checkStatus: 'error' })
    return
  }

  setState({ checkStatus: 'checking' })

  try {

    await registration.update()

    const installing = registration.installing

    if (installing) {

      await new Promise<void>(resolve => {

        const timeout = window.setTimeout(resolve, 20000)

        installing.addEventListener('statechange', () => {

          if (installing.state === 'installed' || installing.state === 'redundant') {
            window.clearTimeout(timeout)
            resolve()
          }

        })

      })

    }

    setState({
      checkStatus: registration.waiting ? 'update-ready' : 'up-to-date',
      updateReady: Boolean(registration.waiting) || state.updateReady,
    })

  } catch {

    setState({ checkStatus: 'error' })

  }

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

/*
  Recovery button: unregisters the service worker and deletes ONLY the
  service worker's own caches (names starting "toothtarget-"), then
  reloads once. Patient data, treatments and sign-in live in
  localStorage, which this never touches.
*/
export async function resetAppCache(): Promise<void> {

  if ('serviceWorker' in navigator) {

    const registrations = await navigator.serviceWorker.getRegistrations()

    await Promise.all(registrations.map(reg => reg.unregister()))

  }

  if ('caches' in window) {

    const keys = await caches.keys()

    await Promise.all(
      keys
        .filter(key => key.startsWith('toothtarget-'))
        .map(key => caches.delete(key))
    )

  }

  window.location.reload()

}
