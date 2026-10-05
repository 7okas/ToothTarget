import {
  validateCloudSyncDocument,
  type CloudSyncDocument,
} from './cloudSync'
import {
  listAppFolderFileNames,
  readCloudData,
  writeCloudData,
  deleteCloudFile,
} from './cloudStorage'

/*
  RESOLUTION SAFETY COPIES (Phase 6, step 3)

  Before a resolution is applied, BOTH sides - this device's snapshot
  and the cloud's snapshot - are saved so a wrong choice can be undone.
  This module owns where those copies live, how long they are kept, and
  how they are read back. It never applies a resolution and never
  touches the live synced data or any sync-tracking key.

  ============================================================
  WHERE THEY LIVE
  ============================================================

  OneDrive (the real safety net - it survives this device):
    two files per resolution in the App Folder, next to the sync file:
      toothtarget-resolution-<id>-device.json   this device's data
      toothtarget-resolution-<id>-cloud.json    OneDrive's data, as it
                                                 was before being replaced
    <id> is the capture time, e.g. 2026-10-06T01-20-45-123Z, so files
    sort by time and the folder is readable at a glance.
    The prefix is deliberately NOT toothtarget-backup-: the A/B/C
    rotation and corruption-recovery listing only recognise the
    toothtarget-backup-<A|B|C>-<date>.json pattern, so they never see,
    count, rotate or delete these files (and these code paths never
    touch the A/B/C files either).

  This device (localStorage, key toothTargetResolutionSafetyCopies):
    one entry per resolution holding both sides together.

  ============================================================
  HOW LONG THEY ARE KEPT
  ============================================================

  Count-based, no time expiry:
    - this device: the last 2 resolutions
    - OneDrive:    the last 5 resolutions (10 files)
  When a newer resolution is saved, anything beyond those counts is
  deleted. Pruning is best-effort and can never fail an apply.

  ============================================================
  WHEN A FAILURE BLOCKS THE APPLY
  ============================================================

    OneDrive copy of EITHER side fails  -> blocked (nothing is applied;
                                           any file that did upload is
                                           cleaned up, best-effort)
    Both OneDrive copies OK, local copy fails (eg. localStorage quota)
                                        -> allowed, with a warning
  OneDrive is the copy that can actually save the dentist (it survives
  this device); the local copy is a convenience on top of it.
*/

export const LOCAL_SAFETY_COPY_KEY = 'toothTargetResolutionSafetyCopies'

export const LOCAL_SAFETY_COPY_RETENTION = 2

export const CLOUD_SAFETY_COPY_RETENTION = 5

export const SAFETY_COPY_FILE_PREFIX = 'toothtarget-resolution-'

export type SafetyCopySide = 'device' | 'cloud'

/* The file's own content. Wraps a normal sync document so it can be
   validated with the same validator the sync file uses. */
export type ResolutionSafetyCopy = {
  kind: 'resolution-safety-copy'
  version: 1
  resolutionId: string
  capturedAt: string
  side: SafetyCopySide
  /* The OneDrive ETag the cloud snapshot was read at (informational). */
  cloudETag: string | null
  document: CloudSyncDocument
}

/* One local entry holds both sides of one resolution. */
export type LocalSafetyCopyEntry = {
  resolutionId: string
  capturedAt: string
  /*
    Absent on a normal resolution entry. 'before-restore' marks the
    copy of this device's own data saved right before a Restore replaced
    it (syncResolutionRestore.ts); there `device` and `cloud` hold the
    same snapshot, since only this device's data is being protected.
  */
  reason?: 'before-restore'
  cloudETag: string | null
  device: CloudSyncDocument
  cloud: CloudSyncDocument
}

/* ---------- naming ---------- */

export function resolutionIdFor(capturedAtIso: string): string {
  return capturedAtIso.replace(/[:.]/g, '-')
}

export function safetyCopyFileName(
  resolutionId: string,
  side: SafetyCopySide
): string {
  return `${SAFETY_COPY_FILE_PREFIX}${resolutionId}-${side}.json`
}

const SAFETY_COPY_FILE_PATTERN =
  /^toothtarget-resolution-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(device|cloud)\.json$/

export function parseSafetyCopyFileName(
  fileName: string
): { resolutionId: string; side: SafetyCopySide; fileName: string } | null {

  const match = SAFETY_COPY_FILE_PATTERN.exec(fileName)

  if (!match) {
    return null
  }

  return {
    resolutionId: match[1],
    side: match[2] as SafetyCopySide,
    fileName,
  }

}

/* Inverse of resolutionIdFor() for display: back to an ISO timestamp. */
export function capturedAtFromResolutionId(resolutionId: string): string {

  const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/.exec(resolutionId)

  return match
    ? `${match[1]}:${match[2]}:${match[3]}.${match[4]}`
    : resolutionId

}

