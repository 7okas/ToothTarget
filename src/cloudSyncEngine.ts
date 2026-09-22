import type { Patient, SavedTreatment, ProcedureTemplate, Procedure } from './App'

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  validateCloudSyncDocument,
  type CloudSyncDocument,
} from './cloudSync'

import {
  mergeCloudSyncDocuments,
  type PatientNumberConflict,
} from './cloudMerge'

import {
  readCloudSyncDocument,
  writeCloudSyncDocument,
  type CloudSyncTransportFailure,
} from './cloudStorage'

import { recordAndReconcilePatientNumberConflicts } from './patientNumberConflicts'

/*
  CLOUD SYNC ENGINE (Phase 6 - orchestration)

  This is the one explicit entry point (syncCloudNow()) that connects
  every previous layer into a single safe synchronization transaction:
  Phase 1's schema/validator (cloudSync.ts), Phase 3's pure merge
  engine (cloudMerge.ts), Phase 4's local conflict store
  (patientNumberConflicts.ts), and Phase 5's transport (cloudStorage.ts).

  NOTHING calls syncCloudNow() yet. It is not wired into treatment
  completion, patient creation/deletion, template editing, procedure
  creation, any localStorage write, any React render/effect, or any
  storage event - that wiring is explicitly the NEXT phase's job. This
  file is safe to import and call manually (eg. from a test, or a
  temporary dev-only button) with zero effect on any normal workflow
  until something else actually calls it.

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
    toothTargetPrivacyLock, toothTargetNextPatientNumber (see below -
    reconciled locally, but never taken FROM the cloud document, which
    doesn't carry it), built-in templates/procedures, MSAL state,
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

function commitLocalState(mergedDocument: CloudSyncDocument): void {

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

}

/*
  RESULT TYPE
*/

export type CloudSyncResult =
  | { status: 'synced'; patientNumberConflicts: PatientNumberConflict[] }
  | { status: 'synced-with-conflicts'; patientNumberConflicts: PatientNumberConflict[] }
  | { status: 'cloud-committed-locally-pending'; detail: string }
  | { status: 'contention'; attempts: number }
  | { status: 'cloud-invalid'; detail: string }
  | { status: 'validation-failed'; detail: string }
  | CloudSyncTransportFailure

const MAX_SYNC_ATTEMPTS = 3

