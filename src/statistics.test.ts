import { describe, expect, it } from 'vitest'
import type {
  Patient,
  PhaseRecord,
  PhaseStatus,
  Procedure,
  ProcedureTemplate,
  SavedTreatment,
} from './App'
import {
  ALL_TREATMENTS_FILTER,
  applyStatisticsFilters,
  filterTreatmentsByCaseType,
  resolveToothSelection,
  resolveDateRangePreset,
  calculateAverageTreatmentTime,
  calculateFastestTreatment,
  calculateSlowestTreatment,
  calculateTreatmentStatistics,
  calculatePhaseStatistics,
  calculateProcedureStatistics,
  calculateProcedureFilterOptions,
  calculateOvertimeStatistics,
  calculateTimeLossInsights,
  calculateRctRegionStatistics,
  calculateTimeTrend,
  calculateAppointmentDurationEstimate,
  generatePersonalizedInsights,
  type StatisticsFilters,
} from './statistics'

/*
  Pure-calculation coverage for Phase 7's Statistics screen. statistics.ts
  is entirely React/DOM-free (see that file's own header comment), so
  every scenario the phase asks for - averages, fastest/slowest,
  overtime detection, filtering by procedure/tooth/tooth-category, and
  comparing across date ranges/months - is fully exercisable here
  against representative sample data, without needing this project's
  (nonexistent) React-rendering test harness. StatisticsScreen.tsx
  itself is a thin rendering of exactly these functions' results.
*/

const ACCESS = 'Access'
const WORKING_LENGTH = 'Working Length Determination'
const CLEANING_SHAPING = 'Cleaning and Shaping'
const OBTURATION = 'Obturation'
const RESTORATION = 'Restoration'

function phaseRecord(
  name: string,
  expectedDuration: number,
  actualDuration: number,
  skipped = false
): PhaseRecord {

  return {
    id: `${name}-record`,
    name,
    expectedDuration,
    actualDuration,
    startedAt: null,
    completedAt: null,
    status: (skipped ? 'skipped' : 'completed') as PhaseStatus,
    skipped,
    pausedWhileActive: false,
  }

}

/*
  Default phase set mirrors the five RCT phases named in the Phase 7
  spec (access, working length determination, cleaning and shaping,
  obturation, restoration) - Cleaning and Shaping runs 100s over its
  own target, every other phase is on or under, so tests that need "a
  phase with overtime" and "a phase without" already have both without
  extra setup.
*/
function defaultPhaseRecords(): PhaseRecord[] {
  return [
    phaseRecord(ACCESS, 300, 300),
    phaseRecord(WORKING_LENGTH, 180, 200),
    phaseRecord(CLEANING_SHAPING, 600, 700),
    phaseRecord(OBTURATION, 300, 300),
    phaseRecord(RESTORATION, 300, 250),
  ]
}

function makeTreatment(
  overrides: Partial<SavedTreatment> = {}
): SavedTreatment {

  const phaseRecords = overrides.phaseRecords ?? defaultPhaseRecords()

  const totalExpectedDuration =
    phaseRecords.reduce((total, record) => total + record.expectedDuration, 0)

  const totalActualDuration =
    phaseRecords.reduce((total, record) => total + record.actualDuration, 0)

  const totalOvertimeDuration =
    Math.max(0, totalActualDuration - totalExpectedDuration)

  return {
    id: 'treatment-1',
    patientName: 'Jane Doe',
    patientId: 'patient-1',
    toothId: '16',
    procedureName: 'Root Canal',
    procedureId: 'rct',
    templateName: 'Molar RCT',
    templateId: 'rct-molar',
    phases: phaseRecords.map(record => ({
      name: record.name,
      duration: record.expectedDuration,
    })),
    date: '2026-01-15T10:00:00.000Z',
    completed: true,
    phaseTimes: phaseRecords.map(record => record.expectedDuration),
    actualTimes: phaseRecords.map(record => record.actualDuration),
    phaseRecords,
    totalExpectedDuration,
    totalActualDuration,
    totalOvertimeDuration,
    events: [],
    tags: [],
    chairEnteredAt: null,
    chairLeftAt: null,
    currentPhaseIndex: phaseRecords.length - 1,
    startedAt: '2026-01-15T09:00:00.000Z',
    completedAt: '2026-01-15T10:00:00.000Z',
    updatedAt: '2026-01-15T10:00:00.000Z',
    ...overrides,
  }

}


