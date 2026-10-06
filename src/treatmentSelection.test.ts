import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SavedTreatment } from './App'
import {
  CHECKED_TABLE_PAGE_SIZE,
  checkAll,
  checkedIdsForFilter,
  describeCheckedCount,
  describeHiddenByCaseType,
  formatSelectionSummary,
  pageOfRows,
  resolveCheckedTreatments,
  clearChecked,
  pruneToExisting,
  summarizeSelection,
  toggleAllVisible,
  toggleChecked,
  uncheckAll,
} from './treatmentSelection'
import {
  __resetCheckedTreatmentsForTests,
  clearCheckedTreatments,
  getCheckedTreatmentIds,
  pruneCheckedTreatments,
  setCheckedTreatmentIds,
  subscribeCheckedTreatments,
} from './checkedTreatmentsStore'

const set = (...ids: string[]) => new Set(ids)

describe('toggleChecked', () => {

  it('checks an unchecked id and unchecks a checked one, without mutating the input', () => {
    const start = set('a')
    const afterAdd = toggleChecked(start, 'b')
    expect(Array.from(afterAdd).sort()).toEqual(['a', 'b'])
    expect(Array.from(start)).toEqual(['a'])
    expect(Array.from(toggleChecked(afterAdd, 'a'))).toEqual(['b'])
  })

})

describe('checkAll - "select all from the current search" ADDS to what is checked', () => {

  it('keeps earlier checks and adds the visible ones', () => {
    const result = checkAll(set('old-1', 'old-2'), ['new-1', 'new-2'])
    expect(Array.from(result).sort()).toEqual(['new-1', 'new-2', 'old-1', 'old-2'])
  })

  it('ids already checked are not duplicated', () => {
    expect(Array.from(checkAll(set('a'), ['a', 'b'])).sort()).toEqual(['a', 'b'])
  })

  it('returns the very same set when nothing new was added (so nothing re-renders)', () => {
    const start = set('a', 'b')
    expect(checkAll(start, ['a'])).toBe(start)
    expect(checkAll(start, [])).toBe(start)
  })

  it('never mutates its input', () => {
    const start = set('a')
    checkAll(start, ['b'])
    expect(Array.from(start)).toEqual(['a'])
  })

})

describe('uncheckAll / toggleAllVisible', () => {

  it('uncheckAll removes only the given ids', () => {
    expect(Array.from(uncheckAll(set('a', 'b', 'c'), ['b'])).sort()).toEqual(['a', 'c'])
    const start = set('a')
    expect(uncheckAll(start, ['zzz'])).toBe(start)
  })

  it('toggleAllVisible checks every visible row when some are unchecked', () => {
    const result = toggleAllVisible(set('hidden', 'v1'), ['v1', 'v2', 'v3'])
    expect(Array.from(result).sort()).toEqual(['hidden', 'v1', 'v2', 'v3'])
  })

  it('toggleAllVisible unchecks just the visible rows when all are checked, and leaves hidden checks alone', () => {
    const result = toggleAllVisible(set('hidden', 'v1', 'v2'), ['v1', 'v2'])
    expect(Array.from(result)).toEqual(['hidden'])
  })

  it('toggleAllVisible with no visible rows changes nothing', () => {
    const start = set('a')
    expect(toggleAllVisible(start, [])).toBe(start)
  })

})

describe('clearChecked', () => {

  it('empties the selection', () => {
    expect(clearChecked(set('a', 'b')).size).toBe(0)
  })

  it('returns the same set when already empty', () => {
    const empty = set()
    expect(clearChecked(empty)).toBe(empty)
  })

})

