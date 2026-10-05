import type { SavedTreatment } from './App'
import type { ApplyResult, PrepareResult } from './syncResolutionEngine'
import { classifySyncOutcome, describeSyncOutcome } from './syncOutcome'
import type {
  DiffEntity,
  DifferentDiffItem,
  OneSidedDiffItem,
  SnapshotDiff,
  SyncAge,
} from './syncDiff'
import {
  recordKey,
  type Choice,
  type Decisions,
  type ResolveResult,
} from './syncResolve'
import {
  CLOUD_SAFETY_COPY_RETENTION,
  LOCAL_SAFETY_COPY_RETENTION,
} from './syncResolutionSafetyCopy'

/*
  RESOLUTION VIEW MODEL (Phase 6, step 6)

  Pure (no React, no I/O) translation of the diff + the dentist's
  current choices into exactly what the resolution screen draws:
  sections, groups, rows with their button labels, progress counts, the
  final summary lines, and plain-language wording for every way an
  apply can end. Keeping this out of the component makes the screen's
  rules - which buttons a row offers, when "Review summary" unlocks,
  what the summary says - unit-testable without a DOM.
*/

export const ENTITY_ORDER: DiffEntity[] = ['patient', 'treatment', 'procedure', 'template']

export const ENTITY_LABELS: Record<DiffEntity, string> = {
  patient: 'Patients',
  treatment: 'Treatments',
  procedure: 'Procedures / tags',
  template: 'Templates',
}

export type RowKind = 'device-only' | 'cloud-only' | 'different'

export type ChoiceOption = {
  choice: Choice
  label: string
}

/*
  One-sided rows never say "use this": "Leave it out" is the delete, and
  the wording for the side that HAS the record says what choosing it
  does to the dentist's data. Rows with a copy on both sides are a
  plain either/or.
*/
export function choiceOptionsFor(kind: RowKind): ChoiceOption[] {

  switch (kind) {

    case 'device-only':
      return [
        { choice: 'device', label: 'Keep it' },
        { choice: 'omit', label: 'Leave it out' },
      ]

    case 'cloud-only':
      return [
        { choice: 'cloud', label: 'Bring to this device' },
        { choice: 'omit', label: 'Leave it out' },
      ]

    case 'different':
      return [
        { choice: 'device', label: "Use this device's" },
        { choice: 'cloud', label: "Use OneDrive's" },
      ]

  }

}

export type RowViewModel = {
  key: string
  entity: DiffEntity
  id: string
  kind: RowKind
  summary: string
  /* Both-sides rows only. */
  deviceSummary?: string
  cloudSummary?: string
  changes?: string[]
  newer?: DifferentDiffItem['newer']
  age?: SyncAge
  hint: string | null
  /* True for the amber "probably deleted" warning rows. */
  warn: boolean
  /* Treatments only: the patient they belong to, for grouping. */
  groupLabel?: string
  options: ChoiceOption[]
  choice: Choice | undefined
  undecided: boolean
}

export type GroupViewModel = {
  title: string
  rows: RowViewModel[]
}

export type SectionViewModel = {
  entity: DiffEntity
  label: string
  groups: {
    deviceOnly: GroupViewModel
    cloudOnly: GroupViewModel
    different: GroupViewModel
  }
  total: number
  decided: number
  /*
    How many UNDECIDED rows in this section are labelled "Created since
    last sync" - what the section's bulk button would fill. 0 hides it.
  */
  createdSinceUndecided: number
}

export type ResolutionViewModel = {
  sections: SectionViewModel[]
  totalRows: number
  decidedRows: number
  allDecided: boolean
  progressLabel: string
}

function groupLabelOf(item: OneSidedDiffItem | DifferentDiffItem): string | undefined {

  if (item.entity !== 'treatment') {
    return undefined
  }

  const record = 'record' in item ? item.record : item.device

  return (record as SavedTreatment).patientName

}

function rowFromOneSided(item: OneSidedDiffItem, decisions: Decisions): RowViewModel {

  const key = recordKey(item.entity, item.id)
  const kind: RowKind = item.side === 'device' ? 'device-only' : 'cloud-only'

  return {
    key,
    entity: item.entity,
    id: item.id,
    kind,
    summary: item.summary,
    age: item.age,
    hint: item.hint,
    warn: item.age === 'at-or-before',
    groupLabel: groupLabelOf(item),
    options: choiceOptionsFor(kind),
    choice: decisions[key],
    undecided: decisions[key] === undefined,
  }

}

