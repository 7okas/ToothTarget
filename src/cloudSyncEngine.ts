import type { Patient, SavedTreatment, ProcedureTemplate, Procedure } from './App'

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  validateCloudSyncDocument,
  type CloudSyncDocument,
} from './cloudSync'

/*
  mergeCloudSyncDocuments()/pruneExpiredTombstones() (cloudMerge.ts),
  recordAndReconcilePatientNumberConflicts() (patientNumberConflicts.ts),
  isDeviceSyncStale()/findStaleReviewCandidates() (deviceSyncTracking.ts/
  staleRecordReview.ts) are no longer imported here - Phase 5 (single-
  writer sync model) removed their one caller in this file (the old
  performSync()). None of those modules themselves were touched; they
  keep compiling and keep passing their own tests, simply with one
  fewer caller. PatientNumberConflict/StaleReviewCandidate stay as
  type-only imports - CloudSyncResult's own type still carries them
  (patientNumberConflicts on every success; the now-unconstructed-from-
  here 'stale-review-required' variant still exists in the union, per
  this phase's own instruction to keep that shape unchanged).
*/
import type { PatientNumberConflict } from './patientNumberConflicts'

import {
  readCloudSyncDocument,
  writeCloudSyncDocument,
  type CloudSyncReadResult,
  type CloudSyncTransportFailure,
} from './cloudStorage'

import type { CloudSyncCorruptionDiagnosis } from './cloudSyncCorruptionDiagnosis'

import { recordDeviceSyncSuccess } from './deviceSyncTracking'

import type { StaleReviewCandidate } from './staleRecordReview'

/*
  CLOUD SYNC ENGINE (Phase 6 - orchestration)

  This is the one explicit entry point (syncCloudNow()) that connects
  every previous layer into a single safe synchronization transaction:
  Phase 1's schema/validator (cloudSync.ts), Phase 3's pure merge
  engine (cloudMerge.ts), Phase 4's local conflict store
  (patientNumberConflicts.ts), and Phase 5's transport (cloudStorage.ts).

  Automatic background sync is real and in production: syncCloudNow()
  is called through cloudSyncScheduler.ts's requestCloudSync()/
  requestCloudSyncIfSignedIn(), which App.tsx triggers after every
  meaningful synchronized-data change (patient/treatment/template/
  procedure create-edit-delete, tombstones), on app load, and on
  Microsoft sign-in (see MicrosoftAccountSection.tsx's handleSignIn()).
  It is also safe to call directly - eg. from a test - with the same
  behavior either way.

  Only TYPE-ONLY imports are taken from App.tsx (erased at compile
  time under verbatimModuleSyntax) - same reasoning as
  patientNumberConflicts.ts's own header comment: importing App.tsx's
  RUNTIME module graph would pull in MicrosoftAccountSection.tsx ->
  auth.ts/authConfig.ts, which touch `window.location` and instantiate
  MSAL at module load time, crashing under Vitest's default 'node'
  environment. This module DOES have a real runtime dependency on
  auth.ts, but only transitively through cloudStorage.ts's
  getAccessToken() call - exactly the boundary Phase 5's own tests
  already mock via vi.mock('./auth', ...), and this file's own tests
  do the same.

  ============================================================
  SYNCHRONIZED VS LOCAL-ONLY DATA (confirmed by re-auditing App.tsx)
  ============================================================

  Synchronized (this file reads/writes these, and ONLY these, as the
  cloud-synchronized set):
    toothTargetPatients, toothTargetSavedTreatments,
    toothTargetTemplates (custom entries only),
    toothTargetProcedures (Phase 2, Sync & Statistics Redesign: EVERY
    entry, not just isCustom ones - every procedure is now a
    renamable/archivable tag, including former "built-ins", and a
    rename/archive on one device must reach every other device)

  Local-only (never read, written, or referenced by this file):
    toothTargetActiveTreatment, toothTargetIncompleteTreatments,
    toothTargetNextPatientNumber (see below - reconciled locally, but
    never taken FROM the cloud document, which doesn't carry it),
    built-in templates (templates are unaffected by Phase 2 - still
    isCustom-only, see TEMPLATES_KEY handling below), MSAL state,
    transient UI state.

  ============================================================
  CRASH-SAFETY ANALYSIS (see report for the full writeup)
  ============================================================

  No new "pending snapshot" transaction marker was needed. Phase 3's
  merge is a deterministic, commutative, idempotent UNION over each
  entity collection (patients/treatments/templates/procedures/
  tombstones keyed by id, tombstones keyed by (entityType, entityId)):
  merging a SUBSET of a dataset back into that same dataset always
  reproduces the dataset unchanged. Since a successful cloud write
  always uploads merge(local-at-that-moment, cloud-at-that-moment),
  and local-at-that-moment is by construction a subset of the
  resulting merged/uploaded document, ANY future sync attempt that
  re-reads a stale (or even partially-torn, key-by-key) local snapshot
  and merges it against the now-current cloud document is guaranteed
  to converge back to the correct state - old data can never be lost,
  and re-merging never fabricates or duplicates anything. This is what
  makes the five localStorage.setItem() calls in commitLocalState()
  safe to perform as separate, non-atomic writes: even if the tab
  crashes between two of them, the next sync's fresh read-merge-write
  cycle self-heals, because each individual key is still either the
  old (subset) value or the new (already-converged) value, and merging
  either against the authoritative cloud state produces the same
  correct result.

  The one thing this module must still get right ITSELF (within a
  single call) is honesty: if the cloud upload succeeds but the local
  commit throws (eg. a real localStorage quota error) DURING this same
  call, this function must not report a false 'synced' - see the
  'cloud-committed-locally-pending' status below and its handling in
  performSync().
*/

const PATIENTS_KEY = 'toothTargetPatients'
const SAVED_TREATMENTS_KEY = 'toothTargetSavedTreatments'
const TEMPLATES_KEY = 'toothTargetTemplates'
const PROCEDURES_KEY = 'toothTargetProcedures'
/*
  Retired: deletions no longer leave a record behind. Old devices still
  have this key (and old per-account caches still carry the same field);
  both are ignored on read and dropped on the next save.
*/
const RETIRED_TOMBSTONES_KEY = 'toothTargetDeletionTombstones'
const NEXT_PATIENT_NUMBER_KEY = 'toothTargetNextPatientNumber'

/*
  Phase 3's own local synchronized-document timestamp (section 3) -
  deliberately NOT part of CloudSyncDocument itself (that type has no
  extra field for it). Read as the LOCAL candidate document's
  updatedAt when building it for a push, and only ever written by this
  module's own commit helpers, to the value a push/pull just produced -
  never bumped merely because a sync was attempted.

  Phase 5 (single-writer sync model) repurposes this exact key as "the
  cloud updatedAt this device last confirmed matches" - the one piece
  of state pushLocalSnapshot()/pullCloudSnapshot() compare the cloud's
  CURRENT updatedAt against before ever writing anything. See
  isLocalDataDirty() below for the other half of that same decision
  (does LOCAL have anything the last confirmed state doesn't).
*/
const LOCAL_SYNC_UPDATED_AT_KEY = 'toothTargetCloudSyncUpdatedAt'

