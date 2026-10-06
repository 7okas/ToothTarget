import type { Patient, SavedTreatment, ProcedureTemplate, Procedure } from './App'
import type { CloudSyncDocument } from './cloudSync'
import { getPatientCaseType } from './patientCaseType'
import { getToothLabel } from './teeth'

/*
  SNAPSHOT DIFF (Phase 6, step 1)

  Pure, standalone module (no I/O, no React, no localStorage) that
  compares this device's synced snapshot against the cloud's, record by
  record, and says exactly which records are only on one side or differ
  between them. It decides NOTHING - it never picks a winner and never
  builds a merged result (that is syncResolve.ts's job, driven by the
  dentist's own per-record choices). Its output is what the resolution
  screen lists.

  Four collections, each keyed by record id: patients, savedTreatments,
  customTemplates, customProcedures (procedures/tags). The retired
  deletion-tombstone list is not compared - nothing writes it any more.

  ============================================================
  WHAT COUNTS AS "DIFFERENT"
  ============================================================

  Same id on both sides, and the two records' content is not equal
  after normalisation:
    - key order never matters; array order DOES matter inside a record
      (phases, phaseTimes, events), never between records
    - `updatedAt` is excluded: a record whose only difference is a
      newer timestamp is "identical" and is never shown
    - absent-vs-default is normalised: Patient.caseType absent equals
      'Clinical', Procedure.status absent equals 'active'
    - keys holding `undefined` are the same as absent keys

  ============================================================
  DELETED RECORDS (no tombstones)
  ============================================================

  With no tombstones, "deleted on the other side" and "never existed
  on the other side" look identical to a plain two-way diff. The only
  evidence available is time: if a one-sided record already existed at
  the last sync, the side that lacks it most likely deleted it. Each
  one-sided record therefore carries a SyncAge (see classifyAge()) and a
  ready-made hint. These are HINTS ONLY - they never preselect or imply
  a choice, and they depend on device clocks and on timestamps that
  older records only have as approximations (a backfilled
  Patient.createdAt is an approximation, see App.tsx's Patient type).
*/

export type DiffEntity = 'patient' | 'treatment' | 'procedure' | 'template'

export type DiffSide = 'device' | 'cloud'

/*
  created-since    creation time is KNOWN and later than the last sync
  changed-since    creation time unknown; updatedAt is later than the
                   last sync - may be new, may be an old record that was
                   merely edited
  at-or-before     already existed at the last sync (creation time, or
                   failing that updatedAt, is at or before it)
  unknown          the last sync time is unknown, or no usable
                   timestamp exists - no hint is given
*/
export type SyncAge =
  | 'created-since'
  | 'changed-since'
  | 'at-or-before'
  | 'unknown'

type AnyRecord = Patient | SavedTreatment | ProcedureTemplate | Procedure

export type OneSidedDiffItem = {
  entity: DiffEntity
  id: string
  side: DiffSide
  record: AnyRecord
  summary: string
  age: SyncAge
  /* null when age === 'unknown' */
  hint: string | null
}

export type DifferentDiffItem = {
  entity: DiffEntity
  id: string
  device: AnyRecord
  cloud: AnyRecord
  deviceSummary: string
  cloudSummary: string
  /* One plain-language line per changed field, e.g. "Name: "A" vs "B"". */
  changes: string[]
  /* Informational only - which side's updatedAt is later. */
  newer: DiffSide | 'same' | 'unknown'
}

export type SnapshotDiff = {
  deviceOnly: OneSidedDiffItem[]
  cloudOnly: OneSidedDiffItem[]
  different: DifferentDiffItem[]
  /* Same id, equal content (ignoring updatedAt) - never listed. */
  identicalCount: number
}

export type DiffOptions = {
  /*
    The cloud time this device last confirmed (toothTargetCloudSyncUpdatedAt).
    null/undefined -> every age is 'unknown' and no hints are produced.
  */
  lastSyncAt?: string | null
}

/* ---------- canonical comparison ---------- */

function canonicalize(value: unknown): unknown {

  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value && typeof value === 'object') {

    const result: Record<string, unknown> = {}

    for (const key of Object.keys(value as Record<string, unknown>).sort()) {

      const inner = (value as Record<string, unknown>)[key]

      if (inner !== undefined) {
        result[key] = canonicalize(inner)
      }

    }

    return result

  }

  return value

}

function normalizeForComparison(
  entity: DiffEntity,
  record: AnyRecord
): Record<string, unknown> {

  const copy: Record<string, unknown> = { ...record }

  delete copy.updatedAt

  if (entity === 'patient') {
    copy.caseType = getPatientCaseType(record as Patient)
  }

  if (entity === 'procedure') {
    copy.status = (record as Procedure).status ?? 'active'
  }

  return copy

}

