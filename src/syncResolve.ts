import type { Patient, SavedTreatment, ProcedureTemplate, Procedure } from './App'
import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  validateCloudSyncDocument,
  type CloudSyncDocument,
} from './cloudSync'
import { applyPatientRenameToSavedTreatments } from './patientRenameCascade'
import { computeNextPatientNumber } from './patientNumberConflicts'
import {
  diffSnapshots,
  exactRecordSignature,
  type DiffEntity,
  type SnapshotDiff,
  type OneSidedDiffItem,
  type DifferentDiffItem,
} from './syncDiff'

/*
  SNAPSHOT RESOLUTION (Phase 6, step 2)

  Pure module (no I/O, no React, no localStorage): turns the dentist's
  per-record choices into ONE resolved snapshot, plus everything the
  screen needs to decide whether that snapshot may be applied yet
  (undecided rows, blocking problems, patient-number collisions,
  records being brought back). Nothing here writes anything -
  resolveSnapshots() only ever returns a candidate document.

  ============================================================
  CHOICES
  ============================================================

  A choice is keyed by recordKey(entity, id) and is one of:
    'device'  use this device's version of the record
    'cloud'   use OneDrive's version of the record
    'omit'    leave the record out of the result (this IS the delete)
  Legal choices per row kind:
    only on this device  -> 'device' (keep)  | 'omit'
    only in the cloud    -> 'cloud' (bring)  | 'omit'
    on both, different   -> 'device' | 'cloud'   (no omit: the record
                            exists on both sides; "delete" is not a
                            conflict resolution)
  A row with no choice is UNDECIDED and blocks canApply.

  ============================================================
  INTEGRITY RULES (applied to the in-memory result, never to storage)
  ============================================================

  1. Treatment whose patient is not in the result:
       - patient was left out (or is undecided) -> BLOCKING problem
         'treatment-needs-patient'. Deliberately NOT auto-included: a
         patient the dentist explicitly left out must never be quietly
         resurrected because some treatment still points at them. The
         screen offers: keep the patient, or leave the treatment out
         too (see decisionsKeepingPatientWithTreatments()).
       - patient exists on NEITHER side (an orphan that was already
         there before this resolution) -> non-blocking warning
         'orphan-treatment'; nothing about it is made worse.
  2. Treatment's denormalised patientName differs from the patient it
     points at in the result -> rewritten to the result patient's name
     (via patientRenameCascade's own pure function), updatedAt = now.
  3. Procedure whose templateId/regionTemplateIds names a CUSTOM
     template that exists on either side but is missing from the
     result -> that template is AUTO-INCLUDED and reported in
     autoIncluded. (Templates, unlike patients, carry no "resurrection"
     risk worth blocking over, and a procedure without its template is
     broken.) A templateId that is on neither side is assumed to be a
     built-in template, which is not part of the synced data - left
     alone.
  4. A treatment pointing at a missing procedure is only a warning
     'treatment-procedure-missing' (statistics merge by name).
  5. Patient-number collisions (two DIFFERENT patient ids, same number,
     after numberFixes are applied) are BLOCKING.
  6. The final document must pass validateCloudSyncDocument().

  The result's updatedAt is the nowIso passed in (the caller generates
  and remembers it once - the crash-recovery stamp); tombstones are
  always [] (nothing writes them to the cloud any more).
*/

export type Choice = 'device' | 'cloud' | 'omit'

export type Decisions = Record<string, Choice>

/* patientId -> the new patient number that patient should get. */
export type NumberFixes = Record<string, number>

export function recordKey(entity: DiffEntity, id: string): string {
  return `${entity}:${id}`
}

type Snapshot = Pick<
  CloudSyncDocument,
  'patients' | 'savedTreatments' | 'customTemplates' | 'customProcedures'
>

export type AutoIncluded = {
  entity: 'template'
  id: string
  name: string
  /* Why: which procedures needed it. */
  neededBy: string[]
}

