import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
} from './cloudSync'
import type {
  Patient,
  SavedTreatment,
  ProcedureTemplate,
  Procedure,
  DeletionTombstone,
} from './App'

/*
  CLOUD SYNC CORRUPTION DIAGNOSIS

  Runs only AFTER cloudSync.ts's validateCloudSyncDocument() has
  already rejected a document (or after the cloud file failed to
  parse as JSON at all) - this module never decides whether a
  document is valid, and never changes that outcome. It answers a
  different, dentist-facing question: "why, in plain language, and
  is there one specific record responsible?"

  Exactly two answers, matching this feature's own required
  classification:
    - 'unreadable': the problem is with the file/document as a whole
      (not JSON, not a ToothTarget document, wrong schema version, a
      required list missing/not a list) - no single record can be
      blamed.
    - 'invalid-record': the document's own shape is fine, but one
      specific patient/treatment/template/procedure/deletion-record
      inside it fails its own field rules, or shares an id with
      another record of the same kind - that record and the plain-
      language reason are identified.

  Deliberately duplicates the FIELD-LEVEL checks already in
  cloudSync.ts's isValidSyncXxx() functions rather than reusing them
  directly - those only ever return a boolean (pass/fail), which
  cannot say WHICH single field failed first or in what words. Every
  rule below matches cloudSync.ts's own validator exactly, field for
  field; this file changes nothing about which documents/records are
  considered valid, only how a rejection already decided elsewhere is
  explained.
*/

export type CloudSyncCorruptionDiagnosis =
  | { kind: 'unreadable'; reason: string }
  | {
      kind: 'invalid-record'
      recordType: 'patient' | 'treatment' | 'template' | 'procedure' | 'tombstone'
      recordDescription: string
      reason: string
    }

function describeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function describePatient(value: unknown): string {
  const candidate = (value ?? {}) as Partial<Patient>
  return `Patient "${describeString(candidate.name, 'unnamed')}" (id ${describeString(candidate.id, 'unknown')})`
}

function diagnosePatient(value: unknown): string | null {

  if (!value || typeof value !== 'object') {
    return 'is not a valid record (not an object)'
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    return 'is missing a valid id'
  }

  if (
    typeof candidate.patientNumber !== 'number' ||
    !Number.isInteger(candidate.patientNumber) ||
    candidate.patientNumber <= 0
  ) {
    return 'has an invalid patient number'
  }

  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    return 'is missing a name'
  }

  if (
    typeof candidate.createdAt !== 'string' ||
    candidate.createdAt.trim() === ''
  ) {
    return 'is missing a valid created-at date'
  }

  if (
    typeof candidate.updatedAt !== 'string' ||
    candidate.updatedAt.trim() === ''
  ) {
    return 'is missing a valid updated-at date'
  }

  return null

}

function describeTreatment(value: unknown): string {
  const candidate = (value ?? {}) as Partial<SavedTreatment>
  return (
    `Treatment for "${describeString(candidate.patientName, 'unknown patient')}" ` +
    `dated ${describeString(candidate.date, 'an unknown date')} ` +
    `(id ${describeString(candidate.id, 'unknown')})`
  )
}

function diagnoseTreatment(value: unknown): string | null {

  if (!value || typeof value !== 'object') {
    return 'is not a valid record (not an object)'
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    return 'is missing a valid id'
  }

  if (typeof candidate.patientId !== 'string') {
    return 'is missing a valid patient id'
  }

  if (typeof candidate.patientName !== 'string') {
    return 'is missing a valid patient name'
  }

  if (typeof candidate.toothId !== 'string') {
    return 'is missing a valid tooth id'
  }

  if (!Array.isArray(candidate.phases)) {
    return 'is missing its treatment phases'
  }

  if (
    typeof candidate.updatedAt !== 'string' ||
    (candidate.updatedAt as string).trim() === ''
  ) {
    return 'is missing a valid updated-at date'
  }

  return null

}

function describeTemplate(value: unknown): string {
  const candidate = (value ?? {}) as Partial<ProcedureTemplate>
  return `Procedure template "${describeString(candidate.name, 'unnamed')}" (id ${describeString(candidate.id, 'unknown')})`
}

