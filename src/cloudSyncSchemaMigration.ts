/*
  CLOUD SYNC DOCUMENT SCHEMA MIGRATION (Phase 4.6 - cloud sync hardening)

  validateCloudSyncDocument() (cloudSync.ts) is, and must stay, strict:
  every record must already be shaped exactly like the app's current
  types, or the whole document is rejected. That strictness is what
  makes a genuinely corrupted document (wrong field types, malformed
  structure) reliably caught - relaxing it to tolerate missing fields
  would also let real corruption through.

  The problem that surfaced tonight (root-caused via [sync-diag]
  logging, since removed) is different: a document written by an
  OLDER version of this app, before a field existed at all, is not
  corrupt - it's just outdated. Patient.createdAt and
  SavedTreatment.updatedAt are the two concrete examples so far
  (Phase 4.6), but this is a recurring situation, not a one-off - any
  future phase that adds a required field to a synced type will hit
  the exact same "cloud document predates this field" case (the
  comment on this file's own README example calls out Phase 4.7's
  planned device-tracking fields as the next one).

  This module is that fix, generalized: a small, ordered list of
  migration steps, each responsible for ONE known field, each backfilling
  it the exact same way the equivalent LOCAL migration already does
  (App.tsx's migratePatientTimestamps()/migrateSavedTreatmentTimestamps())
  - never inventing a value, only ever deriving one from another field
  on the SAME record that's known to carry an honest, if approximate,
  substitute. readCloudSyncDocument() (cloudStorage.ts) runs this on
  the raw parsed JSON BEFORE handing it to validateCloudSyncDocument(),
  so a document that's merely outdated is upgraded in memory and then
  passes the very same strict check any current document would need to
  pass - it is never treated as a special, more-permissive case.

  A future phase adds new fields here by adding one more step function
  to CLOUD_DOCUMENT_MIGRATION_STEPS below; validateCloudSyncDocument()
  itself never needs to change or loosen for this reason.

  ============================================================
  SAFETY RULES EVERY STEP MUST FOLLOW
  ============================================================

  1. Only ever ADD a field that's missing/invalid - never overwrite a
     field that already holds a valid value.
  2. Only ever derive the backfilled value from another field already
     present on that SAME record, using the exact fallback the
     equivalent local migration already established as the honest
     approximation - never a fresh "now" (which would fabricate a
     false claim about when the record was created/last edited), and
     never a hardcoded/guessed constant.
  3. If the record has no valid source field to derive from either,
     leave it untouched. The strict validator will then correctly
     reject it - that record is missing data this migration has no
     honest way to reconstruct, which is a real validation failure,
     not a schema-age problem.
  4. Never touch, validate, or make assumptions about any field this
     step isn't specifically responsible for - a malformed field
     elsewhere on the same record must still reach the strict
     validator untouched, so it's still caught as invalid.
*/

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/*
  Patient.createdAt (Phase 4.6) - exactly mirrors
  App.tsx's migratePatientTimestamps(): a patient missing a valid
  createdAt falls back to its own updatedAt, never a fresh "now" (see
  that function's own comment for why). If updatedAt itself isn't a
  valid timestamp either, there is no honest fallback - left
  untouched, so isValidSyncPatient() still rejects it for that (both
  fields are independently required).
*/
function backfillPatientCreatedAt(
  document: Record<string, unknown>
): Record<string, unknown> {

  if (!Array.isArray(document.patients)) {
    return document
  }

  return {
    ...document,
    patients: document.patients.map(patient => {

      if (!patient || typeof patient !== 'object') {
        return patient
      }

      const record = patient as Record<string, unknown>

      if (isValidTimestamp(record.createdAt)) {
        return patient
      }

      if (!isValidTimestamp(record.updatedAt)) {
        return patient
      }

      return { ...record, createdAt: record.updatedAt }

    }),
  }

}

/*
  SavedTreatment.updatedAt (Phase 4.6) - exactly mirrors App.tsx's
  migrateSavedTreatmentTimestamps(): a treatment missing a valid
  updatedAt falls back to its own completedAt if that's valid, or its
  date otherwise (always present, set at completion). If neither is a
  valid timestamp, there is no honest fallback - left untouched, so
  isValidSyncSavedTreatment() still rejects it.
*/
function backfillSavedTreatmentUpdatedAt(
  document: Record<string, unknown>
): Record<string, unknown> {

  if (!Array.isArray(document.savedTreatments)) {
    return document
  }

  return {
    ...document,
    savedTreatments: document.savedTreatments.map(treatment => {

      if (!treatment || typeof treatment !== 'object') {
        return treatment
      }

      const record = treatment as Record<string, unknown>

      if (isValidTimestamp(record.updatedAt)) {
        return treatment
      }

      const fallbackUpdatedAt =
        isValidTimestamp(record.completedAt) ? record.completedAt : record.date

      if (!isValidTimestamp(fallbackUpdatedAt)) {
        return treatment
      }

      return { ...record, updatedAt: fallbackUpdatedAt }

    }),
  }

}

/*
  Ordered list of known field migrations - add a new step here (not a
  change to validateCloudSyncDocument() itself) the next time a synced
  type gains a required field. Order between existing steps doesn't
  currently matter (each only reads/writes its own field on its own
  entity array), but steps run left-to-right, each over the previous
  step's output, so a future step that needs another step's backfilled
  value to already be in place can rely on that ordering.
*/
const CLOUD_DOCUMENT_MIGRATION_STEPS: ReadonlyArray<
  (document: Record<string, unknown>) => Record<string, unknown>
> = [backfillPatientCreatedAt, backfillSavedTreatmentUpdatedAt]

/*
  Entry point - readCloudSyncDocument() (cloudStorage.ts) calls this on
  the raw parsed JSON, before validateCloudSyncDocument() ever sees it.
  Deliberately as permissive as possible about its OWN input shape
  (unknown, not CloudSyncDocument): a document this migration can't
  even recognize as document-shaped is returned completely unchanged,
  and left for validateCloudSyncDocument() to reject on its own terms -
  this function never throws and never itself decides a document is
  invalid.
*/
export function migrateCloudSyncDocumentShape(value: unknown): unknown {

  if (!value || typeof value !== 'object') {
    return value
  }

  return CLOUD_DOCUMENT_MIGRATION_STEPS.reduce(
    (document, step) => step(document),
    value as Record<string, unknown>
  )

}