export type ResolveProblem =
  | {
      kind: 'invalid-choice'
      entity: DiffEntity
      id: string
      choice: Choice
    }
  | {
      kind: 'treatment-needs-patient'
      patientId: string
      patientName: string
      treatmentIds: string[]
      /* Which sides actually have this patient (to offer "keep patient"). */
      patientExistsOn: ('device' | 'cloud')[]
    }
  | {
      kind: 'number-collision'
      patientNumber: number
      patientIds: string[]
    }
  | { kind: 'invalid-number-fix'; patientId: string; newNumber: number }
  | { kind: 'invalid-document'; detail: string }

export type ResolveWarning =
  | { kind: 'orphan-treatment'; treatmentId: string; patientId: string }
  | { kind: 'treatment-procedure-missing'; treatmentId: string; procedureId: string }

export type PatientNumberCollision = {
  patientNumber: number
  patients: { id: string; name: string; treatmentCount: number }[]
}

export type EntityTally = {
  /* One-sided device records kept + both-sides records resolved to the device. */
  fromDevice: number
  /* One-sided cloud records brought over + both-sides records resolved to the cloud. */
  fromCloud: number
  identical: number
  /* One-sided records left out. */
  leftOut: number
  total: number
}

export type ResolveResult = {
  diff: SnapshotDiff
  undecided: (OneSidedDiffItem | DifferentDiffItem)[]
  problems: ResolveProblem[]
  warnings: ResolveWarning[]
  collisions: PatientNumberCollision[]
  autoIncluded: AutoIncluded[]
  /* Treatments whose stored patient name was rewritten to match. */
  renamedTreatmentIds: string[]
  tally: Record<DiffEntity, EntityTally>
  /*
    Patients as they would be in the result (number fixes applied), even
    while other things still block - what suggestNumberFixes() needs.
  */
  candidatePatients: Patient[]
  /* Patients that get a new number from numberFixes, for the final summary. */
  renumbered: { patientId: string; name: string; from: number; to: number }[]
  /*
    Kept records that already existed at the last sync on the side that
    lacks them (age 'at-or-before') - the dentist must acknowledge
    these ("probably deleted, coming back") before applying.
  */
  resurrected: OneSidedDiffItem[]
  /* Informational only: 'changed-since' records being kept. */
  maybeResurrected: OneSidedDiffItem[]
  /*
    Non-null ONLY when nothing blocks: no undecided rows, no problems,
    no collisions. Never a partially-resolved document.
  */
  document: CloudSyncDocument | null
  canApply: boolean
}

export type ResolveOptions = {
  nowIso: string
  /* Forwarded to the diff (one-sided age/hints). */
  lastSyncAt?: string | null
  numberFixes?: NumberFixes
}

/* ---------- legality ---------- */

function legalChoices(
  item: OneSidedDiffItem | DifferentDiffItem
): Choice[] {

  if ('side' in item) {
    return item.side === 'device' ? ['device', 'omit'] : ['cloud', 'omit']
  }

  return ['device', 'cloud']

}

function isOneSided(
  item: OneSidedDiffItem | DifferentDiffItem
): item is OneSidedDiffItem {
  return 'side' in item
}

/* ---------- the resolver ---------- */

function newerOf<T extends { updatedAt: string }>(device: T, cloud: T): T {

  const a = Date.parse(device.updatedAt)
  const b = Date.parse(cloud.updatedAt)

  if (Number.isNaN(a) || Number.isNaN(b)) {
    return device
  }

  return b > a ? cloud : device

}

function emptyTally(): EntityTally {
  return { fromDevice: 0, fromCloud: 0, identical: 0, leftOut: 0, total: 0 }
}

