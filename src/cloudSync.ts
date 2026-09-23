import type {
  Patient,
  SavedTreatment,
  ProcedureTemplate,
  Procedure,
  DeletionTombstone,
} from './App'

/*
  CLOUD SYNC SCHEMA (Phase 1 - foundation only)

  This is the FUTURE multi-device synchronization document shape and
  its validation - deliberately kept separate from cloudBackup.ts's
  CloudBackup, which is a different, already-shipped concept (a
  manual, explicit, one-shot snapshot/restore). The two are allowed
  to diverge over time (see isValidSyncSavedTreatment() below for a
  concrete example of exactly that), so they are not meant to share
  code beyond the underlying App.tsx types.

  IMPORTANT - this file does NOTHING on its own. Nothing calls
  validateCloudSyncDocument() yet; nothing reads or writes
  toothtarget-data.json (or any other file) from here; there is no
  merge logic, no automatic sync, and no UI wired to any of this.
  This module only answers one question: "is this structurally a
  valid ToothTarget sync document, version 2?" - every decision about
  which record wins, whether a patient-number collision exists, or
  whether a tombstone should suppress a record is explicitly deferred
  to a future merge-engine phase, not implemented here.

  Only type-only imports are taken from App.tsx - these are erased
  entirely at compile time (tsconfig has verbatimModuleSyntax), so
  there is no runtime dependency on App.tsx at all, and no risk of
  the same circular-import situation cloudBackup.ts's own comment
  already documents for itself.
*/

export const CLOUD_SYNC_SCHEMA_VERSION = 2 as const

export const CLOUD_SYNC_APP = 'ToothTarget' as const

export type CloudSyncDocument = {
  schemaVersion: typeof CLOUD_SYNC_SCHEMA_VERSION
  app: typeof CLOUD_SYNC_APP
  updatedAt: string
  patients: Patient[]
  savedTreatments: SavedTreatment[]
  customTemplates: ProcedureTemplate[]
  customProcedures: Procedure[]
  deletionTombstones: DeletionTombstone[]
}

/*
  RECORD VALIDATORS

  Each answers only "is this one record structurally valid?" - never
  whether it should win a conflict, whether it references something
  that exists, or whether it's a duplicate (duplicate-ID checking is
  a separate, document-level pass below, since it needs the whole
  array rather than one record at a time).
*/

/*
  updatedAt is required here (Phase 8, added to Patient for the same
  reason ProcedureTemplate got one in Phase 2 - see App.tsx's Patient
  type comment): patient-number conflict resolution is a legitimate
  mutation of an existing patient's own record, and cloudMerge.ts's
  same-id patient merge needs a real timestamp to prefer the
  resolution over a stale copy, exactly like it already does for
  templates. This only checks the field is a real, non-empty
  timestamp string - never compares it to anything; that comparison
  is the merge engine's job, not this validator's.

  createdAt (Phase 4.6) is required the same way, for the same reason
  every other required field here is: a document this module accepts
  must already be shaped exactly like App.tsx's own Patient type, not
  a subset of it - it is never compared or given special merge
  treatment (a same-id disagreement is still resolved purely by
  updatedAt, per cloudMerge.ts's pickWinningByUpdatedAt(); whichever
  record wins simply carries its own createdAt along for free).
*/

function isValidSyncPatient(value: unknown): value is Patient {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Patient).id === 'string' &&
    (value as Patient).id.trim() !== '' &&
    typeof (value as Patient).patientNumber === 'number' &&
    Number.isInteger((value as Patient).patientNumber) &&
    (value as Patient).patientNumber > 0 &&
    typeof (value as Patient).name === 'string' &&
    (value as Patient).name.trim() !== '' &&
    typeof (value as Patient).createdAt === 'string' &&
    (value as Patient).createdAt.trim() !== '' &&
    typeof (value as Patient).updatedAt === 'string' &&
    (value as Patient).updatedAt.trim() !== ''
  )

}