export function buildSafetyCopy(
  side: SafetyCopySide,
  resolutionId: string,
  capturedAt: string,
  cloudETag: string | null,
  document: CloudSyncDocument
): ResolutionSafetyCopy {

  return {
    kind: 'resolution-safety-copy',
    version: 1,
    resolutionId,
    capturedAt,
    side,
    cloudETag,
    document,
  }

}

export type SafetyCopyValidationResult =
  | { valid: true; copy: ResolutionSafetyCopy }
  | { valid: false; error: string }

export function validateSafetyCopy(value: unknown): SafetyCopyValidationResult {

  if (!value || typeof value !== 'object') {
    return { valid: false, error: 'This is not a ToothTarget safety copy.' }
  }

  const candidate = value as Partial<ResolutionSafetyCopy>

  if (
    candidate.kind !== 'resolution-safety-copy' ||
    candidate.version !== 1 ||
    typeof candidate.resolutionId !== 'string' ||
    typeof candidate.capturedAt !== 'string' ||
    (candidate.side !== 'device' && candidate.side !== 'cloud')
  ) {
    return { valid: false, error: 'This is not a ToothTarget safety copy.' }
  }

  const validation = validateCloudSyncDocument(candidate.document)

  if (!validation.valid) {
    return { valid: false, error: validation.error }
  }

  return {
    valid: true,
    copy: {
      kind: 'resolution-safety-copy',
      version: 1,
      resolutionId: candidate.resolutionId,
      capturedAt: candidate.capturedAt,
      side: candidate.side,
      cloudETag: typeof candidate.cloudETag === 'string' ? candidate.cloudETag : null,
      document: validation.document,
    },
  }

}

/* ---------- retention (pure) ---------- */

/*
  Which file names to delete so only the newest `keep` resolutions
  remain. Works from the listing alone: groups this module's own files
  by resolution id (ids sort by time) and returns every file of every
  older resolution. Names that aren't safety-copy files (the sync file,
  A/B/C backups, anything else) are never returned.
*/
export function selectFilesToPrune(
  fileNames: string[],
  keep: number = CLOUD_SAFETY_COPY_RETENTION
): string[] {

  const parsed = fileNames
    .map(parseSafetyCopyFileName)
    .filter((file): file is NonNullable<typeof file> => file !== null)

  const ids = [...new Set(parsed.map(file => file.resolutionId))].sort().reverse()

  const keepIds = new Set(ids.slice(0, keep))

  return parsed
    .filter(file => !keepIds.has(file.resolutionId))
    .map(file => file.fileName)

}

/* ---------- local copies ---------- */

function isValidLocalEntry(value: unknown): value is LocalSafetyCopyEntry {

  if (!value || typeof value !== 'object') {
    return false
  }

  const entry = value as Partial<LocalSafetyCopyEntry>

  return (
    typeof entry.resolutionId === 'string' &&
    typeof entry.capturedAt === 'string' &&
    validateCloudSyncDocument(entry.device).valid &&
    validateCloudSyncDocument(entry.cloud).valid
  )

}

/* Newest first. Never throws; anything unreadable is skipped. */
export function readLocalSafetyCopies(): LocalSafetyCopyEntry[] {

  try {

    const raw = localStorage.getItem(LOCAL_SAFETY_COPY_KEY)

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .filter(isValidLocalEntry)
      .sort((a, b) => (a.resolutionId < b.resolutionId ? 1 : -1))

  } catch {

    return []

  }

}

/*
  Throws on failure (eg. a localStorage quota error) - the caller
  decides what that means (a warning, per this module's own header).
  Keeps only the newest LOCAL_SAFETY_COPY_RETENTION entries. If the
  write is rejected, whatever was stored before is left exactly as it
  was (setItem is all-or-nothing for a single key).
*/
export function saveLocalSafetyCopy(entry: LocalSafetyCopyEntry): void {

  const existing = readLocalSafetyCopies().filter(
    other => other.resolutionId !== entry.resolutionId
  )

  const next = [entry, ...existing]
    .sort((a, b) => (a.resolutionId < b.resolutionId ? 1 : -1))
    .slice(0, LOCAL_SAFETY_COPY_RETENTION)

  localStorage.setItem(LOCAL_SAFETY_COPY_KEY, JSON.stringify(next))

}

/* ---------- saving both sides (the pre-apply step) ---------- */

export type SaveSafetyCopiesInput = {
  device: CloudSyncDocument
  cloud: CloudSyncDocument
  cloudETag: string | null
  nowIso: string
}

