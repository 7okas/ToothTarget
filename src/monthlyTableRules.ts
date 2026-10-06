import {
  ALL_TREATMENTS_FILTER,
  MIN_SAMPLE_SIZE,
  type MonthlySpan,
  type MonthlyStatistic,
  type StatisticsFilters,
} from './statistics'
import { checkedIdsForFilter, type CheckedIds } from './treatmentSelection'

/*
  BY-MONTH TABLE (Statistics, Phase 8) - the rules around the numbers

  statistics.ts's calculateMonthlyStatistics() produces the figures;
  this file decides everything else the table needs to be honest and
  readable, as pure functions: which filters feed it, the month labels,
  newest-first order, which rows are empty or "few treatments", how a
  percentage is written, which of the four section states applies, and
  the wording. MonthlyTable.tsx only renders what these return.
*/

export const MONTHLY_SPAN_OPTIONS: { id: MonthlySpan; label: string }[] = [
  { id: 'last6', label: 'Last 6 months' },
  { id: 'last12', label: 'Last 12 months' },
  { id: 'all', label: 'All' },
]

/*
  The filters the table uses: the same as the rest of the screen except
  the date range (calculateMonthlyStatistics() ignores it by design).
  Presets mode: the screen's own procedure/tooth/template filters.
  Checked mode: just the checked treatments (the Clinical/Practice/Both
  buttons are applied to the treatment list the caller passes in, in
  both modes).
*/

export function monthlyFilters(
  inCheckedMode: boolean,
  presetFilters: StatisticsFilters,
  checked: CheckedIds
): StatisticsFilters {

  return inCheckedMode
    ? { ...ALL_TREATMENTS_FILTER, treatmentIds: checkedIdsForFilter(checked) }
    : presetFilters

}

export function monthlyFilterNote(inCheckedMode: boolean): string {

  return inCheckedMode
    ? 'Uses your checked treatments and the case-type buttons; the date range is ignored here.'
    : 'Uses your current filters; the date range is ignored here.'

}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/* "Oct 2026" (month is 1-12). */
export function formatMonthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? '?'} ${year}`
}

export type MonthlyRowKind =
  | 'empty' // no treatments that month: shown as "No treatments", no figures
  | 'few' // fewer than the shared minimum: figures shown but muted and marked
  | 'enough'

export type MonthlyTableRow = {
  key: string
  label: string
  kind: MonthlyRowKind
  treatmentCount: number
  averageActualDuration: number | null
  averageExpectedDuration: number | null
  percentWithinTarget: number | null
}

/* Newest month first, with each row's kind decided here. */
export function buildMonthlyTableRows(
  stats: MonthlyStatistic[]
): MonthlyTableRow[] {

  return [...stats]
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    .map(stat => ({
      key: stat.key,
      label: formatMonthLabel(stat.year, stat.month),
      kind:
        stat.treatmentCount === 0
          ? 'empty'
          : stat.lowSample
            ? 'few'
            : 'enough',
      treatmentCount: stat.treatmentCount,
      averageActualDuration: stat.averageActualDuration,
      averageExpectedDuration: stat.averageExpectedDuration,
      percentWithinTarget: stat.percentWithinTarget,
    }))

}

/* "67%" - whole percent; a missing value is a dash, never NaN or 0%. */
export function formatPercentWithinTarget(percent: number | null): string {

  if (percent === null || !Number.isFinite(percent)) {
    return '—'
  }

  return `${Math.round(percent)}%`

}

/*
  Which of four things the section shows:
    'hidden'       - checked mode with nothing checked (the screen already
                     tells the dentist to check treatments)
    'no-match'     - no treatment at all passes the filters
    'none-in-span' - some do, but none fall inside the chosen span
    'table'        - the table
*/

export type MonthlySectionView = 'hidden' | 'no-match' | 'none-in-span' | 'table'

export function decideMonthlySectionView(input: {
  inCheckedMode: boolean
  existingCheckedCount: number
  /* Rows for the chosen span. */
  spanRows: MonthlyStatistic[]
  /* Rows for span 'all' (empty only when nothing passes the filters). */
  allTimeRows: MonthlyStatistic[]
}): MonthlySectionView {

  if (input.inCheckedMode && input.existingCheckedCount === 0) {
    return 'hidden'
  }

  if (input.allTimeRows.length === 0) {
    return 'no-match'
  }

  if (input.spanRows.every(row => row.treatmentCount === 0)) {
    return 'none-in-span'
  }

  return 'table'

}

export function monthlyEmptyMessage(
  view: 'no-match' | 'none-in-span',
  span: MonthlySpan
): string {

  if (view === 'no-match') {
    return 'No treatments match your current filters.'
  }

  return span === 'last6'
    ? 'No treatments in the last 6 months. Try Last 12 months or All.'
    : 'No treatments in the last 12 months. Try All.'

}

export function monthlyFewTreatmentsNote(): string {
  return `Months marked "few treatments" have fewer than ${MIN_SAMPLE_SIZE} treatments, so treat their averages as indicative only.`
}
