import { syncCloudNow, type CloudSyncResult } from './cloudSyncEngine'
import type { StaleReviewCandidate } from './staleRecordReview'
import { classifySyncOutcome, type SyncOutcomeReason } from './syncOutcome'
import { maybeRotateBackup } from './cloudBackupRotation'

/*
  CLOUD SYNC SCHEDULER (Phase 7 - integration)

  The one function production code calls after a meaningful,
  already-successfully-committed change to the synchronized dataset
  (patients/savedTreatments/customTemplates/customProcedures/
  deletionTombstones): requestCloudSync(). It never contains merge or
  Graph logic of its OWN - it only decides WHEN to call Phase 6's
  syncCloudNow(), and coalesces bursts of requests into a single call.

  Phase 9 addition: every successful attempt also fires
  maybeRotateBackup() (cloudBackupRotation.ts) - fire-and-forget, see
  that call site's own comment. This is the one exception to "no
  Graph logic of its own" in spirit, not in fact: the actual Graph
  calls still live in cloudBackupRotation.ts/cloudStorage.ts, this
  file only decides WHEN to fire them, exactly like it already does
  for syncCloudNow() itself.

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
  Consumed by exactly one sync attempt - see resumeSyncAfterStaleReview()
  below and PerformSyncOptions's own comment in cloudSyncEngine.ts for
  the full reasoning. Read-and-cleared at the moment an attempt actually
  starts (inside startIfIdle(), not when it's set), so it can never leak
  into a later, unrelated attempt.
*/
let skipStaleReviewCheckOnce = false

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

/*
  STALE-RECORD REVIEW (Phase 4.7)

  A separate store from `status` above, the same relationship
  patientNumberConflicts already has to the coarse sync status
  elsewhere in this app (App.tsx's own patientNumberConflicts state):
  'stale-review-required' collapses into the plain 'unavailable' status
  for the small persistent indicator's coarse state machine, while this
  dedicated store carries the actual candidate list a real review
  screen needs. null means "no review currently pending"; a non-null
  (possibly empty, though performSync() never actually returns one
  empty) array means the dentist has something to decide before this
  device's sync can proceed. (Phase 6 note: SyncStatusIndicator.tsx now
  DOES read a review-needed reason out of lastSyncOutcome below, for
  its own short badge text - that's presentation only, layered on top
  of this store, which remains the one source of truth for the actual
  candidate list and the review screen/banner built around it.)
*/

let pendingStaleReview: StaleReviewCandidate[] | null = null

const staleReviewListeners = new Set<() => void>()

function setPendingStaleReview(candidates: StaleReviewCandidate[] | null): void {

  pendingStaleReview = candidates

  for (const listener of staleReviewListeners) {
    listener()
  }

}

export function getPendingStaleReview(): StaleReviewCandidate[] | null {
  return pendingStaleReview
}

export function subscribePendingStaleReview(listener: () => void): () => void {

  staleReviewListeners.add(listener)

  return () => {
    staleReviewListeners.delete(listener)
  }

}

/*
  LAST SYNC OUTCOME (Phase 6 - failure differentiation)

  Same get/subscribe module-store pattern as `status` and
  pendingStaleReview above - this is the one addition Phase 6 makes to
  this file. Every sync attempt that actually resolves (success or any
  failure mode alike - see syncOutcome.ts's classifySyncOutcome(),
  which is exhaustive over every CloudSyncResult status) updates this
  to the freshly classified reason, so a caller reading it always has
  the most recent, specific outcome rather than a generic pass/fail
  flag. null only before this device's very first sync attempt this
  session has resolved at all - SyncStatusIndicator.tsx pairs this with
  the SAME status-transition ("did a sync attempt just finish?") logic
  it already used before this phase, so this store answers "what
  happened" while `status` still answers "is one happening right now".
*/

let lastSyncOutcome: SyncOutcomeReason | null = null

const syncOutcomeListeners = new Set<() => void>()

function setLastSyncOutcome(reason: SyncOutcomeReason): void {

  lastSyncOutcome = reason

  for (const listener of syncOutcomeListeners) {
    listener()
  }

}

export function getLastSyncOutcome(): SyncOutcomeReason | null {
  return lastSyncOutcome
}

export function subscribeLastSyncOutcome(listener: () => void): () => void {

  syncOutcomeListeners.add(listener)

  return () => {
    syncOutcomeListeners.delete(listener)
  }

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

  const skipStaleReviewCheck = skipStaleReviewCheckOnce
  skipStaleReviewCheckOnce = false

  setStatus('syncing')

  syncCloudNow(skipStaleReviewCheck ? { skipStaleReviewCheck: true } : undefined)
    .then(
      result => {

        logSyncOutcome(result)

        /*
          Phase 6 - classified BEFORE the stale-review branch below, so
          lastSyncOutcome reflects every resolved attempt uniformly
          (including 'review-needed' itself), not just the ones that
          reached a normal success/failure.
        */
        setLastSyncOutcome(classifySyncOutcome(result))

        /*
          A gated attempt never reached the cloud at all (see
          cloudSyncEngine.ts's own gate comment) - surface its candidate
          list to whatever's watching pendingStaleReview and treat it as
          a non-success for status purposes, same as any other attempt
          that didn't actually complete.
        */
        if (result.status === 'stale-review-required') {
          setPendingStaleReview(result.candidates)
        }

        const succeeded = isSuccessStatus(result)

        /*
          Phase 9 - dated backup rotation. Deliberately fire-and-
          forget: not awaited, and its own promise is never returned
          from here, so it can never delay or affect this scheduler's
          own status transition below. maybeRotateBackup() already
          swallows and logs its own failures internally and should
          never reject - the trailing .catch() here is the same
          defensive-only backstop this file's own header comment
          already applies to syncCloudNow() itself, in case that
          contract is ever violated.
        */
        if (succeeded) {
          maybeRotateBackup().catch(() => {})
        }

        return succeeded

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
  Call this once the dentist has finished a stale-record review (every
  candidate in pendingStaleReview has been kept or discarded - see
  App.tsx's own staleReview screen). Clears the pending review
  immediately (optimistic - the review UI should disappear the moment
  the dentist finishes, not wait for the next sync to resolve) and
  requests exactly one more sync attempt that skips the stale-review
  gate, via the same coalescing machinery requestCloudSync() already
  uses - this is deliberately NOT a separate code path, so a decision
  made here composes correctly with any other mutation that happens to
  land in the same microtask (eg. a discard, which itself already calls
  requestCloudSync() through the app's normal patient-deletion flow).
*/

export function resumeSyncAfterStaleReview(): void {

  setPendingStaleReview(null)

  skipStaleReviewCheckOnce = true

  requestCloudSync()

}

/*
  Call this from a trigger that has no synchronized-data mutation of
  its own to report - app load, and a fresh Microsoft sign-in (see
  App.tsx's post-migration effect and MicrosoftAccountSection.tsx's
  handleSignIn()). Both of those only want to reconcile with the cloud
  IF a Microsoft account is actually signed in; neither should ever
  start (or even schedule) a sync attempt for a dentist who has never
  connected one - not a console log, not a status transition, nothing.
  Takes a plain boolean rather than an account/MSAL type so this
  module stays free of any dependency on auth.ts - the caller already
  knows whether it has an account (getActiveAccount() truthy, or a
  just-succeeded sign-in) and just reports that one fact here.
*/

export function requestCloudSyncIfSignedIn(isSignedIn: boolean): void {

  if (isSignedIn) {
    requestCloudSync()
  }

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
  skipStaleReviewCheckOnce = false
  pendingStaleReview = null
  lastSyncOutcome = null
}
