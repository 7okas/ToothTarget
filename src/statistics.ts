import type { Procedure, ProcedureTemplate, SavedTreatment } from './App'
import { getToothIdsForGroup, type ToothGroup } from './teeth'

/*
  STATISTICS

  Every function here is pure: SavedTreatment[] (and occasionally the
  live procedures/templates lists) in, a plain data/number result out.
  Nothing here touches React state or renders anything - StatisticsScreen
  is the only thing that reads these results and turns them into UI.

  All numbers are seconds unless named otherwise. Every calculation is
  performed directly against real completed-treatment records; nothing
  here is sample/fake data.
*/

const MIN_SAMPLE_SIZE = 3

function mean(values: number[]): number | null {

  if (values.length === 0) {
    return null
  }

  return (
    values.reduce((total, value) => total + value, 0) /
    values.length
  )

}

/*
  FILTERS

  Procedures, templates, and teeth are each either unrestricted
  (null) or an explicit list of ids to match against - "OR" within a
  dimension (e.g. toothIds matches ANY of the listed teeth, so a
  dentist can combine "Molars + Premolars" into one filter), "AND"
  across dimensions (a treatment must satisfy every non-null
  dimension). Tooth *groups* (all molars, upper premolars, ...) are
  a UI-level concept - resolveToothSelection() in this module turns
  a set of group ids / individual toothIds into the concrete toothIds
  list this filter actually matches against (see teeth.ts's
  TOOTH_GROUPS), so the filtering engine itself only ever deals with
  plain toothId strings.

  The shape is deliberately open so future filters (patient) can be
  added as additional optional fields without changing every call
  site - applyStatisticsFilters() is the single place that would
  grow to handle them.
*/

export type DateRange = {
  from: string
  to: string
}

export type StatisticsFilters = {
  procedureIds: string[] | null
  templateIds: string[] | null
  toothIds: string[] | null
  dateRange: DateRange | null
  // Reserved for future filters - intentionally unimplemented for now:
  // patientId?: string | null
}

export const ALL_TREATMENTS_FILTER: StatisticsFilters = {
  procedureIds: null,
  templateIds: null,
  toothIds: null,
  dateRange: null,
}

export function applyStatisticsFilters(
  treatments: SavedTreatment[],
  filters: StatisticsFilters
): SavedTreatment[] {

  return treatments.filter(treatment => {

    if (
      filters.procedureIds !== null &&
      !filters.procedureIds.includes(treatment.procedureId)
    ) {
      return false
    }

    if (
      filters.templateIds !== null &&
      !filters.templateIds.includes(treatment.templateId)
    ) {
      return false
    }

    if (
      filters.toothIds !== null &&
      !filters.toothIds.includes(treatment.toothId)
    ) {
      return false
    }

    if (filters.dateRange !== null) {

      const treatmentTime = new Date(treatment.date).getTime()
      const fromTime = new Date(filters.dateRange.from).getTime()
      const toTime = new Date(filters.dateRange.to).getTime()

      if (treatmentTime < fromTime || treatmentTime > toTime) {
        return false
      }

    }

    return true

  })

}

/*
  DATE RANGE PRESETS

  "Today"/"This Week"/etc resolve against the caller's local clock
  (defaulting to now) into a concrete {from, to} range in the same
  ISO-string shape a SavedTreatment.date already uses, so
  applyStatisticsFilters() never needs to know these preset names
  exist - it only ever compares two timestamps.
*/

export type DateRangePresetId =
  | 'today'
  | 'thisWeek'
  | 'thisMonth'
  | 'last3Months'
  | 'thisYear'
  | 'allTime'
  | 'custom'

export const DATE_RANGE_PRESETS: {
  id: DateRangePresetId
  label: string
}[] = [
  { id: 'allTime', label: 'All Time' },
  { id: 'today', label: 'Today' },
  { id: 'thisWeek', label: 'This Week' },
  { id: 'thisMonth', label: 'This Month' },
  { id: 'last3Months', label: 'Last 3 Months' },
  { id: 'thisYear', label: 'This Year' },
  { id: 'custom', label: 'Custom Range' },
]

