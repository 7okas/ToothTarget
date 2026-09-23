import type { Patient } from './App'
import type { PatientNumberConflict } from './cloudMerge'

/*
  PATIENT-NUMBER CONFLICTS (Phase 4 - cloud sync foundation)

  A future cloud merge (see cloudMerge.ts's mergeCloudSyncDocuments())
  can report that two different patient UUIDs ended up holding the
  same patientNumber - eg. two devices each allocated "#12" to a
  different patient while offline. That can NEVER happen from normal
  local use of App.tsx's own allocatePatientUnderLock() (it always
  reads the current registry fresh under the allocation lock before
  handing out a number), so this mechanism exists purely to record and
  let the dentist explicitly resolve a collision that arrived from
  elsewhere - nothing in this file ever creates one on its own.

  This is a SEPARATE module (not more code added directly to App.tsx)
  specifically so it can be unit-tested in isolation: App.tsx pulls in
  MicrosoftAccountSection.tsx -> auth.ts/authConfig.ts, which touch
  `window.location` and instantiate MSAL's PublicClientApplication at
  module load time - importing App.tsx from a plain Vitest test would
  crash before any test body even runs. Only TYPE-ONLY imports are
  taken from App.tsx/cloudMerge.ts above (erased entirely at compile
  time under verbatimModuleSyntax), so this module has zero runtime
  dependency on either of them and is safe to import directly in
  tests. Consequently, readPersistedPatients()/
  PATIENT_ALLOCATION_LOCK_NAME below are each small, self-contained
  re-implementations of the equivalent helpers already living in
  App.tsx (reading the exact same 'toothTargetPatients' key, and using
  the exact same lock name string) - mirroring the same "duplicate the
  tiny localStorage read, never the business logic" pattern
  cloudBackup.ts already established for the same reason. If either
  key name or the lock name ever changes in App.tsx, it must change
  here too. NEXT_PATIENT_NUMBER_KEY is still written (see
  resolvePatientNumberConflictUnderLock() below) as a non-authoritative
  cache, per Phase 4.6's own reasoning (App.tsx's
  allocatePatientUnderLock()), but is no longer read anywhere in this
  file.

  Only { patientNumber, patientIds } is ever persisted - never patient
  names, treatment data, or anything else - because the current
  patient registry (toothTargetPatients) already IS the source of
  truth for every other detail; this store only needs to remember
  WHICH numbers/UUIDs are still in collision.
*/

const PATIENTS_KEY = 'toothTargetPatients'
const NEXT_PATIENT_NUMBER_KEY = 'toothTargetNextPatientNumber'
export const PATIENT_NUMBER_CONFLICTS_KEY = 'toothTargetPatientNumberConflicts'

/*
  Must stay the same lock name App.tsx's own PATIENT_ALLOCATION_LOCK_NAME
  uses: conflict resolution rewrites the same two keys
  (toothTargetPatients/toothTargetNextPatientNumber) that patient
  creation/deletion do, so it has to serialize against the exact same
  lock, not a separate one.
*/
export const PATIENT_ALLOCATION_LOCK_NAME = 'toothtarget-patient-allocation'

/*
  DYNAMIC NEXT-PATIENT-NUMBER (Phase 4.6)

  Shared by App.tsx's allocatePatientUnderLock() (brand-new patient
  creation) and this file's own resolvePatientNumberConflictUnderLock()
  (renumbering a conflict's losing patient(s)) - the one place either
  of those now computes "what's the next safe patientNumber", so the
  two can never drift apart in how they answer that question. Purely a
  function of the CURRENT patient list - never
  toothTargetNextPatientNumber, which is no longer trusted as a floor
  for this decision (see this file's own header comment and App.tsx's
  allocatePatientUnderLock() for the full reasoning, including the
  deliberate trade-off that a deleted patient's number can now be
  handed out again, since nothing here remembers numbers that used to
  exist but don't anymore).
*/

export function computeNextPatientNumber(
  patients: { patientNumber: number }[]
): number {

  const highestAssignedPatientNumber =
    patients.reduce(
      (highest, patient) =>
        patient.patientNumber > highest ? patient.patientNumber : highest,
      0
    )

  return highestAssignedPatientNumber + 1

}

