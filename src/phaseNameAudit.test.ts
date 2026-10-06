import { describe, expect, it } from 'vitest'
import {
  auditPhaseNames,
  extractAuditInput,
  formatAuditReport,
  type AuditInput,
} from './phaseNameAudit'

function many(n: number, names: string[]): string[][] {
  return Array.from({ length: n }, () => names)
}

function input(saved: string[][], templates: string[][] = []): AuditInput {
  return { savedPhaseNameLists: saved, templatePhaseNameLists: templates }
}

describe('extractAuditInput - reads phase names and nothing else', () => {

  const backup = {
    app: 'ToothTarget',
    exportedAt: '2026-01-01T00:00:00.000Z',
    data: {
      toothTargetPatients: [{ id: 'p1', name: 'SECRET PATIENT NAME', patientNumber: 1 }],
      toothTargetSavedTreatments: [
        {
          id: 't1',
          patientName: 'SECRET PATIENT NAME',
          patientId: 'p1',
          date: '2026-01-01T00:00:00.000Z',
          toothId: '16',
          tags: ['SECRET TAG'],
          events: [{ note: 'SECRET NOTE' }],
          phaseRecords: [
            { name: 'Access', skipped: false, actualDuration: 10 },
            { name: 'Obturation', skipped: true },
            { name: 'Shaping' },
          ],
        },
      ],
      toothTargetTemplates: [
        { id: 'x', name: 'Template name', phases: [{ name: 'Access', duration: 60 }, { name: 'Glide Path', duration: 60 }] },
      ],
    },
  }

  it('returns only the non-skipped phase names of each saved treatment and the phase names of each template', () => {
    expect(extractAuditInput(backup)).toEqual({
      savedPhaseNameLists: [['Access', 'Shaping']],
      templatePhaseNameLists: [['Access', 'Glide Path']],
    })
  })

  it('nothing from the rest of the file appears in the extracted data', () => {
    const text = JSON.stringify(extractAuditInput(backup))
    for (const secret of ['SECRET', 'p1', '2026', 'Template name', '16', 'Obturation']) {
      expect(text).not.toContain(secret)
    }
  })

  it('also reads the cloud-document shape', () => {
    expect(
      extractAuditInput({
        savedTreatments: [{ phaseRecords: [{ name: 'Access' }] }],
        customTemplates: [{ phases: [{ name: 'Shaping' }] }],
      })
    ).toEqual({ savedPhaseNameLists: [['Access']], templatePhaseNameLists: [['Shaping']] })
  })

  it('is null for anything that is not a backup, and tolerant of odd entries', () => {
    expect(extractAuditInput(null)).toBeNull()
    expect(extractAuditInput('text')).toBeNull()
    expect(extractAuditInput([])).toBeNull()
    expect(extractAuditInput({ data: {} })).toBeNull()
    expect(
      extractAuditInput({
        data: {
          toothTargetSavedTreatments: [null, 5, { phaseRecords: 'x' }, { phaseRecords: [null, { name: 3 }, { name: 'Ok' }] }],
          toothTargetTemplates: [{ phases: null }],
        },
      })
    ).toEqual({ savedPhaseNameLists: [[], [], [], ['Ok']], templatePhaseNameLists: [[]] })
  })

})

describe('auditPhaseNames - section 1: same name written differently', () => {

  it('groups spellings that differ only by case / spacing / punctuation / "&" vs "and", with each spelling\'s uses', () => {
    const report = auditPhaseNames(
      input(
        [
          ...many(12, ['Access']),
          ...many(1, ['access']),
          ...many(5, ['Cleaning & Shaping']),
          ...many(2, ['Cleaning and Shaping']),
        ],
        [['Access']]
      )
    )
    expect(report.tier0).toHaveLength(2)
    const access = report.tier0.find(group => group.normalised === 'access')!
    expect(access.spellings).toEqual([
      { name: 'Access', savedCount: 12, templateCount: 1 },
      { name: 'access', savedCount: 1, templateCount: 0 },
    ])
    expect(access.name).toBe('Access')
    expect(access.savedCount).toBe(13)
    expect(report.tier0.map(group => group.normalised)).toEqual(['access', 'cleaning and shaping'])
  })

  it('a name with only one spelling is not a group', () => {
    expect(auditPhaseNames(input(many(3, ['Access', 'Shaping']))).tier0).toEqual([])
  })

  it('counts each treatment once per name, however often it repeats it', () => {
    const report = auditPhaseNames(input([['Access', 'Access', ' Access ']]))
    expect(report.distinctSpellings).toBe(1)
    expect(report.tier0).toEqual([])
  })

})