export function resolveDateRangePreset(
  presetId: DateRangePresetId,
  customRange: DateRange | null,
  now: Date = new Date()
): DateRange | null {

  if (presetId === 'allTime') {
    return null
  }

  if (presetId === 'custom') {
    return customRange
  }

  const start = new Date(now)
  start.setHours(0, 0, 0, 0)

  const end = new Date(now)
  end.setHours(23, 59, 59, 999)

  if (presetId === 'thisWeek') {
    start.setDate(start.getDate() - start.getDay())
  }

  if (presetId === 'thisMonth') {
    start.setDate(1)
  }

  if (presetId === 'last3Months') {
    start.setMonth(start.getMonth() - 3)
  }

  if (presetId === 'thisYear') {
    start.setMonth(0, 1)
  }

  return {
    from: start.toISOString(),
    to: end.toISOString(),
  }

}

/*
  Resolves a UI-level tooth selection (some picked tooth groups, plus
  some individually picked teeth) into the deduplicated toothIds list
  a StatisticsFilters actually uses. Returns null (meaning "no tooth
  restriction") when nothing is selected, matching the "unrestricted"
  convention used by every other filter dimension.
*/

export function resolveToothSelection(
  groups: ToothGroup[],
  individualToothIds: string[]
): string[] | null {

  const combined = new Set<string>(individualToothIds)

  groups.forEach(group => {
    getToothIdsForGroup(group).forEach(
      toothId => combined.add(toothId)
    )
  })

  return combined.size === 0 ? null : Array.from(combined)

}


/*
  MAIN TREATMENT STATISTICS
*/

export type TreatmentStatistics = {
  completedCount: number
  averageActualDuration: number | null
  averageExpectedDuration: number | null
  /*
    averageActualDuration - averageExpectedDuration, as one signed
    aggregate figure (can be negative, unlike averageOvertimeDuration
    which only ever sums the over-target portion of each treatment).
  */
  averageDifferenceDuration: number | null
  averageOvertimeDuration: number | null
  percentWithinTarget: number | null
  fastestTreatment: SavedTreatment | null
  slowestTreatment: SavedTreatment | null
}

export function calculateAverageTreatmentTime(
  treatments: SavedTreatment[]
): number | null {

  return mean(
    treatments.map(treatment => treatment.totalActualDuration)
  )

}

export function calculateFastestTreatment(
  treatments: SavedTreatment[]
): SavedTreatment | null {

  return treatments.reduce<SavedTreatment | null>(
    (fastest, treatment) =>
      !fastest ||
      treatment.totalActualDuration < fastest.totalActualDuration
        ? treatment
        : fastest,
    null
  )

}

export function calculateSlowestTreatment(
  treatments: SavedTreatment[]
): SavedTreatment | null {

  return treatments.reduce<SavedTreatment | null>(
    (slowest, treatment) =>
      !slowest ||
      treatment.totalActualDuration > slowest.totalActualDuration
        ? treatment
        : slowest,
    null
  )

}

export function calculateTreatmentStatistics(
  treatments: SavedTreatment[]
): TreatmentStatistics {

  const withinTargetCount =
    treatments.filter(
      treatment => treatment.totalOvertimeDuration === 0
    ).length

  const averageActualDuration =
    calculateAverageTreatmentTime(treatments)

  const averageExpectedDuration =
    mean(treatments.map(t => t.totalExpectedDuration))

  return {

    completedCount: treatments.length,

    averageActualDuration,

    averageExpectedDuration,

    averageDifferenceDuration:
      averageActualDuration !== null &&
      averageExpectedDuration !== null
        ? averageActualDuration - averageExpectedDuration
        : null,

    averageOvertimeDuration:
      mean(treatments.map(t => t.totalOvertimeDuration)),

    percentWithinTarget:
      treatments.length === 0
        ? null
        : (withinTargetCount / treatments.length) * 100,

    fastestTreatment:
      calculateFastestTreatment(treatments),

    slowestTreatment:
      calculateSlowestTreatment(treatments),

  }

}


/*
  FUTURE APPOINTMENT ESTIMATION (Phase 17)

  Purely informational - a typical duration and historical range for
  one specific tooth + procedure combination, built only from real
  completed-treatment records that already exist. This never reads
  or writes a template's expected duration, never modifies a
  treatment target, and never schedules anything on its own - it
  only surfaces what already happened, for the dentist to weigh
  however (or whether) they choose. Requires the same minimum sample
  size as every other averaged statistic in this file, so a single
  unusually fast or slow treatment can never masquerade as "typical."
*/