/*
  Exact (updatedAt INCLUDED) canonical JSON of one record - used by
  syncResolve.ts to tell whether a record changed at all between two
  diffs (eg. while the dentist was deciding), where even a timestamp
  bump means "this isn't the version you looked at".
*/
export function exactRecordSignature(record: unknown): string {
  return JSON.stringify(canonicalize(record))
}

function fingerprint(entity: DiffEntity, record: AnyRecord): string {
  return JSON.stringify(canonicalize(normalizeForComparison(entity, record)))
}

/* ---------- age / hints ---------- */

function parseTime(value: unknown): number | null {

  if (typeof value !== 'string') {
    return null
  }

  const ms = Date.parse(value)

  return Number.isNaN(ms) ? null : ms

}

/*
  Only a patient's createdAt and a saved treatment's completedAt are
  real creation times. Templates and procedures carry only updatedAt,
  so they can never be 'created-since' - at most 'changed-since'.
*/
function creationTimeOf(entity: DiffEntity, record: AnyRecord): number | null {

  if (entity === 'patient') {
    return parseTime((record as Patient).createdAt)
  }

  if (entity === 'treatment') {
    return parseTime((record as SavedTreatment).completedAt)
  }

  return null

}

export function classifyAge(
  entity: DiffEntity,
  record: AnyRecord,
  lastSyncAt: string | null | undefined
): SyncAge {

  const lastSyncMs = parseTime(lastSyncAt)

  if (lastSyncMs === null) {
    return 'unknown'
  }

  const created = creationTimeOf(entity, record)

  if (created !== null) {
    return created > lastSyncMs ? 'created-since' : 'at-or-before'
  }

  const updated = parseTime((record as { updatedAt?: unknown }).updatedAt)

  if (updated === null) {
    return 'unknown'
  }

  return updated > lastSyncMs ? 'changed-since' : 'at-or-before'

}

export function describeAge(age: SyncAge, side: DiffSide): string | null {

  switch (age) {

    case 'created-since':
      return 'Created since last sync'

    case 'changed-since':
      return 'Changed since last sync - may have been deleted on the other side'

    case 'at-or-before':
      return side === 'device'
        ? 'Was here at the last sync, so it was probably DELETED from OneDrive. Keeping it brings it back.'
        : 'Was here at the last sync, so it was probably DELETED on this device. Bringing it over brings it back.'

    case 'unknown':
      return null

  }

}

/* ---------- plain-language summaries ---------- */

function formatDate(value: unknown): string {

  const ms = parseTime(value)

  if (ms === null) {
    return 'unknown date'
  }

  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

}

function formatMinutes(seconds: number): string {

  const minutes = Math.round(seconds / 60)

  return `${minutes} min`

}

function describePatientLabel(
  patientId: string,
  fallbackName: string,
  patientsById: Map<string, Patient>
): string {

  const patient = patientsById.get(patientId)

  return patient
    ? `#${patient.patientNumber} ${patient.name}`
    : fallbackName

}

export function summarizeRecord(
  entity: DiffEntity,
  record: AnyRecord,
  patientsById: Map<string, Patient>
): string {

  switch (entity) {

    case 'patient': {

      const patient = record as Patient

      return (
        `#${patient.patientNumber} ${patient.name} - ` +
        `${getPatientCaseType(patient)} - added ${formatDate(patient.createdAt)}`
      )

    }

    case 'treatment': {

      const treatment = record as SavedTreatment

      return (
        `${treatment.procedureName} - tooth ${getToothLabel(treatment.toothId)} - ` +
        `${formatDate(treatment.date)} - ` +
        `${formatMinutes(treatment.totalActualDuration)} total ` +
        `(patient ${describePatientLabel(
          treatment.patientId,
          treatment.patientName,
          patientsById
        )})`
      )

    }

    case 'procedure': {

      const procedure = record as Procedure

      return `${procedure.name} (${procedure.status ?? 'active'})`

    }

    case 'template': {

      const template = record as ProcedureTemplate

      return (
        `Custom template "${template.name}" - ` +
        `${template.phases.length} ${template.phases.length === 1 ? 'phase' : 'phases'}`
      )

    }

  }

}

/* ---------- field-level change lines ---------- */

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))
}