/*
  Paired with LOCAL_SYNC_UPDATED_AT_KEY above, written and read
  alongside it everywhere - updatedAt is the user-facing "cloud version
  this device last knew about" the Phase 5 plan names explicitly, but
  it only has MILLISECOND resolution: two pushes (eg. from two
  different devices, or even this device racing itself) can genuinely
  land in the same millisecond and produce the exact same updatedAt
  string despite being two different writes. The ETag OneDrive/the
  fake transport already hands back on every read/write never collides
  like that - it is a real, server-assigned version identifier - so it
  is what the divergence checks below actually compare; updatedAt
  keeps its role as the human-meaningful "when," never the precise
  "which version" decision.
*/
const LOCAL_SYNC_ETAG_KEY = 'toothTargetCloudSyncETag'

/*
  LOCAL CHANGE TRACKING (Phase 5 - single-writer sync model)

  Answers "does local have anything not yet reflected by the last
  successful push/pull?" without ever diffing individual records (that's
  Phase 6's job) - a plain change counter instead.

  toothTargetLocalChangeCounter is bumped by markLocalDataDirty(),
  called from cloudSyncScheduler.ts's requestCloudSync() - already the
  one choke point every synchronized mutation in this app goes through
  (patient/treatment/template/procedure create-edit-delete), so this
  needs no new call sites anywhere else.

  toothTargetLastSyncedChangeCounter is the counter's value AS OF the
  last successful push or pull-adopt - recorded with whatever value the
  counter held at the START of that operation (captured before its own
  first `await`), not whatever the counter happens to read when the
  operation finishes. This is what makes isLocalDataDirty() correctly
  report "still dirty" if a new edit landed WHILE a push/pull was in
  flight: the counter kept moving during that window, but the recorded
  "as of" value didn't, so the comparison below still disagrees.

  A device that has never recorded either key (never synced before) is
  NOT assumed clean - it's treated as dirty UNLESS local itself has zero
  patients and zero saved treatments. This protects data created on this
  device before Phase 5 ever ran (or before this device ever signed in)
  from being silently treated as disposable just because no counter
  exists yet; an empty device, with nothing to protect, is still free to
  adopt the cloud cleanly on its first pull.
*/

const LOCAL_CHANGE_COUNTER_KEY = 'toothTargetLocalChangeCounter'
const LAST_SYNCED_CHANGE_COUNTER_KEY = 'toothTargetLastSyncedChangeCounter'

export function readLocalChangeCounter(): number {

  const raw = localStorage.getItem(LOCAL_CHANGE_COUNTER_KEY)
  const parsed = raw === null ? NaN : Number(raw)

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0

}

/*
  Call after a synchronized-data mutation has already been committed to
  localStorage - same timing contract cloudSyncScheduler.ts's own
  requestCloudSync() already documents for itself, since that's its one
  caller.
*/
export function markLocalDataDirty(): void {

  localStorage.setItem(
    LOCAL_CHANGE_COUNTER_KEY,
    String(readLocalChangeCounter() + 1)
  )

}

function readLastSyncedChangeCounter(): number | null {

  const raw = localStorage.getItem(LAST_SYNCED_CHANGE_COUNTER_KEY)

  if (raw === null) {
    return null
  }

  const parsed = Number(raw)

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null

}

/*
  Records the counter value AS OF THE START of the push/pull that just
  succeeded - see this section's own header comment for why that's the
  value to record, never whatever the counter reads at this later,
  "just finished" moment. Exported for pushLocalSnapshot()/
  pullCloudSnapshot() (added later this phase) to call on success, and
  directly testable here in the meantime.
*/
export function writeLastSyncedChangeCounter(value: number): void {

  localStorage.setItem(LAST_SYNCED_CHANGE_COUNTER_KEY, String(value))

}

export function isLocalDataDirty(): boolean {

  const lastSynced = readLastSyncedChangeCounter()

  if (lastSynced === null) {

    const patients = readLocalArray(PATIENTS_KEY)
    const savedTreatments = readLocalArray(SAVED_TREATMENTS_KEY)

    return !(patients.length === 0 && savedTreatments.length === 0)

  }

  return readLocalChangeCounter() !== lastSynced

}

function readLocalArray(key: string): unknown[] {

  try {

    const raw = localStorage.getItem(key)

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed : []

  } catch {

    return []

  }

}

export function readLocalSyncUpdatedAt(): string | null {

  const raw = localStorage.getItem(LOCAL_SYNC_UPDATED_AT_KEY)

  return typeof raw === 'string' && raw.trim() !== '' ? raw : null

}

function readLocalSyncETag(): string | null {

  const raw = localStorage.getItem(LOCAL_SYNC_ETAG_KEY)

  return typeof raw === 'string' && raw.trim() !== '' ? raw : null

}

function readPersistedNextPatientNumber(): number {

  try {

    const raw = localStorage.getItem(NEXT_PATIENT_NUMBER_KEY)

    if (!raw) {
      return 1
    }

    const parsed = JSON.parse(raw)

    return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0
      ? parsed
      : 1

  } catch {

    return 1

  }

}

/*
  LOCAL DOCUMENT CONSTRUCTION

  Reads exactly the five synchronized keys and runs the result
  through validateCloudSyncDocument() before returning it - this
  module never uploads or merges data it hasn't first confirmed is a
  structurally valid v2 document. If local data is somehow not yet in
  the current (migrated) shape - this module does not itself run
  migrations, see this file's header comment - validation fails here
  and syncCloudNow() reports 'validation-failed' rather than guessing
  or repairing anything.

  Templates are still filtered down to isCustom === true (mirroring
  createCloudBackup()'s own filter in cloudBackup.ts) - unaffected by
  Phase 2. Procedures are NOT filtered any more: every procedure/tag,
  built-in or not, is uploaded as-is, so a rename/archive on a former
  "built-in" propagates to other devices exactly like any other edit.

  updatedAt: readLocalSyncUpdatedAt() ?? "now" - the ONLY time "now" is
  used is when no local sync timestamp has ever been recorded (this
  device's very first sync), which is a genuine first-existence event
  for the synchronized-document concept, not a "sync was merely
  attempted" bump. Every subsequent call reuses the persisted value
  until commitLocalState() advances it after an actual successful
  merge commit.
*/

export function buildLocalCloudSyncDocument():
  | { valid: true; document: CloudSyncDocument }
  | { valid: false; error: string } {

  const patients = readLocalArray(PATIENTS_KEY) as Patient[]
  const savedTreatments = readLocalArray(SAVED_TREATMENTS_KEY) as SavedTreatment[]
  const templates = readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]
  const procedures = readLocalArray(PROCEDURES_KEY) as Procedure[]

  const candidate = {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    app: CLOUD_SYNC_APP,
    updatedAt: readLocalSyncUpdatedAt() ?? new Date().toISOString(),
    patients,
    savedTreatments,
    customTemplates: templates.filter(
      template => template.isCustom === true
    ),
    customProcedures: procedures,
  }

  return validateCloudSyncDocument(candidate)

}

