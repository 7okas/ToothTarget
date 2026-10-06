import { describe, expect, it } from 'vitest'

/*
  Months are LOCAL calendar months; pinned to Egypt time so a treatment
  finished just after local midnight on the 1st is tested against a real
  UTC offset (Africa/Cairo: UTC+2 winter, UTC+3 summer). Set before any
  Date is created.
*/
// (This project has no Node type definitions, hence the cast.)
;(globalThis as unknown as { process: { env: Record<string, string> } })
  .process.env.TZ = 'Africa/Cairo'

import type { SavedTreatment } from './App'
import {
  ALL_TREATMENTS_FILTER,
  MIN_SAMPLE_SIZE,
  calculateMonthlyStatistics,
  calculateTreatmentStatistics,
  applyStatisticsFilters,
} from './statistics'

function make(
  id: string,
  date: string,
  actual: number,
  expected = 1000,
  extra: Partial<SavedTreatment> = {}
): SavedTreatment {
  return {
    id,
    date,
    procedureId: 'rct',
    templateId: 'rct-molar',
    toothId: '16',
    totalActualDuration: actual,
    totalExpectedDuration: expected,
    totalOvertimeDuration: Math.max(0, actual - expected),
    ...extra,
  } as unknown as SavedTreatment
}

// "Now" is mid-June 2026, local.
const NOW = new Date(2026, 5, 15, 12, 0, 0)

describe('calculateMonthlyStatistics - spans', () => {

  const sample = [
    make('jan', '2026-01-10T10:00:00.000Z', 900),
    make('mar', '2026-03-10T10:00:00.000Z', 1100),
    make('jun', '2026-06-01T10:00:00.000Z', 1000),
  ]

  it('MIN_SAMPLE_SIZE is the one shared threshold, 3', () => {
    expect(MIN_SAMPLE_SIZE).toBe(3)
  })

  it('last 6 months: exactly six rows ending with the current month, empty months included, oldest first', () => {
    const rows = calculateMonthlyStatistics(sample, ALL_TREATMENTS_FILTER, 'last6', NOW)
    expect(rows.map(row => row.key)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    ])
    expect(rows.map(row => row.treatmentCount)).toEqual([1, 0, 1, 0, 0, 1])
  })

  it('last 12 months: twelve rows, crossing the year boundary', () => {
    const rows = calculateMonthlyStatistics(sample, ALL_TREATMENTS_FILTER, 'last12', NOW)
    expect(rows).toHaveLength(12)
    expect(rows[0].key).toBe('2025-07')
    expect(rows[11].key).toBe('2026-06')
    expect(rows[5]).toMatchObject({ key: '2025-12', year: 2025, month: 12 })
    expect(rows[6]).toMatchObject({ key: '2026-01', year: 2026, month: 1 })
  })

  it('last 6 months ignores treatments older than the window', () => {
    const rows = calculateMonthlyStatistics(
      [...sample, make('old', '2025-01-10T10:00:00.000Z', 500)],
      ALL_TREATMENTS_FILTER,
      'last6',
      NOW
    )
    expect(rows.reduce((total, row) => total + row.treatmentCount, 0)).toBe(3)
  })

  it('a window that crosses a year end counts December of the previous year', () => {
    const rows = calculateMonthlyStatistics(
      [make('dec', '2025-12-10T10:00:00.000Z', 1000)],
      ALL_TREATMENTS_FILTER,
      'last6',
      new Date(2026, 1, 10)
    )
    expect(rows.map(row => row.key)).toEqual([
      '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
    ])
    expect(rows[3].treatmentCount).toBe(1)
  })

  it('all: from the earliest treatment month to the latest, gaps included', () => {
    const rows = calculateMonthlyStatistics(sample, ALL_TREATMENTS_FILTER, 'all', NOW)
    expect(rows.map(row => row.key)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    ])
  })

  it('all: ends at the latest treatment month, not at today', () => {
    const rows = calculateMonthlyStatistics(
      [make('a', '2025-03-10T10:00:00.000Z', 1000), make('b', '2025-05-10T10:00:00.000Z', 1000)],
      ALL_TREATMENTS_FILTER,
      'all',
      NOW
    )
    expect(rows.map(row => row.key)).toEqual(['2025-03', '2025-04', '2025-05'])
  })

  it('all: no treatments means no rows; last6/last12 with none still list empty months', () => {
    expect(calculateMonthlyStatistics([], ALL_TREATMENTS_FILTER, 'all', NOW)).toEqual([])
    const rows = calculateMonthlyStatistics([], ALL_TREATMENTS_FILTER, 'last6', NOW)
    expect(rows).toHaveLength(6)
    expect(rows.every(row => row.treatmentCount === 0)).toBe(true)
  })

  it('skips treatments with an unreadable date', () => {
    const rows = calculateMonthlyStatistics(
      [make('good', '2026-06-02T10:00:00.000Z', 1000), make('bad', 'not a date', 1000)],
      ALL_TREATMENTS_FILTER,
      'last6',
      NOW
    )
    expect(rows.reduce((total, row) => total + row.treatmentCount, 0)).toBe(1)
  })

})

