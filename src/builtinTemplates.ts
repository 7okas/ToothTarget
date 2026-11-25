import type { Procedure, ProcedureTemplate, TemplatePhase } from './App'
import { clinicalRctPhases, practiceRctPhases } from './endoRctPhases'
import {
  BUILTIN_PROCEDURE_UPDATED_AT,
  COMPOSITE_CLASS_PROCEDURE_SEEDS,
} from './procedureSeeding'
import { UNCLASSIFIED } from './templateTaxonomy'

/*
  BUILT-IN TEMPLATES AND PROCEDURES

  Pulled out of App.tsx as a plain module (type-only import back) so
  it can be tested directly, like procedureSeeding.ts.

  ACTIVE built-ins (what the app uses today): Endodontics > RCT >
  Anterior / Premolar / Molar, and the single "Root Canal Treatment"
  procedure that routes a tooth to its type by region.

  RETIRED built-ins (RETIRED_BUILTIN_TEMPLATES / _PROCEDURES) are the
  earlier General / Composite / Scaling / Extraction / Indirect
  Restoration definitions. They are deliberately kept, unused, so a
  future specialty can bring them back - nothing reads them today.
*/

/*
  Built-ins are code, not account data: one fixed timestamp, never
  read (built-in templates never enter the cloud sync document).
*/
const BUILTIN_TEMPLATE_UPDATED_AT = '2024-01-01T00:00:00.000Z'

/*
  Template editing is switched off for now: Manage Procedure
  Templates is view-only and only built-in templates are listed. The
  editor code is still in App.tsx; flipping this to true brings the
  old Manage Templates behaviour (create, edit, move, duplicate,
  delete) back.
*/
export const TEMPLATE_EDITING_ENABLED = false

/*
  Same switch for the Select Procedure screen: while false it shows
  only the built-in procedure, with no Add / rename / archive controls
  (the handlers and the archived-procedures list are still in App.tsx).
*/
export const PROCEDURE_EDITING_ENABLED = false

/*
  The only specialization shown in Manage Procedure Templates while
  editing is off. The taxonomy keeps its other entries for later.
*/
export const VISIBLE_SPECIALIZATION_IDS: readonly string[] = ['endodontics']

export const DEFAULT_GENERAL_PHASES: TemplatePhase[] = [
  { name: 'Access', duration: 10 * 60 },
  { name: 'Cleaning & Shaping', duration: 30 * 60 },
  { name: 'Obturation', duration: 20 * 60 },
]

const DEFAULT_COMPOSITE_PHASES: TemplatePhase[] = [
  { name: 'Preparation', duration: 10 * 60 },
  { name: 'Restoration & Finishing', duration: 20 * 60 },
]

function rctTemplate(
  typeId: 'anterior' | 'premolar' | 'molar',
  label: string
): Omit<ProcedureTemplate, 'updatedAt'> {

  return {
    id: `endo-rct-${typeId}`,
    name: `RCT - ${label}`,
    isCustom: false,
    phases: clinicalRctPhases(),
    practicePhases: practiceRctPhases(),
    specializationId: 'endodontics',
    procedureKey: 'rct',
    typeId,
  }

}

export const BUILTIN_TEMPLATES: ProcedureTemplate[] = [
  rctTemplate('anterior', 'Anterior'),
  rctTemplate('premolar', 'Premolar'),
  rctTemplate('molar', 'Molar'),
].map(template => ({ ...template, updatedAt: BUILTIN_TEMPLATE_UPDATED_AT }))

export const RETIRED_BUILTIN_TEMPLATES: ProcedureTemplate[] = (
  [
  {
    id: 'general',
    name: 'General Procedure',
    isCustom: false,
    phases: DEFAULT_GENERAL_PHASES.map(phase => ({ ...phase })),
    ...UNCLASSIFIED,
  },
  {
    id: 'rct-anterior',
    name: 'Anterior Root Canal',
    isCustom: false,
    phases: [
      { name: 'Access', duration: 8 * 60 },
      { name: 'Working Length', duration: 5 * 60 },
      { name: 'Glide Path', duration: 5 * 60 },
      { name: 'Shaping', duration: 10 * 60 },
      { name: 'Irrigation', duration: 5 * 60 },
      { name: 'Obturation', duration: 8 * 60 },
    ],
    specializationId: 'endodontics',
    procedureKey: 'rct',
    typeId: 'anterior',
  },
  {
    id: 'rct-premolar',
    name: 'Premolar Root Canal',
    isCustom: false,
    phases: [
      { name: 'Access', duration: 10 * 60 },
      { name: 'Working Length', duration: 8 * 60 },
      { name: 'Glide Path', duration: 5 * 60 },
      { name: 'Shaping', duration: 12 * 60 },
      { name: 'Irrigation', duration: 8 * 60 },
      { name: 'Obturation', duration: 10 * 60 },
    ],
    specializationId: 'endodontics',
    procedureKey: 'rct',
    typeId: 'premolar',
  },
  {
    id: 'rct-molar',
    name: 'Molar Root Canal',
    isCustom: false,
    phases: [
      { name: 'Access', duration: 10 * 60 },
      { name: 'Working Length', duration: 10 * 60 },
      { name: 'Glide Path', duration: 5 * 60 },
      { name: 'Shaping', duration: 15 * 60 },
      { name: 'Irrigation', duration: 10 * 60 },
      { name: 'Obturation', duration: 10 * 60 },
    ],
    specializationId: 'endodontics',
    procedureKey: 'rct',
    typeId: 'molar',
  },
  ...(['class-1', 'class-2', 'class-3', 'class-4', 'class-5'] as const).map(
    (typeId, index) => ({
      id: index === 0 ? 'cr-default' : `cr-class-${index + 1}`,
      name: 'Composite Restoration',
      isCustom: false,
      phases: DEFAULT_COMPOSITE_PHASES.map(phase => ({ ...phase })),
      specializationId: 'restorative',
      procedureKey: 'composite',
      typeId,
    })
  ),
  {
    id: 'sp-default',
    name: 'Scaling & Polishing',
    isCustom: false,
    phases: [
      { name: 'Scaling & Polishing', duration: 30 * 60 },
    ],
    ...UNCLASSIFIED,
  },
  {
    id: 'ext-default',
    name: 'Extraction',
    isCustom: false,
    phases: [
      { name: 'Extraction', duration: 20 * 60 },
    ],
    ...UNCLASSIFIED,
  },
  {
    id: 'irprep-default',
    name: 'Indirect Restoration Preparation',
    isCustom: false,
    phases: [
      { name: 'Preparation', duration: 30 * 60 },
      { name: 'Impression', duration: 10 * 60 },
    ],
    ...UNCLASSIFIED,
  },
  ] satisfies Omit<ProcedureTemplate, 'updatedAt'>[]
).map(template => ({ ...template, updatedAt: BUILTIN_TEMPLATE_UPDATED_AT }))

