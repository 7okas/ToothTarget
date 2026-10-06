import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Patient, Procedure, ProcedureTemplate, SavedTreatment } from './App'
import BackButton from './BackButton'
import TimeTrendChart from './TimeTrendChart'
import CheckedTreatmentsPanel from './CheckedTreatmentsPanel'
import MonthlyTable from './MonthlyTable'
import ToothChart from './ToothChart'
import { formatTime, formatSignedTime, formatDate } from './format'
import { getToothLabel, getToothById, TOOTH_GROUPS, type ToothGroup } from './teeth'
import {
  ALL_TREATMENTS_FILTER,
  applyStatisticsFilters,
  filterTreatmentsByCaseType,
  resolveToothSelection,
  resolveDateRangePreset,
  resolveCustomDateRange,
  calculateMonthlyStatistics,
  MIN_SAMPLE_SIZE,
  DATE_RANGE_PRESETS,
  calculateTreatmentStatistics,
  calculatePhaseStatistics,
  calculateProcedureStatistics,
  calculateProcedureFilterOptions,
  calculateOvertimeStatistics,
  calculateRctRegionStatistics,
  calculateTimeTrend,
  calculateTimeLossInsights,
  generatePersonalizedInsights,
  type StatisticsFilters,
  type DateRangePresetId,
  type ProcedureFilterOption,
  type CaseTypeFilter,
  type MonthlySpan,
} from './statistics'
import {
  clearCheckedTreatments,
  getCheckedTreatmentIds,
  pruneCheckedTreatments,
  setCheckedTreatmentIds,
  subscribeCheckedTreatments,
} from './checkedTreatmentsStore'
import {
  buildMonthlyTableRows,
  decideMonthlySectionView,
  monthlyFilters,
} from './monthlyTableRules'
import {
  describeCheckedCount,
  pruneToExisting,
  resolveCheckedTreatments,
} from './treatmentSelection'

type StatisticsMode = 'presets' | 'checked'

const CASE_TYPE_FILTER_OPTIONS: { id: CaseTypeFilter; label: string }[] = [
  { id: 'clinical', label: 'Clinical' },
  { id: 'practice', label: 'Practice' },
  { id: 'both', label: 'Both' },
]

type StatisticsScreenProps = {
  treatments: SavedTreatment[]
  patients: Patient[]
  procedures: Procedure[]
  templates: ProcedureTemplate[]
  onBack: () => void
}

function toggleId(list: string[], id: string): string[] {
  return list.includes(id)
    ? list.filter(item => item !== id)
    : [...list, id]
}

/*
  Toggles a whole merged procedure-filter option (every id that has
  ever shared its name) as one atomic unit, so selecting "RCT" always
  selects/deselects all of its ids together rather than letting the
  selection get split across a button click.
*/

function toggleIds(list: string[], ids: string[]): string[] {
  const allSelected = ids.every(id => list.includes(id))
  return allSelected
    ? list.filter(id => !ids.includes(id))
    : [...list, ...ids.filter(id => !list.includes(id))]
}

/*
  Plain-language summary of a filter selection, e.g. "All Molars —
  RCT" or "UR6 + UL6 — RCT" or "All Treatments". Shared by the main
  filter panel's "Comparing: X" line and both sides of the optional
  Comparison View, so a given selection always reads the same way.
*/

function describeSelection(
  procedureIds: string[],
  toothGroups: ToothGroup[],
  toothIds: string[],
  templateIds: string[],
  procedureOptions: ProcedureFilterOption[],
  templates: ProcedureTemplate[]
): string {

  const toothParts = [
    ...toothGroups.map(group => group.label),
    ...toothIds.map(
      toothId => getToothById(toothId)?.displayName ?? toothId
    ),
  ]

  /*
    Looks up each selected id's merged option rather than the live
    procedures list, so a deleted-and-recreated procedure's old id
    (no longer in `procedures`) still resolves to its name instead of
    falling back to the raw id - and selecting a merged option (which
    adds every id sharing that name at once) describes as that one
    name, not duplicated once per id.
  */

  const procedureParts =
    procedureOptions
      .filter(option =>
        option.procedureIds.some(id => procedureIds.includes(id))
      )
      .map(option => option.procedureName)

  const templateParts =
    templateIds.map(
      templateId =>
        templates.find(template => template.id === templateId)
          ?.name ?? templateId
    )

  const segments = [
    toothParts.length > 0 ? toothParts.join(' + ') : null,
    procedureParts.length > 0 ? procedureParts.join(' + ') : null,
    templateParts.length > 0 ? templateParts.join(' + ') : null,
  ].filter((segment): segment is string => segment !== null)

  return segments.length > 0 ? segments.join(' — ') : 'All Treatments'

}

