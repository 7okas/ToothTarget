import { describe, expect, it } from 'vitest'
import type { ProcedureTemplate, SavedTreatment, TemplatePhase } from './App'
import {
  buildPhaseNamePool,
  phaseNameWeight,
  type PoolActiveTreatment,
  type PoolSavedTreatment,
  type PoolTemplate,
} from './phaseNamePool'

// Compile-time proof that the app's real types fit the pool's minimal input shapes.
export type _RealTypesFit = [
  SavedTreatment extends PoolSavedTreatment ? true : never,
  ProcedureTemplate extends PoolTemplate ? true : never,
  // An active/incomplete treatment carries `phases: TemplatePhase[]`.
  { phases: TemplatePhase[] } extends PoolActiveTreatment ? true : never,
]

function saved(procedureId: string, phases: [string, boolean?][]) {
  return {
    procedureId,
    phaseRecords: phases.map(([name, skipped]) => ({ name, skipped: skipped ?? false })),
  }
}

function template(...names: string[]) {
  return { phases: names.map(name => ({ name })) }
}

const none = { savedTreatments: [], templates: [], activeTreatments: [] }

function statOf(pool: ReturnType<typeof buildPhaseNamePool>, name: string) {
  return pool.find(entry => entry.name === name)
}

describe('buildPhaseNamePool - saved treatments', () => {

  it('counts the saved treatments containing each name, once per treatment', () => {
    const pool = buildPhaseNamePool({
      ...none,
      savedTreatments: [
        saved('rct', [['Access'], ['Shaping']]),
        saved('rct', [['Access']]),
        saved('filling', [['Access'], ['Access']]), // repeated inside one treatment: still one
      ],
    })
    expect(statOf(pool, 'Access')?.savedTreatmentCount).toBe(3)
    expect(statOf(pool, 'Shaping')?.savedTreatmentCount).toBe(1)
  })

  it('does not count skipped phase records', () => {
    const pool = buildPhaseNamePool({
      ...none,
      savedTreatments: [
        saved('rct', [['Access'], ['Obturation', true]]),
        saved('rct', [['Access'], ['Obturation', true]]),
        saved('rct', [['Access'], ['Obturation']]),
      ],
    })
    expect(statOf(pool, 'Obturation')?.savedTreatmentCount).toBe(1)
  })

  it('a name that only ever appeared as skipped is not in the pool at all', () => {
    const pool = buildPhaseNamePool({
      ...none,
      savedTreatments: [saved('rct', [['Access'], ['Ghost', true]])],
    })
    expect(statOf(pool, 'Ghost')).toBeUndefined()
  })

  it('splits the count by procedure', () => {
    const pool = buildPhaseNamePool({
      ...none,
      savedTreatments: [
        saved('rct', [['Access']]),
        saved('rct', [['Access']]),
        saved('filling', [['Access']]),
      ],
    })
    expect(statOf(pool, 'Access')?.savedByProcedure).toEqual({ rct: 2, filling: 1 })
  })

  it('keeps names exactly as written (case-sensitive), trimmed only - as statistics group them', () => {
    const pool = buildPhaseNamePool({
      ...none,
      savedTreatments: [
        saved('rct', [['Access']]),
        saved('rct', [['access']]),
        saved('rct', [['  Access  ']]),
      ],
    })
    expect(statOf(pool, 'Access')?.savedTreatmentCount).toBe(2)
    expect(statOf(pool, 'access')?.savedTreatmentCount).toBe(1)
    expect(pool).toHaveLength(2)
  })

  it('ignores blank names and tolerates a record list that is missing', () => {
    const pool = buildPhaseNamePool({
      ...none,
      savedTreatments: [
        saved('rct', [[''], ['   '], ['Access']]),
        { procedureId: 'rct' },
      ],
    })
    expect(pool.map(entry => entry.name)).toEqual(['Access'])
  })

})

describe('buildPhaseNamePool - templates and active treatments', () => {

  it('lists template names even when never used (saved count 0)', () => {
    const pool = buildPhaseNamePool({
      ...none,
      templates: [template('Access', 'Shaping'), template('Access', 'Obturation')],
    })
    expect(statOf(pool, 'Access')).toMatchObject({ savedTreatmentCount: 0, templateCount: 2 })
    expect(statOf(pool, 'Obturation')).toMatchObject({ savedTreatmentCount: 0, templateCount: 1 })
  })

  it('a template that repeats a name still counts once', () => {
    const pool = buildPhaseNamePool({ ...none, templates: [template('Access', 'Access')] })
    expect(statOf(pool, 'Access')?.templateCount).toBe(1)
  })

  it('adds active and incomplete treatments', () => {
    const pool = buildPhaseNamePool({
      ...none,
      activeTreatments: [template('Access', 'Rinse'), template('Rinse')],
    })
    expect(statOf(pool, 'Access')?.activeCount).toBe(1)
    expect(statOf(pool, 'Rinse')?.activeCount).toBe(2)
  })

  it('combines all three sources for one name', () => {
    const pool = buildPhaseNamePool({
      savedTreatments: [saved('rct', [['Access']])],
      templates: [template('Access')],
      activeTreatments: [template('Access')],
    })
    const stat = statOf(pool, 'Access')!
    expect(stat).toMatchObject({ savedTreatmentCount: 1, templateCount: 1, activeCount: 1 })
    expect(phaseNameWeight(stat)).toBe(3)
  })

})

describe('buildPhaseNamePool - general', () => {

  it('is empty with no sources', () => {
    expect(buildPhaseNamePool(none)).toEqual([])
  })

  it('is sorted by name so results are deterministic', () => {
    const pool = buildPhaseNamePool({
      ...none,
      templates: [template('Zeta', 'Alpha', 'Mid')],
    })
    expect(pool.map(entry => entry.name)).toEqual(['Alpha', 'Mid', 'Zeta'])
  })

  it('does not change the inputs', () => {
    const savedTreatments = [saved('rct', [['Access']])]
    const before = JSON.stringify(savedTreatments)
    buildPhaseNamePool({ ...none, savedTreatments })
    expect(JSON.stringify(savedTreatments)).toBe(before)
  })

})