describe('auditPhaseNames - section 2: pairs the rules would flag', () => {

  it('lists the less-used spelling as typed and the more-used one as the suggestion', () => {
    const report = auditPhaseNames(input([...many(12, ['Access']), ...many(1, ['Acesss'])]))
    expect(report.flagged).toEqual([
      {
        tier: 1,
        distance: 2,
        typed: { name: 'Acesss', savedCount: 1, templateCount: 0 },
        suggestion: { name: 'Access', savedCount: 12, templateCount: 0 },
      },
    ])
  })

  it('uses the same plural rule as the live check: Access/Acces is flagged, Rinse/Rinses is suppressed', () => {
    const report = auditPhaseNames(
      input([
        ...many(10, ['Access', 'Rinse']),
        ...many(1, ['Acces', 'Rinses']),
      ])
    )
    expect(report.flagged).toEqual([
      {
        tier: 1,
        distance: 1,
        typed: { name: 'Acces', savedCount: 1, templateCount: 0 },
        suggestion: { name: 'Access', savedCount: 10, templateCount: 0 },
      },
    ])
    expect(report.suppressed).toHaveLength(1)
    expect(report.suppressed[0]).toMatchObject({ guard: 'plural-s' })
  })

  it('finds Tier 2 pairs too', () => {
    const report = auditPhaseNames(input([...many(8, ['Obturation']), ...many(2, ['Obturaton'])]))
    expect(report.flagged[0]).toMatchObject({ tier: 2, distance: 1 })
  })

  it('lists Tier 1 before Tier 2', () => {
    const report = auditPhaseNames(
      input([
        ...many(8, ['Obturation', 'Access']),
        ...many(2, ['Obturaton']),
        ...many(1, ['Acesss']),
      ])
    )
    expect(report.flagged.map(pair => pair.tier)).toEqual([1, 2])
  })

  it('template uses count towards which side is "more used"', () => {
    const report = auditPhaseNames(input([...many(1, ['Acesss'])], [['Access'], ['Access']]))
    expect(report.flagged[0].suggestion.name).toBe('Access')
  })

  it('does not report the same-name groups of section 1 again', () => {
    const report = auditPhaseNames(input([...many(4, ['Access']), ...many(1, ['access'])]))
    expect(report.flagged).toEqual([])
    expect(report.suppressed).toEqual([])
  })

})

describe('auditPhaseNames - section 3: close but suppressed', () => {

  it('lists pairs the guards stop, with the guard that did it', () => {
    const report = auditPhaseNames(
      input([
        ...many(5, ['Rinse', 'Coat 1', 'Seal', 'Isolation']),
        ...many(3, ['Rinses', 'Coat 2', 'Seat', 'Insulation']),
      ])
    )
    expect(report.suppressed.map(pair => pair.guard).sort()).toEqual(['digits', 'length', 'plural-s', 'short'])
    expect(report.flagged).toEqual([])
  })

  it('does not list names that are simply different', () => {
    const report = auditPhaseNames(input(many(3, ['Access', 'Obturation', 'Irrigation', 'Shaping'])))
    expect(report.suppressed).toEqual([])
    expect(report.flagged).toEqual([])
  })

})

describe('auditPhaseNames - general', () => {

  it('counts what it read', () => {
    const report = auditPhaseNames(input(many(4, ['Access']), [['Access'], ['Shaping']]))
    expect(report.treatmentsRead).toBe(4)
    expect(report.templatesRead).toBe(2)
    expect(report.distinctSpellings).toBe(2)
    expect(report.distinctNormalised).toBe(2)
  })

  it('an empty backup gives an empty report', () => {
    const report = auditPhaseNames(input([]))
    expect(report).toEqual({
      treatmentsRead: 0,
      templatesRead: 0,
      distinctSpellings: 0,
      distinctNormalised: 0,
      tier0: [],
      flagged: [],
      suppressed: [],
    })
  })

  it('does not change its input', () => {
    const data = input(many(2, ['Access', 'Acesss']), [['Access']])
    const before = JSON.stringify(data)
    auditPhaseNames(data)
    expect(JSON.stringify(data)).toBe(before)
  })

})

describe('formatAuditReport - what gets printed', () => {

  const report = auditPhaseNames(
    input(
      [
        ...many(12, ['Access', 'Rinse']),
        ...many(1, ['access', 'Acesss', 'Rinses']),
      ],
      [['Access']]
    )
  )

  const text = formatAuditReport(report).join('\n')

  it('has the three sections and the counts', () => {
    expect(text).toContain('1. SAME NAME, WRITTEN DIFFERENTLY')
    expect(text).toContain('2. WOULD BE FLAGGED')
    expect(text).toContain('3. CLOSE BUT SUPPRESSED BY A GUARD')
    expect(text).toContain('Read 13 saved treatments and 1 template.')
  })

  it('shows names with how often each is used', () => {
    expect(text).toContain('"Access" (used 12x, in 1 template)')
    expect(text).toContain('"access" (used 1x)')
    expect(text).toContain('typing "Acesss" (used 1x) would suggest "Access"')
    expect(text).toContain('[plural-s] "Rinses" (used 1x)  vs  "Rinse" (used 12x)')
  })

  it('says "none" for an empty section', () => {
    const empty = formatAuditReport(auditPhaseNames(input(many(3, ['Access'])))).join('\n')
    expect(empty).toContain('none')
  })

  it('cuts very long names so a stray note typed as a phase name is not printed in full', () => {
    const long = 'x'.repeat(200)
    const out = formatAuditReport(auditPhaseNames(input([[long], [long.slice(0, -1)]]))).join('\n')
    expect(out).not.toContain('x'.repeat(61))
    expect(out).toContain('…')
  })

  it('prints names as quoted text, so odd characters cannot break the layout', () => {
    const out = formatAuditReport(auditPhaseNames(input([['A\nB'], ['a\nb']]))).join('\n')
    expect(out).toContain('"A\\nB"')
  })

})
