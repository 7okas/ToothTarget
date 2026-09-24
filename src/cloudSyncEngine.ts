import type { Patient, SavedTreatment, ProcedureTemplate, Procedure } from './App'

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  validateCloudSyncDocument,
  type CloudSyncDocument,
} from './cloudSync'

import {
  mergeCloudSyncDocuments,
  pruneExpiredTombstones,
  type PatientNumberConflict,
} from './cloudMerge'

import {
  readCloudSyncDocument,
  writeCloudSyncDocument,
  type CloudSyncTransportFailure,
} from './cloudStorage'

import type { CloudSyncCorruptionDiagnosis } from './cloudSyncCorruptionDiagnosis'

import { recordAndReconcilePatientNumberConflicts } from './patientNumberConflicts'

import {
  isDeviceSyncStale,
  recordDeviceSyncSuccess,
} from './deviceSyncTracking'

import {
  findStaleReviewCandidates,
  type StaleReviewCandidate,
} from './staleRecordReview'

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
    toothTargetProcedures (custom entries only),
    toothTargetDeletionTombstones

  Local-only (never read, written, or referenced by this file):
    toothTargetActiveTreatment, toothTargetIncompleteTreatments,
    toothTargetNextPatientNumber (see below - reconciled locally, but
    never taken FROM the cloud document, which doesn't carry it),
    built-in templates/procedures, MSAL state, transient UI state.

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
const TOMBSTONES_KEY = 'toothTargetDeletionTombstones'
const NEXT_PATIENT_NUMBER_KEY = 'toothTargetNextPatientNumber'

/*
  Phase 3's own local synchronized-document timestamp (section 3) -
  deliberately NOT part of CloudSyncDocument itself (that type has no
  extra field for it). Read as the LOCAL candidate document's
  updatedAt when building it for a merge, and only ever written by
  this module's own commitLocalState(), to the value the merge just
  produced - never bumped merely because a sync was attempted, and
  never bumped by any other local mutation (patient/treatment/
  template/procedure/tombstone changes do not touch this key, since
  wiring that up belongs to the next phase along with the sync
  triggers themselves).
*/
const LOCAL_SYNC_UPDATED_AT_KEY = 'toothTargetCloudSyncUpdatedAt'

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

function readLocalSyncUpdatedAt(): string | null {

  const raw = localStorage.getItem(LOCAL_SYNC_UPDATED_AT_KEY)

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

  Reads exactly the five synchronized keys, filters templates/
  procedures down to isCustom === true (mirroring
  createCloudBackup()'s own filter in cloudBackup.ts), and runs the
  result through validateCloudSyncDocument() before returning it -
  this module never uploads or merges data it hasn't first confirmed
  is a structurally valid v2 document. If local data is somehow not
  yet in the current (migrated) shape - this module does not itself
  run migrations, see this file's header comment - validation fails
  here and syncCloudNow() reports 'validation-failed' rather than
  guessing or repairing anything.

  updatedAt: readLocalSyncUpdatedAt() ?? "now" - the ONLY time "now" is
  used is when no local sync timestamp has ever been recorded (this
  device's very first sync), which is a genuine first-existence event
  for the synchronized-document concept, not a "sync was merely
  attempted" bump. Every subsequent call reuses the persisted value
  until commitLocalState() advances it after an actual successful
  merge commit.
*/

function buildLocalCloudSyncDocument():
  | { valid: true; document: CloudSyncDocument }
  | { valid: false; error: string } {

  const patients = readLocalArray(PATIENTS_KEY) as Patient[]
  const savedTreatments = readLocalArray(SAVED_TREATMENTS_KEY) as SavedTreatment[]
  const templates = readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]
  const procedures = readLocalArray(PROCEDURES_KEY) as Procedure[]
  const deletionTombstones = readLocalArray(TOMBSTONES_KEY)

  const candidate = {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    app: CLOUD_SYNC_APP,
    updatedAt: readLocalSyncUpdatedAt() ?? new Date().toISOString(),
    patients,
    savedTreatments,
    customTemplates: templates.filter(
      template => template.isCustom === true
    ),
    customProcedures: procedures.filter(
      procedure => procedure.isCustom === true
    ),
    deletionTombstones,
  }

  return validateCloudSyncDocument(candidate)

}

/*
  An empty synchronized document - used as the "remote" side of a
  merge when the cloud file doesn't exist yet (section 6), so the
  create-new-cloud-document path reuses mergeCloudSyncDocuments()
  itself (sorting/deduping/patient-number-conflict-detection all come
  for free) instead of a second, separate "just upload local as-is"
  code path. updatedAt here is irrelevant to the outcome - the merged
  document's own updatedAt is the newer of the two inputs, and an
  empty document only ever contributes empty arrays, never a "winning"
  timestamp on its own (see cloudMerge.ts's pickDocumentUpdatedAt()).
*/

function emptyCloudSyncDocument(localUpdatedAt: string): CloudSyncDocument {
  return {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    app: CLOUD_SYNC_APP,
    updatedAt: localUpdatedAt,
    patients: [],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
    deletionTombstones: [],
  }
}

/*
  LOCAL COMMIT

  Runs only after a successful conditional cloud write, using the
  EXACT document that was just uploaded. Writes the five synchronized
  keys, reconciles (never replaces) the local-only patient-number
  counter, and advances the local sync timestamp. See this file's
  header comment for why the non-atomicity of these separate
  localStorage.setItem() calls is safe under this app's merge model.

  Built-in templates/procedures are preserved by reading whatever is
  CURRENTLY persisted and keeping only its isCustom === false entries
  - the exact same pattern cloudBackup.ts's applyCloudRestore() already
  uses for the same reason (built-ins are never part of the cloud
  document and must never be replaced or duplicated by this write).
*/

function commitLocalState(
  mergedDocument: CloudSyncDocument,
  nowIso: string
): void {

  localStorage.setItem(
    PATIENTS_KEY,
    JSON.stringify(mergedDocument.patients)
  )

  localStorage.setItem(
    SAVED_TREATMENTS_KEY,
    JSON.stringify(mergedDocument.savedTreatments)
  )

  const currentTemplates = readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]

  const builtInTemplates =
    currentTemplates.filter(template => template.isCustom === false)

  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify([...builtInTemplates, ...mergedDocument.customTemplates])
  )

  const currentProcedures = readLocalArray(PROCEDURES_KEY) as Procedure[]

  const builtInProcedures =
    currentProcedures.filter(procedure => procedure.isCustom === false)

  localStorage.setItem(
    PROCEDURES_KEY,
    JSON.stringify([...builtInProcedures, ...mergedDocument.customProcedures])
  )

  localStorage.setItem(
    TOMBSTONES_KEY,
    JSON.stringify(mergedDocument.deletionTombstones)
  )

  /*
    Reconcile only - never derived from, or replaced by, the cloud
    document (which carries no counter at all). A patient-number
    conflict (two patients sharing a number) never bumps this beyond
    highest+1 on its own account; it is exactly the same "highest
    assigned + 1, never less than what's already persisted" invariant
    App.tsx's own allocatePatientUnderLock()/
    patientNumberConflicts.ts's resolvePatientNumberConflictUnderLock()
    already use.
  */

  const storedNextPatientNumber = readPersistedNextPatientNumber()

  const highestAssignedPatientNumber =
    mergedDocument.patients.reduce(
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

  localStorage.setItem(LOCAL_SYNC_UPDATED_AT_KEY, mergedDocument.updatedAt)

  /*
    Phase 4.7 - the one point in this whole module where a sync is
    genuinely, fully complete (cloud write already succeeded, and every
    local write above just succeeded too, all inside the same try/catch
    performSync() wraps this call in) - see deviceSyncTracking.ts's own
    header comment for why this is deliberately a DEVICE fact, not an
    account one, and therefore lives as its own write here rather than
    inside the account-scoped keys above.
  */
  recordDeviceSyncSuccess(nowIso)

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
  | CloudSyncTransportFailure

const MAX_SYNC_ATTEMPTS = 3

export type PerformSyncOptions = {
  /*
    Set by cloudSyncScheduler.ts's resumeSyncAfterStaleReview() for
    exactly the one sync attempt that follows a completed stale-record
    review - the dentist has already decided every candidate this
    device found (kept ones are left as normal local patients, discarded
    ones are already tombstoned via the app's normal deletion path), so
    re-running the stale-review gate on THIS attempt would either find
    nothing new (harmless but pointless) or, worse, re-surface patients
    that were already decided moments ago. Never persisted, never
    defaulted to true anywhere else - every other call path (the
    scheduler's normal flush, app load, sign-in) always re-evaluates
    staleness fresh, which is exactly what should happen for a genuinely
    new sync attempt.
  */
  skipStaleReviewCheck?: boolean
}

async function performSync(
  options: PerformSyncOptions = {}
): Promise<CloudSyncResult> {

  /*
    Phase 6 - set true the moment ANY attempt in this call hits
    'precondition-failed' and retries; read once, at the very end, by
    whichever attempt finally succeeds. See CloudSyncResult's own
    recoveredFromConflict comment for why this is worth tracking at
    all - it changes nothing about the retry behavior itself (still the
    exact same `continue` it always was), only what the eventual
    success result reports.
  */
  let hadContention = false

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {

    const nowIso = new Date().toISOString()

    const localResult = buildLocalCloudSyncDocument()

    if (!localResult.valid) {
      return { status: 'validation-failed', detail: localResult.error }
    }

    const localDocument = localResult.document

    const cloudRead = await readCloudSyncDocument()

    let remoteDocument: CloudSyncDocument
    let expectedETag: string | null

    switch (cloudRead.status) {

      case 'not-found':
        remoteDocument = emptyCloudSyncDocument(localDocument.updatedAt)
        expectedETag = null
        break

      case 'found':
        remoteDocument = cloudRead.document
        expectedETag = cloudRead.eTag
        break

      /*
        PRE-MERGE CORRUPTION GATE

        A corrupt/unreadable live cloud file is rejected right here,
        as soon as readCloudSyncDocument() reports it - before
        mergeCloudSyncDocuments() is ever called (that call is further
        down this same loop body) and before ANY local write happens.
        This has always been true of this switch (readCloudSyncDocument()
        already classified both statuses before this document existed);
        this comment only makes that existing behavior explicit, and
        the diagnosis it now carries is what lets the corruption-
        recovery dialog explain WHY, not just THAT, the cloud file was
        rejected.
      */
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

    /*
      STALE-DEVICE / STALE-RECORD REVIEW GATE (Phase 4.7)

      Checked BEFORE any merge happens (section 3 of this phase's own
      brief), using exactly the local/remote documents already read
      above - no extra network round-trip needed. isDeviceSyncStale()
      is a cheap, purely local, purely time-based check; the (slightly
      more work) candidate search only ever runs once that's already
      true, so a device that syncs regularly never pays for it and
      never sees this gate fire. If candidates come back empty (either
      because nothing on this device is actually unsynced-and-
      untombstoned, or because skipStaleReviewCheck is set for a
      resumed post-review attempt), this falls straight through to the
      normal merge below - a stale device with nothing new to review
      has nothing for the dentist to decide and should sync exactly
      like any other device.
    */

    if (!options.skipStaleReviewCheck && isDeviceSyncStale(nowIso)) {

      const candidates = findStaleReviewCandidates({
        localPatients: localDocument.patients,
        localSavedTreatments: localDocument.savedTreatments,
        remotePatients: remoteDocument.patients,
        localTombstones: localDocument.deletionTombstones,
        remoteTombstones: remoteDocument.deletionTombstones,
      })

      if (candidates.length > 0) {
        return { status: 'stale-review-required', candidates }
      }

    }

    const mergeResult = mergeCloudSyncDocuments(localDocument, remoteDocument)

    /*
      TOMBSTONE EXPIRY (Phase 4.7) - pruned here, right before this
      document is validated/uploaded, so tombstones older than
      cloudMerge.ts's TOMBSTONE_EXPIRY_MS never accumulate in the cloud
      document either (see pruneExpiredTombstones()'s own comment for
      why this can't live inside the pure mergeCloudSyncDocuments()
      itself). The commit-time re-merge below prunes again for the same
      reason - re-reading local storage there can reintroduce tombstones
      already-expired-and-dropped here, since local storage isn't
      rewritten until commitLocalState() runs.
    */
    const mergedDocument: CloudSyncDocument = {
      ...mergeResult.document,
      deletionTombstones: pruneExpiredTombstones(
        mergeResult.document.deletionTombstones,
        nowIso
      ),
    }

    const mergeValidation = validateCloudSyncDocument(mergedDocument)

    if (!mergeValidation.valid) {
      return { status: 'validation-failed', detail: mergeValidation.error }
    }

    /*
      Same read this iteration's `expectedETag` came from - never a
      different iteration's cloud read merged against a different
      iteration's ETag (section 18). Each loop iteration is fully
      self-contained: its own read, its own merge, its own write.
    */
    const writeResult =
      await writeCloudSyncDocument(mergeValidation.document, expectedETag)

    if (writeResult.status === 'precondition-failed') {
      hadContention = true
      continue
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
        Shouldn't happen - mergeValidation.valid was just confirmed
        above - but transport re-validates independently and this
        module never assumes away a disagreement between the two.
      */
      return { status: 'validation-failed', detail: writeResult.detail }
    }

    /*
      writeResult.status === 'written' from here on. The cloud is now
      authoritatively the merged document - committing locally (and
      recording conflicts) is bookkeeping for THIS device, not a
      condition of the sync having succeeded from the cloud's point of
      view (see this file's header comment on crash safety).

      COMMIT-TIME RE-MERGE (Phase 8 fix)

      `mergedDocument` is a snapshot from BEFORE the two awaited Graph
      calls above - if a genuinely new local mutation happened while
      this sync was in flight (eg. the dentist completed a second
      treatment, or another concurrent syncCloudNow() call in another
      tab committed first), committing `mergedDocument` verbatim would
      silently overwrite and permanently lose that newer local data,
      since it was never part of what got read/merged/uploaded this
      round. Re-reading local state fresh and merging it against the
      document that was JUST uploaded - using the exact same pure,
      idempotent merge engine, purely locally, no network - closes
      that window: anything genuinely new stays in local storage
      (the scheduler's own pending-request tracking, or the next
      meaningful mutation trigger, ensures it also reaches the cloud
      in a follow-up sync), and anything that was already part of
      `mergedDocument` is unaffected, since merging is idempotent.
    */

    const localAtCommitTime = buildLocalCloudSyncDocument()

    const finalMergeResult =
      localAtCommitTime.valid
        ? mergeCloudSyncDocuments(localAtCommitTime.document, mergedDocument)
        : mergeResult

    const finalDocument: CloudSyncDocument = {
      ...finalMergeResult.document,
      deletionTombstones: pruneExpiredTombstones(
        finalMergeResult.document.deletionTombstones,
        nowIso
      ),
    }

    try {

      commitLocalState(finalDocument, nowIso)

    } catch (error) {

      const detail = error instanceof Error ? error.message : String(error)

      return {
        status: 'cloud-committed-locally-pending',
        detail:
          `The cloud document was updated successfully, but saving it locally failed (${detail}). ` +
          'The next sync will re-read the cloud and converge safely.',
      }

    }

    const reconciledConflicts =
      recordAndReconcilePatientNumberConflicts(
        finalMergeResult.patientNumberConflicts,
        finalDocument.patients
      )

    return reconciledConflicts.length > 0
      ? {
          status: 'synced-with-conflicts',
          patientNumberConflicts: reconciledConflicts,
          recoveredFromConflict: hadContention,
        }
      : {
          status: 'synced',
          patientNumberConflicts: [],
          recoveredFromConflict: hadContention,
        }

  }

  return { status: 'contention', attempts: MAX_SYNC_ATTEMPTS }

}

/*
  ENTRY POINT

  The only function anything outside this file should call. Guards
  against overlapping executions IN THIS TAB by returning the same
  in-flight promise to a second caller rather than starting a second,
  independent merge/write transaction (section 20) - this is a plain
  module-level promise cache, not a new lock; Web Locks/cross-tab
  coordination is explicitly out of scope for this phase.
*/

let inFlightSync: Promise<CloudSyncResult> | null = null

export function syncCloudNow(
  options?: PerformSyncOptions
): Promise<CloudSyncResult> {

  if (inFlightSync) {
    return inFlightSync
  }

  inFlightSync = performSync(options).finally(() => {
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
  deletionTombstones: unknown[]
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
}

function readSyncedAccountId(): string | null {

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
  const currentProcedures = readLocalArray(PROCEDURES_KEY) as Procedure[]

  return {
    patients: readLocalArray(PATIENTS_KEY),
    savedTreatments: readLocalArray(SAVED_TREATMENTS_KEY),
    customTemplates: currentTemplates.filter(
      template => template.isCustom === true
    ),
    customProcedures: currentProcedures.filter(
      procedure => procedure.isCustom === true
    ),
    deletionTombstones: readLocalArray(TOMBSTONES_KEY),
    nextPatientNumber: readPersistedNextPatientNumber(),
    cloudSyncUpdatedAt: readLocalSyncUpdatedAt(),
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
      deletionTombstones: Array.isArray(candidate.deletionTombstones) ? candidate.deletionTombstones : [],
      nextPatientNumber:
        typeof candidate.nextPatientNumber === 'number' && candidate.nextPatientNumber > 0
          ? candidate.nextPatientNumber
          : 1,
      cloudSyncUpdatedAt:
        typeof candidate.cloudSyncUpdatedAt === 'string' ? candidate.cloudSyncUpdatedAt : null,
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
  templates/procedures are preserved either way, read fresh from
  whatever is CURRENTLY persisted, the same pattern commitLocalState()
  already uses for the same reason (built-ins are never account-
  specific and must never be replaced or duplicated by this).
*/
function applyAccountCacheToLocalStorage(cache: AccountLocalCache | null): void {

  const builtInTemplates =
    (readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[])
      .filter(template => template.isCustom === false)

  const builtInProcedures =
    (readLocalArray(PROCEDURES_KEY) as Procedure[])
      .filter(procedure => procedure.isCustom === false)

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
    JSON.stringify([...builtInProcedures, ...(cache?.customProcedures ?? [])])
  )

  localStorage.setItem(
    TOMBSTONES_KEY,
    JSON.stringify(cache?.deletionTombstones ?? [])
  )

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