function diagnoseTemplate(value: unknown): string | null {

  if (!value || typeof value !== 'object') {
    return 'is not a valid record (not an object)'
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    return 'is missing a valid id'
  }

  if (typeof candidate.name !== 'string') {
    return 'is missing a name'
  }

  if (!Array.isArray(candidate.phases)) {
    return 'is missing its phases'
  }

  if (candidate.isCustom !== true) {
    return 'is not marked as a custom template (a built-in template should never appear in synced data)'
  }

  if (
    typeof candidate.updatedAt !== 'string' ||
    (candidate.updatedAt as string).trim() === ''
  ) {
    return 'is missing a valid updated-at date'
  }

  return null

}

function describeProcedure(value: unknown): string {
  const candidate = (value ?? {}) as Partial<Procedure>
  return `Procedure "${describeString(candidate.name, 'unnamed')}" (id ${describeString(candidate.id, 'unknown')})`
}

function diagnoseProcedure(value: unknown): string | null {

  if (!value || typeof value !== 'object') {
    return 'is not a valid record (not an object)'
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    return 'is missing a valid id'
  }

  if (typeof candidate.name !== 'string') {
    return 'is missing a name'
  }

  if (typeof candidate.templateId !== 'string') {
    return 'is missing a valid template id'
  }

  if (candidate.isCustom !== true) {
    return 'is not marked as a custom procedure (a built-in procedure should never appear in synced data)'
  }

  if (
    typeof candidate.updatedAt !== 'string' ||
    (candidate.updatedAt as string).trim() === ''
  ) {
    return 'is missing a valid updated-at date'
  }

  return null

}

const VALID_TOMBSTONE_ENTITY_TYPES: DeletionTombstone['entityType'][] = [
  'patient',
  'procedureTemplate',
  'treatment',
  'procedure',
]

function describeTombstone(value: unknown): string {
  const candidate = (value ?? {}) as Partial<DeletionTombstone>
  return `Deletion record for ${describeString(candidate.entityType, 'an unknown type of')} ${describeString(candidate.entityId, 'unknown id')}`
}

function diagnoseTombstone(value: unknown): string | null {

  if (!value || typeof value !== 'object') {
    return 'is not a valid record (not an object)'
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    return 'is missing a valid id'
  }

  if (
    typeof candidate.entityId !== 'string' ||
    (candidate.entityId as string).trim() === ''
  ) {
    return 'is missing a valid entity id'
  }

  if (
    !VALID_TOMBSTONE_ENTITY_TYPES.includes(
      candidate.entityType as DeletionTombstone['entityType']
    )
  ) {
    return 'has an unrecognized entity type'
  }

  if (
    typeof candidate.deletedAt !== 'string' ||
    (candidate.deletedAt as string).trim() === ''
  ) {
    return 'is missing a valid deleted-at date'
  }

  return null

}

function findDuplicateId(items: unknown[]): string | null {

  const seenIds = new Set<string>()

  for (const item of items) {

    const id =
      item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
        ? (item as { id: string }).id
        : null

    if (id === null) {
      continue
    }

    if (seenIds.has(id)) {
      return id
    }

    seenIds.add(id)

  }

  return null

}

