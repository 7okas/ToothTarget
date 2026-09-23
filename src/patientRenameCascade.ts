/*
  PATIENT RENAME CASCADE (Phase 4.6, Part E)

  Pure decision logic for what happens to a patient's saved treatments
  when the patient's own name is edited (see App.tsx's
  editPatientRecordUnderLock()) - extracted out for the same reason
  patientDeletionCascade.ts was: so it can be unit-tested without a
  React rendering harness (this project has none).

  Each SavedTreatment carries its own denormalized snapshot of the
  patient's name, taken at treatment-save time (patientName), rather
  than a live lookup against the patient registry. Renaming the
  patient has to walk every one of that patient's saved treatments and
  update that snapshot to match, or treatment history would keep
  showing a name the patient no longer has.

  Matched by patientId alone, never by name - every treatment is
  expected to carry a valid patientId once migratePatientIdentity()
  has run on load (see patientDeletionCascade.ts's own header comment
  for the full reasoning); a rename has no legacy-data name-matching
  fallback to worry about the way deletion does, since a stale/missing
  patientId there just means the treatment is left unrenamed rather
  than mis-attributed.

  Each rewritten treatment also gets its updatedAt bumped to `now` -
  SavedTreatment.updatedAt exists specifically so cloudMerge.ts can
  resolve a same-id disagreement by recency (see SavedTreatment's own
  comment on that field, added Phase 4.6 Part D). Leaving updatedAt
  untouched here would let this rename lose a merge race against an
  older, stale copy of the same treatment sitting on another device -
  exactly the bug Part D fixed for phase-timing edits.
*/

type RenameableTreatment = {
  patientId: string
  patientName: string
  updatedAt: string
}

export function applyPatientRenameToSavedTreatments<
  T extends RenameableTreatment
>(savedTreatments: T[], patientId: string, newName: string, now: string): T[] {

  return savedTreatments.map(treatment =>
    treatment.patientId === patientId
      ? { ...treatment, patientName: newName, updatedAt: now }
      : treatment
  )

}
