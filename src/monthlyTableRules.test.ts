import { describe, expect, it } from 'vitest'
import {
  ALL_TREATMENTS_FILTER,
  MIN_SAMPLE_SIZE,
  type MonthlyStatistic,
  type StatisticsFilters,
} from './statistics'
import {
  MONTHLY_SPAN_OPTIONS,
  buildMonthlyTableRows,
  decideMonthlySectionView,
  formatMonthLabel,
  formatPercentWithinTarget,
  monthlyEmptyMessage,
  monthlyFewTreatmentsNote,
  monthlyFilterNote,
  monthlyFilters,
} from './monthlyTableRules'

function stat(
  key: string,
  count: number,
  extra: Partial<MonthlyStatistic> = {}
): MonthlyStatistic {
  const [year, month] = key.split('-').map(Number)
  return {
    key,
    year,
    month,
    treatmentCount: count,
    averageActualDuration: count === 0 ? null : 1000,
    averageExpectedDuration: count === 0 ? null : 900,
    percentWithinTarget: count === 0 ? null : 50,
    lowSample: count < MIN_SAMPLE_SIZE,
    ...extra,
  }
}

describe('MONTHLY_SPAN_OPTIONS', () => {

  it('are Last 6 months, Last 12 months and All, in that order', () => {
    expect(MONTHLY_SPAN_OPTIONS).toEqual([
      { id: 'last6', label: 'Last 6 months' },
      { id: 'last12', label: 'Last 12 months' },
      { id: 'all', label: 'All' },
    ])
  })

})

describe('formatMonthLabel', () => {

  it('writes a short month name and the year', () => {
    expect(formatMonthLabel(2026, 10)).toBe('Oct 2026')
    expect(formatMonthLabel(2026, 1)).toBe('Jan 2026')
    expect(formatMonthLabel(2025, 12)).toBe('Dec 2025')
  })

})

describe('buildMonthlyTableRows', () => {

  it('puts the newest month first, across a year boundary', () => {
    const rows = buildMonthlyTableRows([
      stat('2025-11', 4),
      stat('2025-12', 4),
      stat('2026-01', 4),
    ])
    expect(rows.map(row => row.label)).toEqual(['Jan 2026', 'Dec 2025', 'Nov 2025'])
  })

  it('does not change the list it was given', () => {
    const input = [stat('2026-01', 4), stat('2026-02', 4)]
    buildMonthlyTableRows(input)
    expect(input.map(item => item.key)).toEqual(['2026-01', '2026-02'])
  })

  it('an empty month is "empty" and carries no figures (no zeros, no NaN)', () => {
    const [row] = buildMonthlyTableRows([stat('2026-03', 0)])
    expect(row.kind).toBe('empty')
    expect(row.averageActualDuration).toBeNull()
    expect(row.averageExpectedDuration).toBeNull()
    expect(row.percentWithinTarget).toBeNull()
  })

  it('a month with fewer than the shared minimum is "few" but keeps its figures', () => {
    const rows = buildMonthlyTableRows([stat('2026-03', 1), stat('2026-04', MIN_SAMPLE_SIZE - 1)])
    expect(rows.map(row => row.kind)).toEqual(['few', 'few'])
    expect(rows[0].averageActualDuration).toBe(1000)
  })

  it('a month with the minimum or more is "enough"', () => {
    const [row] = buildMonthlyTableRows([stat('2026-03', MIN_SAMPLE_SIZE)])
    expect(row.kind).toBe('enough')
  })

  it('classifies a mixed list correctly', () => {
    const rows = buildMonthlyTableRows([
      stat('2026-01', 5),
      stat('2026-02', 0),
      stat('2026-03', 2),
    ])
    expect(rows.map(row => [row.label, row.kind])).toEqual([
      ['Mar 2026', 'few'],
      ['Feb 2026', 'empty'],
      ['Jan 2026', 'enough'],
    ])
  })

  it('an empty list gives no rows', () => {
    expect(buildMonthlyTableRows([])).toEqual([])
  })

})

describe('formatPercentWithinTarget', () => {

  it('rounds to a whole percent', () => {
    expect(formatPercentWithinTarget(66.666)).toBe('67%')
    expect(formatPercentWithinTarget(0)).toBe('0%')
    expect(formatPercentWithinTarget(100)).toBe('100%')
  })

  it('a missing or invalid value is a dash, never NaN', () => {
    expect(formatPercentWithinTarget(null)).toBe('—')
    expect(formatPercentWithinTarget(Number.NaN)).toBe('—')
    expect(formatPercentWithinTarget(Number.POSITIVE_INFINITY)).toBe('—')
  })

})

