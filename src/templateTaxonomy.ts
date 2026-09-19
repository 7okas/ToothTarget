/*
  TEMPLATE TAXONOMY

  Data-driven Specialization -> Procedure -> Type hierarchy that
  templates are filed under, instead of one flat list. Adding a new
  branch (eg. "Endodontics -> Retreatment -> Molar" or a whole new
  "Prosthodontics" specialization) only means adding entries here -
  no screen/navigation code needs to change shape.

  'general' is not a real dental specialization - it's the catch-all
  home for templates that predate this taxonomy (or don't fit
  Endodontics/Restorative yet), so nothing gets silently dropped or
  hidden when migrating existing data.
*/

export type TemplateTypeOption = {
  id: string
  name: string
}

export type TemplateProcedureOption = {
  key: string
  name: string
  types: TemplateTypeOption[]
}

export type TemplateSpecialization = {
  id: string
  name: string
  procedures: TemplateProcedureOption[]
}

export type TemplateClassification = {
  specializationId: string
  procedureKey: string
  typeId: string
}

export const TEMPLATE_TAXONOMY: TemplateSpecialization[] = [
  {
    id: 'endodontics',
    name: 'Endodontics',
    procedures: [
      {
        key: 'rct',
        name: 'RCT',
        types: [
          { id: 'anterior', name: 'Anterior' },
          { id: 'premolar', name: 'Premolar' },
          { id: 'molar', name: 'Molar' },
        ],
      },
    ],
  },
  {
    id: 'restorative',
    name: 'Restorative Dentistry',
    procedures: [
      {
        key: 'composite',
        name: 'Composite',
        types: [
          { id: 'class-1', name: 'Class I' },
          { id: 'class-2', name: 'Class II' },
          { id: 'class-3', name: 'Class III' },
          { id: 'class-4', name: 'Class IV' },
          { id: 'class-5', name: 'Class V' },
        ],
      },
    ],
  },
  {
    id: 'general',
    name: 'General',
    procedures: [
      {
        key: 'general',
        name: 'General',
        types: [
          { id: 'general', name: 'Templates' },
        ],
      },
    ],
  },
]

export const UNCLASSIFIED: TemplateClassification = {
  specializationId: 'general',
  procedureKey: 'general',
  typeId: 'general',
}

export function findSpecialization(
  specializationId: string
): TemplateSpecialization | null {
  return (
    TEMPLATE_TAXONOMY.find(
      specialization => specialization.id === specializationId
    ) ?? null
  )
}

export function findProcedureOption(
  specializationId: string,
  procedureKey: string
): TemplateProcedureOption | null {

  const specialization = findSpecialization(specializationId)

  return (
    specialization?.procedures.find(
      procedure => procedure.key === procedureKey
    ) ?? null
  )

}

export function findTypeOption(
  specializationId: string,
  procedureKey: string,
  typeId: string
): TemplateTypeOption | null {

  const procedure = findProcedureOption(specializationId, procedureKey)

  return (
    procedure?.types.find(type => type.id === typeId) ?? null
  )

}

/*
  Known built-in template ids from before this taxonomy existed, so
  templates saved to localStorage by an earlier version of the app
  land in the right bucket on first load instead of "General".
*/

const LEGACY_ID_CLASSIFICATION: Record<string, TemplateClassification> = {
  'rct-anterior': { specializationId: 'endodontics', procedureKey: 'rct', typeId: 'anterior' },
  'rct-premolar': { specializationId: 'endodontics', procedureKey: 'rct', typeId: 'premolar' },
  'rct-molar': { specializationId: 'endodontics', procedureKey: 'rct', typeId: 'molar' },
  'cr-default': { specializationId: 'restorative', procedureKey: 'composite', typeId: 'class-1' },
}

/*
  Applied to every template loaded from localStorage (a blob written
  by a pre-taxonomy version of the app won't carry
  specializationId/procedureKey/typeId at all). Known built-in ids
  are restored to their proper bucket; anything else - including a
  dentist's own custom templates - falls back to General so it stays
  visible and editable rather than disappearing.
*/

export function classifyTemplate<
  T extends {
    id: string
    specializationId?: string
    procedureKey?: string
    typeId?: string
  }
>(template: T): T & TemplateClassification {

  if (
    template.specializationId &&
    template.procedureKey &&
    template.typeId
  ) {
    return template as T & TemplateClassification
  }

  const legacy = LEGACY_ID_CLASSIFICATION[template.id]

  return {
    ...template,
    specializationId: legacy?.specializationId ?? UNCLASSIFIED.specializationId,
    procedureKey: legacy?.procedureKey ?? UNCLASSIFIED.procedureKey,
    typeId: legacy?.typeId ?? UNCLASSIFIED.typeId,
  }

}