function describeChanges(
  entity: DiffEntity,
  device: AnyRecord,
  cloud: AnyRecord
): string[] {

  const changes: string[] = []

  switch (entity) {

    case 'patient': {

      const a = device as Patient
      const b = cloud as Patient

      if (a.name !== b.name) {
        changes.push(`Name: "${a.name}" vs "${b.name}"`)
      }

      if (a.patientNumber !== b.patientNumber) {
        changes.push(`Patient number: #${a.patientNumber} vs #${b.patientNumber}`)
      }

      if (getPatientCaseType(a) !== getPatientCaseType(b)) {
        changes.push(
          `Case type: ${getPatientCaseType(a)} vs ${getPatientCaseType(b)}`
        )
      }

      if (a.createdAt !== b.createdAt) {
        changes.push('Creation date differs')
      }

      break

    }

    case 'treatment': {

      const a = device as SavedTreatment
      const b = cloud as SavedTreatment

      if (a.totalActualDuration !== b.totalActualDuration) {
        changes.push(
          `Total time: ${formatMinutes(a.totalActualDuration)} vs ${formatMinutes(b.totalActualDuration)}`
        )
      }

      if (
        !sameJson(a.phases, b.phases) ||
        !sameJson(a.phaseTimes, b.phaseTimes) ||
        !sameJson(a.actualTimes, b.actualTimes) ||
        !sameJson(a.phaseRecords, b.phaseRecords)
      ) {
        changes.push('Phases or phase times differ')
      }

      if (a.patientName !== b.patientName) {
        changes.push(`Patient name on record: "${a.patientName}" vs "${b.patientName}"`)
      }

      if (a.patientId !== b.patientId) {
        changes.push('Belongs to a different patient')
      }

      if (a.toothId !== b.toothId) {
        changes.push(
          `Tooth: ${getToothLabel(a.toothId)} vs ${getToothLabel(b.toothId)}`
        )
      }

      if (a.procedureName !== b.procedureName) {
        changes.push(`Procedure: "${a.procedureName}" vs "${b.procedureName}"`)
      }

      if (!sameJson(a.tags, b.tags)) {
        changes.push('Tags differ')
      }

      if (!sameJson(a.events, b.events)) {
        changes.push('Treatment events differ')
      }

      if (a.completed !== b.completed) {
        changes.push('Completed status differs')
      }

      break

    }

    case 'procedure': {

      const a = device as Procedure
      const b = cloud as Procedure

      if (a.name !== b.name) {
        changes.push(`Name: "${a.name}" vs "${b.name}"`)
      }

      if ((a.status ?? 'active') !== (b.status ?? 'active')) {
        changes.push(`Status: ${a.status ?? 'active'} vs ${b.status ?? 'active'}`)
      }

      if (a.templateId !== b.templateId) {
        changes.push('Uses a different template')
      }

      if (!sameJson(a.regionTemplateIds, b.regionTemplateIds)) {
        changes.push('Region templates differ')
      }

      break

    }

    case 'template': {

      const a = device as ProcedureTemplate
      const b = cloud as ProcedureTemplate

      if (a.name !== b.name) {
        changes.push(`Name: "${a.name}" vs "${b.name}"`)
      }

      if (!sameJson(a.phases, b.phases)) {
        changes.push(`Phases differ (${a.phases.length} vs ${b.phases.length})`)
      }

      if (
        a.specializationId !== b.specializationId ||
        a.procedureKey !== b.procedureKey ||
        a.typeId !== b.typeId
      ) {
        changes.push('Category differs')
      }

      break

    }

  }

  /*
    Safety net: the records are known to be different (that's why we
    are here) but none of the specific checks above named why - eg. a
    field this function doesn't know about. Never show a "different"
    row with no explanation.
  */
  if (changes.length === 0) {
    changes.push('Other details differ')
  }

  return changes

}

function compareUpdatedAt(
  device: AnyRecord,
  cloud: AnyRecord
): DifferentDiffItem['newer'] {

  const a = parseTime((device as { updatedAt?: unknown }).updatedAt)
  const b = parseTime((cloud as { updatedAt?: unknown }).updatedAt)

  if (a === null || b === null) {
    return 'unknown'
  }

  if (a === b) {
    return 'same'
  }

  return a > b ? 'device' : 'cloud'

}

/* ---------- the diff itself ---------- */

type DiffSnapshot = Pick<
  CloudSyncDocument,
  'patients' | 'savedTreatments' | 'customTemplates' | 'customProcedures'
>

function indexById<T extends { id: string }>(records: T[]): Map<string, T> {

  const map = new Map<string, T>()

  for (const record of records) {
    map.set(record.id, record)
  }

  return map

}