/*
  Called only once JSON.parse() has already succeeded but
  validateCloudSyncDocument() has already rejected the result - never
  called on a document that parses AND validates. Walks the document
  in the same field order cloudSync.ts's own validator uses
  (patients -> savedTreatments -> customTemplates -> customProcedures
  -> deletionTombstones), so the first thing this function finds wrong
  is, in practice, consistent with what actually caused the rejection.
*/
export function diagnoseCloudSyncDocumentFailure(
  value: unknown
): CloudSyncCorruptionDiagnosis {

  if (!value || typeof value !== 'object') {
    return { kind: 'unreadable', reason: 'The cloud file is not a JSON object.' }
  }

  const candidate = value as Record<string, unknown>

  if (candidate.app !== CLOUD_SYNC_APP) {
    return {
      kind: 'unreadable',
      reason: 'The cloud file does not look like a ToothTarget sync document.',
    }
  }

  if (candidate.schemaVersion !== CLOUD_SYNC_SCHEMA_VERSION) {
    return {
      kind: 'unreadable',
      reason: `The cloud file uses schema version ${String(candidate.schemaVersion)}, which this version of ToothTarget does not support.`,
    }
  }

  if (
    typeof candidate.updatedAt !== 'string' ||
    candidate.updatedAt.trim() === ''
  ) {
    return {
      kind: 'unreadable',
      reason: 'The cloud file is missing a valid updated-at timestamp.',
    }
  }

  if (!Array.isArray(candidate.patients)) {
    return {
      kind: 'unreadable',
      reason: "The cloud file's patient list is missing or not a list.",
    }
  }

  for (const patient of candidate.patients) {
    const reason = diagnosePatient(patient)
    if (reason) {
      return {
        kind: 'invalid-record',
        recordType: 'patient',
        recordDescription: describePatient(patient),
        reason,
      }
    }
  }

  const duplicatePatientId = findDuplicateId(candidate.patients)
  if (duplicatePatientId) {
    return {
      kind: 'invalid-record',
      recordType: 'patient',
      recordDescription: `Patient id ${duplicatePatientId}`,
      reason: 'this patient id appears more than once in the cloud file',
    }
  }

  if (!Array.isArray(candidate.savedTreatments)) {
    return {
      kind: 'unreadable',
      reason: "The cloud file's treatment list is missing or not a list.",
    }
  }

  for (const treatment of candidate.savedTreatments) {
    const reason = diagnoseTreatment(treatment)
    if (reason) {
      return {
        kind: 'invalid-record',
        recordType: 'treatment',
        recordDescription: describeTreatment(treatment),
        reason,
      }
    }
  }

  const duplicateTreatmentId = findDuplicateId(candidate.savedTreatments)
  if (duplicateTreatmentId) {
    return {
      kind: 'invalid-record',
      recordType: 'treatment',
      recordDescription: `Treatment id ${duplicateTreatmentId}`,
      reason: 'this treatment id appears more than once in the cloud file',
    }
  }

  if (!Array.isArray(candidate.customTemplates)) {
    return {
      kind: 'unreadable',
      reason: "The cloud file's template list is missing or not a list.",
    }
  }

  for (const template of candidate.customTemplates) {
    const reason = diagnoseTemplate(template)
    if (reason) {
      return {
        kind: 'invalid-record',
        recordType: 'template',
        recordDescription: describeTemplate(template),
        reason,
      }
    }
  }

  const duplicateTemplateId = findDuplicateId(candidate.customTemplates)
  if (duplicateTemplateId) {
    return {
      kind: 'invalid-record',
      recordType: 'template',
      recordDescription: `Template id ${duplicateTemplateId}`,
      reason: 'this template id appears more than once in the cloud file',
    }
  }

  if (!Array.isArray(candidate.customProcedures)) {
    return {
      kind: 'unreadable',
      reason: "The cloud file's procedure list is missing or not a list.",
    }
  }

  for (const procedure of candidate.customProcedures) {
    const reason = diagnoseProcedure(procedure)
    if (reason) {
      return {
        kind: 'invalid-record',
        recordType: 'procedure',
        recordDescription: describeProcedure(procedure),
        reason,
      }
    }
  }

  const duplicateProcedureId = findDuplicateId(candidate.customProcedures)
  if (duplicateProcedureId) {
    return {
      kind: 'invalid-record',
      recordType: 'procedure',
      recordDescription: `Procedure id ${duplicateProcedureId}`,
      reason: 'this procedure id appears more than once in the cloud file',
    }
  }

  if (!Array.isArray(candidate.deletionTombstones)) {
    return {
      kind: 'unreadable',
      reason: "The cloud file's deletion-record list is missing or not a list.",
    }
  }

  for (const tombstone of candidate.deletionTombstones) {
    const reason = diagnoseTombstone(tombstone)
    if (reason) {
      return {
        kind: 'invalid-record',
        recordType: 'tombstone',
        recordDescription: describeTombstone(tombstone),
        reason,
      }
    }
  }

  /*
    Should not normally be reached - validateCloudSyncDocument() has
    already rejected this document, so every check above passing means
    this diagnosis doesn't yet cover whatever rule actually rejected
    it (eg. a future rule added to cloudSync.ts without a matching
    check added here). Reported honestly rather than silently implying
    everything is fine.
  */
  return {
    kind: 'unreadable',
    reason: "The cloud file failed validation, but this diagnosis could not pinpoint a specific record.",
  }

}

/*
  Used when the cloud file could not even be parsed as JSON - there is
  no document to walk at all, so this is always 'unreadable'.
*/
export function diagnoseUnparsableCloudSyncContent(): CloudSyncCorruptionDiagnosis {
  return {
    kind: 'unreadable',
    reason: 'The cloud file could not be parsed as JSON.',
  }
}