describe('decideMonthlySectionView', () => {

  const withData = [stat('2026-01', 4), stat('2026-02', 0)]
  const noneInSpan = [stat('2026-05', 0), stat('2026-06', 0)]

  it('shows the table when the span has treatments', () => {
    expect(
      decideMonthlySectionView({
        inCheckedMode: false,
        existingCheckedCount: 0,
        spanRows: withData,
        allTimeRows: withData,
      })
    ).toBe('table')
  })

  it('says "no match" when nothing passes the filters at all', () => {
    expect(
      decideMonthlySectionView({
        inCheckedMode: false,
        existingCheckedCount: 0,
        spanRows: noneInSpan,
        allTimeRows: [],
      })
    ).toBe('no-match')
  })

  it('says "none in span" when treatments exist but not inside the chosen span', () => {
    expect(
      decideMonthlySectionView({
        inCheckedMode: false,
        existingCheckedCount: 0,
        spanRows: noneInSpan,
        allTimeRows: [stat('2024-01', 5)],
      })
    ).toBe('none-in-span')
  })

  it('shows nothing in checked mode with nothing checked, whatever else is true', () => {
    expect(
      decideMonthlySectionView({
        inCheckedMode: true,
        existingCheckedCount: 0,
        spanRows: noneInSpan,
        allTimeRows: [],
      })
    ).toBe('hidden')
    expect(
      decideMonthlySectionView({
        inCheckedMode: true,
        existingCheckedCount: 0,
        spanRows: withData,
        allTimeRows: withData,
      })
    ).toBe('hidden')
  })

  it('in checked mode with something checked it behaves like presets mode', () => {
    expect(
      decideMonthlySectionView({
        inCheckedMode: true,
        existingCheckedCount: 2,
        spanRows: withData,
        allTimeRows: withData,
      })
    ).toBe('table')
    // Checked, but every checked treatment is hidden by the case-type buttons.
    expect(
      decideMonthlySectionView({
        inCheckedMode: true,
        existingCheckedCount: 2,
        spanRows: noneInSpan,
        allTimeRows: [],
      })
    ).toBe('no-match')
  })

  it('presets mode ignores the checked count entirely', () => {
    expect(
      decideMonthlySectionView({
        inCheckedMode: false,
        existingCheckedCount: 0,
        spanRows: withData,
        allTimeRows: withData,
      })
    ).toBe('table')
  })

})

describe('monthlyFilters - what feeds the table', () => {

  const presets: StatisticsFilters = {
    procedureIds: ['rct'],
    templateIds: ['t1'],
    toothIds: ['16'],
    dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
  }

  it('presets mode passes the screen\'s own procedure/tooth/template filters through unchanged', () => {
    expect(monthlyFilters(false, presets, new Set(['a']))).toBe(presets)
  })

  it('checked mode uses only the checked treatments (no preset filters, no date range)', () => {
    expect(monthlyFilters(true, presets, new Set(['a', 'b']))).toEqual({
      ...ALL_TREATMENTS_FILTER,
      treatmentIds: ['a', 'b'],
    })
  })

  it('checked mode with nothing checked is an empty list, never "everything"', () => {
    expect(monthlyFilters(true, presets, new Set()).treatmentIds).toEqual([])
  })

})

describe('wording', () => {

  it('the note above the table says the date range is ignored, in both modes', () => {
    expect(monthlyFilterNote(false)).toBe('Uses your current filters; the date range is ignored here.')
    expect(monthlyFilterNote(true)).toContain('checked treatments')
    expect(monthlyFilterNote(true)).toContain('date range is ignored')
  })

  it('the few-treatments note quotes the shared minimum', () => {
    expect(monthlyFewTreatmentsNote()).toContain(`fewer than ${MIN_SAMPLE_SIZE} treatments`)
    expect(monthlyFewTreatmentsNote()).toContain('"few treatments"')
  })

  it('the empty messages point at a wider span where one exists', () => {
    expect(monthlyEmptyMessage('no-match', 'last6')).toBe('No treatments match your current filters.')
    expect(monthlyEmptyMessage('none-in-span', 'last6')).toContain('Last 12 months or All')
    expect(monthlyEmptyMessage('none-in-span', 'last12')).toContain('Try All')
  })

})