export function diffSnapshots(
  device: DiffSnapshot,
  cloud: DiffSnapshot,
  options: DiffOptions = {}
): SnapshotDiff {

  const lastSyncAt = options.lastSyncAt ?? null

  /*
    Patient lookup for treatment summaries: device patients first, then
    cloud-only patients, so a treatment whose patient exists on either
    side still shows "#12 Ahmed Samy". On a both-sides patient the
    device's version wins for display only.
  */
  const patientsById = new Map<string, Patient>()

  for (const patient of cloud.patients) {
    patientsById.set(patient.id, patient)
  }

  for (const patient of device.patients) {
    patientsById.set(patient.id, patient)
  }

  const result: SnapshotDiff = {
    deviceOnly: [],
    cloudOnly: [],
    different: [],
    identicalCount: 0,
  }

  const collections: {
    entity: DiffEntity
    device: AnyRecord[]
    cloud: AnyRecord[]
  }[] = [
    { entity: 'patient', device: device.patients, cloud: cloud.patients },
    { entity: 'treatment', device: device.savedTreatments, cloud: cloud.savedTreatments },
    { entity: 'procedure', device: device.customProcedures, cloud: cloud.customProcedures },
    { entity: 'template', device: device.customTemplates, cloud: cloud.customTemplates },
  ]

  for (const collection of collections) {

    const deviceById = indexById(collection.device)
    const cloudById = indexById(collection.cloud)

    for (const [id, deviceRecord] of deviceById) {

      const cloudRecord = cloudById.get(id)

      if (!cloudRecord) {

        const age = classifyAge(collection.entity, deviceRecord, lastSyncAt)

        result.deviceOnly.push({
          entity: collection.entity,
          id,
          side: 'device',
          record: deviceRecord,
          summary: summarizeRecord(collection.entity, deviceRecord, patientsById),
          age,
          hint: describeAge(age, 'device'),
        })

        continue

      }

      if (
        fingerprint(collection.entity, deviceRecord) ===
        fingerprint(collection.entity, cloudRecord)
      ) {
        result.identicalCount += 1
        continue
      }

      result.different.push({
        entity: collection.entity,
        id,
        device: deviceRecord,
        cloud: cloudRecord,
        deviceSummary: summarizeRecord(collection.entity, deviceRecord, patientsById),
        cloudSummary: summarizeRecord(collection.entity, cloudRecord, patientsById),
        changes: describeChanges(collection.entity, deviceRecord, cloudRecord),
        newer: compareUpdatedAt(deviceRecord, cloudRecord),
      })

    }

    for (const [id, cloudRecord] of cloudById) {

      if (deviceById.has(id)) {
        continue
      }

      const age = classifyAge(collection.entity, cloudRecord, lastSyncAt)

      result.cloudOnly.push({
        entity: collection.entity,
        id,
        side: 'cloud',
        record: cloudRecord,
        summary: summarizeRecord(collection.entity, cloudRecord, patientsById),
        age,
        hint: describeAge(age, 'cloud'),
      })

    }

  }

  return result

}

/*
  Handy for the screen and for "is there anything to resolve at all":
  true when the two snapshots have no listed differences.
*/
export function isDiffEmpty(diff: SnapshotDiff): boolean {
  return (
    diff.deviceOnly.length === 0 &&
    diff.cloudOnly.length === 0 &&
    diff.different.length === 0
  )
}

/*
  Hint-only helper (never a decision): procedures/templates that exist
  on both sides under the SAME NAME but different ids - Statistics
  merges by name, so the dentist may want to keep both or neither.
  Returns the ids on the device side and the cloud side that collide.
*/
export function findSameNameDifferentId(
  diff: SnapshotDiff
): { entity: 'procedure' | 'template'; name: string; deviceId: string; cloudId: string }[] {

  const pairs: {
    entity: 'procedure' | 'template'
    name: string
    deviceId: string
    cloudId: string
  }[] = []

  for (const entity of ['procedure', 'template'] as const) {

    const nameOf = (record: AnyRecord) =>
      (record as Procedure | ProcedureTemplate).name.trim().toLowerCase()

    for (const deviceItem of diff.deviceOnly.filter(item => item.entity === entity)) {

      const match = diff.cloudOnly.find(
        cloudItem =>
          cloudItem.entity === entity &&
          nameOf(cloudItem.record) === nameOf(deviceItem.record)
      )

      if (match) {
        pairs.push({
          entity,
          name: (deviceItem.record as Procedure | ProcedureTemplate).name,
          deviceId: deviceItem.id,
          cloudId: match.id,
        })
      }

    }

  }

  return pairs

}