export type SaveSafetyCopiesResult =
  | {
      ok: true
      resolutionId: string
      /* true if the local copy was stored too */
      localSaved: boolean
      /* Present only when the local copy failed - shown as a warning. */
      warning?: string
    }
  | {
      ok: false
      reason: 'onedrive-copy-failed'
      detail: string
    }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function saveResolutionSafetyCopies(
  input: SaveSafetyCopiesInput
): Promise<SaveSafetyCopiesResult> {

  const resolutionId = resolutionIdFor(input.nowIso)

  const deviceFile = safetyCopyFileName(resolutionId, 'device')
  const cloudFile = safetyCopyFileName(resolutionId, 'cloud')

  const uploaded: string[] = []

  /*
    OneDrive first, both sides, in order. ANY failure blocks the apply:
    a copy that only exists on this device would not survive losing it,
    and the cloud side's copy is the only record of what is about to be
    overwritten there.
  */
  try {

    await writeCloudData(
      deviceFile,
      buildSafetyCopy('device', resolutionId, input.nowIso, input.cloudETag, input.device)
    )

    uploaded.push(deviceFile)

    await writeCloudData(
      cloudFile,
      buildSafetyCopy('cloud', resolutionId, input.nowIso, input.cloudETag, input.cloud)
    )

    uploaded.push(cloudFile)

  } catch (error) {

    /*
      Best-effort cleanup of a half-uploaded pair, so an aborted
      attempt doesn't crowd a real resolution out of the retention
      window. A failed cleanup is simply left for the next prune.
    */
    for (const fileName of uploaded) {

      try {
        await deleteCloudFile(fileName)
      } catch {
        // left for a later prune
      }

    }

    return {
      ok: false,
      reason: 'onedrive-copy-failed',
      detail: describeError(error),
    }

  }

  let localSaved = false
  let warning: string | undefined

  try {

    saveLocalSafetyCopy({
      resolutionId,
      capturedAt: input.nowIso,
      cloudETag: input.cloudETag,
      device: input.device,
      cloud: input.cloud,
    })

    localSaved = true

  } catch (error) {

    warning =
      'Safety copies of both sides were saved to OneDrive, but a copy ' +
      `could not be saved on this device (${describeError(error)}). ` +
      'The OneDrive copies are enough to undo this.'

  }

  await pruneCloudSafetyCopies()

  return warning === undefined
    ? { ok: true, resolutionId, localSaved }
    : { ok: true, resolutionId, localSaved, warning }

}

/*
  Best-effort: never throws, never fails an apply. Lists the App Folder
  and deletes every safety-copy file beyond the newest
  CLOUD_SAFETY_COPY_RETENTION resolutions.
*/
export async function pruneCloudSafetyCopies(): Promise<void> {

  try {

    const names = await listAppFolderFileNames()

    for (const fileName of selectFilesToPrune(names)) {

      try {
        await deleteCloudFile(fileName)
      } catch {
        // retried by the next prune
      }

    }

  } catch {
    // listing failed - nothing to prune this time
  }

}

/* ---------- reading copies back (for the Restore list) ---------- */

export type CloudSafetyCopyListing = {
  resolutionId: string
  capturedAt: string
  deviceFile: string | null
  cloudFile: string | null
}

/* Newest first. Throws if the folder can't be listed. */
export async function listCloudSafetyCopies(): Promise<CloudSafetyCopyListing[]> {

  const names = await listAppFolderFileNames()

  const byId = new Map<string, CloudSafetyCopyListing>()

  for (const name of names) {

    const parsed = parseSafetyCopyFileName(name)

    if (!parsed) {
      continue
    }

    const listing = byId.get(parsed.resolutionId) ?? {
      resolutionId: parsed.resolutionId,
      capturedAt: capturedAtFromResolutionId(parsed.resolutionId),
      deviceFile: null,
      cloudFile: null,
    }

    if (parsed.side === 'device') {
      listing.deviceFile = name
    } else {
      listing.cloudFile = name
    }

    byId.set(parsed.resolutionId, listing)

  }

  return [...byId.values()].sort((a, b) =>
    a.resolutionId < b.resolutionId ? 1 : -1
  )

}

export type ReadSafetyCopyResult =
  | { status: 'ok'; copy: ResolutionSafetyCopy }
  | { status: 'missing' }
  | { status: 'invalid'; error: string }

/* Throws only on transport failure; a bad or absent file is a result. */
export async function readCloudSafetyCopy(
  fileName: string
): Promise<ReadSafetyCopyResult> {

  const data = await readCloudData<unknown>(fileName)

  if (data === null) {
    return { status: 'missing' }
  }

  const validation = validateSafetyCopy(data)

  return validation.valid
    ? { status: 'ok', copy: validation.copy }
    : { status: 'invalid', error: validation.error }

}
