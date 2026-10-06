import { comparePhaseNames, normalisePhaseName } from './phaseNameMatching.ts'

/*
  PHASE-NAME AUDIT (Phase 9) - pure, read-only, names and counts only

  Used by scripts/auditPhaseNames.ts to answer, on a real backup file,
  "how many near-duplicate phase names do I actually have, and are the
  matching rules and guards in the right place?" before anything is
  wired into a screen.

  PRIVACY BY CONSTRUCTION
  ============================================================
  extractAuditInput() reads exactly two things out of a backup, and
  nothing else, ever:
    - from each saved treatment: the NAMES of its non-skipped phase
      records
    - from each template: the NAMES of its phases
  No patient name, id, date, note, tooth, procedure or any other field
  is read, kept or printed. The report contains only phase names (each
  cut to 60 characters) and counts. Nothing here touches the file
  system, the network or storage; it is plain functions over data.

  The import below deliberately has a ".ts" ending so the Node
  command-line script can load this file directly.
*/

export type AuditInput = {
  /* One list of phase names per saved treatment (skipped phases already left out). */
  savedPhaseNameLists: string[][]
  /* One list of phase names per template. */
  templatePhaseNameLists: string[][]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function namesOf(list: unknown, skipSkipped: boolean): string[] {

  if (!Array.isArray(list)) {
    return []
  }

  const names: string[] = []

  for (const item of list) {

    if (!isObject(item) || typeof item.name !== 'string') {
      continue
    }

    if (skipSkipped && item.skipped === true) {
      continue
    }

    names.push(item.name)

  }

  return names

}

/*
  Accepts the Settings backup file ({ data: { toothTargetSavedTreatments,
  toothTargetTemplates } }) and, as a fallback, a plain object with
  savedTreatments / customTemplates (the shape of the cloud documents).
  Returns null when neither list is there at all.
*/
export function extractAuditInput(backup: unknown): AuditInput | null {

  if (!isObject(backup)) {
    return null
  }

  const source = isObject(backup.data) ? backup.data : backup

  const saved = source.toothTargetSavedTreatments ?? source.savedTreatments
  const templates = source.toothTargetTemplates ?? source.customTemplates

  if (!Array.isArray(saved) && !Array.isArray(templates)) {
    return null
  }

  return {
    savedPhaseNameLists: Array.isArray(saved)
      ? saved.map(item => (isObject(item) ? namesOf(item.phaseRecords, true) : []))
      : [],
    templatePhaseNameLists: Array.isArray(templates)
      ? templates.map(item => (isObject(item) ? namesOf(item.phases, false) : []))
      : [],
  }

}

export type AuditEntry = {
  /* The most-used spelling in its group, as written (shown in the report). */
  name: string
  savedCount: number
  templateCount: number
}

export type AuditGroup = AuditEntry & {
  normalised: string
  /* Every spelling in the group, most used first. */
  spellings: AuditEntry[]
}

export type AuditFlaggedPair = {
  tier: 1 | 2
  distance: number
  /* The less-used side: the name that would be warned about if typed. */
  typed: AuditEntry
  /* The more-used side: what would be suggested. */
  suggestion: AuditEntry
}

export type AuditSuppressedPair = {
  guard: 'short' | 'digits' | 'plural-s' | 'length'
  distance: number
  typed: AuditEntry
  suggestion: AuditEntry
}

export type AuditReport = {
  treatmentsRead: number
  templatesRead: number
  distinctSpellings: number
  distinctNormalised: number
  tier0: AuditGroup[]
  flagged: AuditFlaggedPair[]
  suppressed: AuditSuppressedPair[]
}

function totalUses(entry: AuditEntry): number {
  return entry.savedCount + entry.templateCount
}

function byUseThenName(a: AuditEntry, b: AuditEntry): number {
  return totalUses(b) - totalUses(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export function auditPhaseNames(input: AuditInput): AuditReport {

  const spellings = new Map<string, AuditEntry>()

  function entryFor(name: string): AuditEntry {

    const existing = spellings.get(name)

    if (existing) {
      return existing
    }

    const created: AuditEntry = { name, savedCount: 0, templateCount: 0 }

    spellings.set(name, created)

    return created

  }

  function distinct(names: string[]): Set<string> {
    return new Set(names.map(name => name.trim()).filter(name => name !== ''))
  }

  for (const names of input.savedPhaseNameLists) {
    for (const name of distinct(names)) {
      entryFor(name).savedCount += 1
    }
  }

  for (const names of input.templatePhaseNameLists) {
    for (const name of distinct(names)) {
      entryFor(name).templateCount += 1
    }
  }

  /* Group spellings by their normalised form. */
  const byNormalised = new Map<string, AuditEntry[]>()

  for (const entry of spellings.values()) {

    const key = normalisePhaseName(entry.name)

    if (key === '') {
      continue
    }

    const list = byNormalised.get(key) ?? []

    list.push(entry)

    byNormalised.set(key, list)

  }

  const groups: AuditGroup[] = Array.from(byNormalised.entries()).map(
    ([normalised, list]) => {

      const sorted = [...list].sort(byUseThenName)

      return {
        normalised,
        name: sorted[0].name,
        savedCount: sorted.reduce((total, entry) => total + entry.savedCount, 0),
        templateCount: sorted.reduce((total, entry) => total + entry.templateCount, 0),
        spellings: sorted,
      }

    }
  )

  const tier0 = groups
    .filter(group => group.spellings.length > 1)
    .sort(byUseThenName)

  /* Pairs of different names, each judged in the direction a warning would go: less used -> more used. */
  const flagged: AuditFlaggedPair[] = []
  const suppressed: AuditSuppressedPair[] = []

  for (let i = 0; i < groups.length; i++) {

    for (let j = i + 1; j < groups.length; j++) {

      const [typedGroup, suggestionGroup] =
        byUseThenName(groups[i], groups[j]) > 0
          ? [groups[i], groups[j]]
          : [groups[j], groups[i]]

      const typed: AuditEntry = {
        name: typedGroup.name,
        savedCount: typedGroup.savedCount,
        templateCount: typedGroup.templateCount,
      }

      const suggestion: AuditEntry = {
        name: suggestionGroup.name,
        savedCount: suggestionGroup.savedCount,
        templateCount: suggestionGroup.templateCount,
      }

      const verdict = comparePhaseNames(typed.name, suggestion.name)

      if (verdict.kind === 'match' && verdict.tier !== 0) {
        flagged.push({ tier: verdict.tier, distance: verdict.distance, typed, suggestion })
      } else if (verdict.kind === 'suppressed') {
        suppressed.push({ guard: verdict.guard, distance: verdict.distance, typed, suggestion })
      }

    }

  }

  flagged.sort((a, b) =>
    a.tier - b.tier ||
    a.distance - b.distance ||
    byUseThenName(a.suggestion, b.suggestion)
  )

  suppressed.sort((a, b) =>
    a.guard < b.guard ? -1 : a.guard > b.guard ? 1 :
    a.distance - b.distance ||
    byUseThenName(a.suggestion, b.suggestion)
  )

  return {
    treatmentsRead: input.savedPhaseNameLists.length,
    templatesRead: input.templatePhaseNameLists.length,
    distinctSpellings: spellings.size,
    distinctNormalised: groups.length,
    tier0,
    flagged,
    suppressed,
  }

}

/* ---------------------------------------------------------------- */
/* Printing                                                          */
/* ---------------------------------------------------------------- */

const MAX_NAME_LENGTH = 60

function show(name: string): string {

  const cut =
    name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH)}…` : name

  return JSON.stringify(cut)

}

function uses(entry: AuditEntry): string {

  const saved = `used ${entry.savedCount}x`

  return entry.templateCount > 0
    ? `${saved}, in ${entry.templateCount} template${entry.templateCount === 1 ? '' : 's'}`
    : saved

}

export function formatAuditReport(report: AuditReport): string[] {

  const lines: string[] = []

  lines.push('PHASE NAME AUDIT (phase names and counts only)')
  lines.push(
    `Read ${report.treatmentsRead} saved treatment${report.treatmentsRead === 1 ? '' : 's'} and ${report.templatesRead} template${report.templatesRead === 1 ? '' : 's'}.`
  )
  lines.push(
    `${report.distinctSpellings} distinct spellings, ${report.distinctNormalised} distinct names once case, spacing, punctuation and "&" vs "and" are ignored.`
  )
  lines.push('')

  lines.push(
    `1. SAME NAME, WRITTEN DIFFERENTLY (Tier 0: case / spacing / punctuation / "&" vs "and"): ${report.tier0.length} group(s)`
  )

  if (report.tier0.length === 0) {
    lines.push('   none')
  }

  for (const group of report.tier0) {
    lines.push(
      `   - ${group.spellings.map(entry => `${show(entry.name)} (${uses(entry)})`).join('  |  ')}`
    )
  }

  lines.push('')

  lines.push(
    `2. WOULD BE FLAGGED (Tier 1 = doubled/missed letters or swapped neighbours, Tier 2 = one or two letters off): ${report.flagged.length} pair(s)`
  )

  if (report.flagged.length === 0) {
    lines.push('   none')
  }

  for (const pair of report.flagged) {
    lines.push(
      `   - Tier ${pair.tier}: typing ${show(pair.typed.name)} (${uses(pair.typed)}) would suggest ${show(pair.suggestion.name)} (${uses(pair.suggestion)})  [${pair.distance} edit${pair.distance === 1 ? '' : 's'} apart]`
    )
  }

  lines.push('')

  lines.push(
    `3. CLOSE BUT SUPPRESSED BY A GUARD (not flagged): ${report.suppressed.length} pair(s)`
  )

  if (report.suppressed.length === 0) {
    lines.push('   none')
  }

  for (const pair of report.suppressed) {
    lines.push(
      `   - [${pair.guard}] ${show(pair.typed.name)} (${uses(pair.typed)})  vs  ${show(pair.suggestion.name)} (${uses(pair.suggestion)})  [${pair.distance} edit${pair.distance === 1 ? '' : 's'} apart]`
    )
  }

  lines.push('')
  lines.push(
    'Guards: short = typed name of 4 letters or fewer; digits = the numbers differ; plural-s = only a trailing "s" differs (but not when the longer name ends in a double "s", like Access/Acces); length = too few letters for that many edits.'
  )

  return lines

}
