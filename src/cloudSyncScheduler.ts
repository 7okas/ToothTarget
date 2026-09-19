import { syncCloudNow, type CloudSyncResult } from './cloudSyncEngine'

/*
  CLOUD SYNC SCHEDULER (Phase 7 - integration)

  The one function production code calls after a meaningful,
  already-successfully-committed change to the synchronized dataset
  (patients/savedTreatments/customTemplates/customProcedures/
  deletionTombstones): requestCloudSync(). It never contains merge or
  Graph logic itself - it only decides WHEN to call Phase 6's
  syncCloudNow(), and coalesces bursts of requests into a single call.

  ============================================================
  COALESCING
  ============================================================

  A single user operation (eg. deleting a patient) can touch several
  synchronized keys across a few synchronous statements. Calling
  requestCloudSync() after each individual write would fire several
  independent sync transactions for one logical operation. Instead,
  every call just marks "a sync is wanted" and schedules a microtask;
  because a microtask always runs after the current synchronous
  call stack finishes (but before the next real async work), every
  requestCloudSync() call made during the same synchronous mutation
  (or burst of them) collapses into the exact same pending flag and
  the exact same scheduled microtask - only one sync runs.

  ============================================================
  CHANGES DURING AN ACTIVE SYNC
  ============================================================

  If requestCloudSync() is called while a sync is already running,
  it is NOT started again immediately (Phase 6's syncCloudNow() has
  its own same-tab in-flight guard, but this scheduler avoids relying
  on that alone) - it simply leaves the pending flag set. The running
  sync's own completion handler checks that flag and starts exactly
  one more sync afterward, so a change made mid-sync is never lost,
  and no unbounded chain of syncs can build up (at most one extra sync
  is ever queued on top of the one in flight, regardless of how many
  requestCloudSync() calls arrive while it runs).

  ============================================================
  FAILURE HANDLING
  ============================================================

  syncCloudNow() already resolves to a typed CloudSyncResult for every
  outcome (including auth/permission/graph/contention/validation
  failures) and should never reject - the .catch() below exists purely
  as a defensive backstop so a bug here can never throw out of a
  microtask and surface as an unhandled rejection, since this module
  runs asynchronously, fully detached from whatever synchronous
  mutation called requestCloudSync(). Nothing here inspects the result
  or retries on a timer: Phase 6 already owns bounded 412 retries, and
  per this phase's own scope, the next meaningful local mutation is
  what naturally triggers another attempt after any other failure
  (auth, permission, network/graph, contention) - no new scheduled-
  retry timer was added, since local data is never at risk either way
  (it was already durably committed to localStorage before
  requestCloudSync() was ever called - see this file's call sites in
  App.tsx).

  No persisted "sync needed" marker was added either: Phase 6's merge
  is a deterministic union, so any future sync (triggered by the next
  real mutation, whenever that happens - even after a full page
  reload) reconstructs the correct cloud superset from whatever is
  currently in localStorage. An in-memory pending flag can never make
  data disappear across a refresh, because it was never data in the
  first place - only a hint about when to next attempt a sync that
  will already succeed based purely on local storage's own content.
*/

let running = false
let pending = false
let microtaskQueued = false

/*
  MINIMAL STATUS (Phase 7 - for the existing Microsoft Account section
  only, see MicrosoftAccountSection.tsx)

  Deliberately coarse - just enough for a one-line, non-technical
  status ("Syncing…"/"Synced"/"Sync pending"/"Cloud sync unavailable"),
  never Graph/ETag error detail (that stays in the console - see
  logSyncOutcome() below). Exposed the same
  subscribe/get-snapshot shape auth.ts's getActiveAccount()/
  subscribeToActiveAccount() already use, so MicrosoftAccountSection.tsx
  can read it the same way via useSyncExternalStore.
*/

export type CloudSyncStatus = 'idle' | 'syncing' | 'pending' | 'unavailable'

let status: CloudSyncStatus = 'idle'

const statusListeners = new Set<() => void>()

function setStatus(next: CloudSyncStatus): void {

  if (next === status) {
    return
  }

  status = next

  for (const listener of statusListeners) {
    listener()
  }

}

export function getCloudSyncStatus(): CloudSyncStatus {
  return status
}

export function subscribeCloudSyncStatus(listener: () => void): () => void {

  statusListeners.add(listener)

  return () => {
    statusListeners.delete(listener)
  }

}

/*
  Console-only, safe-status logging - just the result's status literal
  (eg. "cloud sync: precondition-failed"), never a token, patient
  record, or full document (matching cloudStorage.ts's own
  describeGraphError() principle applied to Graph responses). Purely
  diagnostic; nothing reads this programmatically.
*/

function logSyncOutcome(result: CloudSyncResult): void {
  console.log(`cloud sync: ${result.status}`)
}

function isSuccessStatus(result: CloudSyncResult): boolean {
  return result.status === 'synced' || result.status === 'synced-with-conflicts'
}

function scheduleFlush(): void {

  if (microtaskQueued) {
    return
  }

  microtaskQueued = true

  queueMicrotask(() => {
    microtaskQueued = false
    startIfIdle()
  })

}

function startIfIdle(): void {

  if (running) {
    /*
      A sync is already in flight (started by an earlier microtask
      flush). Leave `pending` as-is - the running sync's own
      .finally() below will notice it and schedule another flush once
      it completes.
    */
    return
  }

  if (!pending) {
    return
  }

  pending = false
  running = true

  setStatus('syncing')

  syncCloudNow()
    .then(
      result => {
        logSyncOutcome(result)
        return isSuccessStatus(result)
      },
      () => {
        /*
          Defensive only - see this file's header comment. syncCloudNow()
          itself always resolves with a typed result, never throws.
        */
        return false
      }
    )
    .then(succeeded => {

      running = false

      if (pending) {
        /*
          Another meaningful mutation arrived while this sync was
          running - reflect that immediately rather than briefly
          showing 'idle'/'unavailable' before the next run starts.
        */
        setStatus('pending')
        scheduleFlush()
      } else {
        setStatus(succeeded ? 'idle' : 'unavailable')
      }

    })

}

/*
  Call this after a synchronized-data mutation (patients,
  savedTreatments, custom templates, custom procedures, or deletion
  tombstones) has already been committed successfully to
  localStorage. Safe to call any number of times in a row, from
  anywhere, at any time - it never throws, never blocks the caller,
  and never opens a login prompt on its own (see auth.ts's
  getAccessToken() for where that's actually enforced).
*/

export function requestCloudSync(): void {

  pending = true

  if (!running) {
    setStatus('pending')
  }

  scheduleFlush()

}

/*
  TEST-ONLY - resets this module's internal scheduling state between
  test cases. Never called from production code.
*/

export function __resetCloudSyncSchedulerForTests(): void {
  running = false
  pending = false
  microtaskQueued = false
  status = 'idle'
}