/*
  ============================================================
  PHASE 5 - SINGLE-WRITER PUSH
  ============================================================

  pushLocalSnapshot() is the new push entry point: build the current
  local state into one document and write it, with no per-record merge
  at all - the single-writer model this app actually needs (one
  dentist, one device at a time; OneDrive is a backup, not a
  collaboration store). Not wired into syncCloudNow() yet in this step -
  see this file's own CloudSyncResult/syncCloudNow() for the OLD
  per-record-merge path, still untouched and still exercised by
  cloudSyncEngine.test.ts until a later step rewires syncCloudNow()
  itself to call this.

  THE ONE SAFETY CHECK BEFORE EVER WRITING (the Phase 6 hook): compare
  the cloud document's ACTUAL updatedAt against
  toothTargetCloudSyncUpdatedAt - this device's record of "the cloud
  version I last confirmed matches" (see LOCAL_SYNC_UPDATED_AT_KEY's own
  comment above). A mismatch means something else changed the cloud
  since this device last knew about it - this device refuses to
  silently overwrite that with its own (possibly older, possibly just
  different) local state, and returns 'diverged' instead. Phase 6
  replaces this with real per-record conflict listing; nothing else
  about this function needs to change for that to plug in here.
*/

/*
  Shared by pushLocalSnapshot() and pullCloudSnapshot() (added later
  this phase) - every CloudSyncReadResult status that ISN'T 'not-found'
  or 'found' is a transport/corruption failure this device can't do
  anything about itself, and both callers need to forward it identically
  (the exact same shapes the OLD performSync() already returns for each
  one, so CloudCorruptionRecoveryDialog.tsx/the badge keep working
  unmodified). Returns null for 'not-found'/'found', which the caller
  still needs to handle itself (this function has no opinion on what a
  successful read should do next).
*/
export function classifyCloudReadFailure(
  cloudRead: CloudSyncReadResult
): CloudSyncResult | null {

  switch (cloudRead.status) {

    case 'not-found':
    case 'found':
      return null

    case 'malformed-json':
    case 'invalid-document':
      return {
        status: 'cloud-invalid',
        detail: cloudRead.detail,
        diagnosis: cloudRead.diagnosis,
      }

    case 'auth-failed':
      return { status: 'auth-failed' }

    case 'permission-denied':
      return { status: 'permission-denied', detail: cloudRead.detail }

    case 'network-unreachable':
      return { status: 'network-unreachable', detail: cloudRead.detail }

    case 'graph-error':
      return { status: 'graph-error', detail: cloudRead.detail }

  }

}

/*
  Lighter than the OLD commitLocalState(): a push never changes what
  patients/savedTreatments/customTemplates/customProcedures already are
  (they're exactly what was just read and uploaded), so only the
  sync-tracking state needs advancing - the cloud version this device
  now knows about, the change counter "as of" this push (captured by the
  CALLER before this push's first await - see this function's own
  counterAtStart parameter), the device's own last-successful-sync
  timestamp, and (same reconciliation commitLocalState() already uses)
  the local patient-number counter.
*/
function recordSuccessfulPush(
  document: CloudSyncDocument,
  nowIso: string,
  counterAtStart: number,
  eTag: string | null
): void {

  localStorage.setItem(LOCAL_SYNC_UPDATED_AT_KEY, document.updatedAt)

  /*
    See LOCAL_SYNC_ETAG_KEY's own comment - this is the actual value
    the next push/pull's divergence check compares against, since
    updatedAt alone can collide across two genuinely different writes.
    A write that somehow succeeds with no eTag at all (not expected in
    practice) clears this instead of storing a false one, so the NEXT
    attempt honestly treats the cloud version as unconfirmed again
    rather than trusting a value this write never actually got.
  */
  if (eTag !== null) {
    localStorage.setItem(LOCAL_SYNC_ETAG_KEY, eTag)
  } else {
    localStorage.removeItem(LOCAL_SYNC_ETAG_KEY)
  }

  writeLastSyncedChangeCounter(counterAtStart)

  const storedNextPatientNumber = readPersistedNextPatientNumber()

  const highestAssignedPatientNumber =
    document.patients.reduce(
      (highest, patient) =>
        patient.patientNumber > highest ? patient.patientNumber : highest,
      0
    )

  const reconciledNextPatientNumber =
    Math.max(storedNextPatientNumber, highestAssignedPatientNumber + 1)

  if (reconciledNextPatientNumber !== storedNextPatientNumber) {

    localStorage.setItem(
      NEXT_PATIENT_NUMBER_KEY,
      JSON.stringify(reconciledNextPatientNumber)
    )

  }

  recordDeviceSyncSuccess(nowIso)

}

/*
  MIGRATION BRIDGE (Phase 5 follow-up)

  "Has the cloud changed since this device last knew?" - shared by
  both pushLocalSnapshot()'s pre-write check and pullCloudSnapshot()'s
  own check below. Normally this is a pure ETag comparison (see
  LOCAL_SYNC_ETAG_KEY's own comment for why ETag, not updatedAt, is the
  real signal). But a device whose LAST REAL sync happened under the
  OLD sync engine - before toothTargetCloudSyncETag existed at all -
  has toothTargetCloudSyncUpdatedAt (which the old engine always
  wrote) but no ETag yet. Without this bridge, such a device would
  read knownCloudETag as null on its very first Phase-5 sync and
  treat the cloud as unconditionally "changed", even when nothing
  actually happened - a false 'diverged' purely from the old-to-new
  migration gap, not a real conflict.

  The bridge only ever fires in that one specific gap (ETag absent,
  OLD updatedAt marker present): it falls back to comparing that
  updatedAt against the cloud document's own updatedAt. Equal means
  "treat as unchanged" - the normal push/pull rules then decide what
  to do from there (push if local is dirty, adopt if clean), and a
  successful push/adopt always records a real ETag afterward (see
  recordSuccessfulPush()/adoptCloudSnapshotLocally()), so this bridge
  is consulted at most once per device. Different means "treat as
  changed" - exactly today's behavior, so 'diverged' still stands when
  local has its own unsynced changes. A device with BOTH keys absent
  (genuinely never synced under either system) hits neither branch and
  falls through to "changed", unchanged from before this bridge
  existed.

  Deliberately does not touch isLocalDataDirty(), the pre-adopt safety
  copy, the change counters, or anything else - deciding "is the cloud
  different" is the only thing this answers, exactly like the plain
  ETag comparison it's standing in for.
*/
export function hasCloudChangedSinceKnown(
  cloudUpdatedAt: string,
  cloudETag: string
): boolean {

  const knownCloudETag = readLocalSyncETag()

  if (knownCloudETag !== null) {
    return cloudETag !== knownCloudETag
  }

  const knownCloudUpdatedAt = readLocalSyncUpdatedAt()

  if (knownCloudUpdatedAt !== null) {
    return cloudUpdatedAt !== knownCloudUpdatedAt
  }

  return true

}

/*
  PHASE 6 - RESOLUTION IN PROGRESS GUARD

  Set only by syncResolutionEngine.ts's applyResolution() for the
  duration of one apply, so no background push/pull can run in the
  middle of it. Always false otherwise - when false (every code path
  that exists today) pushLocalSnapshot()/pullCloudSnapshot() behave
  exactly as before. While set they stop at the same 'diverged' result
  they already return for an unresolved disagreement, writing nothing.
*/
let resolutionApplying = false

export function setResolutionApplying(value: boolean): void {
  resolutionApplying = value
}

