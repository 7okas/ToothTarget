import { describe, expect, it } from 'vitest'
import type { Procedure } from './App'
import {
  BUILTIN_PROCEDURE_UPDATED_AT,
  COMPOSITE_CLASS_PROCEDURE_SEEDS,
  seedMissingBuiltinProcedures,
} from './procedureSeeding'

/*
  Phase 2, Step 7 of the Sync & Statistics Redesign: Composite
  Restoration Class II-V each get their own standalone, permanent-id
  tag (Class I already has one - the existing 'cr' procedure, left
  untouched). These tests cover the three things asked for: the tags
  are created exactly once (never duplicated on a second run), each
  one resolves to the correct pre-existing composite template, and an
  existing "Composite Restoration" (Class I) record - and, by
  construction, every saved treatment - is left completely untouched.
*/

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: 'cr',
    name: 'Composite Restoration',
    isCustom: false,
    templateId: 'cr-default',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('COMPOSITE_CLASS_PROCEDURE_SEEDS - each resolves to the correct template', () => {

  it('is exactly the four Class II-V tags, each pointing at its own pre-existing template id', () => {

    expect(
      COMPOSITE_CLASS_PROCEDURE_SEEDS.map(seed => ({
        id: seed.id,
        name: seed.name,
        templateId: seed.templateId,
      }))
    ).toEqual([
      { id: 'cr-ii', name: 'Composite Restoration - Class II', templateId: 'cr-class-2' },
      { id: 'cr-iii', name: 'Composite Restoration - Class III', templateId: 'cr-class-3' },
      { id: 'cr-iv', name: 'Composite Restoration - Class IV', templateId: 'cr-class-4' },
      { id: 'cr-v', name: 'Composite Restoration - Class V', templateId: 'cr-class-5' },
    ])

  })

  it('every seed name contains "Composite" so a search for it finds all of them, including the existing Class I tag', () => {

    for (const seed of COMPOSITE_CLASS_PROCEDURE_SEEDS) {
      expect(seed.name).toContain('Composite')
    }

  })

  it('is not marked isCustom - these are built-ins, not dentist-created procedures', () => {

    for (const seed of COMPOSITE_CLASS_PROCEDURE_SEEDS) {
      expect(seed.isCustom).toBe(false)
    }

  })

})

describe('seedMissingBuiltinProcedures - created once, never duplicated', () => {

  it('appends all four seeds to a fresh/legacy list that has none of them yet', () => {

    const existing: Procedure[] = [
      makeProcedure({ id: 'rct', name: 'Root Canal Treatment', templateId: 'rct-molar' }),
      makeProcedure(),
    ]

    const result = seedMissingBuiltinProcedures(existing)

    expect(result.changed).toBe(true)
    expect(result.procedures).toHaveLength(6)

    const seededIds = result.procedures.map(p => p.id)
    expect(seededIds).toEqual(
      expect.arrayContaining(['cr-ii', 'cr-iii', 'cr-iv', 'cr-v'])
    )

    for (const seed of COMPOSITE_CLASS_PROCEDURE_SEEDS) {
      expect(result.procedures.find(p => p.id === seed.id)).toEqual({
        ...seed,
        updatedAt: BUILTIN_PROCEDURE_UPDATED_AT,
      })
    }

  })

  it('running it again on the already-seeded result is a complete no-op (no duplicates, changed is false)', () => {

    const existing: Procedure[] = [makeProcedure()]

    const firstRun = seedMissingBuiltinProcedures(existing)
    expect(firstRun.changed).toBe(true)

    const secondRun = seedMissingBuiltinProcedures(firstRun.procedures)

    expect(secondRun.changed).toBe(false)
    expect(secondRun.procedures).toEqual(firstRun.procedures)
    expect(secondRun.procedures).toHaveLength(firstRun.procedures.length)

    // No id appears twice.
    const ids = secondRun.procedures.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)

  })

  it('only appends the ids that are actually missing when some are already present', () => {

    const alreadyPartiallySeeded: Procedure[] = [
      makeProcedure(),
      { ...COMPOSITE_CLASS_PROCEDURE_SEEDS[0], updatedAt: BUILTIN_PROCEDURE_UPDATED_AT },
    ]

    const result = seedMissingBuiltinProcedures(alreadyPartiallySeeded)

    expect(result.changed).toBe(true)
    expect(result.procedures).toHaveLength(5)

    // The already-present seed appears exactly once, unchanged.
    expect(
      result.procedures.filter(p => p.id === 'cr-ii')
    ).toEqual([alreadyPartiallySeeded[1]])

  })

  it('leaves a dentist\'s own rename/archive of an already-seeded tag completely alone, rather than overwriting it back to the default', () => {

    const renamedAndArchived: Procedure = {
      ...COMPOSITE_CLASS_PROCEDURE_SEEDS[1], // cr-iii
      name: 'Class III (renamed by dentist)',
      status: 'archived',
      updatedAt: '2026-05-01T00:00:00.000Z',
    }

    const existing: Procedure[] = [makeProcedure(), renamedAndArchived]

    const result = seedMissingBuiltinProcedures(existing)

    // cr-ii/cr-iv/cr-v are newly appended; cr-iii is the dentist's own edited copy, untouched.
    expect(result.procedures.find(p => p.id === 'cr-iii')).toEqual(renamedAndArchived)
    expect(result.procedures).toHaveLength(5)

  })

  it('two independent "devices" seeding from the same starting point produce byte-for-byte identical new records', () => {

    const deviceAStartingState: Procedure[] = [makeProcedure()]
    const deviceBStartingState: Procedure[] = [makeProcedure()]

    const deviceAResult = seedMissingBuiltinProcedures(deviceAStartingState)
    const deviceBResult = seedMissingBuiltinProcedures(deviceBStartingState)

    expect(deviceAResult.procedures).toEqual(deviceBResult.procedures)

  })

})

describe('seedMissingBuiltinProcedures - existing Composite Restoration (Class I) is unaffected', () => {

  it('never modifies the existing "cr" procedure record', () => {

    const existingClassOne = makeProcedure({
      name: 'Composite Restoration (dentist renamed this)',
      updatedAt: '2026-03-01T00:00:00.000Z',
    })

    const result = seedMissingBuiltinProcedures([existingClassOne])

    expect(result.procedures.find(p => p.id === 'cr')).toBe(existingClassOne)

  })

  it('never introduces a tag for Class I - only Class II-V are new', () => {

    const result = seedMissingBuiltinProcedures([makeProcedure()])

    expect(result.procedures.filter(p => p.templateId === 'cr-default')).toHaveLength(1)
    expect(result.procedures.some(p => p.id === 'cr-i')).toBe(false)

  })

  it('has no way to touch saved treatments at all - its signature only ever takes/returns a procedure list', () => {

    // Documents the structural guarantee: this function cannot read or
    // write treatment data because it is never given any to begin with.
    expect(seedMissingBuiltinProcedures.length).toBe(1)

  })

})
