import type { SavedTreatment } from './App'
import { ALL_TREATMENTS_FILTER, applyStatisticsFilters } from './statistics'

/*
  CHECKED-TREATMENTS SELECTION (Statistics, Phase 8)

  Pure helpers over a set of checked treatment ids. Every function
  returns a NEW set (or the very same set when nothing changed) and
  never mutates its input, so React can compare by identity.

  "Select all from the search" ADDS the visible rows to what is already
  checked (checkAll); checks are never dropped just because the search
  text changed - the set lives apart from whatever rows are showing.
*/

export type CheckedIds = ReadonlySet<string>

export function toggleChecked(checked: CheckedIds, id: string): CheckedIds {

  const next = new Set(checked)

  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }

  return next

}

/* Adds every id (union). Returns the same set when nothing new was added. */
export function checkAll(checked: CheckedIds, ids: readonly string[]): CheckedIds {

  if (ids.every(id => checked.has(id))) {
    return checked
  }

  const next = new Set(checked)

  ids.forEach(id => next.add(id))

  return next

}

/* Removes the given ids only; every other checked id stays. */
export function uncheckAll(checked: CheckedIds, ids: readonly string[]): CheckedIds {

  if (!ids.some(id => checked.has(id))) {
    return checked
  }

  const next = new Set(checked)

  ids.forEach(id => next.delete(id))

  return next

}

/*
  The header checkbox over the visible rows: if every visible row is
  already checked, uncheck just those; otherwise check them all.
  Never touches checked ids that are not currently visible.
*/
export function toggleAllVisible(
  checked: CheckedIds,
  visibleIds: readonly string[]
): CheckedIds {

  const everyVisibleChecked =
    visibleIds.length > 0 && visibleIds.every(id => checked.has(id))

  return everyVisibleChecked
    ? uncheckAll(checked, visibleIds)
    : checkAll(checked, visibleIds)

}

const EMPTY: CheckedIds = new Set<string>()

export function clearChecked(checked: CheckedIds): CheckedIds {
  return checked.size === 0 ? checked : EMPTY
}

/*
  Drops ids whose treatment no longer exists (deleted since it was
  checked), silently. Returns the same set when nothing was dropped.
*/
export function pruneToExisting(
  checked: CheckedIds,
  treatments: readonly Pick<SavedTreatment, 'id'>[]
): CheckedIds {

  if (checked.size === 0) {
    return checked
  }

  const existing = new Set(treatments.map(treatment => treatment.id))

  const kept = Array.from(checked).filter(id => existing.has(id))

  return kept.length === checked.size ? checked : new Set(kept)

}

export type SelectionSummary = {
  checkedCount: number
  visibleCount: number
  visibleCheckedCount: number
  allVisibleChecked: boolean
  someVisibleChecked: boolean
}

export function summarizeSelection(
  checked: CheckedIds,
  visibleIds: readonly string[]
): SelectionSummary {

  const visibleCheckedCount =
    visibleIds.filter(id => checked.has(id)).length

  return {
    checkedCount: checked.size,
    visibleCount: visibleIds.length,
    visibleCheckedCount,
    allVisibleChecked:
      visibleIds.length > 0 && visibleCheckedCount === visibleIds.length,
    someVisibleChecked: visibleCheckedCount > 0,
  }

}

/*
  The list handed to StatisticsFilters.treatmentIds in checked mode.
  An empty selection stays an EMPTY list (statistics over nothing),
  never null (which would mean "everything").
*/
export function checkedIdsForFilter(checked: CheckedIds): string[] {
  return Array.from(checked)
}

/*
  CHECKED AND CASE TYPE

  Statistics in checked mode are computed on the treatments that are
  checked AND allowed by the Clinical/Practice/Both buttons. Checked
  treatments the buttons currently hide are neither dropped silently
  nor counted silently: they are reported as hiddenByCaseTypeCount so
  the screen can say so.

  `allTreatments` is every saved treatment, `caseTypeAllowed` is that
  list after the case-type buttons. Ids with no treatment (deleted)
  count for nothing. The narrowing itself is the ordinary statistics
  filter's treatmentIds, so it is exactly the same engine as the presets.
*/

export type CheckedResolution = {
  /* What every statistic is computed on. */
  statisticsTreatments: SavedTreatment[]
  /* Checked treatments that still exist (before the case-type buttons). */
  existingCheckedCount: number
  /* Checked, existing, but hidden by the case-type buttons. */
  hiddenByCaseTypeCount: number
}

export function resolveCheckedTreatments(
  allTreatments: SavedTreatment[],
  caseTypeAllowed: SavedTreatment[],
  checked: CheckedIds
): CheckedResolution {

  const existingCheckedCount =
    allTreatments.filter(treatment => checked.has(treatment.id)).length

  const statisticsTreatments = applyStatisticsFilters(
    caseTypeAllowed,
    { ...ALL_TREATMENTS_FILTER, treatmentIds: checkedIdsForFilter(checked) }
  )

  return {
    statisticsTreatments,
    existingCheckedCount,
    hiddenByCaseTypeCount: Math.max(
      0,
      existingCheckedCount - statisticsTreatments.length
    ),
  }

}

/* "1 checked treatment" / "3 checked treatments" - for the "Comparing:" line. */
export function describeCheckedCount(count: number): string {
  return `${count} checked treatment${count === 1 ? '' : 's'}`
}

/* The notice shown when the case-type buttons hide some checked treatments. */
export function describeHiddenByCaseType(count: number): string | null {

  if (count <= 0) {
    return null
  }

  return count === 1
    ? '1 checked treatment is hidden by the case-type filter'
    : `${count} checked treatments are hidden by the case-type filter`

}

/* "4 of 12 selected", plus the total when more is checked than is in view. */
export function formatSelectionSummary(summary: SelectionSummary): string {

  const base = `${summary.visibleCheckedCount} of ${summary.visibleCount} selected`

  return summary.checkedCount > summary.visibleCheckedCount
    ? `${base} (${summary.checkedCount} checked in total)`
    : base

}

/*
  Long lists: the table shows a page of rows at a time with a "show
  more" button, so hundreds of treatments stay responsive on an iPad.
*/

export const CHECKED_TABLE_PAGE_SIZE = 50

export function pageOfRows<T>(
  rows: readonly T[],
  limit: number
): { shown: T[]; remaining: number } {

  const shown = rows.slice(0, Math.max(0, limit))

  return { shown, remaining: rows.length - shown.length }

}
