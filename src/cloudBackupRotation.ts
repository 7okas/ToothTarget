import { createCloudBackup, type CloudBackup } from './cloudBackup'
import {
  listAppFolderFileNames,
  writeCloudData,
  deleteCloudFile,
} from './cloudStorage'

/*
  ROTATING DATED BACKUPS (Phase 9)

  A separate, additive safety net alongside the real-time two-way
  sync document (cloudSyncEngine.ts/cloudSync.ts, untouched by this
  file) - three independent, human-readable snapshot files in the
  OneDrive App Folder, named so the dates are visible just by looking
  at the folder, without opening the app:

    toothtarget-backup-A-2026-09-24.json
    toothtarget-backup-B-2026-09-20.json
    toothtarget-backup-C-2026-09-18.json

  Rotation is decided entirely from what's ALREADY in the cloud
  folder (never a local per-device counter/flag) - maybeRotateBackup()
  lists the folder, figures out which slot was written most recently
  and how long ago, and only writes a fresh snapshot if the calendar
  day has changed since then. This is deliberately multi-device-safe
  the same way the rest of this app's cloud state is: any device that
  syncs successfully reasons from the same shared source of truth
  (the folder's own contents), not a value only it remembers, so two
  different devices independently reach the same rotation decision.
  A theoretical two-devices-write-at-the-exact-same-instant race would
  at worst overwrite one same-day snapshot with another same-day
  snapshot - never lose a slot, never corrupt anything - so no
  distributed lock was added for it.

  Reuses createCloudBackup() (cloudBackup.ts) for the actual snapshot
  content - the exact same patients/savedTreatments/customTemplates/
  customProcedures shape the old manual "Backup to Cloud" button used
  to upload - and the generalized readCloudData()/writeCloudData()/
  listAppFolderFileNames()/deleteCloudFile() (cloudStorage.ts) for all
  Graph I/O. No new backup CONTENT format, no new Graph transport -
  only the rotation/naming/scheduling decision below is new.
*/

export type BackupSlot = 'A' | 'B' | 'C'

const SLOT_ORDER: BackupSlot[] = ['A', 'B', 'C']

export function nextSlot(slot: BackupSlot): BackupSlot {
  return SLOT_ORDER[(SLOT_ORDER.indexOf(slot) + 1) % SLOT_ORDER.length]
}

export type BackupSlotFile = {
  slot: BackupSlot
  date: string
  fileName: string
}

const BACKUP_FILE_NAME_PATTERN = /^toothtarget-backup-([ABC])-(\d{4}-\d{2}-\d{2})\.json$/

export function backupFileName(slot: BackupSlot, dateStr: string): string {
  return `toothtarget-backup-${slot}-${dateStr}.json`
}

/*
  null for anything that isn't one of THIS app's dated backup files
  (a differently-named file the dentist or another app happens to
  have in the same App Folder) - never thrown, since a listing may
  contain any number of unrelated names.
*/
export function parseBackupFileName(fileName: string): BackupSlotFile | null {

  const match = BACKUP_FILE_NAME_PATTERN.exec(fileName)

  if (!match) {
    return null
  }

  return { slot: match[1] as BackupSlot, date: match[2], fileName }

}

export type BackupFilesBySlot = Record<BackupSlot, BackupSlotFile | null>

/*
  Last one wins for a given slot if a listing somehow contained two
  files for the same slot (shouldn't happen - rotation always deletes
  the old one - but this keeps grouping total or a partial/failed
  previous delete).
*/
export function groupBackupFilesBySlot(
  files: BackupSlotFile[]
): BackupFilesBySlot {

  const grouped: BackupFilesBySlot = { A: null, B: null, C: null }

  files.forEach(file => {
    grouped[file.slot] = file
  })

  return grouped

}

export function findMostRecentBackupFile(
  grouped: BackupFilesBySlot
): BackupSlotFile | null {

  const candidates = SLOT_ORDER
    .map(slot => grouped[slot])
    .filter((file): file is BackupSlotFile => file !== null)

  if (candidates.length === 0) {
    return null
  }

  return candidates.reduce(
    (latest, file) => (file.date > latest.date ? file : latest)
  )

}

export type BackupRotationDecision =
  | { shouldWrite: false }
  | { shouldWrite: true; slot: BackupSlot; oldFileToDelete: string | null }

/*
  The one decision this whole feature makes, kept pure and fully
  testable: given what's currently in the folder and today's date,
  should a new snapshot be written, into which slot, and does writing
  it retire an old dated file for that same slot.

  - No backups exist yet: start the rotation at A, nothing to delete.
  - The most recent backup is already dated today: already rotated
    today (by this device or another) - never write a second time the
    same calendar day, no matter how many syncs happen.
  - Otherwise: the calendar day has moved on since the last rotation -
    advance to the next slot in the fixed A -> B -> C -> A order
    (never based on which slot is oldest/least-recently-written), and
    if that slot already holds an old dated file from a previous
    cycle, mark it for deletion.
*/
export function decideBackupRotation(
  grouped: BackupFilesBySlot,
  todayDateStr: string
): BackupRotationDecision {

  const mostRecent = findMostRecentBackupFile(grouped)

  if (mostRecent === null) {
    return { shouldWrite: true, slot: 'A', oldFileToDelete: null }
  }

  if (mostRecent.date === todayDateStr) {
    return { shouldWrite: false }
  }

  const targetSlot = nextSlot(mostRecent.slot)
  const oldFile = grouped[targetSlot]

  return {
    shouldWrite: true,
    slot: targetSlot,
    oldFileToDelete: oldFile ? oldFile.fileName : null,
  }

}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

/*
  ORCHESTRATION

  Called after any sync that just succeeded (see
  cloudSyncScheduler.ts's own call site) - never awaited by, and never
  able to affect, the sync status/outcome that triggered it: this
  always resolves, logging and swallowing its own failures rather
  than throwing, the same defensive-backstop discipline
  cloudSyncScheduler.ts's own requestCloudSync() already follows for
  syncCloudNow() itself. A failure here (eg. a transient network blip
  while listing the folder) simply means today's snapshot doesn't get
  written this time - the very next successful sync tries again, and
  since the decision above is entirely re-derived from the folder's
  own current contents every time, nothing needs to be remembered or
  recovered from between attempts.
*/
export async function maybeRotateBackup(): Promise<void> {

  try {

    const fileNames = await listAppFolderFileNames()

    const existingBackupFiles = fileNames
      .map(parseBackupFileName)
      .filter((file): file is BackupSlotFile => file !== null)

    const grouped = groupBackupFilesBySlot(existingBackupFiles)

    const decision = decideBackupRotation(grouped, todayDateString())

    if (!decision.shouldWrite) {
      return
    }

    const snapshot: CloudBackup = createCloudBackup()

    const newFileName = backupFileName(decision.slot, todayDateString())

    await writeCloudData(newFileName, snapshot)

    if (decision.oldFileToDelete) {
      await deleteCloudFile(decision.oldFileToDelete)
    }

  } catch (error) {

    console.log(
      `Rotating dated backup skipped this attempt: ${
        error instanceof Error ? error.message : String(error)
      }`
    )

  }

}
