import type { CloudSyncDocument } from './cloudSync'
import {
  readCloudSyncDocument,
  writeCloudSyncDocument,
} from './cloudStorage'
import {
  buildLocalCloudSyncDocument,
  classifyCloudReadFailure,
  commitResolvedSnapshotLocally,
  hasCloudChangedSinceKnown,
  isLocalDataDirty,
  isResolutionApplying,
  readLocalChangeCounter,
  readLocalSyncUpdatedAt,
  readSyncedAccountId,
  recordCloudMatchesLocal,
  setResolutionApplying,
  type CloudSyncResult,
} from './cloudSyncEngine'
import {
  diffSnapshots,
  exactRecordSignature,
  isDiffEmpty,
  type SnapshotDiff,
} from './syncDiff'
import {
  carryOverDecisions,
  resolveSnapshots,
  type Decisions,
  type NumberFixes,
  type ResolveResult,
} from './syncResolve'
import { saveResolutionSafetyCopies } from './syncResolutionSafetyCopy'

/*
  RESOLUTION ENGINE (Phase 6, steps 4-5)

  The I/O half of conflict resolution: opens a resolution session from
  a FRESH cloud read, applies the dentist's confirmed choices, and
  finishes an apply that was interrupted. Everything that decides WHAT
  the resolved data is lives in the pure modules (syncDiff.ts,
  syncResolve.ts); where the safety copies go lives in
  syncResolutionSafetyCopy.ts. Nothing in this file is reachable from
  the running app yet - no trigger or screen calls it.

  ============================================================
  THE TWO ENTRY POINTS THAT TOUCH DATA
  ============================================================

  prepareResolution()   READ-ONLY. Reads the cloud and this device and
                        builds the diff. Writes nothing - not to the
                        cloud, not to localStorage (asserted by tests).
  applyResolution()     Runs only when called explicitly with the
                        dentist's confirmed decisions. Everything
                        before step 4 below is also write-free.

  ============================================================
  APPLY ORDER (each step aborts safely on failure)
  ============================================================

  1. Re-resolve the confirmed decisions; refuse if anything is
     undecided, blocked (collision, missing patient...) or a
     probably-deleted record is coming back un-acknowledged.
  2. Re-read the cloud. If a previous attempt's write already landed
     (lost response), skip to step 6. If the cloud's ETag is no longer
     the one the dentist looked at, or this device changed since the
     screen opened, STOP: 'changed-while-deciding' with a fresh session
     and the choices that still apply.
  3. Safety copies of BOTH sides (syncResolutionSafetyCopy.ts). A
     failed OneDrive copy blocks; a failed local-only copy only warns.
     Saved once per session, so a retry doesn't duplicate them.
  4. Write the pending marker (toothTargetPendingResolution): the
     account, the stamp, the change counter captured when the screen
     opened, and the resolved document. A marker that can't be stored
     blocks the apply (it is what makes a crash recoverable).
  5. Conditional write to the cloud with If-Match = the ETag the
     dentist looked at. 412 -> 'changed-while-deciding'. Any other
     failure leaves the marker in place (the outcome is unknown, eg. a
     lost response) and is reported as retryable.
  6. Local commit - but ONLY if the change counter still equals the one
     captured when the screen opened. If it moved (an edit during the
     write), local data is NOT overwritten: the cloud holds the
     resolved data, local tracking is untouched, and the next sync is
     'diverged' again with a small diff. Otherwise the resolved data is
     committed locally and every tracking value is advanced.
  7. Marker cleared.

  ============================================================
  CRASH RECOVERY
  ============================================================

  finishPendingResolution() runs at startup, and only does anything if
  a marker exists. It completes the local commit ONLY if ALL of:
    - the marker's account is the account currently active on this
      device,
    - the cloud document's updatedAt equals the marker's stamp (the
      write really landed),
    - the local change counter still equals the one captured when the
      screen opened (no edit since).
  Otherwise the marker is dropped and the state is simply 'diverged'
  again (nothing is lost: both sides are in the safety copies).
*/

export const PENDING_RESOLUTION_KEY = 'toothTargetPendingResolution'

/* ---------- session ---------- */