export function isResolutionApplying(): boolean {
  return resolutionApplying
}

const RESOLUTION_IN_PROGRESS_RESULT: CloudSyncResult = {
  status: 'diverged',
  detail: 'A resolution is being applied right now. Nothing was written.',
}

export async function pushLocalSnapshot(): Promise<CloudSyncResult> {

  if (resolutionApplying) {
    return RESOLUTION_IN_PROGRESS_RESULT
  }

  /*
    Captured before this function's first await, synchronously - see
    recordSuccessfulPush()'s own comment and this phase's own header
    comment on LOCAL_CHANGE_COUNTER_KEY for why the counter value AT
    THIS MOMENT, not whenever this function happens to finish, is what
    correctly keeps local "still dirty" if a new edit lands while this
    push is in flight.
  */
  const counterAtStart = readLocalChangeCounter()

  const localResult = buildLocalCloudSyncDocument()

  if (!localResult.valid) {
    return { status: 'validation-failed', detail: localResult.error }
  }

  const cloudRead = await readCloudSyncDocument()

  const readFailure = classifyCloudReadFailure(cloudRead)

  if (readFailure) {
    return readFailure
  }

  /*
    knownCloudUpdatedAt is read here (even though the PRE-WRITE check
    below now goes through hasCloudChangedSinceKnown(), which does its
    own ETag/migration-bridge reads) because the one-retry-after-412
    check further down still specifically compares it per this phase's
    own spec - see that check's own comment for why updatedAt, not
    ETag, is deliberately used there.
  */
  const knownCloudUpdatedAt = readLocalSyncUpdatedAt()

  const divergedResult: CloudSyncResult = {
    status: 'diverged',
    detail:
      'This device has unsynced changes, and the cloud data has changed ' +
      'since this device last synced. Neither side was overwritten.',
  }

  /*
    A cloud document already exists - never push blindly over it
    without first confirming (via hasCloudChangedSinceKnown(), ETag or
    its old-system migration-bridge fallback) that this device's
    record of the cloud still matches. The normal path for a never-
    synced device is pullCloudSnapshot() running first (app open/
    sign-in), which only ever delegates here once it's already
    confirmed the cloud is unchanged (see that function's own comment)
    - this check only ever fires for the rare direct-push-before-any-
    pull case, and it fires on purpose: a device with no memory of the
    cloud's content must never silently overwrite a document it knows
    nothing about.
  */
  if (
    cloudRead.status === 'found' &&
    hasCloudChangedSinceKnown(cloudRead.document.updatedAt, cloudRead.eTag)
  ) {
    return divergedResult
  }

  const expectedETag = cloudRead.status === 'found' ? cloudRead.eTag : null

  const nowIso = new Date().toISOString()

  /*
    updatedAt is stamped fresh here, for THIS snapshot, rather than
    reused from whatever the local build step read.
  */
  const documentToWrite: CloudSyncDocument = {
    ...localResult.document,
    updatedAt: nowIso,
  }

  let writeResult = await writeCloudSyncDocument(documentToWrite, expectedETag)

  if (writeResult.status === 'precondition-failed') {

    /*
      ONE BOUNDED RETRY, per this phase's own spec - deliberately
      compares updatedAt here (not the ETag the pre-write check above
      uses): a genuine last-instant race between our read and our
      write attempt (something else wrote in that exact window).
      Re-read once: if the cloud's updatedAt still matches what this
      device already knew before this push started, retry the write
      once with the fresh ETag. If it now differs, that's a real
      divergence - report it the same way the pre-write check above
      would have. No loop, no re-merge: there is nothing to merge
      against in this model.
    */

    const retryRead = await readCloudSyncDocument()

    const retryReadFailure = classifyCloudReadFailure(retryRead)

    if (retryReadFailure) {
      return retryReadFailure
    }

    const stillMatchesWhatWeKnew =
      retryRead.status === 'found' &&
      knownCloudUpdatedAt !== null &&
      retryRead.document.updatedAt === knownCloudUpdatedAt

    if (!stillMatchesWhatWeKnew) {
      return divergedResult
    }

    writeResult = await writeCloudSyncDocument(
      documentToWrite,
      retryRead.status === 'found' ? retryRead.eTag : null
    )

    if (writeResult.status === 'precondition-failed') {
      return divergedResult
    }

  }

  if (writeResult.status === 'auth-failed') {
    return { status: 'auth-failed' }
  }

  if (writeResult.status === 'permission-denied') {
    return { status: 'permission-denied', detail: writeResult.detail }
  }

  if (writeResult.status === 'network-unreachable') {
    return { status: 'network-unreachable', detail: writeResult.detail }
  }

  if (writeResult.status === 'graph-error') {
    return { status: 'graph-error', detail: writeResult.detail }
  }

  if (writeResult.status === 'invalid-document') {
    /*
      Shouldn't happen - localResult.valid was already confirmed above -
      but the transport layer re-validates independently and this
      module never assumes away a disagreement between the two (same
      reasoning the OLD performSync() already documents for itself).
    */
    return { status: 'validation-failed', detail: writeResult.detail }
  }

  // writeResult.status === 'written' from here on. The cloud already
  // has this device's data - a failure past this point is a LOCAL
  // bookkeeping problem, never grounds to report anything other than
  // 'cloud-committed-locally-pending' (same honesty discipline the OLD
  // performSync()/commitLocalState() pairing already followed: never
  // claim 'synced' if the local half of that didn't actually happen).
  try {

    recordSuccessfulPush(documentToWrite, nowIso, counterAtStart, writeResult.eTag)

  } catch (error) {

    const detail = error instanceof Error ? error.message : String(error)

    return {
      status: 'cloud-committed-locally-pending',
      detail:
        `The cloud document was updated successfully, but saving it locally failed (${detail}). ` +
        'The local data itself is unaffected; only this device\'s own ' +
        'record of having synced may be out of date until a future sync ' +
        'attempt succeeds.',
    }

  }

  return { status: 'synced', patientNumberConflicts: [] }

}

/*
  ============================================================
  PHASE 5 - SINGLE-WRITER PULL
  ============================================================

  pullCloudSnapshot() is the "app open while signed in" / "fresh
  sign-in" entry point: read the cloud, and either adopt it as local
  (local has nothing of its own at risk) or fall back to a push (local
  is ahead of a cloud that hasn't moved) or stop at 'diverged' (both
  sides moved - the same Phase 6 hook pushLocalSnapshot() uses above).
  Not wired into any trigger yet in this step.
*/

const PRE_ADOPT_SAFETY_COPY_KEY = 'toothTargetPreAdoptSafetyCopy'