function rowFromDifferent(item: DifferentDiffItem, decisions: Decisions): RowViewModel {

  const key = recordKey(item.entity, item.id)

  return {
    key,
    entity: item.entity,
    id: item.id,
    kind: 'different',
    summary: item.deviceSummary,
    deviceSummary: item.deviceSummary,
    cloudSummary: item.cloudSummary,
    changes: item.changes,
    newer: item.newer,
    hint: null,
    warn: false,
    groupLabel: groupLabelOf(item),
    options: choiceOptionsFor('different'),
    choice: decisions[key],
    undecided: decisions[key] === undefined,
  }

}

function sortRows(rows: RowViewModel[]): RowViewModel[] {

  return [...rows].sort((a, b) => {

    const byGroup = (a.groupLabel ?? '').localeCompare(b.groupLabel ?? '')

    return byGroup !== 0 ? byGroup : a.summary.localeCompare(b.summary)

  })

}

export function buildViewModel(
  diff: SnapshotDiff,
  decisions: Decisions
): ResolutionViewModel {

  const sections: SectionViewModel[] = []

  let totalRows = 0
  let decidedRows = 0

  for (const entity of ENTITY_ORDER) {

    const deviceOnly = sortRows(
      diff.deviceOnly.filter(item => item.entity === entity).map(item => rowFromOneSided(item, decisions))
    )

    const cloudOnly = sortRows(
      diff.cloudOnly.filter(item => item.entity === entity).map(item => rowFromOneSided(item, decisions))
    )

    const different = sortRows(
      diff.different.filter(item => item.entity === entity).map(item => rowFromDifferent(item, decisions))
    )

    const all = [...deviceOnly, ...cloudOnly, ...different]

    if (all.length === 0) {
      continue
    }

    const decided = all.filter(row => !row.undecided).length

    totalRows += all.length
    decidedRows += decided

    sections.push({
      entity,
      label: ENTITY_LABELS[entity],
      groups: {
        deviceOnly: { title: 'Only on this device', rows: deviceOnly },
        cloudOnly: { title: 'Only in OneDrive', rows: cloudOnly },
        different: { title: 'On both, but different', rows: different },
      },
      total: all.length,
      decided,
      createdSinceUndecided: [...deviceOnly, ...cloudOnly].filter(
        row => row.undecided && row.age === 'created-since'
      ).length,
    })

  }

  return {
    sections,
    totalRows,
    decidedRows,
    allDecided: decidedRows === totalRows,
    progressLabel: `${decidedRows} of ${totalRows} decided`,
  }

}

/* The bulk button's own label, so the screen and tests share one string. */
export const CREATED_SINCE_BUTTON_LABEL =
  'Keep / bring everything created since the last sync'

/* ============================================================
   FINAL SUMMARY
   ============================================================ */