export function resolveSnapshots(
  device: Snapshot,
  cloud: Snapshot,
  decisions: Decisions,
  options: ResolveOptions
): ResolveResult {

  const { nowIso } = options
  const numberFixes = options.numberFixes ?? {}

  const diff = diffSnapshots(device, cloud, { lastSyncAt: options.lastSyncAt })

  const problems: ResolveProblem[] = []
  const warnings: ResolveWarning[] = []
  const undecided: (OneSidedDiffItem | DifferentDiffItem)[] = []
  const resurrected: OneSidedDiffItem[] = []
  const maybeResurrected: OneSidedDiffItem[] = []

  const tally: Record<DiffEntity, EntityTally> = {
    patient: emptyTally(),
    treatment: emptyTally(),
    procedure: emptyTally(),
    template: emptyTally(),
  }

  /*
    Records chosen for the result, per entity, keyed by id. Seeded with
    the identical records (later updatedAt wins; device on a tie), then
    filled from the dentist's choices.
  */
  const chosen: {
    patient: Map<string, Patient>
    treatment: Map<string, SavedTreatment>
    procedure: Map<string, Procedure>
    template: Map<string, ProcedureTemplate>
  } = {
    patient: new Map(),
    treatment: new Map(),
    procedure: new Map(),
    template: new Map(),
  }

  const differingKeys = new Set<string>()
  const oneSidedKeys = new Set<string>()

  for (const item of diff.different) {
    differingKeys.add(recordKey(item.entity, item.id))
  }

  for (const item of [...diff.deviceOnly, ...diff.cloudOnly]) {
    oneSidedKeys.add(recordKey(item.entity, item.id))
  }

  function seedIdentical<T extends { id: string; updatedAt: string }>(
    entity: DiffEntity,
    deviceRecords: T[],
    cloudRecords: T[],
    target: Map<string, T>
  ) {

    const cloudById = new Map(cloudRecords.map(record => [record.id, record]))

    for (const deviceRecord of deviceRecords) {

      const key = recordKey(entity, deviceRecord.id)

      const cloudRecord = cloudById.get(deviceRecord.id)

      if (cloudRecord && !differingKeys.has(key)) {
        target.set(deviceRecord.id, newerOf(deviceRecord, cloudRecord))
        tally[entity].identical += 1
      }

    }

  }

  seedIdentical('patient', device.patients, cloud.patients, chosen.patient)
  seedIdentical('treatment', device.savedTreatments, cloud.savedTreatments, chosen.treatment)
  seedIdentical('procedure', device.customProcedures, cloud.customProcedures, chosen.procedure)
  seedIdentical('template', device.customTemplates, cloud.customTemplates, chosen.template)

  function put(entity: DiffEntity, id: string, record: unknown) {
    (chosen[entity] as Map<string, unknown>).set(id, record)
  }

  for (const item of [...diff.deviceOnly, ...diff.cloudOnly, ...diff.different]) {

    const key = recordKey(item.entity, item.id)
    const choice = decisions[key]

    if (choice === undefined) {
      undecided.push(item)
      continue
    }

    if (!legalChoices(item).includes(choice)) {
      problems.push({ kind: 'invalid-choice', entity: item.entity, id: item.id, choice })
      continue
    }

    if (isOneSided(item)) {

      if (choice === 'omit') {
        tally[item.entity].leftOut += 1
        continue
      }

      put(item.entity, item.id, item.record)

      if (item.side === 'device') {
        tally[item.entity].fromDevice += 1
      } else {
        tally[item.entity].fromCloud += 1
      }

      if (item.age === 'at-or-before') {
        resurrected.push(item)
      } else if (item.age === 'changed-since') {
        maybeResurrected.push(item)
      }

      continue

    }

    // Both sides, different.
    if (choice === 'device') {
      put(item.entity, item.id, item.device)
      tally[item.entity].fromDevice += 1
    } else {
      put(item.entity, item.id, item.cloud)
      tally[item.entity].fromCloud += 1
    }

  }

  /* ---- Integrity 3: templates needed by kept procedures ---- */

  const deviceTemplatesById = new Map(device.customTemplates.map(t => [t.id, t]))
  const cloudTemplatesById = new Map(cloud.customTemplates.map(t => [t.id, t]))

  const autoIncludedById = new Map<string, AutoIncluded>()

  for (const procedure of chosen.procedure.values()) {

    const referenced = [
      procedure.templateId,
      procedure.regionTemplateIds?.anterior,
      procedure.regionTemplateIds?.premolar,
      procedure.regionTemplateIds?.molar,
    ].filter((id): id is string => typeof id === 'string' && id !== '')

    for (const templateId of referenced) {

      if (chosen.template.has(templateId)) {
        continue
      }

      const source =
        deviceTemplatesById.get(templateId) ?? cloudTemplatesById.get(templateId)

      if (!source) {
        // Not a synced custom template - assumed built-in, left alone.
        continue
      }

      chosen.template.set(templateId, source)
      const existing = autoIncludedById.get(templateId)

      if (existing) {
        if (!existing.neededBy.includes(procedure.name)) {
          existing.neededBy.push(procedure.name)
        }
      } else {
        autoIncludedById.set(templateId, {
          entity: 'template',
          id: templateId,
          name: source.name,
          neededBy: [procedure.name],
        })
      }

    }

  }

  /* ---- Integrity 1: treatments need their patient ---- */

  const allKnownPatientIds = new Map<string, ('device' | 'cloud')[]>()

  for (const patient of device.patients) {
    allKnownPatientIds.set(patient.id, ['device'])
  }

  for (const patient of cloud.patients) {

    const sides = allKnownPatientIds.get(patient.id)

    if (sides) {
      sides.push('cloud')
    } else {
      allKnownPatientIds.set(patient.id, ['cloud'])
    }

  }

  const missingPatientTreatments = new Map<string, SavedTreatment[]>()

  for (const treatment of chosen.treatment.values()) {

    if (chosen.patient.has(treatment.patientId)) {
      continue
    }

    if (!allKnownPatientIds.has(treatment.patientId)) {
      warnings.push({
        kind: 'orphan-treatment',
        treatmentId: treatment.id,
        patientId: treatment.patientId,
      })
      continue
    }

    const list = missingPatientTreatments.get(treatment.patientId) ?? []
    list.push(treatment)
    missingPatientTreatments.set(treatment.patientId, list)

  }

  for (const [patientId, treatments] of missingPatientTreatments) {

    problems.push({
      kind: 'treatment-needs-patient',
      patientId,
      patientName: treatments[0].patientName,
      treatmentIds: treatments.map(treatment => treatment.id),
      patientExistsOn: allKnownPatientIds.get(patientId) ?? [],
    })

  }

  /* ---- Integrity 4: procedure missing (warning only) ---- */

  const knownProcedureIds = new Set<string>([
    ...device.customProcedures.map(p => p.id),
    ...cloud.customProcedures.map(p => p.id),
  ])

  for (const treatment of chosen.treatment.values()) {

    if (
      treatment.procedureId &&
      knownProcedureIds.has(treatment.procedureId) &&
      !chosen.procedure.has(treatment.procedureId)
    ) {
      warnings.push({
        kind: 'treatment-procedure-missing',
        treatmentId: treatment.id,
        procedureId: treatment.procedureId,
      })
    }

  }

  /* ---- number fixes, then collision detection (Integrity 5) ---- */

  const patientsWithFixes: Patient[] = []
  const renumbered: ResolveResult['renumbered'] = []

  for (const patient of chosen.patient.values()) {

    const fix = numberFixes[patient.id]

    if (fix === undefined) {
      patientsWithFixes.push(patient)
      continue
    }

    if (!Number.isInteger(fix) || fix <= 0) {
      problems.push({ kind: 'invalid-number-fix', patientId: patient.id, newNumber: fix })
      patientsWithFixes.push(patient)
      continue
    }

    if (fix !== patient.patientNumber) {
      renumbered.push({
        patientId: patient.id,
        name: patient.name,
        from: patient.patientNumber,
        to: fix,
      })
    }

    patientsWithFixes.push(
      fix === patient.patientNumber
        ? patient
        : { ...patient, patientNumber: fix, updatedAt: nowIso }
    )

  }

  const byNumber = new Map<number, Patient[]>()

  for (const patient of patientsWithFixes) {

    const list = byNumber.get(patient.patientNumber) ?? []
    list.push(patient)
    byNumber.set(patient.patientNumber, list)

  }

  const collisions: PatientNumberCollision[] = []

  for (const [patientNumber, patients] of byNumber) {

    if (patients.length < 2) {
      continue
    }

    collisions.push({
      patientNumber,
      patients: patients.map(patient => ({
        id: patient.id,
        name: patient.name,
        treatmentCount: [...chosen.treatment.values()].filter(
          treatment => treatment.patientId === patient.id
        ).length,
      })),
    })

    problems.push({
      kind: 'number-collision',
      patientNumber,
      patientIds: patients.map(patient => patient.id).sort(),
    })

  }

  collisions.sort((a, b) => a.patientNumber - b.patientNumber)

  /* ---- Integrity 2: rewrite stale denormalised patient names ---- */

  const patientsById = new Map(patientsWithFixes.map(patient => [patient.id, patient]))

  let treatments = [...chosen.treatment.values()]

  const renamedTreatmentIds: string[] = []

  for (const patient of patientsById.values()) {

    const stale = treatments.filter(
      treatment =>
        treatment.patientId === patient.id && treatment.patientName !== patient.name
    )

    if (stale.length === 0) {
      continue
    }

    const staleIds = new Set(stale.map(treatment => treatment.id))

    const renamed = applyPatientRenameToSavedTreatments(
      treatments.filter(treatment => staleIds.has(treatment.id)),
      patient.id,
      patient.name,
      nowIso
    )

    const renamedById = new Map(renamed.map(treatment => [treatment.id, treatment]))

    treatments = treatments.map(treatment => renamedById.get(treatment.id) ?? treatment)

    renamedTreatmentIds.push(...staleIds)

  }

  /* ---- assemble + totals ---- */

  const resolvedPatients = patientsWithFixes
  const resolvedTemplates = [...chosen.template.values()]
  const resolvedProcedures = [...chosen.procedure.values()]

  tally.patient.total = resolvedPatients.length
  tally.treatment.total = treatments.length
  tally.procedure.total = resolvedProcedures.length
  tally.template.total = resolvedTemplates.length

  const blocked = undecided.length > 0 || problems.length > 0

  let document: CloudSyncDocument | null = null

  if (!blocked) {

    const validation = validateCloudSyncDocument({
      schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
      app: CLOUD_SYNC_APP,
      updatedAt: nowIso,
      patients: resolvedPatients,
      savedTreatments: treatments,
      customTemplates: resolvedTemplates,
      customProcedures: resolvedProcedures,
      deletionTombstones: [],
    })

    if (validation.valid) {
      document = validation.document
    } else {
      problems.push({ kind: 'invalid-document', detail: validation.error })
    }

  }

  return {
    diff,
    undecided,
    problems,
    warnings,
    collisions,
    autoIncluded: [...autoIncludedById.values()],
    renamedTreatmentIds,
    tally,
    candidatePatients: resolvedPatients,
    renumbered,
    resurrected,
    maybeResurrected,
    document,
    canApply: document !== null,
  }

}