describe('pruneToExisting - ids of deleted treatments drop out silently', () => {

  it('drops ids with no matching treatment and keeps the rest', () => {
    const result = pruneToExisting(set('a', 'gone', 'b'), [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(Array.from(result).sort()).toEqual(['a', 'b'])
  })

  it('returns the same set when every id still exists', () => {
    const start = set('a', 'b')
    expect(pruneToExisting(start, [{ id: 'a' }, { id: 'b' }])).toBe(start)
  })

  it('an empty treatment list drops everything', () => {
    expect(pruneToExisting(set('a'), []).size).toBe(0)
  })

})

describe('summarizeSelection', () => {

  it('counts total, visible and visible-checked, and says whether all/some visible are checked', () => {
    expect(summarizeSelection(set('a', 'b', 'hidden'), ['a', 'b', 'c'])).toEqual({
      checkedCount: 3,
      visibleCount: 3,
      visibleCheckedCount: 2,
      allVisibleChecked: false,
      someVisibleChecked: true,
    })
  })

  it('allVisibleChecked is true only with at least one visible row', () => {
    expect(summarizeSelection(set('a'), ['a']).allVisibleChecked).toBe(true)
    expect(summarizeSelection(set('a'), []).allVisibleChecked).toBe(false)
  })

  it('nothing checked', () => {
    expect(summarizeSelection(set(), ['a'])).toEqual({
      checkedCount: 0,
      visibleCount: 1,
      visibleCheckedCount: 0,
      allVisibleChecked: false,
      someVisibleChecked: false,
    })
  })

})

describe('checkedIdsForFilter', () => {

  it('lists the checked ids; an empty selection is an EMPTY list, never null', () => {
    expect(checkedIdsForFilter(set('a', 'b')).sort()).toEqual(['a', 'b'])
    expect(checkedIdsForFilter(set())).toEqual([])
  })

})

describe('checkedTreatmentsStore - in memory, survives leaving the screen, never saved', () => {

  afterEach(() => {
    __resetCheckedTreatmentsForTests()
    vi.restoreAllMocks()
  })

  it('starts empty and keeps what was set (same object until something changes)', () => {
    expect(getCheckedTreatmentIds().size).toBe(0)
    const next = set('a', 'b')
    setCheckedTreatmentIds(next)
    expect(getCheckedTreatmentIds()).toBe(next)
    expect(getCheckedTreatmentIds()).toBe(next)
  })

  it('keeps the checks when the screen unsubscribes and a new one subscribes later (leave and come back)', () => {
    const firstScreen = vi.fn()
    const unsubscribe = subscribeCheckedTreatments(firstScreen)
    setCheckedTreatmentIds(set('a'))
    expect(firstScreen).toHaveBeenCalledTimes(1)
    unsubscribe()

    // The screen is gone; the store is not.
    setCheckedTreatmentIds(toggleChecked(getCheckedTreatmentIds(), 'b'))
    expect(firstScreen).toHaveBeenCalledTimes(1)

    const secondScreen = vi.fn()
    subscribeCheckedTreatments(secondScreen)
    expect(Array.from(getCheckedTreatmentIds()).sort()).toEqual(['a', 'b'])
    expect(secondScreen).not.toHaveBeenCalled()
  })

  it('does not notify when nothing actually changed', () => {
    const listener = vi.fn()
    subscribeCheckedTreatments(listener)
    const same = set('a')
    setCheckedTreatmentIds(same)
    setCheckedTreatmentIds(same)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('Clear empties it and notifies once; clearing an empty store notifies nobody', () => {
    setCheckedTreatmentIds(set('a'))
    const listener = vi.fn()
    subscribeCheckedTreatments(listener)
    clearCheckedTreatments()
    expect(getCheckedTreatmentIds().size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(1)
    clearCheckedTreatments()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('prune drops deleted treatments silently and notifies only when something was dropped', () => {
    setCheckedTreatmentIds(set('a', 'gone'))
    const listener = vi.fn()
    subscribeCheckedTreatments(listener)
    pruneCheckedTreatments([{ id: 'a' }])
    expect(Array.from(getCheckedTreatmentIds())).toEqual(['a'])
    expect(listener).toHaveBeenCalledTimes(1)
    pruneCheckedTreatments([{ id: 'a' }, { id: 'b' }])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('never reads or writes any browser storage', () => {
    const trap = {
      getItem: () => { throw new Error('storage was read') },
      setItem: () => { throw new Error('storage was written') },
      removeItem: () => { throw new Error('storage was written') },
      clear: () => { throw new Error('storage was written') },
      key: () => { throw new Error('storage was read') },
      length: 0,
    }
    vi.stubGlobal('localStorage', trap)
    vi.stubGlobal('sessionStorage', trap)

    try {
      setCheckedTreatmentIds(set('a'))
      setCheckedTreatmentIds(toggleChecked(getCheckedTreatmentIds(), 'b'))
      pruneCheckedTreatments([{ id: 'a' }])
      clearCheckedTreatments()
      expect(getCheckedTreatmentIds().size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

})

describe('resolveCheckedTreatments - checked AND case type', () => {

  const t = (id: string) => ({ id }) as unknown as SavedTreatment

  const all = [t('a'), t('b'), t('c'), t('d')]
  // The case-type buttons currently allow only a, b and d.
  const allowed = [t('a'), t('b'), t('d')]

  it('uses exactly the treatments that are both checked and allowed, in list order', () => {
    const result = resolveCheckedTreatments(all, allowed, set('d', 'a'))
    expect(result.statisticsTreatments.map(x => x.id)).toEqual(['a', 'd'])
    expect(result.existingCheckedCount).toBe(2)
    expect(result.hiddenByCaseTypeCount).toBe(0)
  })

  it('reports checked treatments hidden by the case-type buttons instead of dropping or counting them silently', () => {
    const result = resolveCheckedTreatments(all, allowed, set('a', 'c'))
    expect(result.statisticsTreatments.map(x => x.id)).toEqual(['a'])
    expect(result.existingCheckedCount).toBe(2)
    expect(result.hiddenByCaseTypeCount).toBe(1)
  })

  it('everything checked is hidden: no statistics, all counted as hidden', () => {
    const result = resolveCheckedTreatments(all, allowed, set('c'))
    expect(result.statisticsTreatments).toEqual([])
    expect(result.hiddenByCaseTypeCount).toBe(1)
  })

  it('nothing checked: no statistics and nothing hidden - an empty list, never "everything"', () => {
    const result = resolveCheckedTreatments(all, allowed, set())
    expect(result.statisticsTreatments).toEqual([])
    expect(result.existingCheckedCount).toBe(0)
    expect(result.hiddenByCaseTypeCount).toBe(0)
  })

  it('ids of deleted treatments count for nothing', () => {
    const result = resolveCheckedTreatments(all, allowed, set('a', 'gone'))
    expect(result.statisticsTreatments.map(x => x.id)).toEqual(['a'])
    expect(result.existingCheckedCount).toBe(1)
    expect(result.hiddenByCaseTypeCount).toBe(0)
  })

})

describe('wording helpers', () => {

  it('describeCheckedCount pluralises for the "Comparing:" line', () => {
    expect(describeCheckedCount(0)).toBe('0 checked treatments')
    expect(describeCheckedCount(1)).toBe('1 checked treatment')
    expect(describeCheckedCount(12)).toBe('12 checked treatments')
  })

  it('describeHiddenByCaseType says nothing for 0 and pluralises otherwise', () => {
    expect(describeHiddenByCaseType(0)).toBeNull()
    expect(describeHiddenByCaseType(1)).toBe('1 checked treatment is hidden by the case-type filter')
    expect(describeHiddenByCaseType(3)).toBe('3 checked treatments are hidden by the case-type filter')
  })

  it('formatSelectionSummary reads "N of M selected", adding the grand total only when more is checked than in view', () => {
    expect(formatSelectionSummary(summarizeSelection(set('a', 'b'), ['a', 'b', 'c']))).toBe('2 of 3 selected')
    expect(formatSelectionSummary(summarizeSelection(set('a', 'x', 'y'), ['a', 'b']))).toBe('1 of 2 selected (3 checked in total)')
    expect(formatSelectionSummary(summarizeSelection(set(), []))).toBe('0 of 0 selected')
  })

})

describe('pageOfRows - long lists stay responsive', () => {

  const rows = Array.from({ length: 120 }, (_, index) => index)

  it('the page size is 50', () => {
    expect(CHECKED_TABLE_PAGE_SIZE).toBe(50)
  })

  it('shows the first rows up to the limit and reports how many remain', () => {
    expect(pageOfRows(rows, 50).shown).toHaveLength(50)
    expect(pageOfRows(rows, 50).remaining).toBe(70)
    expect(pageOfRows(rows, 100).remaining).toBe(20)
  })

  it('a limit past the end shows everything with nothing remaining', () => {
    expect(pageOfRows(rows, 500)).toEqual({ shown: rows, remaining: 0 })
  })

  it('an empty list or a zero limit is safe', () => {
    expect(pageOfRows([], 50)).toEqual({ shown: [], remaining: 0 })
    expect(pageOfRows(rows, 0)).toEqual({ shown: [], remaining: 120 })
  })

})