export type SummaryViewModel = {
  /* One plain-language line per kind of record. */
  lines: string[]
  /* "Also included automatically: ..." lines. */
  autoIncluded: string[]
  /* "Name: #12 -> #16" lines. */
  renumbered: string[]
  /* Amber: records that were probably deleted and are coming back. */
  resurrectedWarning: string | null
  resurrectedNames: string[]
  /* The dentist must tick "I understand" before Apply when true. */
  requiresAcknowledgement: boolean
  /* Informational only: kept records that "may have been deleted". */
  maybeResurrectedNote: string | null
  /* The safety-copy promise shown before Apply. */
  safetyNote: string
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function withoutTrailingPeriod(text: string): string {
  return text.replace(/[.\s]+$/, '')
}

function recordNameOf(item: OneSidedDiffItem): string {
  return item.summary
}

export function buildSummary(result: ResolveResult): SummaryViewModel {

  const lines = ENTITY_ORDER.map(entity => {

    const tally = result.tally[entity]
    const label = ENTITY_LABELS[entity]

    return (
      `${label}: ${tally.fromDevice} from this device, ` +
      `${tally.fromCloud} from OneDrive, ` +
      `${tally.leftOut} left out` +
      (tally.identical > 0 ? `, ${tally.identical} identical on both` : '') +
      ` - ${tally.total} in total`
    )

  })

  const autoIncluded = result.autoIncluded.map(
    item =>
      `Template "${item.name}" (needed by ${item.neededBy.join(', ')})`
  )

  const renumbered = result.renumbered.map(
    item => `${item.name}: #${item.from} -> #${item.to}`
  )

  const resurrectedNames = result.resurrected.map(recordNameOf)

  return {
    lines,
    autoIncluded,
    renumbered,
    resurrectedWarning:
      result.resurrected.length > 0
        ? `${plural(
            result.resurrected.length,
            'record that was',
            'records that were'
          )} probably deleted will come back.`
        : null,
    resurrectedNames,
    requiresAcknowledgement: result.resurrected.length > 0,
    maybeResurrectedNote:
      result.maybeResurrected.length > 0
        ? `${plural(
            result.maybeResurrected.length,
            'kept record',
            'kept records'
          )} changed since the last sync and may have been deleted on the other side.`
        : null,
    safetyNote:
      'Before anything is applied, a safety copy of BOTH sides is saved. ' +
      `OneDrive keeps the last ${CLOUD_SAFETY_COPY_RETENTION} resolutions and this device ` +
      `keeps the last ${LOCAL_SAFETY_COPY_RETENTION}; older ones are removed automatically.`,
  }

}

/* ============================================================
   PLAIN-LANGUAGE OUTCOMES
   ============================================================ */

export type OutcomeTone = 'success' | 'warning' | 'error' | 'info'

export type OutcomeMessage = {
  tone: OutcomeTone
  title: string
  message: string
  /* True when pressing the same button again is the right next step. */
  retryable: boolean
  /* True when the screen should reload the diff (choices partly kept). */
  needsRefresh: boolean
}

export function describeApplyResult(result: ApplyResult): OutcomeMessage {

  switch (result.status) {

    case 'applied':
      return {
        tone: result.warning ? 'warning' : 'success',
        title: 'Done - this device and OneDrive now match',
        message: result.warning ?? 'Your choices were applied and synced.',
        retryable: false,
        needsRefresh: false,
      }

    case 'blocked':
      return {
        tone: 'error',
        title: 'Some choices still need attention',
        message: 'Finish every row and fix anything marked in red before applying. Nothing was changed.',
        retryable: false,
        needsRefresh: false,
      }

    case 'needs-acknowledgement':
      return {
        tone: 'warning',
        title: 'Please confirm the deleted records',
        message:
          'Some records that were probably deleted are coming back. Tick "I understand" to continue. Nothing was changed.',
        retryable: false,
        needsRefresh: false,
      }

    case 'changed-while-deciding':
      return {
        tone: 'warning',
        title: 'Things changed while you were deciding',
        message:
          result.reset.length > 0
            ? `${plural(result.reset.length, 'row', 'rows')} changed and need a fresh choice. Your other choices were kept. Nothing was changed.`
            : 'The data changed, so the differences were reloaded. Your choices were kept. Nothing was changed.',
        retryable: false,
        needsRefresh: true,
      }

    case 'failed': {

      const outcome = describeSyncOutcome(classifySyncOutcome(result.result))

      return {
        tone: 'error',
        title: outcome.label,
        message:
          `${withoutTrailingPeriod(outcome.detail)}. Your data on this device is unchanged` +
          (result.retryable ? ' - you can try again.' : '.'),
        retryable: result.retryable,
        needsRefresh: false,
      }

    }

    case 'safety-copy-failed':
      return {
        tone: 'error',
        title: "Couldn't save the safety copies",
        message:
          'A safety copy could not be saved to OneDrive, so nothing was applied. ' +
          'Check your connection and try again.',
        retryable: true,
        needsRefresh: false,
      }

    case 'marker-failed':
      return {
        tone: 'error',
        title: "This device is out of storage",
        message:
          'There is not enough room on this device to apply the changes safely, so nothing was applied.',
        retryable: false,
        needsRefresh: false,
      }

    case 'cloud-written-local-changed':
      return {
        tone: 'warning',
        title: 'OneDrive was updated, but you saved something meanwhile',
        message:
          'Your newest change on this device was kept and was not overwritten. ' +
          'The app will ask you to review the small remaining difference.',
        retryable: false,
        needsRefresh: true,
      }

    case 'cloud-committed-locally-pending':
      return {
        tone: 'warning',
        title: 'OneDrive was updated; finishing on this device',
        message: 'It will be finished the next time the app opens.',
        retryable: false,
        needsRefresh: false,
      }

  }

}

export function describePrepareResult(result: PrepareResult): OutcomeMessage | null {

  switch (result.status) {

    case 'ready':
      return null

    case 'identical':
      return {
        tone: 'success',
        title: 'Both sides already match',
        message: 'There is nothing to decide. You can mark this device as in sync.',
        retryable: false,
        needsRefresh: false,
      }

    case 'not-diverged':
      return {
        tone: 'info',
        title: 'Nothing to resolve any more',
        message: 'The differences were already sorted out. Syncing normally.',
        retryable: false,
        needsRefresh: false,
      }

    case 'no-cloud-document':
      return {
        tone: 'info',
        title: 'Nothing on OneDrive to compare with',
        message: 'There is no synced data on OneDrive yet. Syncing normally.',
        retryable: false,
        needsRefresh: false,
      }

    case 'failed': {

      const outcome = describeSyncOutcome(classifySyncOutcome(result.result))

      return {
        tone: 'error',
        title: outcome.label,
        message: `${withoutTrailingPeriod(outcome.detail)}. Nothing was changed.`,
        retryable: true,
        needsRefresh: false,
      }

    }

  }

}