describe('calculateAverageTreatmentTime / fastest / slowest', () => {

  it('averages totalActualDuration across every treatment given', () => {

    const treatments = [
      makeTreatment({ id: 't1', totalActualDuration: 1000 }),
      makeTreatment({ id: 't2', totalActualDuration: 2000 }),
      makeTreatment({ id: 't3', totalActualDuration: 3000 }),
    ]

    expect(calculateAverageTreatmentTime(treatments)).toBe(2000)

  })

  it('returns null for an empty list rather than NaN or 0', () => {
    expect(calculateAverageTreatmentTime([])).toBeNull()
  })

  it('picks the treatment with the smallest/largest totalActualDuration', () => {

    const fast = makeTreatment({ id: 'fast', totalActualDuration: 900 })
    const mid = makeTreatment({ id: 'mid', totalActualDuration: 1500 })
    const slow = makeTreatment({ id: 'slow', totalActualDuration: 2200 })

    const treatments = [mid, slow, fast]

    expect(calculateFastestTreatment(treatments)?.id).toBe('fast')
    expect(calculateSlowestTreatment(treatments)?.id).toBe('slow')

  })

  it('fastest/slowest are both null for an empty list', () => {
    expect(calculateFastestTreatment([])).toBeNull()
    expect(calculateSlowestTreatment([])).toBeNull()
  })

})


describe('calculateTreatmentStatistics - overall averages, overtime, fastest/slowest', () => {

  it('computes average target, average actual, average difference, average overtime, and percent within target', () => {

    const withinTarget = makeTreatment({
      id: 'on-time',
      patientName: 'Amy On Time',
      phaseRecords: [phaseRecord(ACCESS, 300, 300)],
    })

    const overTarget = makeTreatment({
      id: 'over',
      patientName: 'Bob Slow',
      phaseRecords: [phaseRecord(ACCESS, 300, 500)],
    })

    const stats = calculateTreatmentStatistics([withinTarget, overTarget])

    expect(stats.completedCount).toBe(2)
    expect(stats.averageExpectedDuration).toBe(300)
    expect(stats.averageActualDuration).toBe(400)
    expect(stats.averageDifferenceDuration).toBe(100)
    expect(stats.averageOvertimeDuration).toBe(100) // (0 + 200) / 2
    expect(stats.percentWithinTarget).toBe(50)
    expect(stats.fastestTreatment?.id).toBe('on-time')
    expect(stats.slowestTreatment?.id).toBe('over')

  })

  it('every field is null (not NaN/0) for an empty treatment list', () => {

    const stats = calculateTreatmentStatistics([])

    expect(stats).toEqual({
      completedCount: 0,
      averageActualDuration: null,
      averageExpectedDuration: null,
      averageDifferenceDuration: null,
      averageOvertimeDuration: null,
      percentWithinTarget: null,
      fastestTreatment: null,
      slowestTreatment: null,
    })

  })

})


describe('calculatePhaseStatistics - per-phase expected vs. actual', () => {

  it('averages expected/actual duration per phase name, grouped by procedure', () => {

    const t1 = makeTreatment({
      id: 't1',
      phaseRecords: [
        phaseRecord(ACCESS, 300, 300),
        phaseRecord(CLEANING_SHAPING, 600, 700),
      ],
    })

    const t2 = makeTreatment({
      id: 't2',
      phaseRecords: [
        phaseRecord(ACCESS, 300, 340),
        phaseRecord(CLEANING_SHAPING, 600, 660),
      ],
    })

    const stats = calculatePhaseStatistics([t1, t2])

    const access = stats.find(s => s.phaseName === ACCESS)
    const cleaning = stats.find(s => s.phaseName === CLEANING_SHAPING)

    expect(access).toMatchObject({
      sampleSize: 2,
      averageExpectedDuration: 300,
      averageActualDuration: 320,
      averageDifference: 20,
    })

    expect(cleaning).toMatchObject({
      sampleSize: 2,
      averageExpectedDuration: 600,
      averageActualDuration: 680,
      averageDifference: 80,
    })

  })

  it('excludes skipped phase records entirely (they never happened)', () => {

    const treatment = makeTreatment({
      phaseRecords: [
        phaseRecord(ACCESS, 300, 300),
        phaseRecord(OBTURATION, 300, 0, true), // skipped
      ],
    })

    const stats = calculatePhaseStatistics([treatment])

    expect(stats.find(s => s.phaseName === OBTURATION)).toBeUndefined()
    expect(stats.find(s => s.phaseName === ACCESS)).toBeDefined()

  })

  it('keeps same-named phases from different procedures separate', () => {

    const rct = makeTreatment({
      id: 'rct',
      procedureId: 'rct',
      procedureName: 'Root Canal',
      phaseRecords: [phaseRecord('Prep', 200, 200)],
    })

    const filling = makeTreatment({
      id: 'filling',
      procedureId: 'filling',
      procedureName: 'Filling',
      phaseRecords: [phaseRecord('Prep', 100, 400)],
    })

    const stats = calculatePhaseStatistics([rct, filling])

    const prepStats = stats.filter(s => s.phaseName === 'Prep')

    expect(prepStats).toHaveLength(2)
    expect(
      prepStats.find(s => s.procedureId === 'rct')?.averageActualDuration
    ).toBe(200)
    expect(
      prepStats.find(s => s.procedureId === 'filling')?.averageActualDuration
    ).toBe(400)

  })

})