function StatisticsScreen({
  treatments,
  patients,
  procedures,
  templates,
  onBack,
}: StatisticsScreenProps) {

  /*
    CASE TYPE FILTER (Phase 3) - defaults to Clinical-only, per this
    phase's own spec ("the preset/readymade statistics default to
    Clinical only"). Deliberately its own, separate piece of state
    from everything below: it's applied to `treatments` BEFORE the
    manual-selection filter engine (applyStatisticsFilters()) ever
    sees them, so that engine - and every one of its own
    procedure/tooth/template pickers below - stays completely
    untouched by this phase.
  */

  const [caseTypeFilter, setCaseTypeFilter] =
    useState<CaseTypeFilter>('clinical')

  const caseTypeFilteredTreatments =
    filterTreatmentsByCaseType(treatments, patients, caseTypeFilter)

  /*
    MAIN FILTER STATE

    Kept as separate, readable-id selections (rather than the raw
    StatisticsFilters shape) because the UI needs to describe what's
    selected in plain language ("All Molars + RCT") - resolving down
    to the toothIds/procedureIds/templateIds the filtering engine
    actually matches against happens just below, via
    resolveToothSelection() from statistics.ts.
  */

  const [selectedProcedureIds, setSelectedProcedureIds] =
    useState<string[]>([])

  const [selectedToothGroupIds, setSelectedToothGroupIds] =
    useState<string[]>([])

  const [selectedToothIds, setSelectedToothIds] =
    useState<string[]>([])

  const [selectedTemplateIds, setSelectedTemplateIds] =
    useState<string[]>([])

  const [showToothChart, setShowToothChart] =
    useState(false)

  const [selectedDatePresetId, setSelectedDatePresetId] =
    useState<DateRangePresetId>('allTime')

  const [customDateFrom, setCustomDateFrom] =
    useState('')

  const [customDateTo, setCustomDateTo] =
    useState('')

  /*
    COMPARISON VIEW (optional, off by default)

    A deliberately smaller filter than the main panel - just
    procedure(s), tooth group(s), and its own date range - no
    specific-tooth picker or template row - so turning it on doesn't
    double the size of the page. It reuses the exact same
    filtering/statistics functions as the main panel, just against a
    second, independent selection.

    Phase 7: Group B's date range is independent of the main panel's
    (its own preset/custom-range state below), specifically so this
    doubles as a month/period comparison - e.g. leave every other
    filter at "All" on both sides and set the main panel to "This
    Month" and this one to "Last Month" to see performance/improvement
    across the two. Defaults to "All Time", same as the main panel, so
    turning comparison on with nothing else touched reproduces the old
    "compare against the same period" behavior whenever the main
    filter is also at its own "All Time" default.
  */

  const [showComparison, setShowComparison] =
    useState(false)

  const [compareProcedureIds, setCompareProcedureIds] =
    useState<string[]>([])

  const [compareToothGroupIds, setCompareToothGroupIds] =
    useState<string[]>([])

  const [compareDatePresetId, setCompareDatePresetId] =
    useState<DateRangePresetId>('allTime')

  const [compareCustomDateFrom, setCompareCustomDateFrom] =
    useState('')

  const [compareCustomDateTo, setCompareCustomDateTo] =
    useState('')

  /*
    CHECKED-TREATMENTS MODE (Phase 8)

    The two modes share this one screen. The preset filter state above
    is simply not shown in checked mode (never reset), so switching
    back restores exactly what was selected. The checked ids live in an
    in-memory store (checkedTreatmentsStore.ts), not in this component,
    so they survive leaving and re-entering the screen; they are never
    written to storage. Ids of deleted treatments are dropped there.
  */

  const [statsMode, setStatsMode] =
    useState<StatisticsMode>('presets')

  const [monthlySpan, setMonthlySpan] =
    useState<MonthlySpan>('last6')

  const storedCheckedIds =
    useSyncExternalStore(
      subscribeCheckedTreatments,
      getCheckedTreatmentIds
    )

  const checkedIds =
    pruneToExisting(storedCheckedIds, treatments)

  useEffect(() => {
    pruneCheckedTreatments(treatments)
  }, [treatments])

  if (treatments.length === 0) {

    return (

      <div className="app">

        <div className="top-header">
          <BackButton onClick={onBack} />
          <div className="title-block">
            <h1>Statistics</h1>
          </div>
          <div className="top-header-spacer" />
        </div>

        <p className="empty-message">
          Complete your first treatment to start seeing statistics.
        </p>

      </div>

    )

  }

  const selectedToothGroups: ToothGroup[] =
    TOOTH_GROUPS.filter(
      group => selectedToothGroupIds.includes(group.id)
    )

  const resolvedToothIds =
    resolveToothSelection(
      selectedToothGroups,
      selectedToothIds
    )

  const resolvedDateRange =
    resolveDateRangePreset(
      selectedDatePresetId,
      resolveCustomDateRange(customDateFrom, customDateTo)
    )

  const filters: StatisticsFilters =
    selectedProcedureIds.length === 0 &&
    resolvedToothIds === null &&
    selectedTemplateIds.length === 0 &&
    resolvedDateRange === null
      ? ALL_TREATMENTS_FILTER
      : {
          procedureIds:
            selectedProcedureIds.length > 0
              ? selectedProcedureIds
              : null,
          templateIds:
            selectedTemplateIds.length > 0
              ? selectedTemplateIds
              : null,
          toothIds: resolvedToothIds,
          dateRange: resolvedDateRange,
        }

  const inCheckedMode = statsMode === 'checked'

  const checkedResolution =
    resolveCheckedTreatments(
      treatments,
      caseTypeFilteredTreatments,
      checkedIds
    )

  /*
    The one place the two modes meet: in checked mode the list is the
    checked treatments that the case-type buttons also allow; in presets
    mode it is today's filtered list, unchanged. Everything below reads
    filteredTreatments, so both modes feed the same calculations.
  */

  const filteredTreatments =
    inCheckedMode
      ? checkedResolution.statisticsTreatments
      : applyStatisticsFilters(caseTypeFilteredTreatments, filters)

  /*
    BY-MONTH TABLE: same filters as the rest of the screen except the
    date range (calculateMonthlyStatistics() ignores it), run over the
    list the case-type buttons already narrowed. All rules and wording
    come from monthlyTableRules.ts.
  */

  const monthlyFilterSet =
    monthlyFilters(inCheckedMode, filters, checkedIds)

  const monthlySpanStats =
    calculateMonthlyStatistics(
      caseTypeFilteredTreatments,
      monthlyFilterSet,
      monthlySpan
    )

  const monthlyAllTimeStats =
    monthlySpan === 'all'
      ? monthlySpanStats
      : calculateMonthlyStatistics(
          caseTypeFilteredTreatments,
          monthlyFilterSet,
          'all'
        )

  const monthlySection = (
    <MonthlyTable
      view={decideMonthlySectionView({
        inCheckedMode,
        existingCheckedCount: checkedResolution.existingCheckedCount,
        spanRows: monthlySpanStats,
        allTimeRows: monthlyAllTimeStats,
      })}
      rows={buildMonthlyTableRows(monthlySpanStats)}
      span={monthlySpan}
      onSpanChange={setMonthlySpan}
      inCheckedMode={inCheckedMode}
    />
  )

  const procedureOptions =
    calculateProcedureFilterOptions(caseTypeFilteredTreatments)

  /*
    Template filter options are scoped to whatever procedure/tooth
    filters are already active (not template-filtered themselves),
    and only shown when there's more than one template in play -
    filtering by template is only "appropriate" (per the spec) when
    it would actually narrow anything down.
  */

  const treatmentsForTemplateOptions =
    applyStatisticsFilters(caseTypeFilteredTreatments, {
      ...filters,
      templateIds: null,
    })

  const availableTemplateOptions =
    Array.from(
      new Set(
        treatmentsForTemplateOptions.map(
          treatment => treatment.templateId
        )
      )
    )
      .map(templateId =>
        templates.find(template => template.id === templateId)
      )
      .filter((template): template is ProcedureTemplate => !!template)
      .sort((a, b) => a.name.localeCompare(b.name))

  const overall =
    calculateTreatmentStatistics(filteredTreatments)

  const procedureStats =
    calculateProcedureStatistics(filteredTreatments)

  const phaseStats =
    calculatePhaseStatistics(filteredTreatments)

  const phaseStatsByProcedure =
    new Map<string, typeof phaseStats>()

  phaseStats.forEach(stat => {
    const list = phaseStatsByProcedure.get(stat.procedureName) ?? []
    list.push(stat)
    phaseStatsByProcedure.set(stat.procedureName, list)
  })

  const timeLossInsights =
    calculateTimeLossInsights(filteredTreatments)

  const overtimeStats =
    calculateOvertimeStatistics(filteredTreatments)

  const rctRegionStats =
    calculateRctRegionStatistics(filteredTreatments, procedures)

  const trendPoints =
    calculateTimeTrend(filteredTreatments)

  const personalizedInsights =
    generatePersonalizedInsights(filteredTreatments, templates)

  /*
    A plain-language summary of the active filter combination, e.g.
    "All Molars — RCT" or "UR6 + UL6 — RCT" or "All Treatments" -
    this is what lets the dentist see at a glance whether they're
    looking at one tooth, a tooth group, a procedure, or everything.
  */

  const selectedDatePresetLabel =
    DATE_RANGE_PRESETS.find(
      preset => preset.id === selectedDatePresetId
    )?.label ?? 'All Time'

  const presetSelectionDescription =
    describeSelection(
      selectedProcedureIds,
      selectedToothGroups,
      selectedToothIds,
      selectedTemplateIds,
      procedureOptions,
      templates
    ) +
    (selectedDatePresetId === 'allTime'
      ? ''
      : ` — ${selectedDatePresetLabel}`)

  const currentSelectionDescription =
    inCheckedMode
      ? describeCheckedCount(checkedResolution.statisticsTreatments.length)
      : presetSelectionDescription

  /*
    COMPARISON VIEW: Group A is just the main filter's own results
    (already computed above as `overall`/`currentSelectionDescription`)
    - Group B is the second, independently-selected set, run through
    the exact same calculateTreatmentStatistics() function.
  */

  const compareToothGroups: ToothGroup[] =
    TOOTH_GROUPS.filter(
      group => compareToothGroupIds.includes(group.id)
    )

  const compareResolvedDateRange =
    resolveDateRangePreset(
      compareDatePresetId,
      resolveCustomDateRange(compareCustomDateFrom, compareCustomDateTo)
    )

  const compareFilters: StatisticsFilters =
    compareProcedureIds.length === 0 &&
    compareToothGroups.length === 0 &&
    compareResolvedDateRange === null
      ? ALL_TREATMENTS_FILTER
      : {
          procedureIds:
            compareProcedureIds.length > 0
              ? compareProcedureIds
              : null,
          templateIds: null,
          toothIds:
            resolveToothSelection(compareToothGroups, []),
          /*
            Group B's OWN date range (see this state's own comment
            above) - independent of the main filter's, specifically so
            two different time periods can be compared side by side.
          */
          dateRange: compareResolvedDateRange,
        }

  const compareFilteredTreatments =
    applyStatisticsFilters(caseTypeFilteredTreatments, compareFilters)

  const compareStats =
    calculateTreatmentStatistics(compareFilteredTreatments)

  const compareDatePresetLabel =
    DATE_RANGE_PRESETS.find(
      preset => preset.id === compareDatePresetId
    )?.label ?? 'All Time'

  const compareSelectionDescription =
    describeSelection(
      compareProcedureIds,
      compareToothGroups,
      [],
      [],
      procedureOptions,
      templates
    ) +
    (compareDatePresetId === 'allTime'
      ? ''
      : ` — ${compareDatePresetLabel}`)

  return (

    <div className="app">

      <div className="top-header">
        <BackButton onClick={onBack} />
        <div className="title-block">
          <h1>Statistics</h1>
        </div>
        <div className="top-header-spacer" />
      </div>


      <div className="stats-page">

        {/* FILTERS */}

        <div className="stats-filter-group">

          <p className="stats-filter-group-label">Mode</p>

          <div
            className="stats-filter-bar"
            role="group"
            aria-label="Statistics mode"
          >

            <button
              type="button"
              className={`stats-filter-button stats-mode-button ${
                !inCheckedMode ? 'stats-filter-active' : ''
              }`}
              aria-pressed={!inCheckedMode}
              onClick={() => setStatsMode('presets')}
            >
              Presets
            </button>

            <button
              type="button"
              className={`stats-filter-button stats-mode-button ${
                inCheckedMode ? 'stats-filter-active' : ''
              }`}
              aria-pressed={inCheckedMode}
              onClick={() => setStatsMode('checked')}
            >
              Checked treatments
            </button>

          </div>

        </div>


        <div className="stats-filter-group">

          <p className="stats-filter-group-label">Case Type</p>

          <div className="stats-filter-bar">

            {CASE_TYPE_FILTER_OPTIONS.map(option => (

              <button
                key={option.id}
                type="button"
                className={`stats-filter-button stats-case-type-button ${
                  caseTypeFilter === option.id
                    ? 'stats-filter-active'
                    : ''
                }`}
                onClick={() => setCaseTypeFilter(option.id)}
              >
                {option.label}
              </button>

            ))}

          </div>

        </div>


        {!inCheckedMode && (
        <>

        <div className="stats-filter-group">

          <p className="stats-filter-group-label">Procedure</p>

          <div className="stats-filter-bar">

            <button
              type="button"
              className={`stats-filter-button ${
                selectedProcedureIds.length === 0
                  ? 'stats-filter-active'
                  : ''
              }`}
              onClick={() => setSelectedProcedureIds([])}
            >
              All Procedures
            </button>

            {procedureOptions.map(option => (

              <button
                key={option.procedureName.toLowerCase()}
                type="button"
                className={`stats-filter-button ${
                  option.procedureIds.every(id =>
                    selectedProcedureIds.includes(id)
                  )
                    ? 'stats-filter-active'
                    : ''
                }`}
                onClick={() =>
                  setSelectedProcedureIds(
                    toggleIds(selectedProcedureIds, option.procedureIds)
                  )
                }
              >
                {option.procedureName}
              </button>

            ))}

          </div>

        </div>


        <div className="stats-filter-group">

          <p className="stats-filter-group-label">Tooth Group</p>

          <div className="stats-filter-bar">

            <button
              type="button"
              className={`stats-filter-button ${
                selectedToothGroupIds.length === 0 &&
                selectedToothIds.length === 0
                  ? 'stats-filter-active'
                  : ''
              }`}
              onClick={() => {
                setSelectedToothGroupIds([])
                setSelectedToothIds([])
              }}
            >
              All Teeth
            </button>

            {TOOTH_GROUPS.map(group => (

              <button
                key={group.id}
                type="button"
                className={`stats-filter-button ${
                  selectedToothGroupIds.includes(group.id)
                    ? 'stats-filter-active'
                    : ''
                }`}
                onClick={() =>
                  setSelectedToothGroupIds(
                    toggleId(selectedToothGroupIds, group.id)
                  )
                }
              >
                {group.label}
              </button>

            ))}

            <button
              type="button"
              className={`stats-filter-button ${
                showToothChart || selectedToothIds.length > 0
                  ? 'stats-filter-active'
                  : ''
              }`}
              onClick={() => setShowToothChart(!showToothChart)}
            >
              Specific Teeth
              {selectedToothIds.length > 0 &&
                ` (${selectedToothIds.length})`}
            </button>

          </div>

          {showToothChart && (

            <ToothChart
              selectedToothIds={selectedToothIds}
              onToggle={toothId =>
                setSelectedToothIds(
                  toggleId(selectedToothIds, toothId)
                )
              }
            />

          )}

        </div>


        {availableTemplateOptions.length > 1 && (

          <div className="stats-filter-group">

            <p className="stats-filter-group-label">Template</p>

            <div className="stats-filter-bar">

              <button
                type="button"
                className={`stats-filter-button ${
                  selectedTemplateIds.length === 0
                    ? 'stats-filter-active'
                    : ''
                }`}
                onClick={() => setSelectedTemplateIds([])}
              >
                All Templates
              </button>

              {availableTemplateOptions.map(template => (

                <button
                  key={template.id}
                  type="button"
                  className={`stats-filter-button ${
                    selectedTemplateIds.includes(template.id)
                      ? 'stats-filter-active'
                      : ''
                  }`}
                  onClick={() =>
                    setSelectedTemplateIds(
                      toggleId(selectedTemplateIds, template.id)
                    )
                  }
                >
                  {template.name}
                </button>

              ))}

            </div>

          </div>

        )}


        <div className="stats-filter-group">

          <p className="stats-filter-group-label">Date Range</p>

          <div className="stats-filter-bar">

            {DATE_RANGE_PRESETS.map(preset => (

              <button
                key={preset.id}
                type="button"
                className={`stats-filter-button ${
                  selectedDatePresetId === preset.id
                    ? 'stats-filter-active'
                    : ''
                }`}
                onClick={() => setSelectedDatePresetId(preset.id)}
              >
                {preset.label}
              </button>

            ))}

          </div>

          {selectedDatePresetId === 'custom' && (

            <div className="custom-date-range-row">

              <label>
                From
                <input
                  type="date"
                  value={customDateFrom}
                  onChange={event =>
                    setCustomDateFrom(event.target.value)
                  }
                />
              </label>

              <label>
                To
                <input
                  type="date"
                  value={customDateTo}
                  onChange={event =>
                    setCustomDateTo(event.target.value)
                  }
                />
              </label>

            </div>

          )}

        </div>


        </>
        )}


        {inCheckedMode && (
          <CheckedTreatmentsPanel
            treatments={caseTypeFilteredTreatments}
            patients={patients}
            checked={checkedIds}
            hiddenByCaseTypeCount={checkedResolution.hiddenByCaseTypeCount}
            onCheckedChange={setCheckedTreatmentIds}
            onClear={clearCheckedTreatments}
          />
        )}


        <p className="comparison-description">
          Comparing: <strong>{currentSelectionDescription}</strong>
        </p>


        {/* OPTIONAL COMPARISON VIEW */}

        {!inCheckedMode && (
        <div className="stats-compare-toggle">

          <button
            type="button"
            className="stats-filter-button"
            onClick={() => setShowComparison(!showComparison)}
          >
            {showComparison ? 'Hide Comparison' : 'Compare With Another Group'}
          </button>

        </div>
        )}

        {!inCheckedMode && showComparison && (

          <div className="stats-compare-section">

            <p className="stats-filter-group-label">
              Compare Against
            </p>

            <div className="stats-filter-bar">

              <button
                type="button"
                className={`stats-filter-button ${
                  compareProcedureIds.length === 0
                    ? 'stats-filter-active'
                    : ''
                }`}
                onClick={() => setCompareProcedureIds([])}
              >
                All Procedures
              </button>

              {procedureOptions.map(option => (

                <button
                  key={option.procedureName.toLowerCase()}
                  type="button"
                  className={`stats-filter-button ${
                    option.procedureIds.every(id =>
                      compareProcedureIds.includes(id)
                    )
                      ? 'stats-filter-active'
                      : ''
                  }`}
                  onClick={() =>
                    setCompareProcedureIds(
                      toggleIds(compareProcedureIds, option.procedureIds)
                    )
                  }
                >
                  {option.procedureName}
                </button>

              ))}

            </div>

            <div className="stats-filter-bar">

              <button
                type="button"
                className={`stats-filter-button ${
                  compareToothGroupIds.length === 0
                    ? 'stats-filter-active'
                    : ''
                }`}
                onClick={() => setCompareToothGroupIds([])}
              >
                All Teeth
              </button>

              {TOOTH_GROUPS.map(group => (

                <button
                  key={group.id}
                  type="button"
                  className={`stats-filter-button ${
                    compareToothGroupIds.includes(group.id)
                      ? 'stats-filter-active'
                      : ''
                  }`}
                  onClick={() =>
                    setCompareToothGroupIds(
                      toggleId(compareToothGroupIds, group.id)
                    )
                  }
                >
                  {group.label}
                </button>

              ))}

            </div>

            <p className="stats-filter-group-label">
              Date Range (independent of the main filter above - this
              is what lets you compare two different time periods)
            </p>

            <div className="stats-filter-bar">

              {DATE_RANGE_PRESETS.map(preset => (

                <button
                  key={preset.id}
                  type="button"
                  className={`stats-filter-button ${
                    compareDatePresetId === preset.id
                      ? 'stats-filter-active'
                      : ''
                  }`}
                  onClick={() => setCompareDatePresetId(preset.id)}
                >
                  {preset.label}
                </button>

              ))}

            </div>

            {compareDatePresetId === 'custom' && (

              <div className="custom-date-range-row">

                <label>
                  From
                  <input
                    type="date"
                    value={compareCustomDateFrom}
                    onChange={event =>
                      setCompareCustomDateFrom(event.target.value)
                    }
                  />
                </label>

                <label>
                  To
                  <input
                    type="date"
                    value={compareCustomDateTo}
                    onChange={event =>
                      setCompareCustomDateTo(event.target.value)
                    }
                  />
                </label>

              </div>

            )}

            <table className="stats-table stats-compare-table">

              <thead>
                <tr>
                  <th></th>
                  <th>{currentSelectionDescription}</th>
                  <th>{compareSelectionDescription}</th>
                </tr>
              </thead>

              <tbody>

                <tr>
                  <td>Treatments</td>
                  <td>{overall.completedCount}</td>
                  <td>{compareStats.completedCount}</td>
                </tr>

                <tr>
                  <td>Avg Target</td>
                  <td>{formatTime(overall.averageExpectedDuration ?? 0)}</td>
                  <td>{formatTime(compareStats.averageExpectedDuration ?? 0)}</td>
                </tr>

                <tr>
                  <td>Avg Actual</td>
                  <td>{formatTime(overall.averageActualDuration ?? 0)}</td>
                  <td>{formatTime(compareStats.averageActualDuration ?? 0)}</td>
                </tr>

                <tr>
                  <td>Avg Overtime</td>
                  <td>+{formatTime(overall.averageOvertimeDuration ?? 0)}</td>
                  <td>+{formatTime(compareStats.averageOvertimeDuration ?? 0)}</td>
                </tr>

              </tbody>

            </table>

            {(overall.completedCount < MIN_SAMPLE_SIZE ||
              compareStats.completedCount < MIN_SAMPLE_SIZE) && (

              <p className="small-sample-note">
                One or both groups have very few treatments - treat
                this comparison as indicative only.
              </p>

            )}

          </div>

        )}


        {filteredTreatments.length === 0 && (

          <p className="empty-message">
            {inCheckedMode
              ? checkedResolution.existingCheckedCount === 0
                ? 'Check treatments above to see statistics'
                : 'None of the checked treatments match the case-type buttons above - change the case type to see their statistics.'
              : 'No completed treatments match this filter yet.'}
          </p>

        )}

        {filteredTreatments.length === 0 && monthlySection}


        {filteredTreatments.length > 0 && (

          <>

            {/* MAIN STATISTICS */}

            <div className="stats-section">

              <h2>Overview</h2>

              <div className="stats-grid">

                <div className="stats-tile">
                  <span className="stats-tile-label">Treatments</span>
                  <span className="stats-tile-value">
                    {overall.completedCount}
                  </span>
                </div>

                <div className="stats-tile">
                  <span className="stats-tile-label">Average Target</span>
                  <span className="stats-tile-value">
                    {formatTime(overall.averageExpectedDuration ?? 0)}
                  </span>
                </div>

                <div className="stats-tile">
                  <span className="stats-tile-label">Average Actual</span>
                  <span className="stats-tile-value">
                    {formatTime(overall.averageActualDuration ?? 0)}
                  </span>
                </div>

                <div className="stats-tile">
                  <span className="stats-tile-label">Average Difference</span>
                  <span className="stats-tile-value">
                    {formatSignedTime(overall.averageDifferenceDuration ?? 0)}
                  </span>
                </div>

                <div className="stats-tile">
                  <span className="stats-tile-label">Average Overtime</span>
                  <span className="stats-tile-value">
                    +{formatTime(overall.averageOvertimeDuration ?? 0)}
                  </span>
                </div>

                <div className="stats-tile">
                  <span className="stats-tile-label">Within Target</span>
                  <span className="stats-tile-value">
                    {Math.round(overall.percentWithinTarget ?? 0)}%
                  </span>
                </div>

              </div>

              {overall.completedCount > 0 &&
                overall.completedCount < MIN_SAMPLE_SIZE && (

                  <p className="small-sample-note">
                    Small sample size ({overall.completedCount} treatment
                    {overall.completedCount === 1 ? '' : 's'}) - treat
                    this as indicative only.
                  </p>

                )}

              <div className="stats-fastest-slowest">

                {/*
                  Patient name included alongside tooth/procedure/date
                  - same identifying detail (and no more) the other
                  cross-patient summary view already shows for each
                  treatment (see the Search Treatments screen's own
                  treatment-card rendering in App.tsx).
                */}

                {overall.fastestTreatment && (
                  <p>
                    <strong>Fastest:</strong>{' '}
                    {overall.fastestTreatment.patientName}
                    {' — '}
                    {getToothLabel(overall.fastestTreatment.toothId)}
                    {' — '}
                    {overall.fastestTreatment.procedureName}
                    {' — '}
                    {formatTime(overall.fastestTreatment.totalActualDuration)}
                    {' ('}
                    {formatDate(overall.fastestTreatment.date)}
                    {')'}
                  </p>
                )}

                {overall.slowestTreatment && (
                  <p>
                    <strong>Slowest:</strong>{' '}
                    {overall.slowestTreatment.patientName}
                    {' — '}
                    {getToothLabel(overall.slowestTreatment.toothId)}
                    {' — '}
                    {overall.slowestTreatment.procedureName}
                    {' — '}
                    {formatTime(overall.slowestTreatment.totalActualDuration)}
                    {' ('}
                    {formatDate(overall.slowestTreatment.date)}
                    {')'}
                  </p>
                )}

              </div>

            </div>


            {/* BY MONTH (below the overview) */}

            {monthlySection}


            {/* WHERE AM I LOSING TIME */}

            <div className="stats-section">

              <h2>Where Am I Losing Time?</h2>

              {filteredTreatments.length < MIN_SAMPLE_SIZE && (
                <p className="empty-message">
                  Complete more treatments to establish a reliable average.
                </p>
              )}

              {filteredTreatments.length >= MIN_SAMPLE_SIZE &&
                timeLossInsights.length === 0 && (
                  <p className="empty-message">
                    No phases are currently averaging over their target.
                  </p>
                )}

              {timeLossInsights.map(insight => (

                <div
                  className="time-loss-card"
                  key={`${insight.procedureId}::${insight.phaseName}`}
                >

                  <strong>
                    {insight.phaseName}
                    {' '}
                    <span className="time-loss-procedure">
                      ({insight.procedureName})
                    </span>
                  </strong>

                  <p>
                    Target: {formatTime(insight.averageExpectedDuration)}
                  </p>

                  <p>
                    Your average: {formatTime(insight.averageActualDuration)}
                  </p>

                  <p className="summary-diff-over">
                    Difference: {formatSignedTime(insight.averageDifference)}
                  </p>

                </div>

              ))}

            </div>


            {/* PROCEDURE STATISTICS */}

            <div className="stats-section">

              <h2>Procedure Statistics</h2>

              <table className="stats-table">

                <thead>
                  <tr>
                    <th>Procedure</th>
                    <th>Treatments</th>
                    <th>Target</th>
                    <th>Average</th>
                  </tr>
                </thead>

                <tbody>

                  {procedureStats.map(stat => (

                    <tr key={stat.procedureId}>
                      <td>{stat.procedureName}</td>
                      <td>{stat.treatmentCount}</td>
                      <td>{formatTime(stat.averageExpectedDuration)}</td>
                      <td>{formatTime(stat.averageActualDuration)}</td>
                    </tr>

                  ))}

                </tbody>

              </table>

            </div>


            {/* RCT REGION STATISTICS */}

            {rctRegionStats.length > 0 && (

              <div className="stats-section">

                <h2>RCT Statistics</h2>

                {rctRegionStats.map(stat => (

                  <p key={stat.templateId}>
                    {stat.templateName}
                    {' — '}
                    {formatTime(stat.averageActualDuration)} average
                    {' '}
                    <span className="stats-sample-size">
                      ({stat.treatmentCount} treatment
                      {stat.treatmentCount === 1 ? '' : 's'})
                    </span>
                  </p>

                ))}

              </div>

            )}


            {/*
              PHASE PERFORMANCE for the current comparison, grouped
              by procedure so unrelated procedures are never mixed
              into one table (e.g. when "All Procedures" is active).
              Once the filter narrows to a single procedure/tooth
              group, this collapses to exactly one table - the
              "Molar RCT - Phase Performance" breakdown.
            */}

            <div className="stats-section">

              <h2>Phase Performance</h2>

              {Array.from(phaseStatsByProcedure.entries()).map(
                ([procedureName, stats]) => (

                  <div key={procedureName} className="stats-subsection">

                    <h3>{procedureName}</h3>

                    <table className="stats-table">

                      <thead>
                        <tr>
                          <th>Phase</th>
                          <th>Target</th>
                          <th>Average Actual</th>
                          <th>Difference</th>
                        </tr>
                      </thead>

                      <tbody>

                        {stats.map(stat => (

                          <tr key={stat.phaseName}>

                            <td>
                              {stat.phaseName}
                              {stat.sampleSize < MIN_SAMPLE_SIZE && (
                                <span className="stats-sample-size">
                                  {' '}(n={stat.sampleSize})
                                </span>
                              )}
                            </td>

                            <td>
                              {formatTime(stat.averageExpectedDuration)}
                            </td>

                            <td>
                              {formatTime(stat.averageActualDuration)}
                            </td>

                            <td
                              className={
                                stat.averageDifference > 0
                                  ? 'summary-diff-over'
                                  : stat.averageDifference < 0
                                    ? 'summary-diff-under'
                                    : ''
                              }
                            >
                              {formatSignedTime(stat.averageDifference)}
                            </td>

                          </tr>

                        ))}

                      </tbody>

                    </table>

                  </div>

                )
              )}

            </div>


            {/* OVERTIME STATISTICS */}

            <div className="stats-section">

              <h2>Overtime Statistics</h2>

              <div className="stats-grid">

                <div className="stats-tile">
                  <span className="stats-tile-label">With Overtime</span>
                  <span className="stats-tile-value">
                    {Math.round(overtimeStats.percentWithOvertime ?? 0)}%
                  </span>
                </div>

                <div className="stats-tile">
                  <span className="stats-tile-label">Average Overtime</span>
                  <span className="stats-tile-value">
                    +{formatTime(overtimeStats.averageOvertimeDuration ?? 0)}
                  </span>
                </div>

                <div className="stats-tile">
                  <span className="stats-tile-label">Largest Overtime</span>
                  <span className="stats-tile-value">
                    +{formatTime(overtimeStats.largestOvertimeDuration ?? 0)}
                  </span>
                </div>

              </div>

              <div className="stats-subsection">

                <h3>Overtime by Procedure</h3>

                <table className="stats-table">

                  <thead>
                    <tr>
                      <th>Procedure</th>
                      <th>With Overtime</th>
                      <th>Average Overtime</th>
                    </tr>
                  </thead>

                  <tbody>

                    {overtimeStats.byProcedure.map(group => (

                      <tr key={group.key}>
                        <td>{group.label}</td>
                        <td>{Math.round(group.percentWithOvertime)}%</td>
                        <td>+{formatTime(group.averageOvertimeDuration)}</td>
                      </tr>

                    ))}

                  </tbody>

                </table>

              </div>

              <div className="stats-subsection">

                <h3>Overtime by Phase</h3>

                <table className="stats-table">

                  <thead>
                    <tr>
                      <th>Phase</th>
                      <th>Procedure</th>
                      <th>Average Overtime</th>
                    </tr>
                  </thead>

                  <tbody>

                    {overtimeStats.byPhase.map(stat => (

                      <tr key={`${stat.procedureId}::${stat.phaseName}`}>
                        <td>{stat.phaseName}</td>
                        <td>{stat.procedureName}</td>
                        <td>+{formatTime(stat.averageOvertimeDuration)}</td>
                      </tr>

                    ))}

                  </tbody>

                </table>

              </div>

            </div>


            {/* TIME TRENDS */}

            <div className="stats-section">

              <h2>Time Trends</h2>

              <TimeTrendChart points={trendPoints} />

            </div>


            {/* PERSONALIZED INSIGHTS */}

            <div className="stats-section">

              <h2>Insights</h2>

              {personalizedInsights.length === 0 &&
                timeLossInsights.length === 0 && (
                  <p className="empty-message">
                    Complete more treatments to establish a reliable average.
                  </p>
                )}

              {timeLossInsights.length > 0 && (
                <p className="stats-insight">
                  {timeLossInsights[0].phaseName} has the largest
                  average time difference (
                  {formatSignedTime(timeLossInsights[0].averageDifference)}
                  ).
                </p>
              )}

              {personalizedInsights.map(insight => (
                <p key={insight.templateId} className="stats-insight">
                  {insight.message}
                </p>
              ))}

            </div>

          </>

        )}

      </div>

    </div>

  )

}

export default StatisticsScreen