/* ============================================================
   CHOICE HELPERS (shortcuts, bulk fill, carry-over)
   ============================================================ */

function allItems(
  diff: SnapshotDiff
): (OneSidedDiffItem | DifferentDiffItem)[] {
  return [...diff.deviceOnly, ...diff.cloudOnly, ...diff.different]
}

/*
  "Use everything from this device": the result equals this device's
  data - device-only records kept, cloud-only records left out, shared
  records resolved to the device's version.
*/
export function decideAllFromDevice(diff: SnapshotDiff): Decisions {

  const decisions: Decisions = {}

  for (const item of allItems(diff)) {

    const key = recordKey(item.entity, item.id)

    decisions[key] = isOneSided(item)
      ? item.side === 'device' ? 'device' : 'omit'
      : 'device'

  }

  return decisions

}

/* Mirror image: the result equals the cloud's data. */
export function decideAllFromCloud(diff: SnapshotDiff): Decisions {

  const decisions: Decisions = {}

  for (const item of allItems(diff)) {

    const key = recordKey(item.entity, item.id)

    decisions[key] = isOneSided(item)
      ? item.side === 'cloud' ? 'cloud' : 'omit'
      : 'cloud'

  }

  return decisions

}

/*
  The per-section bulk button, "Keep / bring everything created since
  the last sync". Fills ONLY one-sided rows whose age is exactly
  'created-since' (creation time known and later than the last sync) -
  never 'changed-since', never 'at-or-before', never a both-sides
  row. `entity` limits it to one section (null = every section). Rows
  that already have a choice are left exactly as the dentist set them.
*/
export function decideCreatedSinceLastSync(
  diff: SnapshotDiff,
  entity: DiffEntity | null,
  existing: Decisions
): Decisions {

  const decisions: Decisions = { ...existing }

  for (const item of [...diff.deviceOnly, ...diff.cloudOnly]) {

    if (item.age !== 'created-since') {
      continue
    }

    if (entity !== null && item.entity !== entity) {
      continue
    }

    const key = recordKey(item.entity, item.id)

    if (decisions[key] === undefined) {
      decisions[key] = item.side
    }

  }

  return decisions

}