/*
  EDIT-TIME CONFLICT DETECTION (Phase 4.6)

  Used by App.tsx's editPatientRecordUnderLock() right after applying a
  patient-number edit, to check whether that edit just collided with
  another patient's number. Deliberately NOT exported as a blocker -
  the edit itself is never prevented by this; the caller passes
  whatever this returns straight into recordAndReconcilePatientNumberConflicts()
  below, the exact same detect-and-record pattern a cloud merge already
  uses for the same underlying situation (two independently-made
  changes landing on the same number).
*/

export function detectPatientNumberConflict(
  patients: { id: string; patientNumber: number }[],
  patientNumber: number
): PatientNumberConflict | null {

  const collidingIds =
    patients
      .filter(patient => patient.patientNumber === patientNumber)
      .map(patient => patient.id)

  return collidingIds.length > 1
    ? { patientNumber, patientIds: collidingIds.sort() }
    : null

}

function isValidPatient(value: unknown): value is Patient {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Patient).id === 'string' &&
    typeof (value as Patient).name === 'string' &&
    typeof (value as Patient).patientNumber === 'number'
  )

}

function readPersistedPatients(): Patient[] {

  try {

    const raw = localStorage.getItem(PATIENTS_KEY)

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed.filter(isValidPatient) : []

  } catch {

    return []

  }

}

export function isValidPatientNumberConflict(
  value: unknown
): value is PatientNumberConflict {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as PatientNumberConflict).patientNumber === 'number' &&
    Number.isInteger((value as PatientNumberConflict).patientNumber) &&
    (value as PatientNumberConflict).patientNumber > 0 &&
    Array.isArray((value as PatientNumberConflict).patientIds) &&
    (value as PatientNumberConflict).patientIds.every(
      patientId => typeof patientId === 'string' && patientId.trim() !== ''
    )
  )

}

export function readPersistedPatientNumberConflicts(): PatientNumberConflict[] {

  try {

    const raw = localStorage.getItem(PATIENT_NUMBER_CONFLICTS_KEY)

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed)
      ? parsed.filter(isValidPatientNumberConflict)
      : []

  } catch {

    return []

  }

}

/*
  Re-derives which persisted conflicts are still genuine against the
  CURRENT patient registry, rather than trusting the persisted record
  itself (which can go stale the moment either patient is deleted, or
  the conflict is explicitly resolved). A conflict only survives this
  pass if at least two DISTINCT patient ids from its (deduplicated,
  defensively-cleaned) patientIds list still exist in the registry AND
  still actually hold that exact patientNumber right now. This never
  mutates or deletes a patient - it only decides which bookkeeping
  records are worth keeping.
*/

export function reconcilePatientNumberConflicts(
  conflicts: PatientNumberConflict[],
  currentPatients: Patient[]
): PatientNumberConflict[] {

  const reconciled: PatientNumberConflict[] = []

  for (const conflict of conflicts) {

    const stillConflictingIds = Array.from(
      new Set(conflict.patientIds)
    ).filter(patientId =>
      currentPatients.some(
        patient =>
          patient.id === patientId &&
          patient.patientNumber === conflict.patientNumber
      )
    )

    if (stillConflictingIds.length > 1) {

      reconciled.push({
        patientNumber: conflict.patientNumber,
        patientIds: stillConflictingIds.sort(),
      })

    }

  }

  return reconciled

}

/*
  Reads the persisted conflict list, reconciles it against
  `currentPatients`, and re-persists it ONLY when reconciliation
  actually changed something - called by the tab that just changed the
  patient registry itself (initial load, or after a delete), never
  from a cross-tab storage-event handler (which should only ever
  update its own React state, exactly like App.tsx's existing handler
  already does for toothTargetPatients/toothTargetTemplates).
*/

