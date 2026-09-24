import { TOMBSTONE_EXPIRY_MS } from './cloudMerge'

/*
  PER-DEVICE LAST-SUCCESSFUL-SYNC TRACKING (Phase 4.7)

  A small, deliberately standalone piece of infrastructure - not a
  cloudSyncEngine.ts internal, so it can be unit-tested in isolation
  and, per this phase's own brief, reused later for a "synced X
  minutes/hours ago" display without that display needing to know
  anything about merge/transport/orchestration.

  DEVICE-LOCAL, NOT SYNCED
  ============================================================
  toothTargetDeviceLastSyncAt answers "when did THIS DEVICE last
  finish a real round-trip with the cloud", not "when was this
  account's data last changed" (that's CloudSyncDocument.updatedAt,
  a synced field) and not "when did THIS ACCOUNT last sync on this
  device" (cloudSyncEngine.ts's own toothTargetCloudSyncUpdatedAt,
  which IS deliberately swapped per account on an account switch -
  see reconcileSyncedAccount()). This key is intentionally left OUT
  of that per-account cache swap: it is a fact about the device's own
  clock/connectivity, independent of which Microsoft account happens
  to be active on it right now, so switching accounts must never
  reset or fork it.

  Only ever written by recordDeviceSyncSuccess(), called by
  cloudSyncEngine.ts's performSync() at the exact moment a sync
  genuinely completes end-to-end (cloud write AND local commit both
  succeeded) - never merely attempted, never on a read-only/gated
  attempt (see isDeviceSyncStale() below), matching the same
  "advance only on real success" discipline
  LOCAL_SYNC_UPDATED_AT_KEY already follows in cloudSyncEngine.ts.
*/

const DEVICE_LAST_SYNC_AT_KEY = 'toothTargetDeviceLastSyncAt'

/*
  STALE-DEVICE THRESHOLD
  ============================================================
  Reuses cloudMerge.ts's TOMBSTONE_EXPIRY_MS rather than defining its
  own separate ~1-month constant - see that constant's own comment for
  why the two are intentionally tied together: a device that syncs at
  least this often can never miss a tombstone before it expires, which
  is exactly the safety margin this threshold exists to preserve.
*/

export const STALE_DEVICE_THRESHOLD_MS = TOMBSTONE_EXPIRY_MS

export function recordDeviceSyncSuccess(nowIso: string): void {
  localStorage.setItem(DEVICE_LAST_SYNC_AT_KEY, nowIso)
}

export function getDeviceLastSyncAt(): string | null {

  const raw = localStorage.getItem(DEVICE_LAST_SYNC_AT_KEY)

  return typeof raw === 'string' && raw.trim() !== '' ? raw : null

}

/*
  A device that has never recorded a successful sync is treated as NOT
  stale, not as "infinitely stale" - this is a deliberate choice, not
  an oversight. Staleness is a claim about a device that WAS keeping
  up and then fell behind; a brand-new device (or one that has simply
  never connected a Microsoft account yet) has no prior cloud
  relationship to have fallen behind on, so gating it through a
  "review your local patients before they can sync" screen on its
  very first-ever sync would be a confusing, unearned interruption for
  perfectly normal onboarding, not the resurrected-deletion risk this
  feature actually protects against.
*/

export function isDeviceSyncStale(
  nowIso: string,
  thresholdMs: number = STALE_DEVICE_THRESHOLD_MS
): boolean {

  const lastSyncAt = getDeviceLastSyncAt()

  if (lastSyncAt === null) {
    return false
  }

  const nowMs = Date.parse(nowIso)
  const lastSyncMs = Date.parse(lastSyncAt)

  if (Number.isNaN(nowMs) || Number.isNaN(lastSyncMs)) {
    return false
  }

  return nowMs - lastSyncMs > thresholdMs

}
