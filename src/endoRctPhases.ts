import type { TemplatePhase } from './App'
import type { PatientCaseType } from './patientCaseType'

/*
  ENDODONTICS > RCT PHASE LISTS

  The one place the RCT phase names and their placeholder target
  durations are written down. All three tooth types (Anterior,
  Premolar, Molar) use the same two lists - which list a treatment
  gets is decided by the patient's case type, never by the tooth.

  Clinical = real patient work, so it starts with Anesthesia.
  Practice = extracted-teeth practice work, the same list WITHOUT
  Anesthesia (it is derived by filtering, so the two lists can never
  drift apart).

  The durations are PLACEHOLDERS (Clinical 50 min, Practice 45 min).
  They are only the starting target for a new treatment and stay
  editable per treatment.

  Only type-only imports are taken, so this module can be tested
  directly without pulling App.tsx's runtime dependencies in.
*/

export const ANESTHESIA_PHASE_NAME = 'Anesthesia'

const minutes = (value: number) => value * 60

export const CLINICAL_RCT_PHASES: readonly TemplatePhase[] = [
  { name: ANESTHESIA_PHASE_NAME, duration: minutes(5) },
  { name: 'Access', duration: minutes(8) },
  { name: 'Glide Path', duration: minutes(5) },
  { name: 'Working Length', duration: minutes(7) },
  { name: 'Shaping', duration: minutes(10) },
  { name: 'MC X-ray', duration: minutes(3) },
  { name: 'Irrigant Activation', duration: minutes(5) },
  { name: 'Obturation', duration: minutes(7) },
]

export const PRACTICE_RCT_PHASES: readonly TemplatePhase[] =
  CLINICAL_RCT_PHASES.filter(phase => phase.name !== ANESTHESIA_PHASE_NAME)

export function clinicalRctPhases(): TemplatePhase[] {
  return CLINICAL_RCT_PHASES.map(phase => ({ ...phase }))
}

export function practiceRctPhases(): TemplatePhase[] {
  return PRACTICE_RCT_PHASES.map(phase => ({ ...phase }))
}

/*
  The phase list a new treatment starts with. A template with a
  separate practicePhases list (the built-in RCT templates) uses it
  for Practice patients; every other template - and every Clinical
  patient - uses its ordinary phases. Always returns fresh copies, so
  editing a treatment's phases can never change the template.
*/
export function phasesForCaseType(
  template: { phases: TemplatePhase[]; practicePhases?: TemplatePhase[] },
  caseType: PatientCaseType
): TemplatePhase[] {

  const source =
    caseType === 'Practice' && template.practicePhases
      ? template.practicePhases
      : template.phases

  return source.map(phase => ({ ...phase }))

}