export function reconcileAndPersistPatientNumberConflicts(
  currentPatients: Patient[]
): PatientNumberConflict[] {

  const persisted = readPersistedPatientNumberConflicts()

  const reconciled = reconcilePatientNumberConflicts(
    persisted,
    currentPatients
  )

  if (JSON.stringify(reconciled) !== JSON.stringify(persisted)) {

    localStorage.setItem(
      PATIENT_NUMBER_CONFLICTS_KEY,
      JSON.stringify(reconciled)
    )

  }

  return reconciled

}

/*
  INGEST CONFLICTS REPORTED BY A CLOUD MERGE (Phase 6)

  mergeCloudSyncDocuments() (cloudMerge.ts) can report brand new
  patient-number conflicts that this device has never seen before -
  this is the one place that happens, since normal local patient
  creation can never produce one (see this file's own header comment).
  Unlike reconcileAndPersistPatientNumberConflicts() above (which only
  ever DROPS stale entries), this ADDS the merge's freshly-reported
  conflicts to whatever is already persisted, unioning patientIds by
  patientNumber (two independently-detected conflicts for the same
  number combine their known conflicting ids rather than one silently
  replacing the other), and then reconciles the combined list against
  the current patient registry in the same pass - so a conflict that's
  already stale by the time this runs is dropped immediately rather
  than being persisted and cleaned up on some later read.
*/

function unionConflictsByPatientNumber(
  existingConflicts: PatientNumberConflict[],
  incomingConflicts: PatientNumberConflict[]
): PatientNumberConflict[] {

  const idsByNumber = new Map<number, Set<string>>()

  for (const conflict of [...existingConflicts, ...incomingConflicts]) {

    const ids = idsByNumber.get(conflict.patientNumber) ?? new Set<string>()

    for (const patientId of conflict.patientIds) {
      ids.add(patientId)
    }

    idsByNumber.set(conflict.patientNumber, ids)

  }

  return Array.from(idsByNumber.entries()).map(
    ([patientNumber, ids]) => ({
      patientNumber,
      patientIds: Array.from(ids).sort(),
    })
  )

}

export function recordAndReconcilePatientNumberConflicts(
  incomingConflicts: PatientNumberConflict[],
  currentPatients: Patient[]
): PatientNumberConflict[] {

  const persisted = readPersistedPatientNumberConflicts()

  const combined = unionConflictsByPatientNumber(
    persisted,
    incomingConflicts
  )

  const reconciled = reconcilePatientNumberConflicts(
    combined,
    currentPatients
  )

  if (JSON.stringify(reconciled) !== JSON.stringify(persisted)) {

    localStorage.setItem(
      PATIENT_NUMBER_CONFLICTS_KEY,
      JSON.stringify(reconciled)
    )

  }

  return reconciled

}

/*
  RESOLVE ONE PATIENT-NUMBER CONFLICT

  The dentist picks which patient KEEPS the conflicted number
  (keepPatientId); every other patient currently holding that same
  number is reassigned a fresh one, using the exact same monotonic
  toothTargetNextPatientNumber counter/formula App.tsx's own
  allocatePatientUnderLock() uses - never max(current patients) + 1
  computed in isolation, so a number that was only ever briefly
  assigned and then deleted can never be handed out again.
  `keepPatientId`'s own record is never modified in any way, and no
  patient is created, deleted, or has their id changed - only
  `patientNumber` on the losing patient(s) is ever rewritten.

  "Other patients currently using that number" is recomputed fresh
  from the registry here, deliberately NOT taken from the conflict
  record's own patientIds list - if malformed data ever put three
  different UUIDs on the same number, this still finds and reassigns
  all of them, not just the two the stored conflict happened to name.

  Resolving one conflict never touches any other conflict's patients
  or numbers: only patients that currently hold THIS patientNumber are
  ever considered.
*/

export type PatientNumberConflictResolutionResult =
  | {
      resolved: true
      patients: Patient[]
      conflicts: PatientNumberConflict[]
    }
  | {
      resolved: false
      reason: string
      patients: Patient[]
      conflicts: PatientNumberConflict[]
    }