/*
  Amendment 3 - a single, overwritten-each-time (never accumulated)
  local-only safety copy of whatever local synced data is about to be
  replaced by a pull's adoption step, captured synchronously
  immediately before that replacement happens. Deliberately excluded
  from everything else: buildLocalCloudSyncDocument() never reads this
  key (so it can never reach the cloud), and it is never added to
  cloudBackup.ts's own key lists (so it's never part of a manual backup
  either) - this exists purely as this device's own undo-adjacent
  breadcrumb, nothing more. No UI reads it yet. Best-effort, wrapped in
  try/catch exactly like saveAccountCache() already is - a failure here
  must never block the adoption it exists to protect against.
*/
function writePreAdoptSafetyCopy(): void {

  try {

    const snapshot = {
      capturedAt: new Date().toISOString(),
      patients: readLocalArray(PATIENTS_KEY),
      savedTreatments: readLocalArray(SAVED_TREATMENTS_KEY),
      customTemplates:
        (readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]).filter(
          template => template.isCustom === true
        ),
      customProcedures: readLocalArray(PROCEDURES_KEY),
    }

    localStorage.setItem(PRE_ADOPT_SAFETY_COPY_KEY, JSON.stringify(snapshot))

  } catch (error) {

    console.error(
      'Cloud sync: could not save a safety copy of local data before ' +
      'adopting the cloud snapshot - proceeding anyway (this copy is ' +
      'only an extra safeguard; nothing here is at risk of being lost ' +
      'either way).',
      error
    )

  }

}

/*
  Adopts `document` as local truth - patients/savedTreatments/
  customProcedures replace wholesale (this device had nothing of its
  own worth keeping, per the caller's own clean-to-adopt check), and
  templates keep this device's built-ins and replace only the custom
  ones, the same pattern commitLocalState()/applyCloudRestore() already
  use for the identical reason.
*/
function adoptCloudSnapshotLocally(
  document: CloudSyncDocument,
  nowIso: string,
  counterAtAdopt: number,
  eTag: string | null
): void {

  localStorage.setItem(PATIENTS_KEY, JSON.stringify(document.patients))

  localStorage.setItem(
    SAVED_TREATMENTS_KEY,
    JSON.stringify(document.savedTreatments)
  )

  const currentTemplates = readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]

  const builtInTemplates =
    currentTemplates.filter(template => template.isCustom === false)

  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify([...builtInTemplates, ...document.customTemplates])
  )

  localStorage.setItem(
    PROCEDURES_KEY,
    JSON.stringify(document.customProcedures)
  )

  localStorage.removeItem(RETIRED_TOMBSTONES_KEY)

  const storedNextPatientNumber = readPersistedNextPatientNumber()

  const highestAssignedPatientNumber =
    document.patients.reduce(
      (highest, patient) =>
        patient.patientNumber > highest ? patient.patientNumber : highest,
      0
    )

  const reconciledNextPatientNumber =
    Math.max(storedNextPatientNumber, highestAssignedPatientNumber + 1)

  if (reconciledNextPatientNumber !== storedNextPatientNumber) {

    localStorage.setItem(
      NEXT_PATIENT_NUMBER_KEY,
      JSON.stringify(reconciledNextPatientNumber)
    )

  }

  localStorage.setItem(LOCAL_SYNC_UPDATED_AT_KEY, document.updatedAt)

  if (eTag !== null) {
    localStorage.setItem(LOCAL_SYNC_ETAG_KEY, eTag)
  } else {
    localStorage.removeItem(LOCAL_SYNC_ETAG_KEY)
  }

  writeLastSyncedChangeCounter(counterAtAdopt)

  recordDeviceSyncSuccess(nowIso)

}

export async function pullCloudSnapshot(): Promise<CloudSyncResult> {

  if (resolutionApplying) {
    return RESOLUTION_IN_PROGRESS_RESULT
  }

  const cloudRead = await readCloudSyncDocument()

  const readFailure = classifyCloudReadFailure(cloudRead)

  if (readFailure) {
    return readFailure
  }

  if (cloudRead.status === 'not-found') {
    /*
      Nothing to pull. If local has its own data, this is exactly
      "first sign-in on a device that already has local data" (or a
      first-ever sync on a brand-new one, where pushing an empty
      document is a harmless no-op) - either way, the right move is to
      push, not to invent a cloud document here ourselves.
    */
    return pushLocalSnapshot()
  }

  if (cloudRead.status !== 'found') {
    /*
      Unreachable - classifyCloudReadFailure() above already handles
      every CloudSyncReadResult status except 'not-found'/'found', and
      'not-found' was just handled too. Kept as an explicit, honest
      guard (never a type assertion) so TypeScript's own narrowing
      stays sound below, the same "never assume away a disagreement"
      discipline this file already applies elsewhere.
    */
    return { status: 'validation-failed', detail: 'Unexpected cloud read result.' }
  }

  /*
    ETag (or, for a device last synced under the OLD system, the
    updatedAt migration bridge) - see hasCloudChangedSinceKnown()'s own
    comment, shared with pushLocalSnapshot().
  */
  const cloudChangedSinceKnown =
    hasCloudChangedSinceKnown(cloudRead.document.updatedAt, cloudRead.eTag)

  /*
    AMENDMENT 2 - PULL-SIDE RACE GUARD

    Evaluated synchronously, right here - immediately after this
    function's only await, and before any localStorage.setItem() that
    would overwrite synced data. This is what correctly catches a save
    that landed WHILE the cloud read above was in flight: isLocalDataDirty()
    re-reads the live counter fresh at this exact moment, so if an edit
    happened during that await, this now reports dirty even if it
    wasn't dirty when this function started - and the counter value
    captured here (counterAtAdopt) is the exact "as of" value recorded
    on success, so a later edit that lands AFTER this point is still
    correctly detected as unsynced on the next sync attempt.
  */
  const counterAtAdopt = readLocalChangeCounter()
  const cleanToAdopt = !isLocalDataDirty()

  if (cleanToAdopt) {

    writePreAdoptSafetyCopy()

    /*
      Same honesty discipline pushLocalSnapshot() applies to its own
      local commit: a thrown localStorage write here (eg. a quota
      error) happens AFTER this function has already decided adopting
      is safe, so it must never be reported as a silent 'synced' - the
      cloud is unaffected either way (a pull never writes to it), only
      this device's own local copy may be left partially updated.
    */
    try {

      adoptCloudSnapshotLocally(
        cloudRead.document,
        new Date().toISOString(),
        counterAtAdopt,
        cloudRead.eTag
      )

    } catch (error) {

      const detail = error instanceof Error ? error.message : String(error)

      return {
        status: 'cloud-committed-locally-pending',
        detail:
          `Adopting the cloud data failed partway through (${detail}). ` +
          'A future sync attempt will retry.',
      }

    }

    return { status: 'synced', patientNumberConflicts: [] }

  }

  /*
    Local is dirty - either it already was when this function started,
    or it just became dirty during the read above. Either way, adopting
    the cloud now would destructively overwrite real local work, so
    this never reaches adoptCloudSnapshotLocally() from here.
  */

  if (!cloudChangedSinceKnown) {
    // Local is ahead of a cloud that hasn't moved - flush it up instead
    // of discarding it.
    return pushLocalSnapshot()
  }

  // Both sides have unreconciled changes - the Phase 6 hook, same as
  // pushLocalSnapshot()'s own divergence check.
  return {
    status: 'diverged',
    detail:
      'This device has unsynced changes, and the cloud data has changed ' +
      'since this device last synced. Neither side was overwritten.',
  }

}

