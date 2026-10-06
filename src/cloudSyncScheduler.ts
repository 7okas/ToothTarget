import {
  syncCloudNow,
  pullCloudSnapshot,
  markLocalDataDirty,
  type CloudSyncResult,
} from './cloudSyncEngine'
import {
  classifySyncOutcome,
  type SyncOutcomeReason,
  type SyncState,
} from './syncOutcome'
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
  outcome (including auth/permission/graph/validation
  failures) and should never reject - the .catch() below exists purely
  as a defensive backstop so a bug here can never throw out of a
  microtask and surface as an unhandled rejection, since this module
  runs asynchronously, fully detached from whatever synchronous
  mutation called requestCloudSync(). Nothing here inspects the result
  or retries on a timer: Phase 6 already owns bounded 412 retries, and
  per this phase's own scope, the next meaningful local mutation is
  what naturally triggers another attempt after any other failure
  (auth, permission, network/graph) - no new scheduled-
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
let microtaskQueued = false

/*
  Phase 5 (single-writer sync model) - replaces the old plain boolean
  `pending` flag with an operation KIND, since there are now two
  genuinely different things to request: 'push' (requestCloudSync(),
  called after a synchronized-data mutation - the vast majority of
  triggers) and 'pull' (requestCloudPullIfSignedIn(), called only at
  app open and a fresh sign-in/gate retry - see those functions' own
  comments). 'pull' always wins when both are pending at once: pulling
  first establishes the correct baseline a push should build on, and
  pullCloudSnapshot() itself already falls through to a push whenever
  that's actually the safe thing to do (local ahead of an unmoved
  cloud) - see cloudSyncEngine.ts's own pullCloudSnapshot() comment.
*/
let pendingOperation: 'none' | 'push' | 'pull' = 'none'

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

/*
  Phase 7 - the four result states (see syncOutcome.ts's SyncState) plus
  the two in-progress ones. 'synced' is also the value before any sync
  attempt has run; nothing may treat it as proof that an attempt
  completed (lastSyncOutcome is null until one has).
*/
export type CloudSyncStatus = SyncState | 'syncing' | 'pending'

let status: CloudSyncStatus = 'synced'

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
  return result.status === 'synced'
}

/*
  LAST SYNC OUTCOME (Phase 6 - failure differentiation)

  Same get/subscribe module-store pattern as `status` and
  `status` above - this is the one addition Phase 6 makes to
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

/*
  LOCAL DATA VERSION (UI refresh signal)

  A plain incrementing counter, bumped exactly once per sync attempt
  whose result is 'synced' - the one status that only exists
  once cloudSyncEngine.ts's own commitLocalState() has already run and
  succeeded (see that file's header comment: 'cloud-committed-locally-pending' is returned
  instead whenever the cloud write succeeded but the local commit
  itself threw, so it deliberately does NOT bump this).

  This exists so a component holding React state that mirrors synced
  localStorage keys (App.tsx's savedPatients/savedTreatments/
  templates/procedures/patientNumberConflicts) can notice "new synced
  data just landed in localStorage" and re-read it, regardless of
  whether THIS tab initiated the sync or another device's change
  simply arrived via one. Deliberately a separate, narrower signal
  from `status`/lastSyncOutcome above: those exist to describe a sync
  attempt's outcome for DISPLAY (see their own comments); this one
  exists purely to say "synced data actually changed underneath you,
  go re-read it" - a component only interested in display text has no
  reason to subscribe to this, and a component only interested in
  fresh data has no reason to parse a SyncOutcomeReason to figure out
  whether local storage actually changed.
*/

let localDataVersion = 0

const localDataVersionListeners = new Set<() => void>()

function bumpLocalDataVersion(): void {

  localDataVersion += 1

  for (const listener of localDataVersionListeners) {
    listener()
  }

}

export function getLocalDataVersion(): number {
  return localDataVersion
}

export function subscribeLocalDataVersion(listener: () => void): () => void {

  localDataVersionListeners.add(listener)

  return () => {
    localDataVersionListeners.delete(listener)
  }

}

/*
  PHASE 6 - RESOLUTION HOOKS (not called by anything yet)

  notifyLocalDataReplaced() - tell React state that mirrors the synced
  localStorage keys to re-read them, because something other than a
  normal sync (a finished resolution, a startup recovery) just
  replaced them. The same signal a successful sync already sends.

  reportResolutionApplied() - a confirmed resolution just completed:
  this device and OneDrive now match. Records a clean 'synced' outcome
  and an idle status (so the badge stops showing "Sync paused"), asks
  React to re-read local data, and fires the same fire-and-forget dated
  backup rotation any successful sync fires. Never starts a sync.
*/

export function notifyLocalDataReplaced(): void {
  bumpLocalDataVersion()
}