/*
  Deliberately stricter than cloudBackup.ts's isValidCloudSavedTreatment()
  (which also accepts a legacy Date.now()-based numeric id, for
  backward compatibility with schema-version-1 backups made before
  ToothTarget's treatment-ID migration). A schema-version-2 sync
  document represents the app's current, already-migrated data model
  - by definition every treatment id in a v2 document should already
  be a real UUID string, so this validator only accepts that form.
  This is exactly the kind of divergence the two schemas are allowed
  to have, per this file's own top comment.

  updatedAt is required here (Phase 4.6, added to SavedTreatment once
  editing a completed treatment's phase data became possible - see
  App.tsx's confirmEditTreatmentPhases()): a completed treatment is no
  longer purely create-only, and cloudMerge.ts's same-id treatment
  merge needs a real timestamp to prefer an edit over a stale copy,
  exactly like it already does for patients/templates. This only
  checks the field is a real, non-empty timestamp string - never
  compares it to anything; that comparison is the merge engine's job.
*/

function isValidSyncSavedTreatment(value: unknown): value is SavedTreatment {

  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim() !== '' &&
    typeof candidate.patientId === 'string' &&
    typeof candidate.patientName === 'string' &&
    typeof candidate.toothId === 'string' &&
    Array.isArray(candidate.phases) &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.updatedAt as string).trim() !== ''
  )

}

/*
  isCustom === true is a hard requirement here (unlike
  cloudBackup.ts's current template/procedure validators, which don't
  check it) - a sync document's customTemplates/customProcedures
  arrays must never admit a built-in record, since built-ins are
  never uploaded by createCloudBackup()-style logic in the first
  place and must never be treated as legitimate incoming sync data.

  updatedAt is likewise required (Phase 2 of App.tsx's own
  ProcedureTemplate type/migration) - this only checks that the field
  is a real, non-empty timestamp string, exactly like every other
  timestamp field in this file. It does not compare updatedAt values
  against anything else; deciding which of two templates with the
  same id "wins" is a future merge-engine concern, not this
  validator's.
*/

function isValidSyncTemplate(value: unknown): value is ProcedureTemplate {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ProcedureTemplate).id === 'string' &&
    (value as ProcedureTemplate).id.trim() !== '' &&
    typeof (value as ProcedureTemplate).name === 'string' &&
    Array.isArray((value as ProcedureTemplate).phases) &&
    (value as ProcedureTemplate).isCustom === true &&
    typeof (value as ProcedureTemplate).updatedAt === 'string' &&
    (value as ProcedureTemplate).updatedAt.trim() !== ''
  )

}

function isValidSyncProcedure(value: unknown): value is Procedure {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Procedure).id === 'string' &&
    (value as Procedure).id.trim() !== '' &&
    typeof (value as Procedure).name === 'string' &&
    typeof (value as Procedure).templateId === 'string' &&
    (value as Procedure).isCustom === true
  )

}

const VALID_TOMBSTONE_ENTITY_TYPES: DeletionTombstone['entityType'][] = [
  'patient',
  'procedureTemplate',
  'treatment',
]

function isValidSyncTombstone(value: unknown): value is DeletionTombstone {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as DeletionTombstone).id === 'string' &&
    (value as DeletionTombstone).id.trim() !== '' &&
    typeof (value as DeletionTombstone).entityId === 'string' &&
    (value as DeletionTombstone).entityId.trim() !== '' &&
    VALID_TOMBSTONE_ENTITY_TYPES.includes(
      (value as DeletionTombstone).entityType
    ) &&
    typeof (value as DeletionTombstone).deletedAt === 'string' &&
    (value as DeletionTombstone).deletedAt.trim() !== ''
  )

}

/*
  DUPLICATE-ID CHECK

  Only ever called on an array that has already passed its per-record
  validator (so every item's id is confirmed to be a real, non-empty
  string) - rejects a document where the same id appears twice within
  ONE entity array. Deliberately NOT applied to deletionTombstones:
  two different tombstone records legitimately targeting the same
  (entityType, entityId) is an expected, tolerated case (eg. two
  devices independently deleting the same record before ever syncing)
  - the future merge layer dedupes those by (entityType, entityId),
  it is not this validator's job to reject the document over it.
*/

function hasDuplicateIds(items: { id: string }[]): boolean {

  const seenIds = new Set<string>()

  for (const item of items) {

    if (seenIds.has(item.id)) {
      return true
    }

    seenIds.add(item.id)

  }

  return false

}

