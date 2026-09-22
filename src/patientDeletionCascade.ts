/*
  PATIENT-DELETION CASCADE (Phase 4.5)

  Pure decision logic for what happens to a patient's treatments when
  the patient itself is deleted, extracted out of App.tsx's
  confirmDeletePatient() specifically so it can be unit-tested without
  a React rendering harness (this project has none) - same reasoning
  as patientNumberConflicts.ts's own extraction from App.tsx.
  confirmDeletePatient() is a thin wrapper around this: it reads the
  current localStorage state, calls planPatientDeletionCascade() once,
  and applies the resulting plan (localStorage writes, appendTombstone()
  calls, requestCloudSync()) - this file touches neither localStorage
  nor React state, and has no knowledge of either.

  ============================================================
  THE ACTIVE-TREATMENT DECISION
  ============================================================

  Deleting a patient who has saved or incomplete treatments removes
  them too (see PatientDeletionCascadePlan's survivingSavedTreatments/
  removedSavedTreatmentIds/survivingIncompleteTreatments) - matching
  the stated policy that a patient is only ever deleted if it was
  created by mistake or as a test, so its treatments should never be
  left behind as orphaned data.

  A patient with an ACTIVE (currently running) treatment is different
  and BLOCKS the deletion outright instead. A completed SavedTreatment
  being removed here is still a synced record right up until this
  moment - it gets tombstoned (by the caller, using
  removedSavedTreatmentIds) so its removal is recoverable from the
  cloud like any other synced deletion, and the patient record itself
  persists in the same way until this device's own tombstone syncs.
  An ACTIVE treatment is neither of those things: it is pure in-memory/
  local-only clock state (see cloudSyncEngine.ts's own header comment
  on what's local-only vs. synced) that has never been saved anywhere,
  synced or not. Clearing it would discard its elapsed phase timings
  permanently, with no tombstone and no recovery path whatsoever. A
  dentist who reaches "delete this patient" while that same patient's
  treatment is actively being timed is far more likely to have gotten
  there by mistake (or simply forgotten a treatment was still running)
  than to genuinely want that live timer thrown away as a side effect
  of a different action - so this blocks with a clear, actionable
  message instead of guessing which outcome was intended.
*/

type PatientIdentity = {
  id: string
  name: string
}

type TreatmentLike = {
  id: string
  patientId: string
  patientName: string
}

/*
  Same matching rule confirmDeletePatient() has always used: identify
  a treatment as the deleted patient's own by UUID whenever the
  treatment has one - which every treatment does, once
  migratePatientIdentity() has run on load, so this can never
  accidentally catch a different patient who happens to share a name.
  Only falls back to a case-insensitive name match for a treatment
  that somehow still lacks a valid patientId (data that predates this
  app's own UUID migration and was never reloaded through it), so old
  records are never silently skipped just because they predate the
  UUID.
*/
function belongsToPatient(
  treatment: TreatmentLike,
  patientToDelete: PatientIdentity | undefined,
  nameToDeleteLowercase: string
): boolean {

  if (
    patientToDelete &&
    typeof treatment.patientId === 'string' &&
    treatment.patientId !== ''
  ) {
    return treatment.patientId === patientToDelete.id
  }

  return treatment.patientName.toLowerCase() === nameToDeleteLowercase

}

/*
  Two separate type parameters, not one shared T - in the real app,
  saved treatments (SavedTreatment) and incomplete/active treatments
  (ActiveTreatment) are different types that happen to share this
  file's own minimal TreatmentLike shape, but are NOT interchangeable
  (SavedTreatment carries phaseRecords/completedAt/etc. that
  ActiveTreatment doesn't, and vice versa) - a single shared generic
  here would force TypeScript to unify two incompatible shapes into
  one at the actual App.tsx call site.
*/

export type PatientDeletionCascadeInput<
  TSaved extends TreatmentLike,
  TIncomplete extends TreatmentLike
> = {
  patientToDelete: PatientIdentity | undefined
  nameToDelete: string
  savedTreatments: TSaved[]
  incompleteTreatments: TIncomplete[]
  activeTreatment: TIncomplete | null
}

export type PatientDeletionCascadePlan<
  TSaved extends TreatmentLike,
  TIncomplete extends TreatmentLike
> =
  | { blocked: true; reason: string }
  | {
      blocked: false
      survivingSavedTreatments: TSaved[]
      removedSavedTreatmentIds: string[]
      survivingIncompleteTreatments: TIncomplete[]
    }

export const ACTIVE_TREATMENT_BLOCKS_DELETION_MESSAGE =
  'This patient has an active treatment in progress. Finish or cancel it before deleting this patient.'

export function planPatientDeletionCascade<
  TSaved extends TreatmentLike,
  TIncomplete extends TreatmentLike
>(
  input: PatientDeletionCascadeInput<TSaved, TIncomplete>
): PatientDeletionCascadePlan<TSaved, TIncomplete> {

  const nameToDeleteLowercase = input.nameToDelete.toLowerCase()

  const belongsToDeletedPatient = (treatment: TreatmentLike): boolean =>
    belongsToPatient(treatment, input.patientToDelete, nameToDeleteLowercase)

  if (input.activeTreatment && belongsToDeletedPatient(input.activeTreatment)) {

    return {
      blocked: true,
      reason: ACTIVE_TREATMENT_BLOCKS_DELETION_MESSAGE,
    }

  }

  const removedSavedTreatmentIds: string[] = []
  const survivingSavedTreatments: TSaved[] = []

  for (const treatment of input.savedTreatments) {

    if (belongsToDeletedPatient(treatment)) {
      removedSavedTreatmentIds.push(treatment.id)
    } else {
      survivingSavedTreatments.push(treatment)
    }

  }

  const survivingIncompleteTreatments = input.incompleteTreatments.filter(
    treatment => !belongsToDeletedPatient(treatment)
  )

  return {
    blocked: false,
    survivingSavedTreatments,
    removedSavedTreatmentIds,
    survivingIncompleteTreatments,
  }

}