export function reportResolutionApplied(): void {

  setLastSyncOutcome({ state: 'synced', detail: 'Synced' })
  setStatus('synced')
  bumpLocalDataVersion()

  maybeRotateBackup().catch(() => {})

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
      flush). Leave `pendingOperation` as-is - the running sync's own
      .finally() below will notice it and schedule another flush once
      it completes.
    */
    return
  }

  if (pendingOperation === 'none') {
    return
  }

  const operation = pendingOperation
  pendingOperation = 'none'
  running = true

  setStatus('syncing')

  const attempt = operation === 'pull' ? pullCloudSnapshot() : syncCloudNow()

  attempt
    .then(
      result => {

        logSyncOutcome(result)

        /*
          Phase 6 - lastSyncOutcome reflects every resolved attempt
          uniformly, not just the ones that reached a normal
          success/failure.
        */
        const outcome = classifySyncOutcome(result)

        setLastSyncOutcome(outcome)

        const succeeded = isSuccessStatus(result)

        /*
          See LOCAL DATA VERSION's own comment above for exactly why
          this fires here and only here (isSuccessStatus() is exactly
          "commitLocalState() ran and succeeded").
        */
        if (succeeded) {
          bumpLocalDataVersion()
        }

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

        return { succeeded, state: outcome.state }

      },
      () => {
        /*
          Defensive only - see this file's header comment. syncCloudNow()
          itself always resolves with a typed result, never throws.
        */
        return { succeeded: false, state: 'offline' as SyncState }
      }
    )
    .then(({ state }) => {

      running = false

      if (pendingOperation !== 'none') {
        /*
          Another meaningful mutation (or a pull trigger) arrived while
          this attempt was running - reflect that immediately rather
          than briefly showing the finished state before the next run
          starts.
        */
        setStatus('pending')
        scheduleFlush()
      } else {
        setStatus(state)
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

  Phase 5 (single-writer sync model) - also marks local data dirty
  (cloudSyncEngine.ts's markLocalDataDirty()), since every one of this
  function's own call sites IS exactly the "a synchronized mutation
  just happened" moment that flag exists to track - no separate call
  site needed anywhere else for that (see markLocalDataDirty()'s own
  comment). Only ever requests a PUSH; if a 'pull' is already pending
  (app just opened/signed in and hasn't run yet), that stays pending as
  'pull' - establishing the correct baseline first is always at least
  as safe as pushing immediately, and pullCloudSnapshot() itself
  already falls through to a push whenever that's the right call.
*/

export function requestCloudSync(): void {

  markLocalDataDirty()

  if (pendingOperation === 'none') {
    pendingOperation = 'push'
  }

  if (!running) {
    setStatus('pending')
  }

  scheduleFlush()

}

/*
  Call this from a trigger that has no synchronized-data mutation of
  its own to report, and no cloud baseline to establish either - just
  "try a push now if one isn't already going to happen on its own".
  Phase 5 (single-writer sync model) narrowed this to its one
  remaining caller, cloudSyncOnlineRetry.ts's 'online'-event listener:
  reconnecting never itself changes which account is signed in or
  invalidates whatever this device already knew about the cloud, so a
  plain push (flushing anything that piled up while offline) is
  exactly right - unlike app load/a fresh sign-in, which both want
  requestCloudPullIfSignedIn() below instead. Takes a plain boolean
  rather than an account/MSAL type so this module stays free of any
  dependency on auth.ts - the caller already knows whether it has an
  account and just reports that one fact here.
*/

export function requestCloudSyncIfSignedIn(isSignedIn: boolean): void {

  if (isSignedIn) {
    requestCloudSync()
  }

}

/*
  Call this from a trigger that wants to establish/re-establish this
  device's starting point from the cloud rather than push a mutation -
  app open (App.tsx's own effect) and a fresh Microsoft sign-in
  (MicrosoftAccountSection.tsx's handleSignIn(), and
  StartupGateScreen.tsx's handleSignIn()/handleRetry(), since the
  gate's own gating attempt is always a pull under this model - see
  cloudSyncEngine.ts's pullCloudSnapshot()). Same sign-in guard and
  same reasoning as requestCloudSyncIfSignedIn() above: a dentist who
  has never connected a Microsoft account gets zero sync activity from
  either.

  Always sets 'pull', even overriding an already-pending 'push' - see
  the pendingOperation variable's own comment above for why that's
  always the safe choice.
*/

export function requestCloudPullIfSignedIn(isSignedIn: boolean): void {

  if (!isSignedIn) {
    return
  }

  pendingOperation = 'pull'

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
  pendingOperation = 'none'
  microtaskQueued = false
  status = 'synced'
  lastSyncOutcome = null
  localDataVersion = 0
}