/*
  PHASE 6 - COMMIT HELPERS FOR A CONFIRMED RESOLUTION

  Thin exported wrappers over the two existing, private routines that
  already do exactly what a resolution needs, so syncResolutionEngine.ts
  never has to know the storage keys:

  commitResolvedSnapshotLocally() - this device now holds `document` as
  its data AND matches the cloud version `eTag` (replaces the five
  synced collections the same way a pull's adoption does, records the
  known cloud version, the change counter, the next patient number and
  the device's last-sync time).

  recordCloudMatchesLocal() - the data is already the same on both
  sides (an empty diff): nothing in the data is touched, only the
  tracking (known cloud version, change counter, next patient number,
  last-sync time) is advanced.
*/
export function commitResolvedSnapshotLocally(
  document: CloudSyncDocument,
  nowIso: string,
  counterToRecord: number,
  eTag: string | null
): void {
  adoptCloudSnapshotLocally(document, nowIso, counterToRecord, eTag)
}

export function recordCloudMatchesLocal(
  document: CloudSyncDocument,
  nowIso: string,
  counterToRecord: number,
  eTag: string | null
): void {
  recordSuccessfulPush(document, nowIso, counterToRecord, eTag)
}

/*
  PHASE 6 - RESTORE FROM A SAFETY COPY

  Replaces this device's five synced collections with `document`
  (templates keep this device's built-ins, the next patient number is
  reconciled upward) and touches NO sync-tracking value: not the known
  cloud version, not the change counter. The caller (syncResolutionRestore.ts)
  then marks local data as having unsynced changes, so the normal sync
  flow decides what happens next - push if OneDrive hasn't moved,
  'diverged' (and the resolution screen) if it has.
*/
export function replaceLocalSyncedData(document: CloudSyncDocument): void {

  localStorage.setItem(PATIENTS_KEY, JSON.stringify(document.patients))

  localStorage.setItem(
    SAVED_TREATMENTS_KEY,
    JSON.stringify(document.savedTreatments)
  )

  const builtInTemplates =
    (readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[])
      .filter(template => template.isCustom === false)

  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify([...builtInTemplates, ...document.customTemplates])
  )

  localStorage.setItem(
    PROCEDURES_KEY,
    JSON.stringify(document.customProcedures)
  )

  localStorage.removeItem(RETIRED_TOMBSTONES_KEY)

  const highestAssignedPatientNumber =
    document.patients.reduce(
      (highest, patient) =>
        patient.patientNumber > highest ? patient.patientNumber : highest,
      0
    )

  const reconciledNextPatientNumber = Math.max(
    readPersistedNextPatientNumber(),
    highestAssignedPatientNumber + 1
  )

  localStorage.setItem(
    NEXT_PATIENT_NUMBER_KEY,
    JSON.stringify(reconciledNextPatientNumber)
  )

}

/*
  RESULT TYPE
*/

/*
  recoveredFromConflict (Phase 6) - optional, and only ever set true by
  performSync() itself below, never by any other construction site
  (including every existing test that builds a literal CloudSyncResult
  for mocking purposes, which is exactly why this is optional rather
  than required - see this file's own comment where it's set for the
  full reasoning). True means this attempt only succeeded after one or
  more earlier attempts in the SAME performSync() call hit a 412/409
  ETag conflict (writeCloudSyncDocument() returning
  'precondition-failed') and this call transparently re-read/re-merged/
  retried - a real event worth surfacing distinctly (see syncOutcome.ts),
  since "sync attempt succeeded and there was never any contention" and
  "sync attempt succeeded after quietly resolving a conflict with
  another device" are different enough stories to tell the dentist
  apart, even though the RESULT (a fully synced, fully merged document)
  is identical either way - this flag changes nothing about what gets
  synced or how, only what gets reported afterward.
*/
export type CloudSyncResult =
  | {
      status: 'synced'
      patientNumberConflicts: PatientNumberConflict[]
      recoveredFromConflict?: boolean
    }
  | {
      status: 'synced-with-conflicts'
      patientNumberConflicts: PatientNumberConflict[]
      recoveredFromConflict?: boolean
    }
  | { status: 'stale-review-required'; candidates: StaleReviewCandidate[] }
  | { status: 'cloud-committed-locally-pending'; detail: string }
  | { status: 'contention'; attempts: number }
  | {
      status: 'cloud-invalid'
      detail: string
      /*
        Optional for the same reason CloudSyncReadResult's own
        diagnosis field is (see cloudStorage.ts) - every existing
        mocked CloudSyncResult literal in this project's test suite,
        written before this diagnosis feature existed, keeps
        compiling unchanged. performSync() below always forwards
        whatever readCloudSyncDocument() gave it.
      */
      diagnosis?: CloudSyncCorruptionDiagnosis
    }
  | { status: 'validation-failed'; detail: string }
  /*
    Phase 5 (single-writer sync model) - local has its own unsynced
    changes AND the cloud document has moved to an updatedAt this device
    never confirmed matches (see pushLocalSnapshot()/pullCloudSnapshot()'s
    own comments for exactly where this is checked). Neither side is
    written in this state - this is the honest "cannot safely guess which
    side wins without per-record comparison" stop, which Phase 6's real
    conflict detection will replace with an actual resolution path.
  */
  | { status: 'diverged'; detail: string }
  | CloudSyncTransportFailure

/*
  Phase 5 (single-writer sync model) removed this type's one real
  consumer (the old per-record-merge performSync(), which used
  skipStaleReviewCheck to skip its own stale-device review gate) -
  kept, unused by syncCloudNow() below, per this phase's own
  instruction not to delete Phase 4.7's stale-review machinery yet.
  cloudSyncScheduler.ts's resumeSyncAfterStaleReview()/
  skipStaleReviewCheckOnce still construct/reference this shape.
*/
export type PerformSyncOptions = {
  skipStaleReviewCheck?: boolean
}

/*
  ENTRY POINT (push side)

  The only push function anything outside this file should call. Guards
  against overlapping executions IN THIS TAB by returning the same
  in-flight promise to a second caller rather than starting a second,
  independent write transaction - this is a plain module-level promise
  cache, not a new lock; Web Locks/cross-tab coordination is explicitly
  out of scope for this phase.

  Phase 5 (single-writer sync model) - now calls pushLocalSnapshot()
  instead of the old per-record-merge performSync() (removed from this
  file; see this file's own header comment on what's replaced vs what's
  untouched elsewhere). `options` is accepted but unused - nothing
  pushLocalSnapshot() does has a stale-review gate to skip - kept only
  so cloudSyncScheduler.ts's existing call site keeps compiling; a
  later step in this same phase removes the pass-through there too.
*/

let inFlightSync: Promise<CloudSyncResult> | null = null

export function syncCloudNow(
  options?: PerformSyncOptions
): Promise<CloudSyncResult> {

  void options

  if (inFlightSync) {
    return inFlightSync
  }

  inFlightSync = pushLocalSnapshot().finally(() => {
    inFlightSync = null
  })

  return inFlightSync

}

