import type {
  Patient,
  SavedTreatment,
  ProcedureTemplate,
  Procedure,
} from './App'

/*
  CLOUD SYNC SCHEMA

  This is the real, in-production multi-device synchronization
  document shape and its validation - deliberately kept separate from
  cloudBackup.ts's CloudBackup, which is a different, also-shipped
  concept (a manual, explicit, one-shot snapshot/restore). The two are
  allowed to diverge over time (see isValidSyncSavedTreatment() below
  for a concrete example of exactly that), so they are not meant to
  share code beyond the underlying App.tsx types.

  This module only answers one question: "is this structurally a
  valid ToothTarget sync document, version 2?" - it never decides
  which record wins, whether a patient-number collision exists, or
  whether a record was deleted. validateCloudSyncDocument() is called on every sync, both when
  reading the cloud document (cloudStorage.ts's readCloudSyncDocument())
  and when about to write one (writeCloudSyncDocument()), via
  cloudSyncEngine.ts's syncCloudNow() - the automatic sync engine that
  runs in the background on app load, sign-in, and after every
  synchronized-data change.

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
  mutation of an existing patient's own record, and the sync
  resolution screen needs a real timestamp as its "which side is
  newer" hint, exactly like it does for templates. This only checks
  the field is a real, non-empty timestamp string - never compares it
  to anything.

  createdAt (Phase 4.6) is required the same way, for the same reason
  every other required field here is: a document this module accepts
  must already be shaped exactly like App.tsx's own Patient type, not
  a subset of it - it is never compared or given special
  treatment (whichever record the dentist keeps simply carries its own
  createdAt along for free).

  caseType (Phase 3 of the Sync & Statistics Redesign) is OPTIONAL,
  unlike every field above - deliberately, so a document written by
  an older version of this app (before this field existed at all)
  still validates exactly as before; missing is itself the correct,
  permanent "treat as Clinical" state (see App.tsx's
  getPatientCaseType()), not a schema-age gap cloudSyncSchemaMigration.ts
  needs to backfill. When present, it's still constrained to the two
  real values, so a genuinely corrupted value is still caught here -
  matches this file's own isValidSyncProcedure()'s status field for
  the same reasoning.
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
    (value as Patient).updatedAt.trim() !== '' &&
    ((value as Patient).caseType === undefined ||
      (value as Patient).caseType === 'Clinical' ||
      (value as Patient).caseType === 'Practice')
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
  longer purely create-only, and the sync resolution screen needs a
  real timestamp as its "which side is newer" hint, exactly like it
  does for patients/templates. This only checks the field is a real,
  non-empty timestamp string - never compares it to anything.
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
  same id is newer is the sync resolution screen's concern, not this
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

/*
  updatedAt is required here (Phase 5.5, added once editing/deleting a
  procedure became possible - see App.tsx's confirmEditProcedure()/
  the old deleteProcedureFromRegistry()), for the identical reason
  SavedTreatment gained one in Phase 4.6: the sync resolution screen
  needs a real timestamp as its "which side is newer" hint, exactly
  like it does for patients/templates/treatments. This only checks the
  field is a real, non-empty timestamp string - never compares it to
  anything.

  Phase 2 (Sync & Statistics Redesign) relaxations:
  - isCustom is no longer required to be true. Every procedure/tag,
    including a former "built-in" (isCustom: false), is now part of
    the synchronized set, since any of them can be renamed/archived
    and that change must propagate across devices - see
    cloudSyncEngine.ts's buildLocalCloudSyncDocument(), which used to
    filter this array down to isCustom === true before uploading and
    no longer does. Only the field's TYPE is checked now, matching
    every other boolean/string field here - this validator has never
    decided what a value MEANS, only whether the document is
    structurally well-formed.
  - status is optional and, when present, must be 'active' or
    'archived'. Optional (rather than required) specifically so an
    older cloud document written before this field existed - local or
    already synced from the cloud - still validates exactly as
    before; App.tsx's isProcedureActive() treats a missing status as
    'active', the same default this validator implicitly allows.
*/

function isValidSyncProcedure(value: unknown): value is Procedure {

  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim() !== '' &&
    typeof candidate.name === 'string' &&
    typeof candidate.templateId === 'string' &&
    typeof candidate.isCustom === 'boolean' &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.updatedAt as string).trim() !== '' &&
    (candidate.status === undefined ||
      candidate.status === 'active' ||
      candidate.status === 'archived')
  )

}

/*
  DUPLICATE-ID CHECK

  Only ever called on an array that has already passed its per-record
  validator (so every item's id is confirmed to be a real, non-empty
  string) - rejects a document where the same id appears twice within
  ONE entity array.
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

  The single entry point - checked before the sync engine is ever
  allowed to use a cloud document (see cloudStorage.ts's
  readCloudSyncDocument()/writeCloudSyncDocument()). Returns a
  specific, plain-language reason for rejection rather than throwing,
  matching the same discriminated-result convention cloudBackup.ts's
  own validateCloudBackup() already established. Never mutates the
  input, never migrates a schema-version-1 document (see
  cloudSyncSchemaMigration.ts for that), never decides which record
  wins a conflict, and never checks cross-references (eg. whether a
  Procedure's templateId actually resolves to a template in this same
  document) - all of that is deliberately out of scope for this
  module, which only ever answers "is this structurally valid?".
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

  /*
    deletionTombstones is a retired field: documents written before the
    single-writer sync model carry it, newer ones don't. Whatever is
    there (a valid list, garbage, or nothing at all) is ignored and
    never causes a rejection; it is simply not copied into the result,
    so it disappears on the next save.
  */

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
    },
  }

}
