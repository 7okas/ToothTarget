import { useMemo, useState } from 'react'
import type { Patient, SavedTreatment } from './App'
import { formatDate, formatTime } from './format'
import {
  buildTreatmentRows,
  searchTreatmentRows,
  sortRowsNewestFirst,
} from './treatmentSearch'
import {
  CHECKED_TABLE_PAGE_SIZE,
  checkAll,
  describeHiddenByCaseType,
  formatSelectionSummary,
  pageOfRows,
  summarizeSelection,
  toggleAllVisible,
  toggleChecked,
  type CheckedIds,
} from './treatmentSelection'

/*
  CHECKED TREATMENTS PANEL (Statistics, Phase 8)

  Search box, "N of M selected" summary, "Select all from search" and
  Clear buttons, and a table of matching completed treatments with a
  checkbox per row. This file only renders: every decision (what a
  search matches, how checks are added/removed, the summary and notice
  wording, paging) comes from the tested pure modules treatmentSearch.ts
  and treatmentSelection.ts. The checked set itself is owned by the
  caller (the in-memory store), so it survives this panel unmounting.

  `treatments` is the list ALREADY narrowed by the Clinical/Practice/
  Both buttons, so the table never lists what those buttons hide.

  Header checkbox: acts on the rows currently SHOWN in the table (the
  page on screen). "Select all from search" is the one that takes every
  matching row, including those not shown yet.
*/

type CheckedTreatmentsPanelProps = {
  treatments: SavedTreatment[]
  patients: Patient[]
  checked: CheckedIds
  hiddenByCaseTypeCount: number
  onCheckedChange: (next: CheckedIds) => void
  onClear: () => void
}

function formatRowDate(date: string): string {
  return Number.isNaN(new Date(date).getTime()) ? '—' : formatDate(date)
}

function CheckedTreatmentsPanel({
  treatments,
  patients,
  checked,
  hiddenByCaseTypeCount,
  onCheckedChange,
  onClear,
}: CheckedTreatmentsPanelProps) {

  const [query, setQuery] = useState('')

  /*
    How many rows to show, remembered together with the query it was
    chosen for: a new search starts again from the first page, with no
    effect needed.
  */
  const [pageState, setPageState] = useState({ query: '', limit: CHECKED_TABLE_PAGE_SIZE })

  const limit =
    pageState.query === query ? pageState.limit : CHECKED_TABLE_PAGE_SIZE

  const allRows = useMemo(
    () => sortRowsNewestFirst(buildTreatmentRows(treatments, patients)),
    [treatments, patients]
  )

  const matchingRows = searchTreatmentRows(allRows, query)

  const matchingIds = matchingRows.map(row => row.treatment.id)

  const { shown, remaining } = pageOfRows(matchingRows, limit)

  const shownIds = shown.map(row => row.treatment.id)

  const summary = summarizeSelection(checked, matchingIds)

  const shownSummary = summarizeSelection(checked, shownIds)

  const hiddenNotice = describeHiddenByCaseType(hiddenByCaseTypeCount)

  return (

    <div className="checked-panel">

      <input
        type="search"
        className="checked-search-input"
        placeholder="Search: procedure, template, tooth (16, UR6), molar, upper..."
        aria-label="Search treatments by procedure, template or tooth"
        value={query}
        onChange={event => setQuery(event.target.value)}
      />

      <p className="checked-summary" role="status">
        {formatSelectionSummary(summary)}
      </p>

      {hiddenNotice && (
        <p className="checked-hidden-notice" role="status">
          {hiddenNotice}
        </p>
      )}

      <div className="checked-actions">

        <button
          type="button"
          className="stats-filter-button checked-action-button"
          disabled={matchingIds.length === 0}
          onClick={() => onCheckedChange(checkAll(checked, matchingIds))}
        >
          Select all from search
        </button>

        <button
          type="button"
          className="stats-filter-button checked-action-button"
          disabled={checked.size === 0}
          onClick={onClear}
        >
          Clear
        </button>

      </div>

      {allRows.length === 0 && (
        <p className="empty-message">
          No completed treatments for the selected case type.
        </p>
      )}

      {allRows.length > 0 && matchingRows.length === 0 && (
        <p className="empty-message">
          No treatments match this search.
        </p>
      )}

      {matchingRows.length > 0 && (

        <div
          className="checked-table-scroll"
          tabIndex={0}
          aria-label="Matching treatments (scrolls sideways and up and down)"
        >

          <table className="checked-table">

            <thead>
              <tr>
                <th className="checked-check-cell">
                  <label className="checked-check-label">
                    <input
                      type="checkbox"
                      aria-label="Check or uncheck every row shown"
                      checked={shownSummary.allVisibleChecked}
                      ref={element => {
                        if (element) {
                          element.indeterminate =
                            shownSummary.someVisibleChecked &&
                            !shownSummary.allVisibleChecked
                        }
                      }}
                      onChange={() =>
                        onCheckedChange(toggleAllVisible(checked, shownIds))
                      }
                    />
                  </label>
                </th>
                <th>Date</th>
                <th>Procedure</th>
                <th>Tooth</th>
                <th>Template</th>
                <th>Case type</th>
                <th>Total time</th>
                <th>Phases tracked</th>
              </tr>
            </thead>

            <tbody>

              {shown.map(row => {

                const id = row.treatment.id
                const isChecked = checked.has(id)

                return (

                  <tr key={id} className={isChecked ? 'checked-row-selected' : ''}>

                    <td className="checked-check-cell">
                      <label className="checked-check-label">
                        <input
                          type="checkbox"
                          aria-label={`Check ${row.treatment.procedureName}, tooth ${row.toothLabel}, ${formatRowDate(row.treatment.date)}`}
                          checked={isChecked}
                          onChange={() => onCheckedChange(toggleChecked(checked, id))}
                        />
                      </label>
                    </td>

                    <td>{formatRowDate(row.treatment.date)}</td>
                    <td>{row.treatment.procedureName}</td>
                    <td>{row.toothLabel}</td>
                    <td>{row.treatment.templateName}</td>
                    <td>{row.caseType}</td>
                    <td>{formatTime(row.treatment.totalActualDuration)}</td>

                    <td>
                      {row.phasesTracked} of {row.phasesTotal}
                      {row.hasSkippedPhases && (
                        <span
                          className="checked-skipped-flag"
                          title="Some phases were never started, so the total time covers fewer phases than planned"
                        >
                          ⚠ phases skipped
                        </span>
                      )}
                    </td>

                  </tr>

                )

              })}

            </tbody>

          </table>

        </div>

      )}

      {remaining > 0 && (

        <div className="checked-actions">

          <button
            type="button"
            className="stats-filter-button checked-action-button"
            onClick={() =>
              setPageState({ query, limit: limit + CHECKED_TABLE_PAGE_SIZE })
            }
          >
            Show {Math.min(remaining, CHECKED_TABLE_PAGE_SIZE)} more ({remaining} not shown)
          </button>

        </div>

      )}

    </div>

  )

}

export default CheckedTreatmentsPanel