export function resolvePatientNumberConflictUnderLock(
  patientNumber: number,
  keepPatientId: string
): PatientNumberConflictResolutionResult {

  const currentPatients = readPersistedPatients()

  const keepPatient =
    currentPatients.find(patient => patient.id === keepPatientId)

  if (!keepPatient || keepPatient.patientNumber !== patientNumber) {

    return {
      resolved: false,
      reason:
        'That patient no longer has this conflicted number - it may have already been resolved.',
      patients: currentPatients,
      conflicts: reconcileAndPersistPatientNumberConflicts(currentPatients),
    }

  }

  const patientsToRenumber =
    currentPatients.filter(
      patient =>
        patient.patientNumber === patientNumber &&
        patient.id !== keepPatientId
    )

  if (patientsToRenumber.length === 0) {

    return {
      resolved: false,
      reason: 'This patient-number conflict was already resolved.',
      patients: currentPatients,
      conflicts: reconcileAndPersistPatientNumberConflicts(currentPatients),
    }

  }

  /*
    PHASE 4.6 - DYNAMIC NUMBERING: the renumbering pool now starts
    purely from one past the highest patientNumber any current patient
    already has (computeNextPatientNumber(), above) -
    readPersistedNextPatientNumber() is no longer consulted as a
    floor. Now that a patient's number can be edited directly (App.tsx's
    editPatientRecordUnderLock()), that stored counter can drift
    arbitrarily far behind reality, and trusting it here could hand a
    losing patient a number that collides with one a dentist manually
    assigned. See App.tsx's own allocatePatientUnderLock() comment for
    the identical reasoning.
  */

  let nextAvailableNumber = computeNextPatientNumber(currentPatients)

  const renumberedIds = new Set(
    patientsToRenumber.map(patient => patient.id)
  )

  const newNumberById = new Map<string, number>()

  for (const patient of patientsToRenumber) {
    newNumberById.set(patient.id, nextAvailableNumber)
    nextAvailableNumber += 1
  }

  /*
    updatedAt is refreshed only on the renumbered (losing) patient(s) -
    this is a genuine content change to their record (Phase 8) - never
    on the kept patient, whose data is completely unchanged, matching
    the same "only the actually-edited record gets a fresh timestamp"
    principle Phase 2 already established for templates. Without this,
    cloudMerge.ts's same-id patient merge (pickWinningByUpdatedAt)
    would have no way to prefer this correction over a stale copy of
    the same patient UUID still sitting in the cloud from before the
    resolution.
  */
  const updatedPatients =
    currentPatients.map(patient =>
      renumberedIds.has(patient.id)
        ? {
            ...patient,
            patientNumber: newNumberById.get(patient.id)!,
            updatedAt: new Date().toISOString(),
          }
        : patient
    )

  localStorage.setItem(
    PATIENTS_KEY,
    JSON.stringify(updatedPatients)
  )

  localStorage.setItem(
    NEXT_PATIENT_NUMBER_KEY,
    JSON.stringify(nextAvailableNumber)
  )

  const remainingPersistedConflicts =
    readPersistedPatientNumberConflicts().filter(
      conflict => conflict.patientNumber !== patientNumber
    )

  const reconciledConflicts =
    reconcilePatientNumberConflicts(
      remainingPersistedConflicts,
      updatedPatients
    )

  localStorage.setItem(
    PATIENT_NUMBER_CONFLICTS_KEY,
    JSON.stringify(reconciledConflicts)
  )

  return {
    resolved: true,
    patients: updatedPatients,
    conflicts: reconciledConflicts,
  }

}

export async function resolvePatientNumberConflict(
  patientNumber: number,
  keepPatientId: string
): Promise<PatientNumberConflictResolutionResult> {

  if (
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    navigator.locks
  ) {

    return navigator.locks.request(
      PATIENT_ALLOCATION_LOCK_NAME,
      () =>
        resolvePatientNumberConflictUnderLock(patientNumber, keepPatientId)
    )

  }

  /*
    No Web Locks API available - proceed unprotected, same fallback
    App.tsx's own allocatePatient()/deletePatientFromRegistry() use.
  */

  return resolvePatientNumberConflictUnderLock(patientNumber, keepPatientId)

}