export type AppointmentDurationEstimate = {
  sampleSize: number
  typicalDuration: number
  minDuration: number
  maxDuration: number
}

export function calculateAppointmentDurationEstimate(
  treatments: SavedTreatment[],
  toothId: string,
  procedureId: string,
  minSampleSize: number = MIN_SAMPLE_SIZE
): AppointmentDurationEstimate | null {

  const matching = treatments.filter(
    treatment =>
      treatment.toothId === toothId &&
      treatment.procedureId === procedureId
  )

  if (matching.length < minSampleSize) {
    return null
  }

  const durations =
    matching.map(treatment => treatment.totalActualDuration)

  return {

    sampleSize: matching.length,

    typicalDuration: mean(durations) as number,

    minDuration: Math.min(...durations),

    maxDuration: Math.max(...durations),

  }

}


/*
  PHASE STATISTICS

  Grouped by procedure (not exploded per template variant) so
  unrelated procedures are never mixed - a "Shaping" phase from RCT
  and a same-named phase from an unrelated custom procedure are kept
  separate. Skipped phase records are excluded: a skipped phase
  didn't happen, so a 0-second "actual" for it would understate real
  performance rather than reflect it.
*/

export type PhaseStatistic = {
  procedureId: string
  procedureName: string
  phaseName: string
  sampleSize: number
  averageExpectedDuration: number
  averageActualDuration: number
  averageDifference: number
}

export function calculatePhaseStatistics(
  treatments: SavedTreatment[]
): PhaseStatistic[] {

  const groups = new Map<
    string,
    {
      procedureId: string
      procedureName: string
      phaseName: string
      expected: number[]
      actual: number[]
    }
  >()

  treatments.forEach(treatment => {

    treatment.phaseRecords
      .filter(record => !record.skipped)
      .forEach(record => {

        const key = `${treatment.procedureId}::${record.name}`

        const group =
          groups.get(key) ??
          {
            procedureId: treatment.procedureId,
            procedureName: treatment.procedureName,
            phaseName: record.name,
            expected: [],
            actual: [],
          }

        group.expected.push(record.expectedDuration)
        group.actual.push(record.actualDuration)

        groups.set(key, group)

      })

  })

  return Array.from(groups.values())
    .map(group => {

      const averageExpectedDuration =
        mean(group.expected) ?? 0

      const averageActualDuration =
        mean(group.actual) ?? 0

      return {
        procedureId: group.procedureId,
        procedureName: group.procedureName,
        phaseName: group.phaseName,
        sampleSize: group.actual.length,
        averageExpectedDuration,
        averageActualDuration,
        averageDifference:
          averageActualDuration - averageExpectedDuration,
      }

    })
    .sort((a, b) => {

      const procedureOrder =
        a.procedureName.localeCompare(b.procedureName)

      if (procedureOrder !== 0) {
        return procedureOrder
      }

      return a.phaseName.localeCompare(b.phaseName)

    })

}


/*
  WHERE AM I LOSING TIME?

  Reuses calculatePhaseStatistics(), keeping only phases that are
  actually running over target, with enough samples to mean
  something, sorted worst-first. minSampleSize defaults to 3 per
  spec - "do not make strong conclusions from one treatment."
*/

export type TimeLossInsight = PhaseStatistic

export function calculateTimeLossInsights(
  treatments: SavedTreatment[],
  minSampleSize: number = MIN_SAMPLE_SIZE
): TimeLossInsight[] {

  return calculatePhaseStatistics(treatments)
    .filter(
      stat =>
        stat.averageDifference > 0 &&
        stat.sampleSize >= minSampleSize
    )
    .sort((a, b) => b.averageDifference - a.averageDifference)

}


/*
  PROCEDURE STATISTICS
*/

export type ProcedureStatistic = {
  procedureId: string
  procedureName: string
  treatmentCount: number
  averageExpectedDuration: number
  averageActualDuration: number
}

