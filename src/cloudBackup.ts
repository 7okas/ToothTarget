import type {
  Patient,
  SavedTreatment,
  ProcedureTemplate,
  Procedure,
} from './App'

/*
  CLOUD BACKUP (snapshot, not sync)

  This is a snapshot/restore layer on top of the existing OneDrive App
  Folder file access in cloudStorage.ts - it never talks to Microsoft
  Graph itself (see cloudStorage.ts for that), and never automatically
  uploads/downloads anything on its own.

  Phase 8 removed this module's original callers (the manual "Backup
  to Cloud"/"Load from Cloud" buttons in MicrosoftAccountSection.tsx,
  replaced by a single "Sync Now" button that triggers the existing
  automatic two-way sync instead) - but rather than staying orphaned,
  Phase 9 gave it two new callers: createCloudBackup() is what
  cloudBackupRotation.ts's maybeRotateBackup() uploads into the
  rotating A/B/C dated snapshot slots, and applyCloudRestore() is what
  CloudCorruptionRecoveryDialog.tsx calls once the dentist explicitly
  confirms restoring a backup after the live sync file turns out to
  be unreadable. Same snapshot content/shape and same restore
  behavior as before - only who calls them changed.

  Only type-only imports are taken from App.tsx (Patient/
  SavedTreatment/ProcedureTemplate/Procedure) - these are erased
  entirely at compile time (tsconfig has verbatimModuleSyntax), so
  even though App.tsx renders MicrosoftAccountSection, which imports
  this file, there is no actual runtime circular dependency. Nothing
  here reads a runtime value from App.tsx - every read below goes
  straight to localStorage, exactly like App.tsx's own load effect
  already does for the same keys.
*/

export const CLOUD_BACKUP_SCHEMA_VERSION = 1 as const

export type CloudBackup = {
  schemaVersion: typeof CLOUD_BACKUP_SCHEMA_VERSION
  app: 'ToothTarget'
  exportedAt: string
  patients: Patient[]
  savedTreatments: SavedTreatment[]
  customTemplates: ProcedureTemplate[]
  customProcedures: Procedure[]
}

const PATIENTS_KEY = 'toothTargetPatients'
const SAVED_TREATMENTS_KEY = 'toothTargetSavedTreatments'
const TEMPLATES_KEY = 'toothTargetTemplates'
const PROCEDURES_KEY = 'toothTargetProcedures'

/*
  Deliberately NOT the same array reference App.tsx's own
  BACKUP_STORAGE_KEYS uses (that one isn't exported, and importing it
  as a runtime value here would create a genuine circular module
  dependency, unlike the type-only imports above). This is only used
  for the one-off local safety file downloadSafetyBackup() writes
  immediately before a cloud restore - it deliberately mirrors the
  same key list and { app, backupVersion, exportedAt, data } shape
  App.tsx's own Export Backup feature already uses, so this safety
  file can also be restored later via the existing Import Backup
  screen if a cloud restore ever needs to be undone.
*/
const LOCAL_SAFETY_BACKUP_KEYS = [
  'toothTargetPatients',
  'toothTargetNextPatientNumber',
  'toothTargetSavedTreatments',
  'toothTargetIncompleteTreatments',
  'toothTargetActiveTreatment',
  'toothTargetTemplates',
  'toothTargetProcedures',
] as const

function readLocalArray(key: string): unknown[] {

  try {

    const raw = localStorage.getItem(key)

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed : []

  } catch {

    return []

  }

}

/*
  CREATE

  Builds today's cloud backup snapshot directly from localStorage -
  the same source of truth App.tsx itself loads from - filtering
  templates/procedures down to the custom ones only. Built-in
  templates/procedures are never included: they already ship in the
  app's own code on every device, so uploading them would be both
  redundant and a future staleness risk if a later ToothTarget
  version ever changes a built-in's defaults.
*/

export function createCloudBackup(): CloudBackup {

  const patients = readLocalArray(PATIENTS_KEY) as Patient[]

  const savedTreatments =
    readLocalArray(SAVED_TREATMENTS_KEY) as SavedTreatment[]

  const templates = readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]

  const procedures = readLocalArray(PROCEDURES_KEY) as Procedure[]

  return {
    schemaVersion: CLOUD_BACKUP_SCHEMA_VERSION,
    app: 'ToothTarget',
    exportedAt: new Date().toISOString(),
    patients,
    savedTreatments,
    customTemplates: templates.filter(
      template => template.isCustom === true
    ),
    customProcedures: procedures.filter(
      procedure => procedure.isCustom === true
    ),
  }

}

