import { formatTime } from './format'
import type { MonthlySpan } from './statistics'
import {
  MONTHLY_SPAN_OPTIONS,
  formatPercentWithinTarget,
  monthlyEmptyMessage,
  monthlyFewTreatmentsNote,
  monthlyFilterNote,
  type MonthlySectionView,
  type MonthlyTableRow,
} from './monthlyTableRules'

/*
  BY-MONTH TABLE (Statistics, Phase 8)

  Renders only. The figures come from statistics.ts's
  calculateMonthlyStatistics() and every rule about them (newest first,
  empty / few-treatments rows, percentage text, which of the four section
  states applies, the wording) from monthlyTableRules.ts - all of it tested.
  The caller owns the chosen span and passes the decided view.
*/

type MonthlyTableProps = {
  view: MonthlySectionView
  rows: MonthlyTableRow[]
  span: MonthlySpan
  onSpanChange: (span: MonthlySpan) => void
  inCheckedMode: boolean
}

function MonthlyTable({
  view,
  rows,
  span,
  onSpanChange,
  inCheckedMode,
}: MonthlyTableProps) {

  if (view === 'hidden') {
    return null
  }

  const hasFewRow = rows.some(row => row.kind === 'few')

  return (

    <div className="stats-section monthly-section">

      <h2>By month</h2>

      <p className="monthly-filter-note">
        {monthlyFilterNote(inCheckedMode)}
      </p>

      <div
        className="stats-filter-bar"
        role="group"
        aria-label="Months to show"
      >

        {MONTHLY_SPAN_OPTIONS.map(option => (

          <button
            key={option.id}
            type="button"
            className={`stats-filter-button monthly-span-button ${
              span === option.id ? 'stats-filter-active' : ''
            }`}
            aria-pressed={span === option.id}
            onClick={() => onSpanChange(option.id)}
          >
            {option.label}
          </button>

        ))}

      </div>

      {(view === 'no-match' || view === 'none-in-span') && (
        <p className="empty-message">
          {monthlyEmptyMessage(view, span)}
        </p>
      )}

      {view === 'table' && (

        <>

          <div
            className="monthly-table-scroll"
            tabIndex={0}
            aria-label="Statistics by month (scrolls sideways if needed)"
          >

            <table className="monthly-table">

              <thead>
                <tr>
                  <th>Month</th>
                  <th>Treatments</th>
                  <th>Average actual</th>
                  <th>Average expected</th>
                  <th>Within target</th>
                </tr>
              </thead>

              <tbody>

                {rows.map(row => (

                  row.kind === 'empty'

                    ? (
                      <tr key={row.key} className="monthly-row-empty">
                        <th scope="row">{row.label}</th>
                        <td colSpan={4}>No treatments</td>
                      </tr>
                    )

                    : (
                      <tr
                        key={row.key}
                        className={row.kind === 'few' ? 'monthly-row-few' : ''}
                      >
                        <th scope="row">{row.label}</th>
                        <td>
                          {row.treatmentCount}
                          {row.kind === 'few' && (
                            <span className="monthly-few-badge">
                              few treatments
                            </span>
                          )}
                        </td>
                        <td>
                          {row.averageActualDuration === null
                            ? '—'
                            : formatTime(row.averageActualDuration)}
                        </td>
                        <td>
                          {row.averageExpectedDuration === null
                            ? '—'
                            : formatTime(row.averageExpectedDuration)}
                        </td>
                        <td>{formatPercentWithinTarget(row.percentWithinTarget)}</td>
                      </tr>
                    )

                ))}

              </tbody>

            </table>

          </div>

          {hasFewRow && (
            <p className="small-sample-note">
              {monthlyFewTreatmentsNote()}
            </p>
          )}

        </>

      )}

    </div>

  )

}

export default MonthlyTable
