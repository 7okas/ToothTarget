import type { SavedTreatment } from './App'

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