/*
  VALIDATE

  Checked before anything from the cloud is ever trusted or shown to
  the dentist as restorable - wrong schema version, a missing/
  malformed field on any record, or the file just not being a
  ToothTarget backup at all are all reported as a specific, plain-
  language reason rather than a generic failure or (worse) silently
  accepting malformed data.
*/

function isValidCloudPatient(value: unknown): value is Patient {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Patient).id === 'string' &&
    (value as Patient).id.trim() !== '' &&
    typeof (value as Patient).patientNumber === 'number' &&
    Number.isInteger((value as Patient).patientNumber) &&
    (value as Patient).patientNumber > 0 &&
    typeof (value as Patient).name === 'string' &&
    (value as Patient).name.trim() !== ''
  )

}

function isValidCloudSavedTreatment(value: unknown): value is SavedTreatment {

  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>

  /*
    Accepts either a legacy Date.now()-based numeric id or the
    current crypto.randomUUID() string id - a cloud backup made
    before ToothTarget's treatment-ID migration may still contain
    numeric ids, and this validator must not reject that backup
    outright. Restoring it writes the treatments straight to
    localStorage as-is (applyCloudRestore()); App.tsx's own existing
    treatment-ID migration then normalizes any numeric id to a fresh
    UUID on the very next load, exactly like it already does for any
    other legacy local data - no separate/duplicate migration logic
    needed here. A non-empty string id is accepted as-is with no
    further format/UUID-shape validation, since the project has no
    existing UUID validator to reuse.
  */

  return (
    (typeof candidate.id === 'number' ||
      (typeof candidate.id === 'string' && candidate.id.trim() !== '')) &&
    typeof candidate.patientId === 'string' &&
    typeof candidate.patientName === 'string' &&
    typeof candidate.toothId === 'string' &&
    Array.isArray(candidate.phases)
  )

}

function isValidCloudTemplate(value: unknown): value is ProcedureTemplate {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ProcedureTemplate).id === 'string' &&
    typeof (value as ProcedureTemplate).name === 'string' &&
    Array.isArray((value as ProcedureTemplate).phases)
  )

}

function isValidCloudProcedure(value: unknown): value is Procedure {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Procedure).id === 'string' &&
    typeof (value as Procedure).name === 'string' &&
    typeof (value as Procedure).templateId === 'string'
  )

}

export type CloudBackupValidationResult =
  | { valid: true; backup: CloudBackup }
  | { valid: false; error: string }

export function validateCloudBackup(
  data: unknown
): CloudBackupValidationResult {

  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      error: 'The cloud file is not a valid ToothTarget backup.',
    }
  }

  const candidate = data as Partial<CloudBackup>

  if (candidate.app !== 'ToothTarget') {
    return {
      valid: false,
      error: 'The cloud file does not look like a ToothTarget backup.',
    }
  }

  if (candidate.schemaVersion !== CLOUD_BACKUP_SCHEMA_VERSION) {
    return {
      valid: false,
      error: `This cloud backup uses schema version ${String(
        candidate.schemaVersion
      )}, which this version of ToothTarget does not support (expected ${CLOUD_BACKUP_SCHEMA_VERSION}).`,
    }
  }

  if (typeof candidate.exportedAt !== 'string') {
    return {
      valid: false,
      error: 'The cloud backup is missing its export date.',
    }
  }

  if (
    !Array.isArray(candidate.patients) ||
    !candidate.patients.every(isValidCloudPatient)
  ) {
    return {
      valid: false,
      error: 'The cloud backup contains invalid patient records.',
    }
  }

  if (
    !Array.isArray(candidate.savedTreatments) ||
    !candidate.savedTreatments.every(isValidCloudSavedTreatment)
  ) {
    return {
      valid: false,
      error: 'The cloud backup contains invalid treatment records.',
    }
  }

  if (
    !Array.isArray(candidate.customTemplates) ||
    !candidate.customTemplates.every(isValidCloudTemplate)
  ) {
    return {
      valid: false,
      error: 'The cloud backup contains invalid template records.',
    }
  }

  if (
    !Array.isArray(candidate.customProcedures) ||
    !candidate.customProcedures.every(isValidCloudProcedure)
  ) {
    return {
      valid: false,
      error: 'The cloud backup contains invalid procedure records.',
    }
  }

  return {
    valid: true,
    backup: {
      schemaVersion: CLOUD_BACKUP_SCHEMA_VERSION,
      app: 'ToothTarget',
      exportedAt: candidate.exportedAt,
      patients: candidate.patients,
      savedTreatments: candidate.savedTreatments,
      customTemplates: candidate.customTemplates,
      customProcedures: candidate.customProcedures,
    },
  }

}