export function calculateProcedureStatistics(
  treatments: SavedTreatment[]
): ProcedureStatistic[] {

  const groups = new Map<
    string,
    { procedureName: string; treatments: SavedTreatment[] }
  >()

  treatments.forEach(treatment => {

    const group =
      groups.get(treatment.procedureId) ??
      { procedureName: treatment.procedureName, treatments: [] }

    group.treatments.push(treatment)

    groups.set(treatment.procedureId, group)

  })

  return Array.from(groups.entries())
    .map(([procedureId, group]) => ({
      procedureId,
      procedureName: group.procedureName,
      treatmentCount: group.treatments.length,
      averageExpectedDuration:
        mean(group.treatments.map(t => t.totalExpectedDuration)) ?? 0,
      averageActualDuration:
        mean(group.treatments.map(t => t.totalActualDuration)) ?? 0,
    }))
    .sort((a, b) => b.treatmentCount - a.treatmentCount)

}


/*
  OVERTIME STATISTICS
*/

export type OvertimeGroupStatistic = {
  key: string
  label: string
  treatmentCount: number
  percentWithOvertime: number
  averageOvertimeDuration: number
}

export type OvertimePhaseStatistic = {
  procedureId: string
  procedureName: string
  phaseName: string
  sampleSize: number
  averageOvertimeDuration: number
}

export type OvertimeStatistics = {
  percentWithOvertime: number | null
  averageOvertimeDuration: number | null
  largestOvertimeDuration: number | null
  largestOvertimeTreatment: SavedTreatment | null
  byProcedure: OvertimeGroupStatistic[]
  byPhase: OvertimePhaseStatistic[]
}

export function calculateOvertimeStatistics(
  treatments: SavedTreatment[]
): OvertimeStatistics {

  const overtimeTreatments =
    treatments.filter(t => t.totalOvertimeDuration > 0)

  const largestOvertimeTreatment =
    treatments.reduce<SavedTreatment | null>(
      (largest, treatment) =>
        !largest ||
        treatment.totalOvertimeDuration > largest.totalOvertimeDuration
          ? treatment
          : largest,
      null
    )

  const byProcedure =
    calculateProcedureStatistics(treatments).map(stat => {

      const procedureTreatments =
        treatments.filter(t => t.procedureId === stat.procedureId)

      const procedureOvertimeCount =
        procedureTreatments.filter(
          t => t.totalOvertimeDuration > 0
        ).length

      return {
        key: stat.procedureId,
        label: stat.procedureName,
        treatmentCount: stat.treatmentCount,
        percentWithOvertime:
          (procedureOvertimeCount / procedureTreatments.length) * 100,
        averageOvertimeDuration:
          mean(procedureTreatments.map(t => t.totalOvertimeDuration)) ?? 0,
      }

    })

  const phaseOvertimeGroups = new Map<
    string,
    {
      procedureId: string
      procedureName: string
      phaseName: string
      overtimeSeconds: number[]
    }
  >()

  treatments.forEach(treatment => {

    treatment.phaseRecords
      .filter(record => !record.skipped)
      .forEach(record => {

        const key = `${treatment.procedureId}::${record.name}`

        const group =
          phaseOvertimeGroups.get(key) ??
          {
            procedureId: treatment.procedureId,
            procedureName: treatment.procedureName,
            phaseName: record.name,
            overtimeSeconds: [],
          }

        group.overtimeSeconds.push(
          Math.max(0, record.actualDuration - record.expectedDuration)
        )

        phaseOvertimeGroups.set(key, group)

      })

  })

  const byPhase =
    Array.from(phaseOvertimeGroups.values())
      .map(group => ({
        procedureId: group.procedureId,
        procedureName: group.procedureName,
        phaseName: group.phaseName,
        sampleSize: group.overtimeSeconds.length,
        averageOvertimeDuration: mean(group.overtimeSeconds) ?? 0,
      }))
      .sort(
        (a, b) => b.averageOvertimeDuration - a.averageOvertimeDuration
      )

  return {

    percentWithOvertime:
      treatments.length === 0
        ? null
        : (overtimeTreatments.length / treatments.length) * 100,

    averageOvertimeDuration:
      mean(treatments.map(t => t.totalOvertimeDuration)),

    largestOvertimeDuration:
      largestOvertimeTreatment
        ? largestOvertimeTreatment.totalOvertimeDuration
        : null,

    largestOvertimeTreatment,

    byProcedure,

    byPhase,

  }

}


/*
  RCT REGION STATISTICS

  Uses the templateId actually recorded on each historical
  treatment (frozen at treatment-start time) rather than
  re-deriving a tooth region from the tooth code again - the
  historical association is the source of truth, not a guess.
*/

export type RctRegionStatistic = {
  templateId: string
  templateName: string
  treatmentCount: number
  averageActualDuration: number
}

