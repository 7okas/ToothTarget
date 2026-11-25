import { describe, expect, it } from 'vitest'
import type { Procedure, ProcedureTemplate } from './App'
import {
  BUILTIN_PROCEDURES,
  BUILTIN_TEMPLATES,
  RETIRED_BUILTIN_PROCEDURES,
  RETIRED_BUILTIN_TEMPLATES,
  PROCEDURE_EDITING_ENABLED,
  TEMPLATE_EDITING_ENABLED,
  VISIBLE_SPECIALIZATION_IDS,
  adoptBuiltinProcedures,
  adoptBuiltinTemplates,
  hasRetiredBuiltinTemplates,
} from './builtinTemplates'
import {
  CLINICAL_RCT_PHASES,
  PRACTICE_RCT_PHASES,
  phasesForCaseType,
} from './endoRctPhases'
import { getPatientCaseType } from './patientCaseType'
import { TOOTH_CHART } from './teeth'
import {
  browsableSpecializations,
  listableTemplates,
  templateViewSections,
} from './templateView'
import {
  ALL_TREATMENTS_FILTER,
  calculateMonthlyStatistics,
  calculateProcedureFilterOptions,
  calculateRctRegionStatistics,
} from './statistics'
import {
  buildMonthlyTableRows,
  decideMonthlySectionView,
} from './monthlyTableRules'

/*
  The App.tsx rule for "which template does this tooth use", restated
  from the built-in procedure's own region map (App.tsx itself cannot
  be imported by a test): region of the tooth -> regionTemplateIds.
*/
function templateForTooth(toothId: string): ProcedureTemplate | undefined {

  const tooth = TOOTH_CHART.find(candidate => candidate.toothId === toothId)
  const rct = BUILTIN_PROCEDURES.find(procedure => procedure.id === 'rct')

  return BUILTIN_TEMPLATES.find(
    template =>
      template.id === rct?.regionTemplateIds?.[tooth!.region]
  )

}

const names = (phases: readonly { name: string }[]) =>
  phases.map(phase => phase.name)

const minutes = (phases: readonly { duration: number }[]) =>
  phases.reduce((total, phase) => total + phase.duration, 0) / 60

describe('RCT phase lists', () => {

  it('Clinical is the 8 phases in order, 50 placeholder minutes', () => {

    expect(names(CLINICAL_RCT_PHASES)).toEqual([
      'Anesthesia',
      'Access',
      'Glide Path',
      'Working Length Determination',
      'Shaping',
      'Master Cone X-ray',
      'Irrigant Activation',
      'Obturation',
    ])

    expect(CLINICAL_RCT_PHASES.map(phase => phase.duration / 60)).toEqual(
      [5, 8, 5, 7, 10, 3, 5, 7]
    )

    expect(minutes(CLINICAL_RCT_PHASES)).toBe(50)

  })

  it('Practice is the same list without Anesthesia, 45 minutes', () => {

    expect(names(PRACTICE_RCT_PHASES)).toEqual(
      names(CLINICAL_RCT_PHASES).slice(1)
    )

    expect(names(PRACTICE_RCT_PHASES)).not.toContain('Anesthesia')

    expect(minutes(PRACTICE_RCT_PHASES)).toBe(45)

  })

})

describe('built-in templates: each tooth type x case type', () => {

  it('has exactly the three Endodontics > RCT templates with the new ids', () => {

    expect(BUILTIN_TEMPLATES.map(template => template.id)).toEqual([
      'endo-rct-anterior',
      'endo-rct-premolar',
      'endo-rct-molar',
    ])

    BUILTIN_TEMPLATES.forEach(template => {
      expect(template.isCustom).toBe(false)
      expect(template.specializationId).toBe('endodontics')
      expect(template.procedureKey).toBe('rct')
    })

  })

  for (const typeId of ['anterior', 'premolar', 'molar']) {

    const template = BUILTIN_TEMPLATES.find(item => item.typeId === typeId)!

    it(`${typeId}: Clinical gets the 8 phases including Anesthesia`, () => {

      const phases = phasesForCaseType(template, 'Clinical')

      expect(phases).toEqual(CLINICAL_RCT_PHASES)
      expect(names(phases)[0]).toBe('Anesthesia')

    })

    it(`${typeId}: Practice gets the 7 phases and never Anesthesia`, () => {

      const phases = phasesForCaseType(template, 'Practice')

      expect(phases).toEqual(PRACTICE_RCT_PHASES)
      expect(names(phases)).not.toContain('Anesthesia')

    })

  }

  it('a patient with no stored caseType is Clinical, so gets Anesthesia', () => {

    const template = BUILTIN_TEMPLATES[0]

    const phases = phasesForCaseType(
      template,
      getPatientCaseType({})
    )

    expect(names(phases)).toContain('Anesthesia')
    expect(getPatientCaseType(undefined)).toBe('Clinical')

  })

  it('returns copies, so editing a treatment can never change the template', () => {

    const template = BUILTIN_TEMPLATES[0]

    const phases = phasesForCaseType(template, 'Clinical')
    phases[0].duration = 999
    phases.pop()

    expect(template.phases).toEqual(CLINICAL_RCT_PHASES)
    expect(phasesForCaseType(template, 'Practice')).toEqual(PRACTICE_RCT_PHASES)

  })

  it('a template without practicePhases uses its ordinary phases for Practice', () => {

    const custom = { phases: [{ name: 'Only', duration: 60 }] }

    expect(phasesForCaseType(custom, 'Practice')).toEqual(custom.phases)

  })

  it('every one of the 32 teeth resolves to a built-in template of its own type', () => {

    expect(TOOTH_CHART).toHaveLength(32)

    TOOTH_CHART.forEach(tooth => {
      expect(templateForTooth(tooth.toothId)?.typeId).toBe(tooth.region)
    })

  })

})

