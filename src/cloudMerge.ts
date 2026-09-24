import type {
  Patient,
  DeletionTombstone,
} from './App'

import type { CloudSyncDocument } from './cloudSync'

/*
  CLOUD MERGE ENGINE (Phase 3 - pure, in-memory, offline)

  Takes two already-validated CloudSyncDocuments (see cloudSync.ts's
  validateCloudSyncDocument() - this module trusts that shape and does
  not re-validate it) and produces one merged CloudSyncDocument, plus
  a report of any patient-number collisions found along the way.

  This module is pure: no localStorage, no window/document, no Graph/
  OneDrive/MSAL, no crypto.randomUUID(), no Math.random(), no
  Date.now()/`new Date()` for "now". The only place a `Date` API is
  used at all is Date.parse(), to COMPARE two already-stored ISO
  timestamps - never to generate a new one. Nothing here decides that
  a merge happened "now"; the merged document's own updatedAt is
  always one of the two input timestamps, never a fresh one. Neither
  input argument is ever mutated - every array/object below is either
  passed through by reference (untouched) or rebuilt from scratch.

  Nothing in this file allocates or renumbers a patientNumber, and no
  nextPatientNumber-style counter is added to the document - the
  future sync/apply layer is responsible for recomputing that counter
  locally from whatever patients this merge produces.

  ============================================================
  DECISIONS ON "SHOULD NEVER HAPPEN" CASES (documented, not invented)
  ============================================================

  Every mutable, synchronized entity - Patient (Phase 8), ProcedureTemplate
  (Phase 2), SavedTreatment (Phase 4.6, once editing a completed
  treatment's phase data became possible - see App.tsx's
  confirmEditTreatmentPhases()), and Procedure (Phase 5.5, once
  editing/deleting a procedure became possible - see App.tsx's
  confirmEditProcedure()/deleteProcedureFromRegistry()) - carries a real
  updatedAt, so genuine last-write-wins applies to all four via
  pickWinningByUpdatedAt() below.

  resolveTie() below only ever runs as pickWinningByUpdatedAt()'s
  equal-updatedAt fallback now - a deterministic, content-based
  tie-break that is symmetric regardless of which side is passed as
  "local" vs "remote" (required for merge(local, remote) ===
  merge(remote, local)), and does not fabricate a new identity or
  silently prefer either side by convention. It has no opinion about
  which value is "right" - it only guarantees one single, reproducible
  answer instead of a fabricated timestamp, a random pick, or an
  argument-order-dependent pick. This matters most for the genuinely
  rare "should never happen" case where two sides somehow carry the
  exact same updatedAt but different content (a manually edited cloud
  file, corruption, or a future bug) - normal same-id disagreements are
  already resolved by whichever side's updatedAt is newer, before
  resolveTie() is ever reached.

  patientNumberConflicts is computed from the FINAL surviving patient
  set (after tombstone suppression), not from the raw id-union: a
  patient that was unioned in but then suppressed by a tombstone is
  gone from the merged document entirely, so it cannot meaningfully
  "conflict" with a patient number that a still-live patient holds.
*/

/*
  CANONICAL, ORDER-INDEPENDENT SERIALIZATION

  JSON.stringify's output depends on each object's own key insertion
  order, which can differ between two structurally-identical records
  (eg. one produced by an older code path, one by a newer one) without
  the data actually being different. Sorting keys recursively before
  stringifying means two records are compared by content only, so the
  tie-break below can never be swayed by something as incidental as
  key order.
*/

