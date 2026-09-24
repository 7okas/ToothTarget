import type { SyncOutcomeReason } from './syncOutcome'
import { validateCloudBackup, type CloudBackup } from './cloudBackup'
import { listAppFolderFileNames, readCloudData } from './cloudStorage'
import {
  parseBackupFileName,
  type BackupSlotFile,
} from './cloudBackupRotation'

/*
  CORRUPTED-LIVE-SYNC-FILE RECOVERY (Phase 9)

  Reacts to an outcome the sync engine already detects and classifies
  on its own (cloudSyncEngine.ts's 'cloud-invalid' CloudSyncResult ->
  syncOutcome.ts's classifySyncOutcome() -> SyncOutcomeType
  'cloud-data-corrupted') - this file adds NO new detection of its
  own and does not touch cloudSyncEngine.ts/cloudSync.ts/cloudMerge.ts
  at all. It only decides what to OFFER once that outcome appears,
  and (only on explicit confirmation) reuses cloudBackup.ts's existing
  applyCloudRestore() to actually load a chosen backup locally -
  nothing here writes to OneDrive, deletes anything, or touches the
  corrupt live sync file itself. The very next normal sync handles
  propagating the recovered local data back to the cloud, exactly the
  way any other local change would.
*/

export function isCorruptedSyncOutcome(
  outcome: SyncOutcomeReason | null
): boolean {
  return outcome?.type === 'cloud-data-corrupted'
}

export type NewestValidBackup = {
  file: BackupSlotFile
  backup: CloudBackup
}

/*
  Lists the App Folder, sorts every dated A/B/C backup file newest-
  first by the date already baked into its own filename (never a
  Graph lastModifiedDateTime - the filename IS the source of truth
  for "how old is this snapshot", same as cloudBackupRotation.ts), and
  returns the first one that actually reads back as valid JSON AND
  passes validateCloudBackup() - reusing that existing validator
  rather than re-implementing backup-shape checking here. A dated file
  that exists but is itself unreadable/invalid is skipped in favor of
  the next-newest one rather than failing the whole search - three
  independent snapshots existing is exactly what makes that safe.
  Returns null only when no dated backup file exists at all, or every
  single one that does exist fails to read/validate.
*/
export async function findNewestValidBackup(): Promise<NewestValidBackup | null> {

  const fileNames = await listAppFolderFileNames()

  const candidates = fileNames
    .map(parseBackupFileName)
    .filter((file): file is BackupSlotFile => file !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  for (const file of candidates) {

    try {

      const data = await readCloudData<unknown>(file.fileName)

      if (data === null) {
        continue
      }

      const validation = validateCloudBackup(data)

      if (validation.valid) {
        return { file, backup: validation.backup }
      }

    } catch {
      /*
        This candidate couldn't be read at all (network blip, or it's
        genuinely corrupt too) - fall through to the next-newest one
        rather than failing the whole search over a single bad file.
      */
    }

  }

  return null

}