/*
  ============================================================
  PER-ACCOUNT LOCAL CACHES (Phase 4, reworked)
  ============================================================

  Local synced data (the five keys above) carries no notion of WHICH
  Microsoft account it belongs to - it's just whatever this device
  currently has in localStorage. If the dentist signs out and into a
  DIFFERENT Microsoft account on the same device, the next automatic
  sync would otherwise merge the previous account's still-present
  local data into the new account's OneDrive - two accounts' patient/
  treatment data silently mixed together, in either direction.

  The original version of this (a single rolling "quarantine" backup,
  wiped-and-restored-from-one-slot) has been replaced by a per-account
  CACHE: every Microsoft account that has ever been active on this
  device gets its own persistent slot, kept indefinitely, so switching
  back and forth between accounts always resumes each one exactly
  where it left off - including anything that hadn't reached the
  cloud yet - rather than starting the returning account fresh from
  its cloud document every time.

  reconcileSyncedAccount() must be called with the newly active
  account's stable identifier - MSAL's AccountInfo.homeAccountId, the
  same identifier auth.ts's own getActiveAccount() caching already
  treats as "the" account identity - BEFORE requesting a sync, at
  every point a Microsoft account can newly become active: a fresh
  popup sign-in (MicrosoftAccountSection.tsx's handleSignIn()) and the
  app-load "already signed in from before" check (App.tsx's Phase 2
  effect). It is deliberately NOT wired into Phase 3's online-retry
  listener - regaining connectivity can never itself change which
  account is signed in, so there is nothing to reconcile there.

  Takes a plain accountId string, not an MSAL AccountInfo, for the
  same reason requestCloudSyncIfSignedIn() takes a plain boolean (see
  cloudSyncScheduler.ts) - this file keeps no direct dependency on
  auth.ts/MSAL types; the caller already has the account and passes
  just the one fact this module needs.

  ============================================================
  STORAGE FORMAT - one localStorage key PER ACCOUNT
  ============================================================

  toothTargetAccountCache_<accountId>, rather than one shared key
  holding a { [accountId]: cache } map. Chosen over the single-object
  alternative for two reasons: every read/write this module ever does
  only ever touches ONE account's slot at a time (the outgoing
  account's when saving, the incoming account's when restoring) - a
  shared map would mean parsing and rewriting every OTHER account's
  data too on each operation, for no benefit here, since nothing in
  this design ever needs to enumerate "every account this device has
  seen." One key per account also isolates a corrupted/malformed cache
  to that single account, rather than one bad JSON.parse() taking out
  every account's data at once. homeAccountId is an opaque, trusted
  identifier from MSAL (a GUID-like string), safe to use directly as a
  key suffix with no encoding needed.
*/

const SYNCED_ACCOUNT_ID_KEY = 'toothTargetSyncedAccountId'

function accountCacheKey(accountId: string): string {
  return `toothTargetAccountCache_${accountId}`
}

export type AccountSyncGuardResult =
  | 'first-account'
  | 'same-account'
  | 'switched-account'

/*
  Everything this module considers "this account's own local synced
  state" - the five synced collections, plus two pieces of otherwise
  local-only metadata that are nonetheless meaningfully account-
  specific (see below) - travels together as one unit whenever an
  account's slot is saved or restored.
*/
type AccountLocalCache = {
  patients: unknown[]
  savedTreatments: unknown[]
  customTemplates: unknown[]
  customProcedures: unknown[]
  /*
    toothTargetNextPatientNumber is otherwise local-only/never-synced
    (see this file's own top header comment) - but unlike other
    local-only state such as active/incomplete treatments, it IS
    semantically tied to THIS account's own patient numbering: left
    stale (eg. carried
    over from whichever account happened to be active most recently),
    it can only ever ratchet up (never down, per commitLocalState()'s
    own Math.max reconciliation), so an account resuming after another
    account was used in between could see its own next-patient-number
    jump ahead for no reason. Caching and restoring it per account
    keeps each account's own numbering exactly where that account
    itself left it.
  */
  nextPatientNumber: number
  /*
    toothTargetCloudSyncUpdatedAt likewise isn't one of the five
    synced collections, but it's the rest of "this account's local
    sync state" in every other sense (see this file's own comment on
    LOCAL_SYNC_UPDATED_AT_KEY above) - caching it alongside the
    collections it describes means a restored account resumes with
    its own accurate local sync timestamp instead of silently losing
    it to another account's most recent value.
  */
  cloudSyncUpdatedAt: string | null
  /*
    Paired with cloudSyncUpdatedAt above for the same reason
    LOCAL_SYNC_ETAG_KEY is paired with LOCAL_SYNC_UPDATED_AT_KEY
    everywhere else in this file - the ETag, not updatedAt, is what
    pushLocalSnapshot()/pullCloudSnapshot()'s divergence checks
    actually compare, so it has to travel with the rest of this
    account's sync state across a switch too.
  */
  cloudSyncETag: string | null
  /*
    Phase 5 (single-writer sync model) - the same account-isolation
    reasoning as cloudSyncUpdatedAt directly above, extended to the new
    local-change-tracking pair (see this file's own header comment on
    LOCAL_CHANGE_COUNTER_KEY/LAST_SYNCED_CHANGE_COUNTER_KEY): without
    this, switching to a different account and back could make
    isLocalDataDirty() compare one account's counter against another
    account's "as of" value, or silently forget that an account had
    unsynced work.
  */
  localChangeCounter: number
  lastSyncedChangeCounter: number | null
}

export function readSyncedAccountId(): string | null {

  const raw = localStorage.getItem(SYNCED_ACCOUNT_ID_KEY)

  return typeof raw === 'string' && raw.trim() !== '' ? raw : null

}

/*
  Reads WHATEVER is currently in the five synced keys right now - not
  a stale snapshot from whenever this account was last active or last
  synced. This is what guarantees a switch AWAY from an account
  preserves its latest state, including anything added since its own
  last successful cloud sync (eg. a treatment completed moments before
  switching accounts, per this module's own crash-safety reasoning
  elsewhere in this file).
*/
function captureCurrentAccountState(): AccountLocalCache {

  const currentTemplates = readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]

  return {
    patients: readLocalArray(PATIENTS_KEY),
    savedTreatments: readLocalArray(SAVED_TREATMENTS_KEY),
    customTemplates: currentTemplates.filter(
      template => template.isCustom === true
    ),
    /*
      Not filtered by isCustom any more (Phase 2, Sync & Statistics
      Redesign) - matching buildLocalCloudSyncDocument()'s own change
      above, every procedure (including a former "built-in") is
      account-specific synced state now, so switching accounts must
      carry a rename/archive made under one account along with it,
      exactly like it already does for that account's custom
      templates/patients/treatments.
    */
    customProcedures: readLocalArray(PROCEDURES_KEY) as Procedure[],
    nextPatientNumber: readPersistedNextPatientNumber(),
    cloudSyncUpdatedAt: readLocalSyncUpdatedAt(),
    cloudSyncETag: readLocalSyncETag(),
    localChangeCounter: readLocalChangeCounter(),
    lastSyncedChangeCounter: readLastSyncedChangeCounter(),
  }

}

function saveAccountCache(accountId: string, cache: AccountLocalCache): void {

  try {

    localStorage.setItem(accountCacheKey(accountId), JSON.stringify(cache))

  } catch (error) {

    console.error(
      'Cloud sync: could not save this Microsoft account\'s local data ' +
      'to its own cache before switching accounts - its local-only ' +
      'changes may not carry over the next time this account is used ' +
      'on this device (they are not lost from the cloud, if they had ' +
      'already synced before this point).',
      error
    )

  }

}

