/*
  PER-DEVICE LAST-SUCCESSFUL-SYNC TRACKING

  A small, deliberately standalone piece of infrastructure - not a
  cloudSyncEngine.ts internal, so it can be unit-tested in isolation
  and, per this phase's own brief, reused later for a "synced X
  minutes/hours ago" display without that display needing to know
  anything about transport/orchestration.

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
  cloudSyncEngine.ts at the exact moment a sync
  genuinely completes end-to-end (cloud write AND local commit both
  succeeded) - never merely attempted, never on a read-only/gated
  attempt (see isDeviceSyncStale() below), matching the same
  "advance only on real success" discipline
  LOCAL_SYNC_UPDATED_AT_KEY already follows in cloudSyncEngine.ts.
*/

const DEVICE_LAST_SYNC_AT_KEY = 'toothTargetDeviceLastSyncAt'

export function recordDeviceSyncSuccess(nowIso: string): void {
  localStorage.setItem(DEVICE_LAST_SYNC_AT_KEY, nowIso)
}

export function getDeviceLastSyncAt(): string | null {

  const raw = localStorage.getItem(DEVICE_LAST_SYNC_AT_KEY)

  return typeof raw === 'string' && raw.trim() !== '' ? raw : null

}