describe('calculateTimeLossInsights - overtime patterns, "where am I losing time"', () => {

  it('keeps only phases averaging over target, worst offender first', () => {

    const treatments = [
      makeTreatment({
        id: 't1',
        phaseRecords: [
          phaseRecord(ACCESS, 300, 300), // on target
          phaseRecord(CLEANING_SHAPING, 600, 750), // +150 over
          phaseRecord(OBTURATION, 300, 340), // +40 over
        ],
      }),
      makeTreatment({
        id: 't2',
        phaseRecords: [
          phaseRecord(ACCESS, 300, 290),
          phaseRecord(CLEANING_SHAPING, 600, 780),
          phaseRecord(OBTURATION, 300, 320),
        ],
      }),
      makeTreatment({
        id: 't3',
        phaseRecords: [
          phaseRecord(ACCESS, 300, 300),
          phaseRecord(CLEANING_SHAPING, 600, 690),
          phaseRecord(OBTURATION, 300, 310),
        ],
      }),
    ]

    const insights = calculateTimeLossInsights(treatments)

    expect(insights.map(i => i.phaseName)).toEqual([
      CLEANING_SHAPING,
      OBTURATION,
    ])

    // Cleaning and Shaping should be the worst offender (largest avg diff)
    expect(insights[0].phaseName).toBe(CLEANING_SHAPING)
    expect(insights[0].averageDifference).toBeGreaterThan(
      insights[1].averageDifference
    )

  })

  it('respects the minimum sample size - a phase with too few samples is excluded even if it runs over', () => {

    const treatments = [
      makeTreatment({
        id: 't1',
        phaseRecords: [phaseRecord(ACCESS, 300, 900)], // way over, but n=1
      }),
    ]

    expect(calculateTimeLossInsights(treatments, 3)).toEqual([])
    expect(calculateTimeLossInsights(treatments, 1)).toHaveLength(1)

  })

})


describe('calculateOvertimeStatistics - overall and by-procedure/by-phase overtime', () => {

  it('computes percent-with-overtime and average overtime overall', () => {

    const onTime = makeTreatment({
      id: 'on-time',
      phaseRecords: [phaseRecord(ACCESS, 300, 300)],
    })

    const over = makeTreatment({
      id: 'over',
      phaseRecords: [phaseRecord(ACCESS, 300, 500)],
    })

    const stats = calculateOvertimeStatistics([onTime, over])

    expect(stats.percentWithOvertime).toBe(50)
    expect(stats.averageOvertimeDuration).toBe(100) // (0 + 200) / 2
    expect(stats.largestOvertimeDuration).toBe(200)
    expect(stats.largestOvertimeTreatment?.id).toBe('over')

  })

  it('breaks overtime down by phase, worst average overtime first', () => {

    const treatment = makeTreatment({
      phaseRecords: [
        phaseRecord(ACCESS, 300, 300), // 0 overtime
        phaseRecord(CLEANING_SHAPING, 600, 750), // 150 overtime
        phaseRecord(OBTURATION, 300, 320), // 20 overtime
      ],
    })

    const stats = calculateOvertimeStatistics([treatment])

    expect(stats.byPhase[0].phaseName).toBe(CLEANING_SHAPING)
    expect(stats.byPhase[0].averageOvertimeDuration).toBe(150)

    const obturation = stats.byPhase.find(s => s.phaseName === OBTURATION)
    expect(obturation?.averageOvertimeDuration).toBe(20)

  })

  it('returns 0%/0s (not null/NaN) for an empty treatment list within byProcedure, and null for the overall figures', () => {

    const stats = calculateOvertimeStatistics([])

    expect(stats.percentWithOvertime).toBeNull()
    expect(stats.averageOvertimeDuration).toBeNull()
    expect(stats.largestOvertimeDuration).toBeNull()
    expect(stats.byProcedure).toEqual([])
    expect(stats.byPhase).toEqual([])

  })

})


function makePatient(overrides: Partial<Patient> = {}): Patient {

  return {
    id: 'patient-1',
    patientNumber: 1,
    name: 'Jane Doe',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }

}