export type ResolutionSession = {
  device: CloudSyncDocument
  cloud: CloudSyncDocument
  cloudETag: string
  /* The local change counter when this session was opened (C0). */
  counterAtOpen: number
  /* The cloud time this device last confirmed - drives the age hints. */
  lastSyncAt: string | null
  diff: SnapshotDiff
  /*
    Internal, set during apply attempts so a RETRY reuses the same
    stamp (lets a lost-response write be recognised) and the same
    safety copies (no duplicates).
  */
  attemptStamp?: string
  safetyCopiesSaved?: boolean
  safetyCopyWarning?: string
}

function buildSession(
  device: CloudSyncDocument,
  cloud: CloudSyncDocument,
  cloudETag: string,
  counterAtOpen: number
): ResolutionSession {

  const lastSyncAt = readLocalSyncUpdatedAt()

  return {
    device,
    cloud,
    cloudETag,
    counterAtOpen,
    lastSyncAt,
    diff: diffSnapshots(device, cloud, { lastSyncAt }),
  }

}

export type PrepareResult =
  | { status: 'ready'; session: ResolutionSession }
  /* Both sides hold the same data (ignoring timestamps): only tracking needs advancing. */
  | { status: 'identical'; session: ResolutionSession }
  /* Not diverged any more (cloud unchanged, or nothing unsynced locally). A normal sync handles it. */
  | { status: 'not-diverged' }
  /* There is no cloud document to resolve against. A normal push handles it. */
  | { status: 'no-cloud-document' }
  /* Transport/corruption/local-data failure, in the same shapes the sync engine already uses. */
  | { status: 'failed'; result: CloudSyncResult }

/*
  READ-ONLY. Never writes to the cloud or to localStorage.
*/
export async function prepareResolution(): Promise<PrepareResult> {

  const counterAtOpen = readLocalChangeCounter()

  const local = buildLocalCloudSyncDocument()

  if (!local.valid) {
    return {
      status: 'failed',
      result: { status: 'validation-failed', detail: local.error },
    }
  }

  const cloudRead = await readCloudSyncDocument()

  const readFailure = classifyCloudReadFailure(cloudRead)

  if (readFailure) {
    return { status: 'failed', result: readFailure }
  }

  if (cloudRead.status !== 'found') {
    return { status: 'no-cloud-document' }
  }

  if (
    !isLocalDataDirty() ||
    !hasCloudChangedSinceKnown(cloudRead.document.updatedAt, cloudRead.eTag)
  ) {
    return { status: 'not-diverged' }
  }

  const session = buildSession(
    local.document,
    cloudRead.document,
    cloudRead.eTag,
    counterAtOpen
  )

  return isDiffEmpty(session.diff)
    ? { status: 'identical', session }
    : { status: 'ready', session }

}

/* ---------- apply ---------- */

export type ApplyOptions = {
  numberFixes?: NumberFixes
  /* The dentist ticked "I understand these deleted records come back". */
  acknowledgedResurrection?: boolean
  /* Test hook. Defaults to the real clock. */
  now?: () => string
}

export type ApplyResult =
  /* Everything done: cloud and this device now hold the resolved data. */
  | {
      status: 'applied'
      resolved: CloudSyncDocument
      warning?: string
    }
  /* Choices are not complete/valid yet. Nothing was written. */
  | { status: 'blocked'; result: ResolveResult }
  | { status: 'needs-acknowledgement'; result: ResolveResult }
  /*
    The cloud or this device changed while the dentist was deciding.
    Nothing was written. `session` is freshly built; `decisions` holds
    the choices that still apply, `reset` the rows that go back to
    undecided.
  */
  | {
      status: 'changed-while-deciding'
      session: ResolutionSession
      decisions: Decisions
      reset: string[]
    }
  /* The cloud document disappeared or became unreadable meanwhile. Nothing written. */
  | { status: 'failed'; result: CloudSyncResult; retryable: boolean }
  /* A OneDrive safety copy could not be saved, so nothing was applied. */
  | { status: 'safety-copy-failed'; detail: string }
  /* The pending marker couldn't be stored (storage full), so nothing was applied. */
  | { status: 'marker-failed'; detail: string }
  /*
    The cloud now holds the resolved data, but this device changed
    during the write, so local data was NOT overwritten. Local tracking
    is untouched: the next sync is 'diverged' again, with a small diff.
  */
  | { status: 'cloud-written-local-changed'; resolved: CloudSyncDocument }
  /* Cloud written; saving locally failed. Startup recovery will retry. */
  | { status: 'cloud-committed-locally-pending'; detail: string }

