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

  Only the LATEST of each kind is kept, with no time expiry:
    - kind 'resolution' (both sides, saved before a conflict is
      applied): 1 on this device, 1 on OneDrive (its 2 files)
    - kind 'before-restore' (this device's data, saved before a
      Restore replaces it): 1, on this device only
  The kinds never push each other out. A new copy is written FIRST and
  only after it is stored is the older one of the same kind deleted, so
  a failed save always leaves the previous copy in place. Pruning is
  best-effort and can never fail an apply.

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

/* How many of EACH kind are kept (see the header comment). */
export const LOCAL_SAFETY_COPY_RETENTION = 1

export const CLOUD_SAFETY_COPY_RETENTION = 1

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
  Which file names to delete so only the newest `keep` COMPLETE
  resolutions (both the device and cloud file present) remain. Works
  from the listing alone and is deliberately cautious:
    - a half-uploaded pair is never counted as "the newest" - so it can
      never cause the last good copy to be deleted;
    - nothing is deleted at all unless there is at least `keep` complete
      pair to hold on to;
    - files NEWER than the oldest kept pair are never touched (they may
      be another device's save in progress).
  Names that aren't safety-copy files (the sync file, A/B/C backups,
  anything else) are never returned.
*/
export function selectFilesToPrune(
  fileNames: string[],
  keep: number = CLOUD_SAFETY_COPY_RETENTION
): string[] {

  const parsed = fileNames
    .map(parseSafetyCopyFileName)
    .filter((file): file is NonNullable<typeof file> => file !== null)

  const sidesById = new Map<string, Set<SafetyCopySide>>()

  for (const file of parsed) {

    const sides = sidesById.get(file.resolutionId) ?? new Set<SafetyCopySide>()

    sides.add(file.side)

    sidesById.set(file.resolutionId, sides)

  }

  const completeIds = [...sidesById.entries()]
    .filter(([, sides]) => sides.has('device') && sides.has('cloud'))
    .map(([id]) => id)
    .sort()
    .reverse()

  if (completeIds.length < keep || keep < 1) {
    return []
  }

  const keepIds = new Set(completeIds.slice(0, keep))

  const oldestKept = completeIds[keep - 1]

  return parsed
    .filter(
      file => !keepIds.has(file.resolutionId) && file.resolutionId < oldestKept
    )
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

function localEntryKind(entry: LocalSafetyCopyEntry): 'resolution' | 'before-restore' {
  return entry.reason === 'before-restore' ? 'before-restore' : 'resolution'
}

/*
  Throws on failure (eg. a localStorage quota error) - the caller
  decides what that means (a warning, per this module's own header).
  Keeps only the newest LOCAL_SAFETY_COPY_RETENTION entry OF EACH KIND:
  the new entry replaces the previous one of its own kind and leaves the
  other kind alone. The whole list is written in ONE setItem, which is
  all-or-nothing, so if the write is rejected the previous copy is left
  exactly as it was - the old one is only ever replaced by a new one
  that was actually stored.
*/
export function saveLocalSafetyCopy(entry: LocalSafetyCopyEntry): void {

  const kind = localEntryKind(entry)

  const existing = readLocalSafetyCopies().filter(
    other => other.resolutionId !== entry.resolutionId
  )

  const keptOfOtherKinds = existing.filter(other => localEntryKind(other) !== kind)

  const keptOfThisKind = existing
    .filter(other => localEntryKind(other) === kind)
    .slice(0, Math.max(0, LOCAL_SAFETY_COPY_RETENTION - 1))

  const next = [entry, ...keptOfThisKind, ...keptOfOtherKinds].sort((a, b) =>
    a.resolutionId < b.resolutionId ? 1 : -1
  )

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
  and deletes the safety-copy files older than the newest
  CLOUD_SAFETY_COPY_RETENTION complete resolution (see selectFilesToPrune).
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