/*
  Offered when a kept treatment's patient was left out: choose the
  patient (from whichever side has them) so the kept treatments have
  their patient again. Only ever touches that one patient's own row.
  Returns a new Decisions; does not mutate.
*/
export function decisionsKeepingPatientWithTreatments(
  diff: SnapshotDiff,
  decisions: Decisions,
  patientId: string
): Decisions {

  const next: Decisions = { ...decisions }

  const patientKey = recordKey('patient', patientId)

  const devicePatient =
    diff.deviceOnly.find(item => item.entity === 'patient' && item.id === patientId)

  const cloudPatient =
    diff.cloudOnly.find(item => item.entity === 'patient' && item.id === patientId)

  if (devicePatient) {
    next[patientKey] = 'device'
  } else if (cloudPatient) {
    next[patientKey] = 'cloud'
  }

  return next

}

/* The other offered fix: leave the patient out AND their treatments too. */
export function decisionsOmittingTreatments(
  decisions: Decisions,
  diff: SnapshotDiff,
  treatmentIds: string[]
): Decisions {

  const next: Decisions = { ...decisions }

  const ids = new Set(treatmentIds)

  for (const item of [...diff.deviceOnly, ...diff.cloudOnly]) {

    if (item.entity === 'treatment' && ids.has(item.id)) {
      next[recordKey('treatment', item.id)] = 'omit'
    }

  }

  return next

}