describe('filterTreatmentsByCaseType - Phase 3 (Clinical/Practice)', () => {

  const clinicalPatient = makePatient({
    id: 'patient-clinical',
    caseType: 'Clinical',
  })

  const practicePatient = makePatient({
    id: 'patient-practice',
    caseType: 'Practice',
  })

  const legacyPatient = makePatient({
    id: 'patient-legacy',
    // No caseType at all - predates this field.
  })

  const patients = [clinicalPatient, practicePatient, legacyPatient]

  const clinicalTreatment = makeTreatment({
    id: 'clinical-treatment',
    patientId: clinicalPatient.id,
  })

  const practiceTreatment = makeTreatment({
    id: 'practice-treatment',
    patientId: practicePatient.id,
  })

  const legacyTreatment = makeTreatment({
    id: 'legacy-treatment',
    patientId: legacyPatient.id,
  })

  const orphanedTreatment = makeTreatment({
    id: 'orphaned-treatment',
    patientId: 'patient-deleted-long-ago',
  })

  const all = [
    clinicalTreatment,
    practiceTreatment,
    legacyTreatment,
    orphanedTreatment,
  ]

  it('"both" returns every treatment unfiltered', () => {
    expect(filterTreatmentsByCaseType(all, patients, 'both')).toEqual(all)
  })

  it('"clinical" keeps only treatments whose patient is Clinical, treating a patient missing caseType (or missing entirely) as Clinical', () => {

    const result = filterTreatmentsByCaseType(all, patients, 'clinical')

    expect(result.map(t => t.id).sort()).toEqual([
      'clinical-treatment',
      'legacy-treatment',
      'orphaned-treatment',
    ])

  })

  it('"practice" keeps only treatments whose patient is explicitly Practice', () => {

    const result = filterTreatmentsByCaseType(all, patients, 'practice')

    expect(result.map(t => t.id)).toEqual(['practice-treatment'])

  })

  it('a treatment whose patientId no longer resolves to any known patient defaults to Clinical, same as a missing caseType', () => {

    const result = filterTreatmentsByCaseType(
      [orphanedTreatment],
      patients,
      'clinical'
    )

    expect(result).toEqual([orphanedTreatment])

    expect(
      filterTreatmentsByCaseType([orphanedTreatment], patients, 'practice')
    ).toEqual([])

  })

})


describe('applyStatisticsFilters - procedure / tooth / tooth-category / date filtering', () => {

  const molarRct = makeTreatment({
    id: 'molar-rct',
    procedureId: 'rct',
    toothId: '16', // upper right molar (FDI) - "UR6" in the app's old display naming
    date: '2026-01-10T00:00:00.000Z',
  })

  const premolarFilling = makeTreatment({
    id: 'premolar-filling',
    procedureId: 'filling',
    procedureName: 'Filling',
    toothId: '15', // upper right premolar ("UR5")
    date: '2026-02-05T00:00:00.000Z',
  })

  const anteriorRct = makeTreatment({
    id: 'anterior-rct',
    procedureId: 'rct',
    toothId: '11', // upper right anterior ("UR1")
    date: '2026-02-20T00:00:00.000Z',
  })

  const all = [molarRct, premolarFilling, anteriorRct]

  it('ALL_TREATMENTS_FILTER matches everything unfiltered', () => {
    expect(applyStatisticsFilters(all, ALL_TREATMENTS_FILTER)).toEqual(all)
  })

  it('filters by a single procedure', () => {

    const filters: StatisticsFilters = {
      ...ALL_TREATMENTS_FILTER,
      procedureIds: ['rct'],
    }

    const result = applyStatisticsFilters(all, filters)

    expect(result.map(t => t.id).sort()).toEqual(['anterior-rct', 'molar-rct'])

  })

  it('filters by specific tooth (toothIds is an OR list within the dimension)', () => {

    const filters: StatisticsFilters = {
      ...ALL_TREATMENTS_FILTER,
      toothIds: ['16', '15'],
    }

    const result = applyStatisticsFilters(all, filters)

    expect(result.map(t => t.id).sort()).toEqual([
      'molar-rct',
      'premolar-filling',
    ])

  })

  it('filters by tooth CATEGORY via resolveToothSelection + TOOTH_GROUPS (molars vs. premolars)', () => {

    // resolveToothSelection turns UI-level tooth-group picks into the
    // concrete toothIds applyStatisticsFilters actually matches on -
    // this is the "tooth category" filter dimension from the spec.
    const molarToothIds = resolveToothSelection(
      [{ id: 'all-molars', label: 'All Molars', arch: 'any', region: 'molar' }],
      []
    )

    expect(molarToothIds).toContain('16')
    expect(molarToothIds).not.toContain('15')

    const filters: StatisticsFilters = {
      ...ALL_TREATMENTS_FILTER,
      toothIds: molarToothIds,
    }

    const result = applyStatisticsFilters(all, filters)

    expect(result.map(t => t.id)).toEqual(['molar-rct'])

  })

  it('resolveToothSelection combines groups + individually picked teeth, deduplicated, and returns null when nothing is selected', () => {

    expect(resolveToothSelection([], [])).toBeNull()

    const combined = resolveToothSelection(
      [{ id: 'all-molars', label: 'All Molars', arch: 'any', region: 'molar' }],
      ['16', '15'] // UR6 already in the molar group - should not duplicate
    )

    expect(combined).not.toBeNull()
    expect(combined!.filter(id => id === '16')).toHaveLength(1)
    expect(combined).toContain('15')

  })

  it('filters by date range, inclusive of both endpoints', () => {

    const filters: StatisticsFilters = {
      ...ALL_TREATMENTS_FILTER,
      dateRange: {
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-02-28T23:59:59.999Z',
      },
    }

    const result = applyStatisticsFilters(all, filters)

    expect(result.map(t => t.id).sort()).toEqual([
      'anterior-rct',
      'premolar-filling',
    ])

  })

  it('combines dimensions with AND - procedure AND tooth AND date must all match', () => {

    const filters: StatisticsFilters = {
      procedureIds: ['rct'],
      templateIds: null,
      toothIds: ['11'],
      dateRange: {
        from: '2026-02-01T00:00:00.000Z',
        to: '2026-02-28T23:59:59.999Z',
      },
    }

    // molar-rct matches procedure+date but not tooth; anterior-rct
    // matches all three.
    expect(applyStatisticsFilters(all, filters).map(t => t.id)).toEqual([
      'anterior-rct',
    ])

  })

  it('filters by template', () => {

    const templated = makeTreatment({
      id: 'templated',
      templateId: 'special-template',
    })

    const filters: StatisticsFilters = {
      ...ALL_TREATMENTS_FILTER,
      templateIds: ['special-template'],
    }

    expect(
      applyStatisticsFilters([...all, templated], filters).map(t => t.id)
    ).toEqual(['templated'])

  })

})


