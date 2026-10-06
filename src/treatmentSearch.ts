import type { Patient, SavedTreatment } from './App'
import { getToothById, type ToothArch, type ToothRegion } from './teeth'
import { getPatientCaseType, type PatientCaseType } from './patientCaseType'

/*
  CHECKED-TREATMENTS SEARCH (Statistics, Phase 8)

  Pure search over completed treatments for the Statistics screen's
  "checked treatments" mode: build one display row per treatment, then
  narrow the rows with a search box. No React, no storage, no sync.

  WHAT THE SEARCH BOX MATCHES
  ============================================================
  The query is split into words on whitespace and EVERY word must match
  (AND); a word matches if it matches ANY one of these (OR):
    - the procedure name (substring, ignoring case)
    - the template name (substring, ignoring case)
    - the tooth: an FDI number ("16"), a UR/UL/LR/LL name ("UR6"), or -
      for an old record whose tooth text could not be turned into a real
      tooth - that preserved text, each compared as a WHOLE value, so
      "1" never matches every tooth
    - a tooth category word: anterior, premolar, molar (plurals accepted)
      or upper, lower
  It deliberately does NOT match the patient name or the descriptive
  treatment tags ("Difficult", ...).

  An empty (or all-blank) query matches every row.

  The rows also carry what the table needs to be honest about timing
  (see phasesTracked/phasesTotal/hasSkippedPhases): a treatment that
  skipped phases has a small actual total next to a full expected total,
  so it is flagged, never silently altered.
*/

export type TreatmentSearchRow = {
  treatment: SavedTreatment
  /* A real tooth's display name ("UR6") or, for an old unrecognised tooth, its preserved text. */
  toothLabel: string
  /* null when the tooth is not one of the 32 permanent teeth. */
  toothRegion: ToothRegion | null
  toothArch: ToothArch | null
  caseType: PatientCaseType
  /* Phase records that were actually worked (not skipped). */
  phasesTracked: number
  /* Every phase record the treatment had. */
  phasesTotal: number
  hasSkippedPhases: boolean
}

export function buildTreatmentRows(
  treatments: SavedTreatment[],
  patients: Patient[]
): TreatmentSearchRow[] {

  const patientsById = new Map(
    patients.map(patient => [patient.id, patient])
  )

  return treatments.map(treatment => {

    const tooth = getToothById(treatment.toothId)

    const records = Array.isArray(treatment.phaseRecords)
      ? treatment.phaseRecords
      : []

    const skipped = records.filter(record => record.skipped).length

    return {
      treatment,
      toothLabel: tooth ? tooth.displayName : treatment.toothId,
      toothRegion: tooth ? tooth.region : null,
      toothArch: tooth ? tooth.arch : null,
      caseType: getPatientCaseType(patientsById.get(treatment.patientId)),
      phasesTracked: records.length - skipped,
      phasesTotal: records.length,
      hasSkippedPhases: skipped > 0,
    }

  })

}

/*
  Newest completion date first (the same order the existing Search
  Treatments screen uses). Treatments with an unreadable date go last.
*/

export function sortRowsNewestFirst(
  rows: TreatmentSearchRow[]
): TreatmentSearchRow[] {

  function time(row: TreatmentSearchRow): number {
    const parsed = new Date(row.treatment.date).getTime()
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
  }

  return [...rows].sort((a, b) => time(b) - time(a))

}

const REGION_WORDS: Record<string, ToothRegion> = {
  anterior: 'anterior',
  premolar: 'premolar',
  premolars: 'premolar',
  molar: 'molar',
  molars: 'molar',
}

const ARCH_WORDS: Record<string, ToothArch> = {
  upper: 'upper',
  lower: 'lower',
}

function wordMatchesRow(word: string, row: TreatmentSearchRow): boolean {

  const region = REGION_WORDS[word]

  if (region !== undefined && row.toothRegion === region) {
    return true
  }

  const arch = ARCH_WORDS[word]

  if (arch !== undefined && row.toothArch === arch) {
    return true
  }

  if (
    row.treatment.toothId.toLowerCase() === word ||
    row.toothLabel.toLowerCase() === word
  ) {
    return true
  }

  return (
    row.treatment.procedureName.toLowerCase().includes(word) ||
    row.treatment.templateName.toLowerCase().includes(word)
  )

}

export function searchTreatmentRows(
  rows: TreatmentSearchRow[],
  query: string
): TreatmentSearchRow[] {

  const words =
    query.toLowerCase().split(/\s+/).filter(word => word !== '')

  if (words.length === 0) {
    return rows
  }

  return rows.filter(row =>
    words.every(word => wordMatchesRow(word, row))
  )

}