/*
  DOCUMENT VALIDATION

  The single entry point - checked before any future merge code would
  ever be allowed to read a cloud document. Returns a specific,
  plain-language reason for rejection rather than throwing, matching
  the same discriminated-result convention cloudBackup.ts's own
  validateCloudBackup() already established. Never mutates the input,
  never migrates a schema-version-1 document, never decides which
  record wins a conflict, and never checks cross-references (eg.
  whether a Procedure's templateId actually resolves to a template in
  this same document) - all of that is explicitly out of scope for
  this phase, per its own design brief.
*/

export type CloudSyncValidationResult =
  | { valid: true; document: CloudSyncDocument }
  | { valid: false; error: string }

export function validateCloudSyncDocument(
  value: unknown
): CloudSyncValidationResult {

  if (!value || typeof value !== 'object') {
    return {
      valid: false,
      error: 'The cloud sync document is not a valid ToothTarget document.',
    }
  }

  const candidate = value as Partial<CloudSyncDocument>

  if (candidate.app !== CLOUD_SYNC_APP) {
    return {
      valid: false,
      error: 'The cloud document does not look like a ToothTarget sync document.',
    }
  }

  if (candidate.schemaVersion !== CLOUD_SYNC_SCHEMA_VERSION) {
    return {
      valid: false,
      error: `This cloud sync document uses schema version ${String(
        candidate.schemaVersion
      )}, which this version of ToothTarget does not support (expected ${CLOUD_SYNC_SCHEMA_VERSION}).`,
    }
  }

  if (
    typeof candidate.updatedAt !== 'string' ||
    candidate.updatedAt.trim() === ''
  ) {
    return {
      valid: false,
      error: 'The cloud sync document is missing a valid updatedAt timestamp.',
    }
  }

  if (
    !Array.isArray(candidate.patients) ||
    !candidate.patients.every(isValidSyncPatient)
  ) {
    return {
      valid: false,
      error: 'The cloud sync document contains invalid patient records.',
    }
  }

  if (hasDuplicateIds(candidate.patients)) {
    return {
      valid: false,
      error: 'The cloud sync document contains duplicate patient IDs.',
    }
  }

  if (
    !Array.isArray(candidate.savedTreatments) ||
    !candidate.savedTreatments.every(isValidSyncSavedTreatment)
  ) {
    return {
      valid: false,
      error: 'The cloud sync document contains invalid treatment records.',
    }
  }

  if (hasDuplicateIds(candidate.savedTreatments)) {
    return {
      valid: false,
      error: 'The cloud sync document contains duplicate treatment IDs.',
    }
  }

  if (
    !Array.isArray(candidate.customTemplates) ||
    !candidate.customTemplates.every(isValidSyncTemplate)
  ) {
    return {
      valid: false,
      error: 'The cloud sync document contains invalid custom template records.',
    }
  }

  if (hasDuplicateIds(candidate.customTemplates)) {
    return {
      valid: false,
      error: 'The cloud sync document contains duplicate template IDs.',
    }
  }

  if (
    !Array.isArray(candidate.customProcedures) ||
    !candidate.customProcedures.every(isValidSyncProcedure)
  ) {
    return {
      valid: false,
      error: 'The cloud sync document contains invalid custom procedure records.',
    }
  }

  if (hasDuplicateIds(candidate.customProcedures)) {
    return {
      valid: false,
      error: 'The cloud sync document contains duplicate procedure IDs.',
    }
  }

  if (
    !Array.isArray(candidate.deletionTombstones) ||
    !candidate.deletionTombstones.every(isValidSyncTombstone)
  ) {
    return {
      valid: false,
      error: 'The cloud sync document contains invalid deletion tombstones.',
    }
  }

  return {
    valid: true,
    document: {
      schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
      app: CLOUD_SYNC_APP,
      updatedAt: candidate.updatedAt,
      patients: candidate.patients,
      savedTreatments: candidate.savedTreatments,
      customTemplates: candidate.customTemplates,
      customProcedures: candidate.customProcedures,
      deletionTombstones: candidate.deletionTombstones,
    },
  }

}
