import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getActiveAccount, subscribeToActiveAccount } from './auth'
import {
  getCloudSyncStatus,
  subscribeCloudSyncStatus,
  type CloudSyncStatus,
} from './cloudSyncScheduler'

/*
  PERSISTENT SYNC STATUS INDICATOR

  A small, fixed-position "Syncing…"/"Synced"/"Sync error" text shown
  in the top-right corner on every screen - unlike
  MicrosoftAccountSection.tsx's own status line, which only exists on
  the Settings screen. Rendered once, as a sibling of <App /> in
  main.tsx (see that file), so it survives every screen switch inside
  App() untouched - App.tsx's own screen-switching logic (a long chain
  of early `if (screen === ...) return (...)` statements, not a single
  shared layout) is never touched by this addition.

  Purely a display of state that already exists elsewhere
  (cloudSyncScheduler.ts's status store, auth.ts's active account) -
  this component never calls requestCloudSync() or anything else that
  could influence sync behavior itself.
*/

/*
  DISPLAY DECISION (pure, no React/DOM - see SyncStatusIndicator.test.ts)

  Deliberately keyed off a STATUS TRANSITION, not the current status
  alone: 'idle' means two different things depending on how it was
  reached - "a sync JUST succeeded" (previous status was 'pending' or
  'syncing') vs. "nothing has happened in a while" (the common,
  long-settled case, including the very first render before any sync
  has ever run this session). Only the former should show "Synced";
  the latter must show nothing, per this feature's own "no permanent
  banner" requirement. The exact same reasoning applies to
  'unavailable' or 'Sync error' would otherwise never go away).
*/

export type SyncStatusDisplay =
  | { label: 'Syncing…'; autoHide: false; tone: 'neutral' }
  | { label: 'Synced'; autoHide: true; tone: 'success' }
  | { label: 'Sync error'; autoHide: true; tone: 'error' }
  | null

export function computeSyncStatusDisplay(
  previousStatus: CloudSyncStatus,
  currentStatus: CloudSyncStatus
): SyncStatusDisplay {

  if (currentStatus === 'syncing' || currentStatus === 'pending') {
    return { label: 'Syncing…', autoHide: false, tone: 'neutral' }
  }

  const justFinished =
    previousStatus === 'syncing' || previousStatus === 'pending'

  if (currentStatus === 'idle') {
    return justFinished ? { label: 'Synced', autoHide: true, tone: 'success' } : null
  }

  // currentStatus === 'unavailable'
  return justFinished
    ? { label: 'Sync error', autoHide: true, tone: 'error' }
    : null

}

const AUTO_HIDE_MS = 10000
const FADE_MS = 400

export default function SyncStatusIndicator() {

  /*
    Same read-external-state pattern MicrosoftAccountSection.tsx
    already uses for both of these stores.
  */

  const account = useSyncExternalStore(
    subscribeToActiveAccount,
    getActiveAccount
  )

  const status = useSyncExternalStore(
    subscribeCloudSyncStatus,
    getCloudSyncStatus
  )

  const previousStatusRef = useRef<CloudSyncStatus>(status)

  const [display, setDisplay] = useState<SyncStatusDisplay>(null)

  const [fading, setFading] = useState(false)

  useEffect(() => {

    const previousStatus = previousStatusRef.current

    previousStatusRef.current = status

    setFading(false)

    setDisplay(computeSyncStatusDisplay(previousStatus, status))

  }, [status])

  useEffect(() => {

    if (!display || !display.autoHide) {
      return
    }

    const fadeTimer = setTimeout(
      () => setFading(true),
      AUTO_HIDE_MS - FADE_MS
    )

    const clearTimer = setTimeout(
      () => setDisplay(null),
      AUTO_HIDE_MS
    )

    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(clearTimer)
    }

  }, [display])

  /*
    No cloud UI at all until the dentist has actually signed in - same
    rule the rest of the cloud feature set already follows.
  */
  if (!account || !display) {
    return null
  }

  return (

    <div
      className={
        `sync-status-indicator` +
        (display.tone === 'error' ? ' sync-status-indicator-error' : '') +
        (fading ? ' sync-status-indicator-fading' : '')
      }
    >
      {display.label}
    </div>

  )

}