describe('resolveDateRangePreset - month/period comparison support', () => {

  /*
    resolveDateRangePreset() builds its start/end from LOCAL date
    components (setHours/setDate/setMonth - see that function), so
    "now" is constructed the same way here (year, month, day - not an
    ISO/UTC string) and every assertion below reads local components
    back (getDate()/getMonth()/getFullYear()) - this keeps the whole
    test timezone-independent, since input and assertions never cross
    the UTC/local boundary the function itself doesn't cross either.

    Fixed "now": Wednesday, 2026-03-18 (mid-week, mid-month) so
    thisWeek/thisMonth boundaries are unambiguous.
  */
  const now = new Date(2026, 2, 18, 15, 30) // March 18, 2026, local time

  it('allTime has no range (null) - the "no restriction" convention every filter dimension uses', () => {
    expect(resolveDateRangePreset('allTime', null, now)).toBeNull()
  })

  it('today spans just the current calendar day', () => {

    const range = resolveDateRangePreset('today', null, now)

    expect(range).not.toBeNull()
    expect(new Date(range!.from).getDate()).toBe(18)
    expect(new Date(range!.to).getDate()).toBe(18)

  })

  it('thisMonth starts on the 1st of the current month', () => {

    const range = resolveDateRangePreset('thisMonth', null, now)

    expect(new Date(range!.from).getDate()).toBe(1)
    expect(new Date(range!.from).getMonth()).toBe(2) // March (0-indexed)

  })

  it('lastMonth covers the ENTIRE previous calendar month, not a 30-day lookback', () => {

    const range = resolveDateRangePreset('lastMonth', null, now)

    expect(range).not.toBeNull()

    const from = new Date(range!.from)
    const to = new Date(range!.to)

    expect(from.getMonth()).toBe(1) // February
    expect(from.getDate()).toBe(1)
    expect(to.getMonth()).toBe(1) // still February
    expect(to.getDate()).toBe(28) // 2026 is not a leap year

    // And must not include any day from the current month (March).
    expect(to.getTime()).toBeLessThan(new Date(2026, 2, 1).getTime())

  })

  it('lastMonth correctly crosses a year boundary (January "now" -> December last year)', () => {

    const januaryNow = new Date(2026, 0, 15, 12, 0)

    const range = resolveDateRangePreset('lastMonth', null, januaryNow)

    const from = new Date(range!.from)
    const to = new Date(range!.to)

    expect(from.getFullYear()).toBe(2025)
    expect(from.getMonth()).toBe(11) // December
    expect(to.getFullYear()).toBe(2025)
    expect(to.getMonth()).toBe(11)

  })

  it('thisMonth and lastMonth never overlap - a treatment can only fall in one', () => {

    const thisMonthRange = resolveDateRangePreset('thisMonth', null, now)!
    const lastMonthRange = resolveDateRangePreset('lastMonth', null, now)!

    expect(new Date(lastMonthRange.to).getTime()).toBeLessThan(
      new Date(thisMonthRange.from).getTime()
    )

  })

  it('custom returns exactly the given range unchanged', () => {

    const custom = { from: '2026-05-01T00:00:00.000Z', to: '2026-05-31T23:59:59.999Z' }

    expect(resolveDateRangePreset('custom', custom, now)).toEqual(custom)
    expect(resolveDateRangePreset('custom', null, now)).toBeNull()

  })

})