async function performSync(): Promise<CloudSyncResult> {

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {

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

      case 'malformed-json':
      case 'invalid-document':
        return { status: 'cloud-invalid', detail: cloudRead.detail }

      case 'auth-failed':
        return { status: 'auth-failed' }

      case 'permission-denied':
        return { status: 'permission-denied', detail: cloudRead.detail }

      case 'graph-error':
        return { status: 'graph-error', detail: cloudRead.detail }

    }

    const mergeResult = mergeCloudSyncDocuments(localDocument, remoteDocument)

    const mergedDocument = mergeResult.document

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
      continue
    }

    if (writeResult.status === 'auth-failed') {
      return { status: 'auth-failed' }
    }

    if (writeResult.status === 'permission-denied') {
      return { status: 'permission-denied', detail: writeResult.detail }
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

    const finalDocument = finalMergeResult.document

    try {

      commitLocalState(finalDocument)

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
      ? { status: 'synced-with-conflicts', patientNumberConflicts: reconciledConflicts }
      : { status: 'synced', patientNumberConflicts: [] }

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

export function syncCloudNow(): Promise<CloudSyncResult> {

  if (inFlightSync) {
    return inFlightSync
  }

  inFlightSync = performSync().finally(() => {
    inFlightSync = null
  })

  return inFlightSync

}

/*
  ============================================================
  ACCOUNT-SWITCH ISOLATION (Phase 4)
  ============================================================

  Local synced data (the five keys above) carries no notion of WHICH
  Microsoft account it belongs to - it's just whatever this device
  currently has in localStorage. If the dentist signs out and into a
  DIFFERENT Microsoft account on the same device, the next automatic
  sync would otherwise merge the previous account's still-present
  local data into the new account's OneDrive - two accounts' patient/
  treatment data silently mixed together, in either direction.

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
*/

const SYNCED_ACCOUNT_ID_KEY = 'toothTargetSyncedAccountId'
const ACCOUNT_SWITCH_BACKUP_KEY = 'toothTargetAccountSwitchBackup'

export type AccountSyncGuardResult =
  | 'first-account'
  | 'same-account'
  | 'switched-account'

function readSyncedAccountId(): string | null {

  const raw = localStorage.getItem(SYNCED_ACCOUNT_ID_KEY)

  return typeof raw === 'string' && raw.trim() !== '' ? raw : null

}

/*
  QUARANTINE (not a silent wipe - see this phase's report for the full
  reasoning)

  Local data can genuinely be AHEAD of the outgoing account's own
  cloud document - eg. a treatment was just completed, and
  requestCloudSync() hasn't finished (or even started) before the
  dentist switches accounts. Simply discarding local data in that
  case would make that work unrecoverable even by signing back into
  the correct account, since the correct account's cloud copy would
  still be missing it. A single ROLLING backup (overwritten on every
  switch, never accumulated) is kept instead - enough to recover from
  "signed into the wrong account by mistake" without unbounded
  localStorage growth across repeated switches.

  Only the account-specific portions of templates/procedures
  (isCustom === true) are cleared/backed up - built-ins are a fixed
  catalog, never account-specific, exactly the same distinction
  commitLocalState() already draws for the same two keys.

  toothTargetNextPatientNumber is reset too, even though it is
  otherwise local-only/never-synced (see this file's own top header
  comment) - unlike active/incomplete treatments or the privacy lock,
  it IS semantically tied to the outgoing account's own patient
  numbering: left stale, it can only ever ratchet up (never down, per
  commitLocalState()'s own Math.max reconciliation), so the new
  account's first patients would otherwise start numbering from
  wherever the old account happened to leave off - a visible,
  confusing artifact, not a harmless one. This is a deliberate
  judgment call beyond the literal five synced keys - flagged
  explicitly in this phase's report.
*/

function quarantineLocalAccountData(previousAccountId: string): void {

  const currentTemplates = readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]
  const currentProcedures = readLocalArray(PROCEDURES_KEY) as Procedure[]

  const backup = {
    previousAccountId,
    clearedAt: new Date().toISOString(),
    previousSyncUpdatedAt: readLocalSyncUpdatedAt(),
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
  }

  try {

    localStorage.setItem(ACCOUNT_SWITCH_BACKUP_KEY, JSON.stringify(backup))

  } catch (error) {

    console.error(
      'Cloud sync: could not save a backup of the previous Microsoft ' +
      'account\'s local data before switching accounts - proceeding ' +
      'with the clear anyway.',
      error
    )

  }

  localStorage.setItem(PATIENTS_KEY, JSON.stringify([]))
  localStorage.setItem(SAVED_TREATMENTS_KEY, JSON.stringify([]))

  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify(currentTemplates.filter(template => template.isCustom === false))
  )

  localStorage.setItem(
    PROCEDURES_KEY,
    JSON.stringify(currentProcedures.filter(procedure => procedure.isCustom === false))
  )

  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify([]))

  localStorage.removeItem(LOCAL_SYNC_UPDATED_AT_KEY)
  localStorage.removeItem(NEXT_PATIENT_NUMBER_KEY)

  console.warn(
    'Cloud sync: switched to a different Microsoft account on this device. ' +
    'This device\'s local patients, treatments, custom templates/procedures, ' +
    `and deletion history from the previous account have been cleared (a ` +
    `backup was saved under localStorage key "${ACCOUNT_SWITCH_BACKUP_KEY}" ` +
    'in case this was a mistake) so they are not merged into the new ' +
    'account\'s cloud data. The next sync will pull down the new account\'s ' +
    'own data.'
  )

}

/*
  Call with the newly active account's homeAccountId. Returns which
  case applied - purely informational (eg. for a console log at the
  call site); every case still allows the caller's own normal
  sync-on-sign-in request to proceed afterward exactly as before,
  since by the time this returns, local state is guaranteed to belong
  to `accountId` either way.
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

  quarantineLocalAccountData(storedAccountId)

  localStorage.setItem(SYNCED_ACCOUNT_ID_KEY, accountId)

  return 'switched-account'

}

/*
  TEST-ONLY - resets this module's account-guard state between test
  cases. Never called from production code.
*/

export function __resetAccountSyncGuardForTests(): void {
  localStorage.removeItem(SYNCED_ACCOUNT_ID_KEY)
  localStorage.removeItem(ACCOUNT_SWITCH_BACKUP_KEY)
}