/*
  Never throws and never returns anything malformed - a corrupted or
  hand-edited cache entry is treated exactly like "this device has
  never seen this account before" (null) rather than crashing or
  feeding invalid shapes into the rest of this module.
*/
function readAccountCache(accountId: string): AccountLocalCache | null {

  try {

    const raw = localStorage.getItem(accountCacheKey(accountId))

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const candidate = parsed as Partial<AccountLocalCache>

    return {
      patients: Array.isArray(candidate.patients) ? candidate.patients : [],
      savedTreatments: Array.isArray(candidate.savedTreatments) ? candidate.savedTreatments : [],
      customTemplates: Array.isArray(candidate.customTemplates) ? candidate.customTemplates : [],
      customProcedures: Array.isArray(candidate.customProcedures) ? candidate.customProcedures : [],
      nextPatientNumber:
        typeof candidate.nextPatientNumber === 'number' && candidate.nextPatientNumber > 0
          ? candidate.nextPatientNumber
          : 1,
      cloudSyncUpdatedAt:
        typeof candidate.cloudSyncUpdatedAt === 'string' ? candidate.cloudSyncUpdatedAt : null,
      cloudSyncETag:
        typeof candidate.cloudSyncETag === 'string' ? candidate.cloudSyncETag : null,
      localChangeCounter:
        typeof candidate.localChangeCounter === 'number' &&
        Number.isInteger(candidate.localChangeCounter) &&
        candidate.localChangeCounter >= 0
          ? candidate.localChangeCounter
          : 0,
      lastSyncedChangeCounter:
        typeof candidate.lastSyncedChangeCounter === 'number' &&
        Number.isInteger(candidate.lastSyncedChangeCounter) &&
        candidate.lastSyncedChangeCounter >= 0
          ? candidate.lastSyncedChangeCounter
          : null,
    }

  } catch {

    return null

  }

}

/*
  Makes the five synced keys (+ the two account-specific metadata
  keys) reflect `cache` - or, when `cache` is null (this device has
  never seen the incoming account before), reflect a clean, empty
  default - exactly like today's first-time-device behavior. Built-in
  TEMPLATES are preserved either way, read fresh from whatever is
  CURRENTLY persisted, the same pattern commitLocalState() already
  uses for the same reason (built-in templates are never account-
  specific and must never be replaced or duplicated by this).

  PROCEDURES are written as a full, unconditional replace instead
  (Phase 2, Sync & Statistics Redesign) - unlike commitLocalState()'s
  own "skip the write if empty" guard, this one must NOT skip when
  cache?.customProcedures is empty: isolating each account's own data
  is this function's entire purpose, so a brand-new/never-seen
  account (cache === null) switching in must never keep showing the
  PREVIOUS account's renamed/archived procedures just because its own
  cache has none yet. This is safe specifically because the caller
  always reloads the page right after (see this function's call site)
  - App.tsx's own mount-time load effect falls back to the built-in
  default procedure list whenever toothTargetProcedures comes back
  empty, so the brief "empty in storage" moment this can produce is
  never actually read by live React state the way commitLocalState()'s
  own (reload-free) background-sync path could.
*/
function applyAccountCacheToLocalStorage(cache: AccountLocalCache | null): void {

  const builtInTemplates =
    (readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[])
      .filter(template => template.isCustom === false)

  localStorage.setItem(PATIENTS_KEY, JSON.stringify(cache?.patients ?? []))

  localStorage.setItem(
    SAVED_TREATMENTS_KEY,
    JSON.stringify(cache?.savedTreatments ?? [])
  )

  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify([...builtInTemplates, ...(cache?.customTemplates ?? [])])
  )

  localStorage.setItem(
    PROCEDURES_KEY,
    JSON.stringify(cache?.customProcedures ?? [])
  )

  localStorage.removeItem(RETIRED_TOMBSTONES_KEY)

  if (cache) {
    localStorage.setItem(NEXT_PATIENT_NUMBER_KEY, JSON.stringify(cache.nextPatientNumber))
  } else {
    localStorage.removeItem(NEXT_PATIENT_NUMBER_KEY)
  }

  if (cache?.cloudSyncUpdatedAt) {
    localStorage.setItem(LOCAL_SYNC_UPDATED_AT_KEY, cache.cloudSyncUpdatedAt)
  } else {
    localStorage.removeItem(LOCAL_SYNC_UPDATED_AT_KEY)
  }

  if (cache?.cloudSyncETag) {
    localStorage.setItem(LOCAL_SYNC_ETAG_KEY, cache.cloudSyncETag)
  } else {
    localStorage.removeItem(LOCAL_SYNC_ETAG_KEY)
  }

  if (cache) {
    localStorage.setItem(
      LOCAL_CHANGE_COUNTER_KEY,
      String(cache.localChangeCounter)
    )
  } else {
    localStorage.removeItem(LOCAL_CHANGE_COUNTER_KEY)
  }

  if (cache?.lastSyncedChangeCounter !== null && cache?.lastSyncedChangeCounter !== undefined) {
    localStorage.setItem(
      LAST_SYNCED_CHANGE_COUNTER_KEY,
      String(cache.lastSyncedChangeCounter)
    )
  } else {
    localStorage.removeItem(LAST_SYNCED_CHANGE_COUNTER_KEY)
  }

}

/*
  Call with the newly active account's homeAccountId. Returns which
  case applied - purely informational (eg. for a console log at the
  call site). On 'switched-account', local state has already been
  swapped to the incoming account's own cache (or reset to empty, if
  this device has never seen it) by the time this returns; the
  caller is still expected to reload the page afterward (see this
  file's report) so React state - already initialized from the
  OUTGOING account's data before this runs - doesn't keep showing
  stale data on screen.
*/

export function reconcileSyncedAccount(accountId: string): AccountSyncGuardResult {

  const storedAccountId = readSyncedAccountId()

  if (storedAccountId === null) {

    localStorage.setItem(SYNCED_ACCOUNT_ID_KEY, accountId)

    return 'first-account'

  }

  if (storedAccountId === accountId) {
    return 'same-account'
  }

  saveAccountCache(storedAccountId, captureCurrentAccountState())

  const incomingCache = readAccountCache(accountId)

  applyAccountCacheToLocalStorage(incomingCache)

  localStorage.setItem(SYNCED_ACCOUNT_ID_KEY, accountId)

  console.warn(
    'Cloud sync: switched to a different Microsoft account on this device. ' +
    `This device's local data has been switched to that account's own ` +
    (incomingCache
      ? 'cache from a previous session on this device.'
      : 'fresh (empty) local state, since this device has not seen that account before.') +
    ' The outgoing account\'s local data was saved to its own cache and ' +
    'will be there again the next time this device signs into it. The ' +
    'next sync will reconcile this local state against that account\'s ' +
    'real cloud data.'
  )

  return 'switched-account'

}

/*
  TEST-ONLY - resets this module's account-guard state between test
  cases. Never called from production code. Does not attempt to
  enumerate/clear every per-account cache key (there is no bounded set
  to enumerate) - tests that need a clean slate use a fresh in-memory
  localStorage per test instead (see cloudSyncEngine.test.ts).
*/

export function __resetAccountSyncGuardForTests(): void {
  localStorage.removeItem(SYNCED_ACCOUNT_ID_KEY)
}