describe('built-in procedures', () => {

  it('is only the Root Canal Treatment procedure, id rct', () => {

    expect(BUILTIN_PROCEDURES.map(procedure => procedure.id)).toEqual(['rct'])

    expect(BUILTIN_PROCEDURES[0].regionTemplateIds).toEqual({
      anterior: 'endo-rct-anterior',
      premolar: 'endo-rct-premolar',
      molar: 'endo-rct-molar',
    })

  })

  it('keeps the retired definitions available but separate', () => {

    expect(RETIRED_BUILTIN_TEMPLATES.map(t => t.id)).toContain('cr-class-2')
    expect(RETIRED_BUILTIN_PROCEDURES.map(p => p.id)).toContain('cr-ii')

    const activeIds = new Set(BUILTIN_TEMPLATES.map(t => t.id))

    RETIRED_BUILTIN_TEMPLATES.forEach(template => {
      expect(activeIds.has(template.id)).toBe(false)
    })

  })

})

describe('adoptBuiltinTemplates (defensive load step)', () => {

  it('drops old built-in templates and puts the new ones in front', () => {

    const adopted = adoptBuiltinTemplates(RETIRED_BUILTIN_TEMPLATES)

    expect(adopted.map(template => template.id)).toEqual([
      'endo-rct-anterior',
      'endo-rct-premolar',
      'endo-rct-molar',
    ])

    expect(hasRetiredBuiltinTemplates(RETIRED_BUILTIN_TEMPLATES)).toBe(true)

  })

  it('keeps custom templates and takes built-ins from code, never a stored copy', () => {

    const custom: ProcedureTemplate = {
      id: 'mine',
      name: 'Mine',
      isCustom: true,
      phases: [{ name: 'X', duration: 60 }],
      specializationId: 'general',
      procedureKey: 'general',
      typeId: 'general',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }

    const staleCopy: ProcedureTemplate = {
      ...BUILTIN_TEMPLATES[0],
      phases: [{ name: 'Stale', duration: 1 }],
    }

    const adopted = adoptBuiltinTemplates([staleCopy, custom])

    expect(adopted).toEqual([...BUILTIN_TEMPLATES, custom])
    expect(hasRetiredBuiltinTemplates([staleCopy, custom])).toBe(false)

  })

})