describe('calculateMonthlyStatistics - local calendar months', () => {

  it('a treatment finished at 00:30 local on the 1st counts for that new month (it is still the last day of the old month in UTC)', () => {
    const rows = calculateMonthlyStatistics(
      [
        make('jan-last-ms', '2026-01-31T21:59:59.999Z', 1000), // 31 Jan 23:59:59.999 local
        make('feb-first-ms', '2026-01-31T22:00:00.000Z', 1000), // 1 Feb 00:00 local
        make('feb-00-30', '2026-01-31T22:30:00.000Z', 1000),
      ],
      ALL_TREATMENTS_FILTER,
      'all',
      NOW
    )
    expect(rows.map(row => [row.key, row.treatmentCount])).toEqual([
      ['2026-01', 1],
      ['2026-02', 2],
    ])
  })

  it('year end: 1 Jan 00:00 local belongs to the new year', () => {
    const rows = calculateMonthlyStatistics(
      [
        make('dec', '2025-12-31T21:59:59.999Z', 1000),
        make('jan', '2025-12-31T22:00:00.000Z', 1000),
      ],
      ALL_TREATMENTS_FILTER,
      'all',
      NOW
    )
    expect(rows.map(row => [row.key, row.treatmentCount])).toEqual([
      ['2025-12', 1],
      ['2026-01', 1],
    ])
  })

  it('across the Egyptian summer-time change, month boundaries still follow local midnight', () => {
    // 30 Apr 23:59:59.999 local is UTC+3 = 20:59:59.999Z; 1 May 00:00 local = 21:00Z.
    const rows = calculateMonthlyStatistics(
      [
        make('apr', '2026-04-30T20:59:59.999Z', 1000),
        make('may', '2026-04-30T21:00:00.000Z', 1000),
      ],
      ALL_TREATMENTS_FILTER,
      'all',
      NOW
    )
    expect(rows.map(row => [row.key, row.treatmentCount])).toEqual([
      ['2026-04', 1],
      ['2026-05', 1],
    ])
  })

})

describe('calculateMonthlyStatistics - the numbers', () => {

  const march = [
    make('m1', '2026-03-03T10:00:00.000Z', 800, 1000), // within target
    make('m2', '2026-03-10T10:00:00.000Z', 1000, 1000), // within target (no overtime)
    make('m3', '2026-03-20T10:00:00.000Z', 1500, 1000), // overtime
    make('m4', '2026-03-25T10:00:00.000Z', 1300, 1000), // overtime
  ]

  it('gives count, average actual, average expected and % within target', () => {
    const [row] = calculateMonthlyStatistics(march, ALL_TREATMENTS_FILTER, 'all', NOW)
    expect(row.treatmentCount).toBe(4)
    expect(row.averageActualDuration).toBeCloseTo((800 + 1000 + 1500 + 1300) / 4)
    expect(row.averageExpectedDuration).toBe(1000)
    expect(row.percentWithinTarget).toBe(50)
  })

  it('is exactly what the overview computes for that month\'s treatments', () => {
    const [row] = calculateMonthlyStatistics(march, ALL_TREATMENTS_FILTER, 'all', NOW)
    const overview = calculateTreatmentStatistics(march)
    expect(row.treatmentCount).toBe(overview.completedCount)
    expect(row.averageActualDuration).toBe(overview.averageActualDuration)
    expect(row.averageExpectedDuration).toBe(overview.averageExpectedDuration)
    expect(row.percentWithinTarget).toBe(overview.percentWithinTarget)
  })

  it('an empty month has a zero count and empty (null) figures, not 0 or NaN', () => {
    const rows = calculateMonthlyStatistics(
      [make('jan', '2026-01-10T10:00:00.000Z', 1000), make('mar', '2026-03-10T10:00:00.000Z', 1000)],
      ALL_TREATMENTS_FILTER,
      'all',
      NOW
    )
    expect(rows[1]).toMatchObject({
      key: '2026-02',
      treatmentCount: 0,
      averageActualDuration: null,
      averageExpectedDuration: null,
      percentWithinTarget: null,
    })
  })

})