/*
  Downloads a full local backup file (same shape as App.tsx's own
  Export Backup) before a cloud restore ever touches localStorage -
  an unskippable safety net, not an optional step, so a bad or
  unwanted restore can always be undone via the existing Import
  Backup screen.
*/
function downloadSafetyBackup(): void {

  const data: Record<string, unknown> = {}

  for (const key of LOCAL_SAFETY_BACKUP_KEYS) {

    const raw = localStorage.getItem(key)

    if (raw === null) {
      continue
    }

    try {
      data[key] = JSON.parse(raw)
    } catch {
      // Skip a key that isn't valid JSON rather than failing the whole safety backup.
    }

  }

  const safetyBackup = {
    app: 'ToothTarget',
    backupVersion: 1,
    exportedAt: new Date().toISOString(),
    reason: 'Automatic safety backup taken before a Load from Cloud restore.',
    data,
  }

  const blob = new Blob(
    [JSON.stringify(safetyBackup, null, 2)],
    { type: 'application/json' }
  )

  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download =
    `toothtarget-pre-cloud-restore-backup-${new Date().toISOString().slice(0, 10)}.json`

  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)

  URL.revokeObjectURL(url)

}

/*
  RESTORE

  An explicit, user-confirmed SNAPSHOT RESTORE, not a merge and not
  automatic sync - the caller (Phase 9's
  CloudCorruptionRecoveryDialog.tsx) is responsible for validating the
  backup (validateCloudBackup() above) and getting the dentist's
  explicit confirmation first; this function only ever runs once
  that's already happened.

  Only ever touches toothTargetPatients/toothTargetSavedTreatments/
  toothTargetTemplates/toothTargetProcedures:
  - Patients and saved treatments are replaced wholesale from the
    backup - patient.id and patient.patientNumber are written back
    completely unchanged from what the backup contains, never
    regenerated or altered. (toothTargetNextPatientNumber is
    deliberately left untouched - App.tsx's own existing patient-
    identity migration already recomputes it safely as
    max(current counter, highest patientNumber + 1) on the very next
    load, so it can never collide with a restored patient's number.)
  - Templates/procedures REPLACE only the custom (isCustom: true)
    entries - this device's built-in templates/procedures (isCustom:
    false), already present in localStorage, are preserved exactly
    as they are; the backup never contains built-ins to restore in
    the first place.
  - toothTargetActiveTreatment and toothTargetIncompleteTreatments are
    never written here at all - they stay exactly as this device
    already has them.

  Reloads the page afterward (same pattern App.tsx's own Import
  Backup already uses) so every screen re-hydrates from the new
  localStorage through the app's normal, already-trusted load/
  migration pipeline, rather than this file trying to reach into
  App.tsx's React state directly.
*/

export function applyCloudRestore(backup: CloudBackup): void {

  downloadSafetyBackup()

  localStorage.setItem(
    PATIENTS_KEY,
    JSON.stringify(backup.patients)
  )

  localStorage.setItem(
    SAVED_TREATMENTS_KEY,
    JSON.stringify(backup.savedTreatments)
  )

  const currentTemplates =
    readLocalArray(TEMPLATES_KEY) as ProcedureTemplate[]

  const builtInTemplates =
    currentTemplates.filter(template => template.isCustom === false)

  localStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify([...builtInTemplates, ...backup.customTemplates])
  )

  const currentProcedures =
    readLocalArray(PROCEDURES_KEY) as Procedure[]

  const builtInProcedures =
    currentProcedures.filter(procedure => procedure.isCustom === false)

  localStorage.setItem(
    PROCEDURES_KEY,
    JSON.stringify([...builtInProcedures, ...backup.customProcedures])
  )

  window.location.reload()

}