/*
  The only built-in procedure. Keeps the id 'rct' (and its name) so
  Statistics' RCT-by-region grouping, which finds the procedure that
  has regionTemplateIds, keeps working.
*/
export const BUILTIN_PROCEDURES: Procedure[] = (
  [
  {
    id: 'rct',
    name: 'Root Canal Treatment',
    isCustom: false,
    templateId: 'endo-rct-molar',
    regionTemplateIds: {
      anterior: 'endo-rct-anterior',
      premolar: 'endo-rct-premolar',
      molar: 'endo-rct-molar',
    },
  },
  ] satisfies Omit<Procedure, 'updatedAt'>[]
).map(procedure => ({ ...procedure, updatedAt: BUILTIN_PROCEDURE_UPDATED_AT }))

export const RETIRED_BUILTIN_PROCEDURES: Procedure[] = (
  [
  { id: 'cr', name: 'Composite Restoration', isCustom: false, templateId: 'cr-default' },
  ...COMPOSITE_CLASS_PROCEDURE_SEEDS,
  { id: 'sp', name: 'Scaling & Polishing', isCustom: false, templateId: 'sp-default' },
  { id: 'ext', name: 'Extraction', isCustom: false, templateId: 'ext-default' },
  { id: 'irprep', name: 'Indirect Restoration Preparation', isCustom: false, templateId: 'irprep-default' },
  ] satisfies Omit<Procedure, 'updatedAt'>[]
).map(procedure => ({ ...procedure, updatedAt: BUILTIN_PROCEDURE_UPDATED_AT }))

/*
  DEFENSIVE LOAD STEPS

  A device that still holds the old built-ins in localStorage (or
  receives them in a synced cache) must not show or use them.

  Templates: the built-ins always come from code (so they can never
  be shadowed by an old stored copy); only custom templates are kept
  from storage.
*/

const BUILTIN_TEMPLATE_IDS = new Set(BUILTIN_TEMPLATES.map(t => t.id))

export function adoptBuiltinTemplates(
  persisted: ProcedureTemplate[]
): ProcedureTemplate[] {

  return [
    ...BUILTIN_TEMPLATES,
    ...persisted.filter(template => template.isCustom),
  ]

}

export function hasRetiredBuiltinTemplates(
  persisted: ProcedureTemplate[]
): boolean {

  return persisted.some(
    template => !template.isCustom && !BUILTIN_TEMPLATE_IDS.has(template.id)
  )

}

/*
  Procedures: drops built-in (isCustom: false) procedures that are no
  longer built in, puts back any current built-in that is missing, and
  points the RCT procedure at the new templates if a stored copy still
  routes to the old ones. A stored rename/archive of the RCT procedure
  is kept. Procedures the dentist created themselves are never
  removed here.
*/
export function adoptBuiltinProcedures(
  procedures: Procedure[]
): { procedures: Procedure[]; changed: boolean } {

  let changed = false

  const kept = procedures.filter(procedure => {

    const isRetired =
      !procedure.isCustom &&
      !BUILTIN_PROCEDURES.some(builtin => builtin.id === procedure.id)

    if (isRetired) {
      changed = true
    }

    return !isRetired

  })

  const rerouted = kept.map(procedure => {

    const builtin =
      BUILTIN_PROCEDURES.find(candidate => candidate.id === procedure.id)

    if (
      !builtin ||
      (procedure.templateId === builtin.templateId &&
        JSON.stringify(procedure.regionTemplateIds) ===
          JSON.stringify(builtin.regionTemplateIds))
    ) {
      return procedure
    }

    changed = true

    return {
      ...procedure,
      templateId: builtin.templateId,
      regionTemplateIds: builtin.regionTemplateIds,
    }

  })

  const missing = BUILTIN_PROCEDURES.filter(
    builtin => !rerouted.some(procedure => procedure.id === builtin.id)
  )

  if (missing.length > 0) {
    changed = true
  }

  return {
    procedures: [...missing, ...rerouted],
    changed,
  }

}