describe('calculateMonthlyStatistics - the low-sample flag', () => {

  it('flags a month with fewer than 3 treatments and not one with 3 or more', () => {
    const treatments = [
      make('a1', '2026-04-01T10:00:00.000Z', 1000),
      make('a2', '2026-04-02T10:00:00.000Z', 1000),
      make('b1', '2026-05-01T10:00:00.000Z', 1000),
      make('b2', '2026-05-02T10:00:00.000Z', 1000),
      make('b3', '2026-05-03T10:00:00.000Z', 1000),
    ]
    const rows = calculateMonthlyStatistics(treatments, ALL_TREATMENTS_FILTER, 'all', NOW)
    expect(rows.map(row => [row.key, row.treatmentCount, row.lowSample])).toEqual([
      ['2026-04', 2, true],
      ['2026-05', 3, false],
    ])
  })

  it('an empty month is flagged too', () => {
    const rows = calculateMonthlyStatistics([], ALL_TREATMENTS_FILTER, 'last6', NOW)
    expect(rows.every(row => row.lowSample)).toBe(true)
  })

})

describe('calculateMonthlyStatistics - which filters apply', () => {

  const treatments = [
    make('rct-jan', '2026-01-10T10:00:00.000Z', 1000, 1000, { procedureId: 'rct', toothId: '16', templateId: 'rct-molar' }),
    make('rct-feb', '2026-02-10T10:00:00.000Z', 1000, 1000, { procedureId: 'rct', toothId: '26', templateId: 'rct-molar' }),
    make('fill-feb', '2026-02-12T10:00:00.000Z', 1000, 1000, { procedureId: 'filling', toothId: '24', templateId: 'class-ii' }),
    make('fill-mar', '2026-03-10T10:00:00.000Z', 1000, 1000, { procedureId: 'filling', toothId: '11', templateId: 'class-iii' }),
  ]

  function counts(filters: Parameters<typeof calculateMonthlyStatistics>[1]): number[] {
    return calculateMonthlyStatistics(treatments, filters, 'last6', NOW).map(row => row.treatmentCount)
  }

  it('applies the procedure filter', () => {
    expect(counts({ ...ALL_TREATMENTS_FILTER, procedureIds: ['rct'] })).toEqual([1, 1, 0, 0, 0, 0])
    expect(counts({ ...ALL_TREATMENTS_FILTER, procedureIds: ['filling'] })).toEqual([0, 1, 1, 0, 0, 0])
  })

  it('applies the tooth filter', () => {
    expect(counts({ ...ALL_TREATMENTS_FILTER, toothIds: ['16', '26'] })).toEqual([1, 1, 0, 0, 0, 0])
  })

  it('applies the template filter', () => {
    expect(counts({ ...ALL_TREATMENTS_FILTER, templateIds: ['class-ii'] })).toEqual([0, 1, 0, 0, 0, 0])
  })

  it('applies a checked-treatments list', () => {
    expect(counts({ ...ALL_TREATMENTS_FILTER, treatmentIds: ['rct-jan', 'fill-mar'] })).toEqual([1, 0, 1, 0, 0, 0])
  })

  it('IGNORES the date-range filter: a narrow range never blanks out the months being compared', () => {
    const narrow = { from: '2026-02-01T00:00:00.000Z', to: '2026-02-28T23:59:59.999Z' }
    expect(counts({ ...ALL_TREATMENTS_FILTER, dateRange: narrow })).toEqual(
      counts(ALL_TREATMENTS_FILTER)
    )
    expect(counts({ ...ALL_TREATMENTS_FILTER, dateRange: narrow })).toEqual([1, 2, 1, 0, 0, 0])
  })

  it('does not change the input list or the filters it was given', () => {
    const filters = { ...ALL_TREATMENTS_FILTER, dateRange: { from: 'a', to: 'b' } }
    const before = JSON.stringify(treatments)
    calculateMonthlyStatistics(treatments, filters, 'all', NOW)
    expect(JSON.stringify(treatments)).toBe(before)
    expect(filters.dateRange).toEqual({ from: 'a', to: 'b' })
    expect(applyStatisticsFilters(treatments, ALL_TREATMENTS_FILTER)).toHaveLength(4)
  })

})