export function calculateRctRegionStatistics(
  treatments: SavedTreatment[],
  procedures: Procedure[]
): RctRegionStatistic[] {

  const rctProcedure = procedures.find(
    procedure => procedure.regionTemplateIds
  )

  if (!rctProcedure || !rctProcedure.regionTemplateIds) {
    return []
  }

  const regionTemplateIds = new Set(
    Object.values(rctProcedure.regionTemplateIds)
  )

  const groups = new Map<
    string,
    { templateName: string; treatments: SavedTreatment[] }
  >()

  treatments
    .filter(
      treatment =>
        treatment.procedureId === rctProcedure.id &&
        regionTemplateIds.has(treatment.templateId)
    )
    .forEach(treatment => {

      const group =
        groups.get(treatment.templateId) ??
        { templateName: treatment.templateName, treatments: [] }

      group.treatments.push(treatment)

      groups.set(treatment.templateId, group)

    })

  return Array.from(groups.entries())
    .map(([templateId, group]) => ({
      templateId,
      templateName: group.templateName,
      treatmentCount: group.treatments.length,
      averageActualDuration:
        mean(group.treatments.map(t => t.totalActualDuration)) ?? 0,
    }))
    .sort((a, b) => a.templateName.localeCompare(b.templateName))

}


/*
  TIME TRENDS

  A plain chronological (oldest -> newest) list of totals, ready to
  plot. Filtering by procedure/template happens upstream via
  applyStatisticsFilters() - this just orders whatever it's given.
*/

export type TrendPoint = {
  treatmentId: string
  date: string
  procedureName: string
  actualDuration: number
  expectedDuration: number
}

export function calculateTimeTrend(
  treatments: SavedTreatment[]
): TrendPoint[] {

  return [...treatments]
    .sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    )
    .map(treatment => ({
      treatmentId: treatment.id,
      date: treatment.date,
      procedureName: treatment.procedureName,
      actualDuration: treatment.totalActualDuration,
      expectedDuration: treatment.totalExpectedDuration,
    }))

}


/*
  PERSONALIZED INSIGHTS

  Straightforward arithmetic, no machine learning: for every
  template with enough historical treatments, compare the dentist's
  average actual time on it against that template's CURRENT target
  (live templates, which may have been edited since some of those
  treatments happened) - so the insight reflects "given what I'm
  aiming for today, how am I actually doing."
*/

export type PersonalizedInsight = {
  templateId: string
  templateName: string
  sampleSize: number
  averageActualDuration: number
  currentTargetDuration: number
  percentDifference: number
  message: string
}

export function generatePersonalizedInsights(
  treatments: SavedTreatment[],
  templates: ProcedureTemplate[],
  minSampleSize: number = MIN_SAMPLE_SIZE
): PersonalizedInsight[] {

  const groups = new Map<string, SavedTreatment[]>()

  treatments.forEach(treatment => {

    const list = groups.get(treatment.templateId) ?? []

    list.push(treatment)

    groups.set(treatment.templateId, list)

  })

  const insights: PersonalizedInsight[] = []

  groups.forEach((group, templateId) => {

    if (group.length < minSampleSize) {
      return
    }

    const currentTemplate =
      templates.find(template => template.id === templateId)

    if (!currentTemplate) {
      return
    }

    const currentTargetDuration =
      currentTemplate.phases.reduce(
        (total, phase) => total + phase.duration,
        0
      )

    if (currentTargetDuration <= 0) {
      return
    }

    const averageActualDuration =
      mean(group.map(t => t.totalActualDuration)) ?? 0

    const percentDifference =
      ((averageActualDuration - currentTargetDuration) /
        currentTargetDuration) *
      100

    if (Math.abs(percentDifference) < 1) {
      return
    }

    const direction =
      percentDifference > 0 ? 'longer' : 'shorter'

    insights.push({
      templateId,
      templateName: currentTemplate.name,
      sampleSize: group.length,
      averageActualDuration,
      currentTargetDuration,
      percentDifference,
      message:
        `Your average ${currentTemplate.name} time is ` +
        `${Math.abs(percentDifference).toFixed(1)}% ${direction} ` +
        `than your current template target.`,
    })

  })

  return insights.sort(
    (a, b) => Math.abs(b.percentDifference) - Math.abs(a.percentDifference)
  )

}