describe('comparing performance across two different time periods (month vs. month)', () => {

  it('applying "this month" and "last month" filters to the same data set yields two independent, correct statistics groups', () => {

    // now = mid-March 2026, local time (see resolveDateRangePreset's
    // own tests above for why "now" is built from local components).
    const now = new Date(2026, 2, 18, 12, 0)

    // Treatment dates sit comfortably mid-month (not near a month
    // boundary), so which bucket each falls into is unambiguous in
    // any reasonable timezone.
    const marchTreatment1 = makeTreatment({
      id: 'march-1',
      date: '2026-03-15T12:00:00.000Z',
      totalActualDuration: 1000,
    })

    const marchTreatment2 = makeTreatment({
      id: 'march-2',
      date: '2026-03-16T12:00:00.000Z',
      totalActualDuration: 2000,
    })

    const februaryTreatment = makeTreatment({
      id: 'feb-1',
      date: '2026-02-15T12:00:00.000Z',
      totalActualDuration: 5000,
    })

    const treatments = [marchTreatment1, marchTreatment2, februaryTreatment]

    const thisMonthFilters: StatisticsFilters = {
      ...ALL_TREATMENTS_FILTER,
      dateRange: resolveDateRangePreset('thisMonth', null, now),
    }

    const lastMonthFilters: StatisticsFilters = {
      ...ALL_TREATMENTS_FILTER,
      dateRange: resolveDateRangePreset('lastMonth', null, now),
    }

    const thisMonthStats = calculateTreatmentStatistics(
      applyStatisticsFilters(treatments, thisMonthFilters)
    )

    const lastMonthStats = calculateTreatmentStatistics(
      applyStatisticsFilters(treatments, lastMonthFilters)
    )

    expect(thisMonthStats.completedCount).toBe(2)
    expect(thisMonthStats.averageActualDuration).toBe(1500)

    expect(lastMonthStats.completedCount).toBe(1)
    expect(lastMonthStats.averageActualDuration).toBe(5000)

    // The two groups must be a true partition here - nothing counted twice.
    expect(thisMonthStats.completedCount + lastMonthStats.completedCount).toBe(
      treatments.length
    )

  })

})


describe('calculateProcedureStatistics', () => {

  it('groups by procedure and averages both target and actual duration', () => {

    const stats = calculateProcedureStatistics([
      makeTreatment({ id: 't1', procedureId: 'rct', totalExpectedDuration: 1680, totalActualDuration: 1850 }),
      makeTreatment({ id: 't2', procedureId: 'rct', totalExpectedDuration: 1680, totalActualDuration: 1750 }),
    ])

    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({
      procedureId: 'rct',
      treatmentCount: 2,
      averageExpectedDuration: 1680,
      averageActualDuration: 1800,
    })

  })

})


describe('calculateProcedureFilterOptions', () => {

  /*
    Regression coverage for the "delete and recreate a procedure with
    the same name produces two indistinguishable filter buttons" bug -
    calculateProcedureStatistics() (above) is still id-keyed so a
    rename alone never merges anything, but the filter picker built
    from calculateProcedureFilterOptions() must treat every id that
    has ever shared a name as one selectable option covering all of
    them.
  */

  it('merges two different ids sharing the same procedure name into one option', () => {

    const options = calculateProcedureFilterOptions([
      makeTreatment({ id: 't1', procedureId: 'rct-old', procedureName: 'RCT' }),
      makeTreatment({ id: 't2', procedureId: 'rct-new', procedureName: 'RCT' }),
    ])

    expect(options).toHaveLength(1)
    expect(options[0].procedureName).toBe('RCT')
    expect(options[0].procedureIds.sort()).toEqual(['rct-new', 'rct-old'])
    expect(options[0].treatmentCount).toBe(2)

  })

  it('matches procedure names ignoring case and leading/trailing whitespace', () => {

    const options = calculateProcedureFilterOptions([
      makeTreatment({ id: 't1', procedureId: 'rct-old', procedureName: 'RCT' }),
      makeTreatment({ id: 't2', procedureId: 'rct-new', procedureName: '  rct  ' }),
      makeTreatment({ id: 't3', procedureId: 'filling', procedureName: 'Filling' }),
    ])

    expect(options).toHaveLength(2)

    const rctOption = options.find(option => option.procedureIds.includes('rct-old'))
    expect(rctOption?.procedureIds.sort()).toEqual(['rct-new', 'rct-old'])
    expect(rctOption?.treatmentCount).toBe(2)

  })

  it('leaves a procedure that has only ever had one id behaving exactly as before', () => {

    const options = calculateProcedureFilterOptions([
      makeTreatment({ id: 't1', procedureId: 'filling', procedureName: 'Filling' }),
      makeTreatment({ id: 't2', procedureId: 'filling', procedureName: 'Filling' }),
    ])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      procedureName: 'Filling',
      procedureIds: ['filling'],
      treatmentCount: 2,
    })

  })

  it('selecting a merged option\'s ids via the existing id-list filter includes treatments from every id that shares the name', () => {

    const treatments = [
      makeTreatment({ id: 't1', procedureId: 'rct-old', procedureName: 'RCT' }),
      makeTreatment({ id: 't2', procedureId: 'rct-new', procedureName: 'RCT' }),
      makeTreatment({ id: 't3', procedureId: 'filling', procedureName: 'Filling' }),
    ]

    const options = calculateProcedureFilterOptions(treatments)
    const rctOption = options.find(option => option.procedureName === 'RCT')

    const filtered = applyStatisticsFilters(treatments, {
      ...ALL_TREATMENTS_FILTER,
      procedureIds: rctOption?.procedureIds ?? [],
    })

    expect(filtered.map(t => t.id).sort()).toEqual(['t1', 't2'])

  })

})


