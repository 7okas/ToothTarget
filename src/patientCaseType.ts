/*
  PATIENT CASE TYPE (Phase 3 of the Sync & Statistics Redesign)

  Clinical (real patient work) vs Practice (extracted-teeth practice
  work) - a small, standalone module for the same reason
  patientNumberConflicts.ts/patientRenameCascade.ts/
  patientDeletionCascade.ts already are: App.tsx is a .tsx component
  file, and a plain function/const exported alongside its component
  breaks Fast Refresh (react-refresh/only-export-components) - so
  this single-purpose piece of shared logic lives in its own file
  instead, imported by both App.tsx and statistics.ts.
*/

export type PatientCaseType = 'Clinical' | 'Practice'

export const PATIENT_CASE_TYPES: PatientCaseType[] = ['Clinical', 'Practice']

/*
  Single source of truth for "missing means Clinical" - every piece
  of this app (display, editing, statistics filtering) that needs a
  patient's case type reads it through here rather than inlining its
  own `?? 'Clinical'`, so the default can never drift between call
  sites. Takes a plain duck-typed shape rather than App.tsx's own
  Patient type, so this module never needs to import anything from
  App.tsx at all.
*/
export function getPatientCaseType(
  patient: { caseType?: PatientCaseType } | null | undefined
): PatientCaseType {
  return patient?.caseType ?? 'Clinical'
}