/*
  Carry the dentist's choices over to a fresh diff (the cloud or this
  device changed while they were deciding). A choice survives ONLY if
  the record is still the same kind of row AND every version involved
  is byte-for-byte the one they looked at (exact comparison, updatedAt
  included). Everything else becomes undecided again and is reported in
  `reset`, so the screen can highlight it as "changed".
*/
export function carryOverDecisions(
  previous: SnapshotDiff,
  next: SnapshotDiff,
  decisions: Decisions
): { decisions: Decisions; reset: string[] } {

  function signatures(diff: SnapshotDiff): Map<string, string> {

    const map = new Map<string, string>()

    for (const item of diff.deviceOnly) {
      map.set(recordKey(item.entity, item.id), `device-only|${exactRecordSignature(item.record)}`)
    }

    for (const item of diff.cloudOnly) {
      map.set(recordKey(item.entity, item.id), `cloud-only|${exactRecordSignature(item.record)}`)
    }

    for (const item of diff.different) {
      map.set(
        recordKey(item.entity, item.id),
        `different|${exactRecordSignature(item.device)}|${exactRecordSignature(item.cloud)}`
      )
    }

    return map

  }

  const before = signatures(previous)
  const after = signatures(next)

  const carried: Decisions = {}
  const reset: string[] = []

  for (const [key, signature] of after) {

    const choice = decisions[key]

    if (choice !== undefined && before.get(key) === signature) {
      carried[key] = choice
    } else {
      reset.push(key)
    }

  }

  return { decisions: carried, reset }

}

/* ============================================================
   PATIENT-NUMBER FIX SUGGESTIONS
   ============================================================ */

/*
  For each collision, `keepPatientIds` says who keeps the number (by
  patientNumber -> patientId); every OTHER patient in that collision is
  given the next free number, assigned in a stable order (by patient
  id) from computeNextPatientNumber() over the whole result so far, so
  two renumbered patients never land on the same new number either.
  Returns NumberFixes ready to pass back into resolveSnapshots().
*/
export function suggestNumberFixes(
  resultPatients: { id: string; patientNumber: number }[],
  collisions: PatientNumberCollision[],
  keepPatientIds: Record<number, string>
): NumberFixes {

  const fixes: NumberFixes = {}

  let next = computeNextPatientNumber(resultPatients)

  for (const collision of collisions) {

    const keeper = keepPatientIds[collision.patientNumber] ?? collision.patients[0].id

    const others = collision.patients
      .filter(patient => patient.id !== keeper)
      .sort((a, b) => a.id.localeCompare(b.id))

    for (const other of others) {
      fixes[other.id] = next
      next += 1
    }

  }

  return fixes

}