function canonicalStringify(value: unknown): string {

  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`
  }

  if (value !== null && typeof value === 'object') {

    const keys = Object.keys(value as Record<string, unknown>).sort()

    const entries = keys.map(
      key =>
        `${JSON.stringify(key)}:${canonicalStringify(
          (value as Record<string, unknown>)[key]
        )}`
    )

    return `{${entries.join(',')}}`

  }

  return JSON.stringify(value)

}

/*
  Deterministic, symmetric tie-break for two records that share an id
  but (should-never-happen) differ in content: resolveTie(a, b) always
  equals resolveTie(b, a) in the VALUE it returns, since the choice is
  made purely from each record's own serialized content, never from
  which argument position it was passed in. The lexicographically
  smaller canonical string wins - an arbitrary but fixed and
  documented convention, not a "latest" or "local/remote" preference.
*/

function resolveTie<T>(a: T, b: T): T {

  const canonicalA = canonicalStringify(a)
  const canonicalB = canonicalStringify(b)

  if (canonicalA === canonicalB) {
    return a
  }

  return canonicalA < canonicalB ? a : b

}

/*
  Compares two ISO timestamp strings by actual instant, not by string
  order (although in this app's case, every timestamp is produced by
  toISOString(), which happens to make plain string comparison
  equivalent - Date.parse() is used anyway to be robust to any other
  valid ISO representation of the same instant). Falls back to a
  plain string comparison only if either value fails to parse as a
  date, which validateCloudSyncDocument() should already have ruled
  out for every timestamp field this is used on - this fallback exists
  purely so an unparseable string can never throw or produce NaN
  comparisons, never to change which value "wins" in the normal case.
*/

function compareTimestamps(a: string, b: string): number {

  const parsedA = Date.parse(a)
  const parsedB = Date.parse(b)

  if (
    !Number.isNaN(parsedA) &&
    !Number.isNaN(parsedB) &&
    parsedA !== parsedB
  ) {
    return parsedA - parsedB
  }

  if (a === b) {
    return 0
  }

  return a < b ? -1 : 1

}

/*
  Generic union-by-key: every item from both arrays is kept once per
  key. A key present on only one side is kept as-is; a key present on
  both sides is resolved with `resolveConflict`, which must itself be
  symmetric (resolveConflict(a, b) === resolveConflict(b, a) in the
  value it returns) for the overall merge to be order-independent.
  Iteration order of the input arrays never affects the output SET,
  only intermediate bookkeeping - callers sort the final result
  separately (see the byId/tombstone comparators below).
*/

function unionByKey<T>(
  localItems: T[],
  remoteItems: T[],
  keyOf: (item: T) => string,
  resolveConflict: (a: T, b: T) => T
): T[] {

  const byKey = new Map<string, T>()

  for (const item of [...localItems, ...remoteItems]) {

    const key = keyOf(item)
    const existing = byKey.get(key)

    byKey.set(key, existing ? resolveConflict(existing, item) : item)

  }

  return Array.from(byKey.values())

}

function unionById<T extends { id: string }>(
  localItems: T[],
  remoteItems: T[],
  resolveConflict: (a: T, b: T) => T
): T[] {
  return unionByKey(localItems, remoteItems, item => item.id, resolveConflict)
}

/*
  Same-id resolution for a genuinely mutable, genuinely timestamped
  entity - used for all four synchronized entity types now that each
  one (Patient, ProcedureTemplate, SavedTreatment, Procedure) carries
  its own real updatedAt (see this file's own header comment for when
  each one gained it). The newer valid updatedAt wins outright; the
  winning record's updatedAt is never touched. Only when both sides
  carry the exact same updatedAt (and, per resolveTie(), only actually
  matters if the content also differs) is the canonical-serialization
  tie-break used, exactly as section 10 of the task specifies.
*/

function pickWinningByUpdatedAt<T extends { updatedAt: string }>(
  a: T,
  b: T
): T {

  const comparison = compareTimestamps(a.updatedAt, b.updatedAt)

  if (comparison > 0) {
    return a
  }

  if (comparison < 0) {
    return b
  }

  return resolveTie(a, b)

}

/*
  TOMBSTONES

  Logically keyed by (entityType, entityId), never by the tombstone's
  own id - two tombstone records with different ids but the same
  (entityType, entityId) represent one logical deletion, and only one
  representative is kept. Per section 7: prefer the newest deletedAt;
  if deletedAt ties, use the lexicographically smaller tombstone id as
  the deterministic tie-breaker (an explicit, spec-mandated rule, not
  the generic resolveTie() used elsewhere in this file).
*/

function tombstoneKey(tombstone: DeletionTombstone): string {
  return JSON.stringify([tombstone.entityType, tombstone.entityId])
}

function pickWinningTombstone(
  a: DeletionTombstone,
  b: DeletionTombstone
): DeletionTombstone {

  const comparison = compareTimestamps(a.deletedAt, b.deletedAt)

  if (comparison > 0) {
    return a
  }

  if (comparison < 0) {
    return b
  }

  return a.id <= b.id ? a : b

}

function mergeTombstones(
  localTombstones: DeletionTombstone[],
  remoteTombstones: DeletionTombstone[]
): DeletionTombstone[] {

  return unionByKey(
    localTombstones,
    remoteTombstones,
    tombstoneKey,
    pickWinningTombstone
  )

}

/*
  TOMBSTONE EXPIRY (Phase 4.7)

  A tombstone only needs to outlive every device that might still be
  carrying the record it deletes - once every device has seen it (or
  simply synced at all since it was created), it has done its job and
  can be dropped, so tombstones don't accumulate forever. ~1 month is
  the same margin device-local staleness detection uses (see
  deviceSyncTracking.ts's own STALE_DEVICE_THRESHOLD_MS, which
  intentionally imports THIS constant rather than defining its own):
  a device that syncs at least monthly is guaranteed to see a
  tombstone before it could ever expire, and a device that hasn't
  synced in over a month is exactly the case Phase 4.7's stale-record
  review screen exists to protect - so tightening or loosening this
  window should always move both behaviors together, not just one.

  Deliberately NOT part of mergeCloudSyncDocuments() itself, which
  stays pure with no notion of "now" (see this file's own header
  comment) - pruning needs a real "now" to measure age against, so it
  is exposed here as its own explicit-input pure function instead,
  called by cloudSyncEngine.ts's orchestration layer (which already
  legitimately uses `new Date()` elsewhere) at the points where a
  merged document's tombstones are about to be written, either to the
  cloud or to local storage.

  A tombstone with a deletedAt that fails to parse as a date is kept,
  never dropped - compareTimestamps()'s own NaN-vs-NaN never being
  "greater than" maxAgeMs means an unparseable timestamp naturally
  falls through to "not yet expired" here, the same fail-safe (never
  destructively act on ambiguous input) every other timestamp
  comparison in this file already follows.
*/

export const TOMBSTONE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000

export function pruneExpiredTombstones(
  tombstones: DeletionTombstone[],
  nowIso: string,
  maxAgeMs: number = TOMBSTONE_EXPIRY_MS
): DeletionTombstone[] {

  const nowMs = Date.parse(nowIso)

  return tombstones.filter(tombstone => {

    const deletedAtMs = Date.parse(tombstone.deletedAt)

    if (Number.isNaN(nowMs) || Number.isNaN(deletedAtMs)) {
      return true
    }

    return nowMs - deletedAtMs <= maxAgeMs

  })

}

/*
  DETERMINISTIC OUTPUT ORDERING

  Sorting only ever reorders the CANONICAL CLOUD DOCUMENT this module
  returns - it has no bearing on, and does not touch, any array the
  rest of the app renders in the UI.
*/

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareTombstonesForOutput(
  a: DeletionTombstone,
  b: DeletionTombstone
): number {

  if (a.entityType !== b.entityType) {
    return a.entityType < b.entityType ? -1 : 1
  }

  if (a.entityId !== b.entityId) {
    return a.entityId < b.entityId ? -1 : 1
  }

  if (a.deletedAt !== b.deletedAt) {
    return a.deletedAt < b.deletedAt ? -1 : 1
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0

}

/*
  PATIENT-NUMBER CONFLICTS

  Computed from the final, already-tombstone-filtered patient set (see
  the module-level comment above for why). Grouping is purely by
  patientNumber - contiguity is never assumed, and a number held by
  only one surviving patient is never reported.
*/

export type PatientNumberConflict = {
  patientNumber: number
  patientIds: string[]
}

function findPatientNumberConflicts(
  patients: Patient[]
): PatientNumberConflict[] {

  const idsByNumber = new Map<number, string[]>()

  for (const patient of patients) {

    const ids = idsByNumber.get(patient.patientNumber) ?? []

    ids.push(patient.id)

    idsByNumber.set(patient.patientNumber, ids)

  }

  const conflicts: PatientNumberConflict[] = []

  for (const [patientNumber, ids] of idsByNumber) {

    const uniqueIds = Array.from(new Set(ids))

    if (uniqueIds.length > 1) {

      conflicts.push({
        patientNumber,
        patientIds: uniqueIds.sort(),
      })

    }

  }

  return conflicts.sort((a, b) => a.patientNumber - b.patientNumber)

}

/*
  MERGE RESULT
*/

export type CloudMergeResult = {
  document: CloudSyncDocument
  patientNumberConflicts: PatientNumberConflict[]
}

/*
  Newest valid updatedAt wins for the document-level timestamp, exactly
  like a template's own updatedAt - if both documents happen to carry
  the identical timestamp, the (identical) value is returned either
  way, and if two different-looking strings somehow parse to the same
  instant, the lexicographically smaller string is used so the choice
  stays deterministic rather than depending on argument order.
*/

function pickDocumentUpdatedAt(
  localUpdatedAt: string,
  remoteUpdatedAt: string
): string {

  const comparison = compareTimestamps(localUpdatedAt, remoteUpdatedAt)

  if (comparison > 0) {
    return localUpdatedAt
  }

  if (comparison < 0) {
    return remoteUpdatedAt
  }

  return localUpdatedAt <= remoteUpdatedAt ? localUpdatedAt : remoteUpdatedAt

}

/*
  MAIN ENTRY POINT

  Pure function: mergeCloudSyncDocuments(local, remote) always produces
  the same output for the same two inputs, and produces the same
  logical output as mergeCloudSyncDocuments(remote, local) (every union
  and tie-break above is symmetric by construction). Neither
  `localDocument` nor `remoteDocument` - nor anything nested inside
  them - is ever mutated; every returned array is freshly built.
*/

export function mergeCloudSyncDocuments(
  localDocument: CloudSyncDocument,
  remoteDocument: CloudSyncDocument
): CloudMergeResult {

  const mergedTombstones = mergeTombstones(
    localDocument.deletionTombstones,
    remoteDocument.deletionTombstones
  )

  const tombstonedPatientIds = new Set(
    mergedTombstones
      .filter(tombstone => tombstone.entityType === 'patient')
      .map(tombstone => tombstone.entityId)
  )

  const tombstonedTemplateIds = new Set(
    mergedTombstones
      .filter(tombstone => tombstone.entityType === 'procedureTemplate')
      .map(tombstone => tombstone.entityId)
  )

  const tombstonedTreatmentIds = new Set(
    mergedTombstones
      .filter(tombstone => tombstone.entityType === 'treatment')
      .map(tombstone => tombstone.entityId)
  )

  const tombstonedProcedureIds = new Set(
    mergedTombstones
      .filter(tombstone => tombstone.entityType === 'procedure')
      .map(tombstone => tombstone.entityId)
  )

  /*
    PATIENTS - union by id, then tombstones win regardless of which
    side they came from (section 9): a patient present as a live
    record on one side and a tombstone on the other is always
    suppressed. Same-id disagreement uses latest-updatedAt-wins
    (pickWinningByUpdatedAt) rather than the plain content-only
    resolveTie() - see that function's own comment for why Patient
    needed this treatment too, starting Phase 8.
  */

  const unionedPatients = unionById(
    localDocument.patients,
    remoteDocument.patients,
    pickWinningByUpdatedAt
  )

  const survivingPatients = unionedPatients.filter(
    patient => !tombstonedPatientIds.has(patient.id)
  )

  const patientNumberConflicts = findPatientNumberConflicts(survivingPatients)

  /*
    SAVED TREATMENTS - union by id with latest-updatedAt-wins (Phase
    4.6), then suppressed either if they belong to a tombstoned patient
    (section 8) or if the treatment itself was directly tombstoned (eg.
    an orphaned record with no matching patient, cleaned up by App.tsx's
    own load-time migration, or a single treatment deleted directly -
    see DeletionTombstone['entityType'] for why 'treatment' exists
    alongside 'patient'/'procedureTemplate').

    Phase 4.6 note: SavedTreatment gained an updatedAt field once
    editing a completed treatment's phase data became possible - before
    that, this module's own header comment correctly called this type
    "create-only/immutable" and used the plain content-only resolveTie().
    Now that an edit is a real, intentional mutation, it needs the
    identical "newer updatedAt wins" treatment Patient/ProcedureTemplate
    already get, for the identical reason: a same-id disagreement must
    prefer the edit over a stale pre-edit copy, not an arbitrary
    content-based pick.
  */

  const unionedSavedTreatments = unionById(
    localDocument.savedTreatments,
    remoteDocument.savedTreatments,
    pickWinningByUpdatedAt
  )

  const survivingSavedTreatments = unionedSavedTreatments.filter(
    treatment =>
      !tombstonedPatientIds.has(treatment.patientId) &&
      !tombstonedTreatmentIds.has(treatment.id)
  )

  /*
    CUSTOM TEMPLATES - union by id with latest-updatedAt-wins, then
    tombstones win regardless of side (section 9), same as patients.
  */

  const unionedTemplates = unionById(
    localDocument.customTemplates,
    remoteDocument.customTemplates,
    pickWinningByUpdatedAt
  )

  const survivingTemplates = unionedTemplates.filter(
    template => !tombstonedTemplateIds.has(template.id)
  )

  /*
    CUSTOM PROCEDURES (Phase 5.5) - union by id with latest-updatedAt-
    wins, then tombstones win regardless of side (section 9), same as
    patients/templates now that Procedure carries a real updatedAt and
    the 'procedure' tombstone entityType exists (see App.tsx's
    confirmEditProcedure()/deleteProcedureFromRegistry()). A dangling
    templateId/regionTemplateIds reference into a tombstoned template is
    still left exactly as-is, matching the existing app's own tolerance
    for dangling template references - suppression here is purely by
    the procedure's OWN id, never by anything it references.

    Critically, deleting a procedure ONLY ever removes/tombstones the
    Procedure record itself - it never touches savedTreatments. A past
    SavedTreatment already carries its own denormalized procedureName/
    procedureId snapshot (set once, at the moment the treatment was
    started - see App.tsx's startTreatment()) and is never re-resolved
    against the live customProcedures list, so a treatment that used a
    since-deleted procedure keeps displaying exactly as it always did,
    on every device, forever. This merge engine has no code path that
    could even do otherwise: survivingSavedTreatments above is filtered
    only by tombstonedPatientIds/tombstonedTreatmentIds, never by
    anything procedure-related.
  */

  const unionedProcedures = unionById(
    localDocument.customProcedures,
    remoteDocument.customProcedures,
    pickWinningByUpdatedAt
  )

  const survivingProcedures = unionedProcedures.filter(
    procedure => !tombstonedProcedureIds.has(procedure.id)
  )

  const document: CloudSyncDocument = {

    schemaVersion: localDocument.schemaVersion,

    app: localDocument.app,

    updatedAt: pickDocumentUpdatedAt(
      localDocument.updatedAt,
      remoteDocument.updatedAt
    ),

    patients: [...survivingPatients].sort(compareById),

    savedTreatments: [...survivingSavedTreatments].sort(compareById),

    customTemplates: [...survivingTemplates].sort(compareById),

    customProcedures: [...survivingProcedures].sort(compareById),

    deletionTombstones: [...mergedTombstones].sort(compareTombstonesForOutput),

  }

  return {
    document,
    patientNumberConflicts,
  }

}