describe('calculateTimeTrend', () => {

  it('sorts chronologically oldest to newest regardless of input order', () => {

    const trend = calculateTimeTrend([
      makeTreatment({ id: 'later', date: '2026-03-01T00:00:00.000Z' }),
      makeTreatment({ id: 'earliest', date: '2026-01-01T00:00:00.000Z' }),
      makeTreatment({ id: 'middle', date: '2026-02-01T00:00:00.000Z' }),
    ])

    expect(trend.map(point => point.treatmentId)).toEqual([
      'earliest',
      'middle',
      'later',
    ])

  })

})


describe('calculateRctRegionStatistics', () => {

  it('groups by region template, only for the RCT-style procedure that declares regionTemplateIds', () => {

    const procedures: Procedure[] = [
      {
        id: 'rct',
        name: 'Root Canal',
        isCustom: false,
        templateId: 'rct-default',
        regionTemplateIds: {
          anterior: 'rct-anterior',
          premolar: 'rct-premolar',
          molar: 'rct-molar',
        },
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'filling',
        name: 'Filling',
        isCustom: false,
        templateId: 'filling-default',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]

    const treatments = [
      makeTreatment({
        id: 't1',
        procedureId: 'rct',
        templateId: 'rct-molar',
        templateName: 'Molar RCT',
        totalActualDuration: 1800,
      }),
      makeTreatment({
        id: 't2',
        procedureId: 'rct',
        templateId: 'rct-molar',
        templateName: 'Molar RCT',
        totalActualDuration: 2000,
      }),
      makeTreatment({
        id: 't3',
        procedureId: 'filling', // not RCT - excluded
        templateId: 'rct-molar',
      }),
    ]

    const stats = calculateRctRegionStatistics(treatments, procedures)

    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({
      templateId: 'rct-molar',
      treatmentCount: 2,
      averageActualDuration: 1900,
    })

  })

  it('returns an empty list when no procedure declares regionTemplateIds', () => {

    const procedures: Procedure[] = [
      { id: 'filling', name: 'Filling', isCustom: false, templateId: 'filling-default', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]

    expect(calculateRctRegionStatistics([makeTreatment()], procedures)).toEqual([])

  })

})


describe('generatePersonalizedInsights', () => {

  const templates: ProcedureTemplate[] = [
    {
      id: 'rct-molar',
      name: 'Molar RCT',
      isCustom: false,
      phases: [{ name: ACCESS, duration: 300 }, { name: CLEANING_SHAPING, duration: 600 }],
      specializationId: 'endo',
      procedureKey: 'rct',
      typeId: 'molar',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]

  it('flags a template running meaningfully longer than its current target, with a plain-language message', () => {

    const treatments = [
      makeTreatment({ id: 't1', templateId: 'rct-molar', totalActualDuration: 1200 }),
      makeTreatment({ id: 't2', templateId: 'rct-molar', totalActualDuration: 1300 }),
      makeTreatment({ id: 't3', templateId: 'rct-molar', totalActualDuration: 1250 }),
    ]

    const insights = generatePersonalizedInsights(treatments, templates)

    expect(insights).toHaveLength(1)
    expect(insights[0].templateName).toBe('Molar RCT')
    expect(insights[0].percentDifference).toBeGreaterThan(0)
    expect(insights[0].message).toContain('longer')

  })

  it('requires the minimum sample size before drawing a conclusion', () => {

    const treatments = [
      makeTreatment({ id: 't1', templateId: 'rct-molar', totalActualDuration: 5000 }),
    ]

    expect(generatePersonalizedInsights(treatments, templates, 3)).toEqual([])

  })

  it('skips templates that no longer exist (deleted since those treatments happened)', () => {

    const treatments = [
      makeTreatment({ id: 't1', templateId: 'deleted-template', totalActualDuration: 1000 }),
      makeTreatment({ id: 't2', templateId: 'deleted-template', totalActualDuration: 1100 }),
      makeTreatment({ id: 't3', templateId: 'deleted-template', totalActualDuration: 1050 }),
    ]

    expect(generatePersonalizedInsights(treatments, templates)).toEqual([])

  })

})


describe('calculateAppointmentDurationEstimate', () => {

  it('returns typical/min/max duration once the minimum sample size is met', () => {

    const treatments = [
      makeTreatment({ id: 't1', toothId: '16', procedureId: 'rct', totalActualDuration: 1600 }),
      makeTreatment({ id: 't2', toothId: '16', procedureId: 'rct', totalActualDuration: 2000 }),
      makeTreatment({ id: 't3', toothId: '16', procedureId: 'rct', totalActualDuration: 1800 }),
    ]

    const estimate = calculateAppointmentDurationEstimate(treatments, '16', 'rct')

    expect(estimate).toEqual({
      sampleSize: 3,
      typicalDuration: 1800,
      minDuration: 1600,
      maxDuration: 2000,
    })

  })

  it('returns null below the minimum sample size', () => {

    const treatments = [
      makeTreatment({ id: 't1', toothId: '16', procedureId: 'rct' }),
    ]

    expect(calculateAppointmentDurationEstimate(treatments, '16', 'rct')).toBeNull()

  })

})

describe('applyStatisticsFilters - checked treatments (treatmentIds)', () => {

  function timed(
    id: string,
    overrides: Partial<SavedTreatment>,
    actualSeconds: number[]
  ): SavedTreatment {
    const names = [ACCESS, CLEANING_SHAPING, OBTURATION]
    return makeTreatment({
      id,
      phaseRecords: names.map((name, index) =>
        phaseRecord(name, 300, actualSeconds[index])
      ),
      ...overrides,
    })
  }

  const t1 = timed('t1', { toothId: '16', procedureId: 'rct', procedureName: 'RCT', templateId: 'rct-molar', date: '2026-01-10T10:00:00.000Z' }, [250, 400, 280])
  const t2 = timed('t2', { toothId: '26', procedureId: 'rct', procedureName: 'RCT', templateId: 'rct-molar', date: '2026-01-20T10:00:00.000Z' }, [320, 520, 410])
  const t3 = timed('t3', { toothId: '36', procedureId: 'rct', procedureName: 'RCT', templateId: 'rct-molar', date: '2026-02-03T10:00:00.000Z' }, [200, 300, 250])
  const t4 = timed('t4', { toothId: '24', procedureId: 'filling', procedureName: 'Filling', templateId: 'class-ii', date: '2026-02-10T10:00:00.000Z' }, [100, 200, 150])
  const t5 = timed('t5', { toothId: '11', procedureId: 'filling', procedureName: 'Filling', templateId: 'class-iii', date: '2026-03-01T10:00:00.000Z' }, [90, 180, 120])
  const all = [t1, t2, t3, t4, t5]

  it('keeps exactly the checked treatments, in their original order', () => {

    const result = applyStatisticsFilters(all, {
      ...ALL_TREATMENTS_FILTER,
      treatmentIds: ['t4', 't1', 't3'],
    })

    expect(result.map(t => t.id)).toEqual(['t1', 't3', 't4'])

  })

  it('null or missing means unrestricted; an empty list means nothing is checked', () => {

    expect(
      applyStatisticsFilters(all, { ...ALL_TREATMENTS_FILTER, treatmentIds: null })
    ).toEqual(all)

    expect(applyStatisticsFilters(all, ALL_TREATMENTS_FILTER)).toEqual(all)

    expect(
      applyStatisticsFilters(all, { ...ALL_TREATMENTS_FILTER, treatmentIds: [] })
    ).toEqual([])

  })

  it('ids with no matching treatment (eg. deleted ones) are ignored without error', () => {

    const result = applyStatisticsFilters(all, {
      ...ALL_TREATMENTS_FILTER,
      treatmentIds: ['t2', 'deleted-treatment', 'never-existed'],
    })

    expect(result.map(t => t.id)).toEqual(['t2'])

  })

  it('still ANDs with the other filters when both are given', () => {

    const result = applyStatisticsFilters(all, {
      ...ALL_TREATMENTS_FILTER,
      treatmentIds: ['t1', 't2', 't4'],
      procedureIds: ['rct'],
    })

    expect(result.map(t => t.id)).toEqual(['t1', 't2'])

  })

  it('a checked list gives EXACTLY the same numbers as filtering the same list another way', () => {

    // The same three RCT molars, selected two other ways:
    //   (a) a plain id filter done by hand
    //   (b) the existing preset filters (procedure + tooth + date range)
    const checked = applyStatisticsFilters(all, {
      ...ALL_TREATMENTS_FILTER,
      treatmentIds: ['t1', 't2', 't3'],
    })

    const byHand = all.filter(t => ['t1', 't2', 't3'].includes(t.id))

    const byPresets = applyStatisticsFilters(all, {
      procedureIds: ['rct'],
      templateIds: ['rct-molar'],
      toothIds: ['16', '26', '36'],
      dateRange: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-28T23:59:59.999Z',
      },
    })

    expect(checked).toEqual(byHand)
    expect(checked).toEqual(byPresets)

    // Every calculation the screen runs on its filtered list gives the
    // identical answer, whichever way the list was produced.
    for (const other of [byHand, byPresets]) {
      expect(calculateTreatmentStatistics(checked)).toEqual(calculateTreatmentStatistics(other))
      expect(calculateProcedureStatistics(checked)).toEqual(calculateProcedureStatistics(other))
      expect(calculatePhaseStatistics(checked)).toEqual(calculatePhaseStatistics(other))
      expect(calculateTimeLossInsights(checked, 1)).toEqual(calculateTimeLossInsights(other, 1))
      expect(calculateOvertimeStatistics(checked)).toEqual(calculateOvertimeStatistics(other))
      expect(calculateTimeTrend(checked)).toEqual(calculateTimeTrend(other))
    }

    // And the figures themselves are the expected ones for those three.
    const stats = calculateTreatmentStatistics(checked)
    expect(stats.completedCount).toBe(3)
    expect(stats.averageActualDuration).toBeCloseTo((930 + 1250 + 750) / 3)
    expect(stats.fastestTreatment?.id).toBe('t3')
    expect(stats.slowestTreatment?.id).toBe('t2')

  })

})