describe('adoptBuiltinProcedures (defensive load step)', () => {

  const custom: Procedure = {
    id: 'custom-1',
    name: 'My own',
    isCustom: true,
    templateId: 'endo-rct-molar',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }

  it('changes nothing when the list is already current', () => {

    const result = adoptBuiltinProcedures(BUILTIN_PROCEDURES)

    expect(result.changed).toBe(false)
    expect(result.procedures).toEqual(BUILTIN_PROCEDURES)

  })

  it('drops every old built-in procedure and does not re-add Composite Class II-V', () => {

    const result = adoptBuiltinProcedures(RETIRED_BUILTIN_PROCEDURES)

    expect(result.changed).toBe(true)
    expect(result.procedures.map(p => p.id)).toEqual(['rct'])

  })

  it('re-routes a stored RCT procedure that still points at the old templates', () => {

    const oldRct: Procedure = {
      id: 'rct',
      name: 'Root Canal Treatment',
      isCustom: false,
      templateId: 'rct-molar',
      regionTemplateIds: {
        anterior: 'rct-anterior',
        premolar: 'rct-premolar',
        molar: 'rct-molar',
      },
      updatedAt: '2024-01-01T00:00:00.000Z',
    }

    const result = adoptBuiltinProcedures([oldRct])

    expect(result.changed).toBe(true)
    expect(result.procedures).toHaveLength(1)
    expect(result.procedures[0].regionTemplateIds).toEqual(
      BUILTIN_PROCEDURES[0].regionTemplateIds
    )

  })

  it('keeps a stored rename/archive of the RCT procedure', () => {

    const renamed: Procedure = {
      ...BUILTIN_PROCEDURES[0],
      name: 'RCT',
      status: 'archived',
      updatedAt: '2025-05-05T00:00:00.000Z',
    }

    const result = adoptBuiltinProcedures([renamed])

    expect(result.changed).toBe(false)
    expect(result.procedures).toEqual([renamed])

  })

  it('puts back a missing RCT procedure and never removes custom ones', () => {

    const result = adoptBuiltinProcedures([custom])

    expect(result.changed).toBe(true)
    expect(result.procedures.map(p => p.id)).toEqual(['rct', 'custom-1'])

  })

  it('restores the RCT procedure from an empty list', () => {

    expect(adoptBuiltinProcedures([]).procedures).toEqual(BUILTIN_PROCEDURES)

  })

})

describe('Manage Procedure Templates (view-only)', () => {

  it('has editing switched off', () => {

    expect(TEMPLATE_EDITING_ENABLED).toBe(false)
    expect(PROCEDURE_EDITING_ENABLED).toBe(false)

  })

  it('lists only Endodontics > RCT > Anterior / Premolar / Molar', () => {

    const specializations = browsableSpecializations(VISIBLE_SPECIALIZATION_IDS)

    expect(specializations.map(s => s.name)).toEqual(['Endodontics'])

    expect(specializations[0].procedures.map(p => p.name)).toEqual(['RCT'])

    expect(specializations[0].procedures[0].types.map(t => t.name)).toEqual([
      'Anterior',
      'Premolar',
      'Molar',
    ])

  })

  it('shows exactly one built-in template under each type', () => {

    ;['anterior', 'premolar', 'molar'].forEach(typeId => {

      const listed = listableTemplates(
        BUILTIN_TEMPLATES,
        { specializationId: 'endodontics', procedureKey: 'rct', typeId },
        TEMPLATE_EDITING_ENABLED
      )

      expect(listed).toHaveLength(1)
      expect(listed[0].typeId).toBe(typeId)

    })

  })

  it('hides custom templates while editing is off, shows them when it is on', () => {

    const custom: ProcedureTemplate = {
      ...BUILTIN_TEMPLATES[0],
      id: 'my-molar',
      isCustom: true,
    }

    const bucket = {
      specializationId: 'endodontics',
      procedureKey: 'rct',
      typeId: 'anterior',
    }

    expect(
      listableTemplates([...BUILTIN_TEMPLATES, custom], bucket, false)
    ).toHaveLength(1)

    expect(
      listableTemplates([...BUILTIN_TEMPLATES, custom], bucket, true)
    ).toHaveLength(2)

  })

  it('the read-only view shows Clinical (50 min) then Practice (45 min)', () => {

    const sections = templateViewSections(BUILTIN_TEMPLATES[0])

    expect(sections.map(s => [s.caseType, s.totalMinutes, s.phases.length])).toEqual([
      ['Clinical', 50, 8],
      ['Practice', 45, 7],
    ])

  })

  it('a template with one list shows a single section', () => {

    expect(
      templateViewSections({ phases: [{ name: 'A', duration: 600 }] })
    ).toHaveLength(1)

  })

})

describe('Statistics with no old procedures and no treatments', () => {

  it('has nothing to filter, group, or tabulate', () => {

    expect(calculateProcedureFilterOptions([])).toEqual([])
    expect(calculateRctRegionStatistics([], BUILTIN_PROCEDURES)).toEqual([])

  })

  it('the By-month section reports no match instead of a table', () => {

    const spanRows = calculateMonthlyStatistics([], ALL_TREATMENTS_FILTER, 'last6')
    const allTimeRows = calculateMonthlyStatistics([], ALL_TREATMENTS_FILTER, 'all')

    expect(allTimeRows).toEqual([])

    expect(
      decideMonthlySectionView({
        inCheckedMode: false,
        existingCheckedCount: 0,
        spanRows,
        allTimeRows,
      })
    ).toBe('no-match')

    expect(
      buildMonthlyTableRows(spanRows).every(row => row.kind === 'empty')
    ).toBe(true)

  })

})
