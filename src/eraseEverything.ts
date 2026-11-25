import type { CloudSyncDocument } from './cloudSync'
import { CLOUD_SYNC_APP, CLOUD_SYNC_SCHEMA_VERSION } from './cloudSync'
import type { CloudSyncResult } from './cloudSyncEngine'
import type {
  CloudSyncReadResult,
  CloudSyncWriteResult,
} from './cloudStorage'

/*
  ERASE EVERYTHING (temporary, one-time clean-slate action)

  Wipes this device, the OneDrive sync document and the OneDrive
  backup files in a safe order. It exists only for the move to the
  new built-in template structure, and lives in its own commit so it
  can be reverted cleanly.

  NEVER RUNS BY ITSELF. Nothing in the app calls prepareErase() or
  executeErase() except the two buttons in EraseEverythingSection.tsx.

  TWO STEPS, so the dentist sees what will be deleted first:

  1. prepareErase() - checks every guard, syncs first, then lists the
     OneDrive files that would be deleted. Changes nothing.
  2. executeErase() - only after the dentist has seen that list and
     confirmed again:
       a. overwrites toothtarget-sync.json with an EMPTY document,
          conditional on the ETag read in step 1. The sync file is
          never deleted: a missing sync file makes other devices PUSH
          their local data back up, which would undo the wipe.
       b. deletes the listed toothtarget-* files (the A/B/C backups).
       c. clears this device's local data keys.
       d. records the empty cloud version as "already in sync" so this
          device does not report a conflict afterwards.
     If (a) fails, nothing local or in the cloud has been touched.

  Every outside dependency is passed in (EraseDeps), so the guards are
  tested directly with no Microsoft/MSAL code involved. The real
  wiring is eraseEverythingDeps.ts.
*/

export const ERASE_CONFIRMATION_TEXT = 'ERASE'

export const SYNC_FILE_NAME = 'toothtarget-sync.json'

/* Exactly the local keys the plan lists, plus every per-account cache. */
export const ERASE_LOCAL_KEYS = [
  'toothTargetPatients',
  'toothTargetNextPatientNumber',
  'toothTargetSavedTreatments',
  'toothTargetIncompleteTreatments',
  'toothTargetActiveTreatment',
  'toothTargetTemplates',
  'toothTargetProcedures',
  'toothTargetDeletionTombstones',
  'toothTargetPatientNumberConflicts',
  'toothTargetPendingResolution',
  'toothTargetResolutionSafetyCopies',
  'toothTargetPreAdoptSafetyCopy',
  'toothTargetCloudCorruptionDiagnostics',
] as const

export const ACCOUNT_CACHE_KEY_PREFIX = 'toothTargetAccountCache_'

export type EraseStorage = Pick<
  Storage,
  'getItem' | 'removeItem' | 'key' | 'length'
>

export type EraseDeps = {
  isSignedIn: () => boolean
  hasPendingResolution: () => boolean
  /* A normal pull-first sync; resolves to its result. */
  syncFirst: () => Promise<CloudSyncResult>
  readCloud: () => Promise<CloudSyncReadResult>
  writeCloud: (
    document: CloudSyncDocument,
    expectedETag: string | null
  ) => Promise<CloudSyncWriteResult>
  listFiles: () => Promise<string[]>
  deleteFile: (fileName: string) => Promise<void>
  /* Records "this device matches this cloud version". */
  recordInSync: (
    document: CloudSyncDocument,
    nowIso: string,
    counterToRecord: number,
    eTag: string | null
  ) => void
  readChangeCounter: () => number
  storage: EraseStorage
  now: () => string
}

export type EraseRefusalReason =
  | 'wrong-text'
  | 'signed-out'
  | 'resolution-pending'
  | 'active-treatment'
  | 'sync-failed'
  | 'conflict'
  | 'cloud-read-failed'
  | 'list-failed'
  | 'cloud-changed'
  | 'write-failed'

export type ErasePlan = {
  /* ETag of the sync document read after syncing; null = no cloud file yet. */
  eTag: string | null
  /* toothtarget-* files that will be deleted (never the sync file). */
  filesToDelete: string[]
}

export type PrepareEraseResult =
  | { status: 'ready'; plan: ErasePlan }
  | { status: 'refused'; reason: EraseRefusalReason; message: string }

export type ExecuteEraseResult =
  | {
      status: 'erased'
      deletedFiles: string[]
      failedFiles: { fileName: string; detail: string }[]
    }
  | { status: 'refused'; reason: EraseRefusalReason; message: string }

function refuse(
  reason: EraseRefusalReason,
  message: string
): { status: 'refused'; reason: EraseRefusalReason; message: string } {
  return { status: 'refused', reason, message }
}

export function isEraseConfirmed(typed: string): boolean {
  return typed === ERASE_CONFIRMATION_TEXT
}

export function buildEmptySyncDocument(nowIso: string): CloudSyncDocument {

  return {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    app: CLOUD_SYNC_APP,
    updatedAt: nowIso,
    patients: [],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
  }

}

/* Every toothtarget-* file except the sync file, sorted for display. */
export function selectFilesToDelete(fileNames: string[]): string[] {

  return fileNames
    .filter(
      name =>
        name.toLowerCase().startsWith('toothtarget') &&
        name !== SYNC_FILE_NAME
    )
    .sort()

}

