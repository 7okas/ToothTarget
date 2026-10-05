/*
  RESOLUTION SCREEN STORE (Phase 6, step 6)

  Tiny get/subscribe module store (the same pattern auth.ts's
  active-account store and cloudSyncScheduler.ts's status stores use,
  read through useSyncExternalStore) holding two facts the screen's
  neighbours need to share:

    - is the resolution screen open (the startup gate and the sync
      badge ask to open it; the screen itself closes it), and
    - "a resolution just completed" - a one-shot event the startup gate
      listens for, so it can proceed once the dentist has resolved
      the divergence that was holding it.

  Also holds whether the safety-copies list (Restore) screen is open.

  No sync logic and no I/O here.
*/

let open = false

const openListeners = new Set<() => void>()

export function getResolutionScreenOpen(): boolean {
  return open
}

export function subscribeResolutionScreen(listener: () => void): () => void {

  openListeners.add(listener)

  return () => {
    openListeners.delete(listener)
  }

}

function setOpen(next: boolean): void {

  if (next === open) {
    return
  }

  open = next

  for (const listener of openListeners) {
    listener()
  }

}

export function openResolutionScreen(): void {
  setOpen(true)
}

export function closeResolutionScreen(): void {
  setOpen(false)
}

const resolvedListeners = new Set<() => void>()

/* Fires every listener once, each time a resolution completes. */
export function subscribeResolutionResolved(listener: () => void): () => void {

  resolvedListeners.add(listener)

  return () => {
    resolvedListeners.delete(listener)
  }

}

export function notifyResolutionResolved(): void {

  for (const listener of resolvedListeners) {
    listener()
  }

}

/* ---------- safety-copies (Restore) screen ---------- */

let safetyCopiesOpen = false

const safetyCopiesListeners = new Set<() => void>()

export function getSafetyCopiesScreenOpen(): boolean {
  return safetyCopiesOpen
}

export function subscribeSafetyCopiesScreen(listener: () => void): () => void {

  safetyCopiesListeners.add(listener)

  return () => {
    safetyCopiesListeners.delete(listener)
  }

}

function setSafetyCopiesOpen(next: boolean): void {

  if (next === safetyCopiesOpen) {
    return
  }

  safetyCopiesOpen = next

  for (const listener of safetyCopiesListeners) {
    listener()
  }

}

export function openSafetyCopiesScreen(): void {
  setSafetyCopiesOpen(true)
}

export function closeSafetyCopiesScreen(): void {
  setSafetyCopiesOpen(false)
}

/* TEST-ONLY - never called from production code. */
export function __resetResolutionStoreForTests(): void {
  open = false
  safetyCopiesOpen = false
  safetyCopiesListeners.clear()
  openListeners.clear()
  resolvedListeners.clear()
}
