import type { ProcedureTemplate, TemplatePhase } from './App'
import type { PatientCaseType } from './patientCaseType'
import { TEMPLATE_TAXONOMY } from './templateTaxonomy'

/*
  Pure helpers behind Manage Procedure Templates while editing is off,
  kept apart from the React screen so they can be tested directly.
*/

export type TemplateViewSection = {
  caseType: PatientCaseType
  phases: TemplatePhase[]
  totalMinutes: number
}

function totalMinutes(phases: TemplatePhase[]): number {
  return Math.round(
    phases.reduce((total, phase) => total + phase.duration, 0) / 60
  )
}

/* Clinical first, then Practice if the template has its own list. */
export function templateViewSections(
  template: Pick<ProcedureTemplate, 'phases' | 'practicePhases'>
): TemplateViewSection[] {

  const sections: TemplateViewSection[] = [
    {
      caseType: 'Clinical',
      phases: template.phases,
      totalMinutes: totalMinutes(template.phases),
    },
  ]

  if (template.practicePhases) {
    sections.push({
      caseType: 'Practice',
      phases: template.practicePhases,
      totalMinutes: totalMinutes(template.practicePhases),
    })
  }

  return sections

}

/* The specializations Manage Templates lists, given the visible ids. */
export function browsableSpecializations(
  visibleIds: readonly string[]
) {
  return TEMPLATE_TAXONOMY.filter(
    specialization => visibleIds.includes(specialization.id)
  )
}

/* The templates listed under one Type, given whether editing is on. */
export function listableTemplates(
  templates: ProcedureTemplate[],
  bucket: { specializationId: string; procedureKey: string; typeId: string },
  editingEnabled: boolean
): ProcedureTemplate[] {

  return templates.filter(
    template =>
      template.specializationId === bucket.specializationId &&
      template.procedureKey === bucket.procedureKey &&
      template.typeId === bucket.typeId &&
      (editingEnabled || !template.isCustom)
  )

}