function nowIsoDefault(): string {
  return new Date().toISOString()
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ---- pending marker ---- */

type PendingResolutionMarker = {
  accountId: string | null
  stamp: string
  counterAtOpen: number
  document: CloudSyncDocument
}

function writePendingMarker(marker: PendingResolutionMarker): void {
  localStorage.setItem(PENDING_RESOLUTION_KEY, JSON.stringify(marker))
}

export function clearPendingMarker(): void {

  try {
    localStorage.removeItem(PENDING_RESOLUTION_KEY)
  } catch {
    // nothing sensible to do - recovery re-checks every condition anyway
  }

}

export function hasPendingResolutionMarker(): boolean {

  try {
    return localStorage.getItem(PENDING_RESOLUTION_KEY) !== null
  } catch {
    return false
  }

}

function readPendingMarker(): PendingResolutionMarker | null {

  try {

    const raw = localStorage.getItem(PENDING_RESOLUTION_KEY)

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<PendingResolutionMarker>

    if (
      !parsed ||
      typeof parsed.stamp !== 'string' ||
      typeof parsed.counterAtOpen !== 'number' ||
      !Number.isInteger(parsed.counterAtOpen) ||
      (parsed.accountId !== null && typeof parsed.accountId !== 'string') ||
      !parsed.document ||
      typeof parsed.document !== 'object'
    ) {
      return null
    }

    return parsed as PendingResolutionMarker

  } catch {

    return null

  }

}

/* ---- re-reading the session when something changed ---- */

async function reopenSession(
  previous: ResolutionSession,
  decisions: Decisions
): Promise<ApplyResult> {

  const prepared = await prepareResolution()

  if (prepared.status === 'failed') {
    return { status: 'failed', result: prepared.result, retryable: true }
  }

  if (prepared.status !== 'ready' && prepared.status !== 'identical') {

    /*
      Not diverged any more, or the cloud document is gone - there is
      nothing left to resolve here. Reported as a plain failure with a
      divergence-shaped result; the screen re-prepares and routes.
    */
    return {
      status: 'failed',
      result: {
        status: 'diverged',
        detail: 'The situation changed while you were deciding. Nothing was written.',
      },
      retryable: true,
    }

  }

  const carried = carryOverDecisions(previous.diff, prepared.session.diff, decisions)

  return {
    status: 'changed-while-deciding',
    session: prepared.session,
    decisions: carried.decisions,
    reset: carried.reset,
  }

}

/* ---- the apply itself ---- */

export async function applyResolution(
  session: ResolutionSession,
  decisions: Decisions,
  options: ApplyOptions = {}
): Promise<ApplyResult> {

  const now = options.now ?? nowIsoDefault

  /*
    Step 1 - re-resolve, no I/O. The stamp is created once per session
    and reused by retries (see ResolutionSession.attemptStamp).
  */
  const stamp = session.attemptStamp ?? now()

  const resolution = resolveSnapshots(session.device, session.cloud, decisions, {
    nowIso: stamp,
    lastSyncAt: session.lastSyncAt,
    numberFixes: options.numberFixes,
  })

  if (!resolution.canApply || resolution.document === null) {
    return { status: 'blocked', result: resolution }
  }

  if (resolution.resurrected.length > 0 && !options.acknowledgedResurrection) {
    return { status: 'needs-acknowledgement', result: resolution }
  }

  const resolved = resolution.document

  if (isResolutionApplying()) {
    return {
      status: 'failed',
      result: {
        status: 'diverged',
        detail: 'A resolution is already being applied.',
      },
      retryable: true,
    }
  }

  setResolutionApplying(true)

  try {

    session.attemptStamp = stamp

    /* Step 2 - has anything moved since the dentist looked? */
    const cloudRead = await readCloudSyncDocument()

    const readFailure = classifyCloudReadFailure(cloudRead)

    if (readFailure) {
      return { status: 'failed', result: readFailure, retryable: true }
    }

    if (cloudRead.status !== 'found') {
      return reopenSession(session, decisions)
    }

    /*
      A previous attempt in this session may already have landed (the
      response was lost): the cloud then holds exactly the document
      this attempt would write. Skip straight to the local commit.
    */
    const alreadyWritten =
      cloudRead.document.updatedAt === stamp &&
      exactRecordSignature(cloudRead.document) === exactRecordSignature(resolved)

    if (alreadyWritten) {
      return commitLocally(session, resolved, cloudRead.eTag, now)
    }

    if (cloudRead.eTag !== session.cloudETag) {
      return reopenSession(session, decisions)
    }

    if (readLocalChangeCounter() !== session.counterAtOpen) {
      return reopenSession(session, decisions)
    }

    /* Step 3 - safety copies of BOTH sides (once per session). */
    if (!session.safetyCopiesSaved) {

      const saved = await saveResolutionSafetyCopies({
        device: session.device,
        cloud: session.cloud,
        cloudETag: session.cloudETag,
        nowIso: now(),
      })

      if (!saved.ok) {
        return { status: 'safety-copy-failed', detail: saved.detail }
      }

      session.safetyCopiesSaved = true
      session.safetyCopyWarning = saved.warning

    }

    /*
      The local counter is re-checked once more: the safety-copy
      uploads above are real awaits during which an edit could land.
    */
    if (readLocalChangeCounter() !== session.counterAtOpen) {
      return reopenSession(session, decisions)
    }

    /* Step 4 - pending marker. */
    try {

      writePendingMarker({
        accountId: readSyncedAccountId(),
        stamp,
        counterAtOpen: session.counterAtOpen,
        document: resolved,
      })

    } catch (error) {

      clearPendingMarker()

      return { status: 'marker-failed', detail: describeError(error) }

    }

    /* Step 5 - conditional write. */
    const writeResult = await writeCloudSyncDocument(resolved, session.cloudETag)

    if (writeResult.status === 'precondition-failed') {

      clearPendingMarker()

      return reopenSession(session, decisions)

    }

    if (writeResult.status === 'invalid-document') {

      clearPendingMarker()

      return {
        status: 'failed',
        result: { status: 'validation-failed', detail: writeResult.detail },
        retryable: false,
      }

    }

    if (writeResult.status !== 'written') {

      /*
        auth-failed / permission-denied / network-unreachable /
        graph-error. The outcome is UNKNOWN (a network drop can lose
        the response of a write that did land), so the marker stays:
        a retry recognises a landed write, and startup recovery can
        finish it. Nothing local has changed.
      */
      return { status: 'failed', result: writeResult, retryable: true }

    }

    return commitLocally(session, resolved, writeResult.eTag, now)

  } finally {

    setResolutionApplying(false)

  }

}

/* Steps 6-7. No await between the counter check and the commit. */
function commitLocally(
  session: ResolutionSession,
  resolved: CloudSyncDocument,
  eTag: string | null,
  now: () => string
): ApplyResult {

  if (readLocalChangeCounter() !== session.counterAtOpen) {

    clearPendingMarker()

    return { status: 'cloud-written-local-changed', resolved }

  }

  try {

    commitResolvedSnapshotLocally(resolved, now(), session.counterAtOpen, eTag)

  } catch (error) {

    return {
      status: 'cloud-committed-locally-pending',
      detail:
        `OneDrive was updated, but saving the result on this device failed (${describeError(error)}). ` +
        'It will be finished the next time the app opens.',
    }

  }

  clearPendingMarker()

  return session.safetyCopyWarning === undefined
    ? { status: 'applied', resolved }
    : { status: 'applied', resolved, warning: session.safetyCopyWarning }

}

/* ---------- identical content: advance tracking only ---------- */

export type MarkInSyncResult =
  | { status: 'in-sync' }
  | { status: 'changed-while-deciding'; session: ResolutionSession }
  | { status: 'failed'; result: CloudSyncResult }

/*
  For an empty diff: both sides already hold the same data, so nothing
  is written to the cloud and no data is touched - only the tracking is
  advanced to "this device matches cloud version X". Re-reads the cloud
  first; if it moved since the session opened, nothing is recorded.
*/
export async function markInSync(
  session: ResolutionSession,
  options: { now?: () => string } = {}
): Promise<MarkInSyncResult> {

  const now = options.now ?? nowIsoDefault

  const cloudRead = await readCloudSyncDocument()

  const readFailure = classifyCloudReadFailure(cloudRead)

  if (readFailure) {
    return { status: 'failed', result: readFailure }
  }

  if (cloudRead.status !== 'found') {
    return {
      status: 'failed',
      result: { status: 'diverged', detail: 'The cloud document is gone. Nothing was written.' },
    }
  }

  if (
    cloudRead.eTag !== session.cloudETag ||
    readLocalChangeCounter() !== session.counterAtOpen
  ) {

    const prepared = await prepareResolution()

    if (prepared.status === 'ready' || prepared.status === 'identical') {
      return { status: 'changed-while-deciding', session: prepared.session }
    }

    return {
      status: 'failed',
      result: { status: 'diverged', detail: 'The situation changed. Nothing was written.' },
    }

  }

  recordCloudMatchesLocal(
    cloudRead.document,
    now(),
    session.counterAtOpen,
    cloudRead.eTag
  )

  return { status: 'in-sync' }

}

/* ---------- crash recovery ---------- */

export type RecoveryResult =
  | { status: 'none' }
  /* The interrupted apply was finished: this device now holds the resolved data. */
  | { status: 'completed' }
  /* A condition failed; the marker was dropped. State is simply 'diverged' again. */
  | { status: 'dropped'; reason: 'different-account' | 'cloud-does-not-match' | 'local-changed' | 'unreadable-marker' }
  /* Couldn't reach the cloud; the marker stays for the next start. */
  | { status: 'deferred'; result: CloudSyncResult }
  | { status: 'commit-failed'; detail: string }

export async function finishPendingResolution(
  options: { activeAccountId?: string | null; now?: () => string } = {}
): Promise<RecoveryResult> {

  if (!hasPendingResolutionMarker()) {
    return { status: 'none' }
  }

  const now = options.now ?? nowIsoDefault

  const marker = readPendingMarker()

  if (marker === null) {
    clearPendingMarker()
    return { status: 'dropped', reason: 'unreadable-marker' }
  }

  /*
    Condition 1 - account. The device's recorded synced account is
    compared to the one the marker was written under (and, when the
    caller knows it, the account active right now).
  */
  const currentAccountId = options.activeAccountId ?? readSyncedAccountId()

  if (marker.accountId !== readSyncedAccountId() || marker.accountId !== currentAccountId) {
    clearPendingMarker()
    return { status: 'dropped', reason: 'different-account' }
  }

  /* Condition 3 (cheap, checked early too) - no local edit since the screen opened. */
  if (readLocalChangeCounter() !== marker.counterAtOpen) {
    clearPendingMarker()
    return { status: 'dropped', reason: 'local-changed' }
  }

  const cloudRead = await readCloudSyncDocument()

  const readFailure = classifyCloudReadFailure(cloudRead)

  if (readFailure) {
    return { status: 'deferred', result: readFailure }
  }

  /* Condition 2 - the write really landed. */
  if (cloudRead.status !== 'found' || cloudRead.document.updatedAt !== marker.stamp) {
    clearPendingMarker()
    return { status: 'dropped', reason: 'cloud-does-not-match' }
  }

  /*
    Condition 3 again, AFTER the await: an edit could have landed while
    the cloud was being read, and committing now would overwrite it.
  */
  if (readLocalChangeCounter() !== marker.counterAtOpen) {
    clearPendingMarker()
    return { status: 'dropped', reason: 'local-changed' }
  }

  try {

    commitResolvedSnapshotLocally(
      cloudRead.document,
      now(),
      marker.counterAtOpen,
      cloudRead.eTag
    )

  } catch (error) {

    return { status: 'commit-failed', detail: describeError(error) }

  }

  clearPendingMarker()

  return { status: 'completed' }

}