function hasRunningTreatment(storage: EraseStorage): boolean {

  const raw = storage.getItem('toothTargetActiveTreatment')

  return raw !== null && raw !== '' && raw !== 'null'

}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/*
  Guards shared by both steps. Order matters: the cheapest, most
  explicit refusal comes first.
*/
function checkGuards(
  typed: string,
  deps: EraseDeps
): ReturnType<typeof refuse> | null {

  if (!isEraseConfirmed(typed)) {
    return refuse(
      'wrong-text',
      `Type ${ERASE_CONFIRMATION_TEXT} (capital letters) to confirm.`
    )
  }

  if (!deps.isSignedIn()) {
    return refuse(
      'signed-out',
      'Sign in to Microsoft first. Nothing was erased.'
    )
  }

  if (deps.hasPendingResolution()) {
    return refuse(
      'resolution-pending',
      'A sync conflict is waiting to be resolved. Resolve it first. Nothing was erased.'
    )
  }

  if (hasRunningTreatment(deps.storage)) {
    return refuse(
      'active-treatment',
      'A treatment is still running. Finish or discard it first. Nothing was erased.'
    )
  }

  return null

}

export async function prepareErase(
  typed: string,
  deps: EraseDeps
): Promise<PrepareEraseResult> {

  const refused = checkGuards(typed, deps)

  if (refused) {
    return refused
  }

  let syncResult: CloudSyncResult

  try {
    syncResult = await deps.syncFirst()
  } catch (error) {
    return refuse(
      'sync-failed',
      `Syncing first failed (${describe(error)}). Nothing was erased.`
    )
  }

  if (syncResult.status === 'diverged') {
    return refuse(
      'conflict',
      'This device and OneDrive disagree (a sync conflict). Resolve it first. Nothing was erased.'
    )
  }

  if (syncResult.status !== 'synced') {
    return refuse(
      'sync-failed',
      `Syncing first did not finish (${syncResult.status}). Nothing was erased.`
    )
  }

  let cloud: CloudSyncReadResult

  try {
    cloud = await deps.readCloud()
  } catch (error) {
    return refuse(
      'cloud-read-failed',
      `Could not read the OneDrive sync file (${describe(error)}). Nothing was erased.`
    )
  }

  if (cloud.status !== 'found' && cloud.status !== 'not-found') {
    return refuse(
      'cloud-read-failed',
      `Could not read the OneDrive sync file (${cloud.status}). Nothing was erased.`
    )
  }

  let fileNames: string[]

  try {
    fileNames = await deps.listFiles()
  } catch (error) {
    return refuse(
      'list-failed',
      `Could not list the OneDrive app folder (${describe(error)}). Nothing was erased.`
    )
  }

  return {
    status: 'ready',
    plan: {
      eTag: cloud.status === 'found' ? cloud.eTag : null,
      filesToDelete: selectFilesToDelete(fileNames),
    },
  }

}

export function clearLocalData(storage: EraseStorage): void {

  ERASE_LOCAL_KEYS.forEach(key => storage.removeItem(key))

  const accountCacheKeys: string[] = []

  for (let index = 0; index < storage.length; index += 1) {

    const key = storage.key(index)

    if (key !== null && key.startsWith(ACCOUNT_CACHE_KEY_PREFIX)) {
      accountCacheKeys.push(key)
    }

  }

  accountCacheKeys.forEach(key => storage.removeItem(key))

}

export async function executeErase(
  typed: string,
  plan: ErasePlan,
  deps: EraseDeps
): Promise<ExecuteEraseResult> {

  const refused = checkGuards(typed, deps)

  if (refused) {
    return refused
  }

  /*
    Captured before the first await, like the sync engine does: this
    is the change-counter value recorded as "already synced".
  */
  const counterAtStart = deps.readChangeCounter()

  const nowIso = deps.now()

  const emptyDocument = buildEmptySyncDocument(nowIso)

  let written: CloudSyncWriteResult

  try {
    written = await deps.writeCloud(emptyDocument, plan.eTag)
  } catch (error) {
    return refuse(
      'write-failed',
      `Could not write the empty sync file (${describe(error)}). Nothing was erased.`
    )
  }

  if (written.status === 'precondition-failed') {
    return refuse(
      'cloud-changed',
      'OneDrive changed while you were confirming. Nothing was erased. Start again.'
    )
  }

  if (written.status !== 'written') {
    return refuse(
      'write-failed',
      `Could not write the empty sync file (${written.status}). Nothing was erased.`
    )
  }

  /*
    From here the cloud is already empty. Backup deletions that fail
    are reported, never fatal: this device still has to be cleared, or
    it would keep showing data the cloud no longer has.
  */
  const deletedFiles: string[] = []
  const failedFiles: { fileName: string; detail: string }[] = []

  for (const fileName of plan.filesToDelete) {

    try {
      await deps.deleteFile(fileName)
      deletedFiles.push(fileName)
    } catch (error) {
      failedFiles.push({ fileName, detail: describe(error) })
    }

  }

  clearLocalData(deps.storage)

  deps.recordInSync(emptyDocument, nowIso, counterAtStart, written.eTag)

  return { status: 'erased', deletedFiles, failedFiles }

}
