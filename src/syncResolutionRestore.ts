import { validateCloudSyncDocument, type CloudSyncDocument } from './cloudSync'
import {
  buildLocalCloudSyncDocument,
  markLocalDataDirty,
  replaceLocalSyncedData,
} from './cloudSyncEngine'
import {
  readCloudSafetyCopy,
  resolutionIdFor,
  saveLocalSafetyCopy,
  type CloudSafetyCopyListing,
  type LocalSafetyCopyEntry,
  type SafetyCopySide,
} from './syncResolutionSafetyCopy'

/*
  RESTORE FROM A SAFETY COPY (Phase 6, step 10)

  Undo for a resolution that turned out wrong. Restoring replaces THIS
  DEVICE's data with the chosen copy, marks local data as having
  unsynced changes, and stops there: it never writes to OneDrive and
  never touches any sync-tracking value. The normal sync flow then runs
  by itself - if OneDrive hasn't moved since this device last knew
  about it, the restored data is simply pushed; if it has, the state is
  'diverged' and the dentist lands back in the resolution screen,
  exactly as for any other disagreement.

  Before replacing anything, this device's CURRENT data is saved as a
  local 'before-restore' safety copy (see LocalSafetyCopyEntry.reason),
  so a Restore can itself be undone. If that copy can't be saved, the
  restore is refused - replacing data with no way back is exactly what
  this feature exists to prevent.
*/

export type RestoreResult =
  | {
      status: 'restored'
      patients: number
      treatments: number
      /* Present when this device's current data could not be snapshotted first. */
      warning?: string
    }
  | {
      status: 'failed'
      reason: 'invalid-copy' | 'safety-copy-failed' | 'storage-failed'
      detail: string
    }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function restoreDocumentToDevice(
  document: CloudSyncDocument,
  options: { now?: () => string } = {}
): RestoreResult {

  const now = (options.now ?? (() => new Date().toISOString()))()

  const validation = validateCloudSyncDocument(document)

  if (!validation.valid) {
    return { status: 'failed', reason: 'invalid-copy', detail: validation.error }
  }

  let warning: string | undefined

  const current = buildLocalCloudSyncDocument()

  if (current.valid) {

    try {

      saveLocalSafetyCopy({
        resolutionId: resolutionIdFor(now),
        capturedAt: now,
        cloudETag: null,
        reason: 'before-restore',
        device: current.document,
        cloud: current.document,
      })

    } catch (error) {

      return {
        status: 'failed',
        reason: 'safety-copy-failed',
        detail: describeError(error),
      }

    }

  } else {

    warning =
      "This device's current data could not be read, so it was not copied " +
      'first. It is being replaced by the restored copy.'

  }

  try {

    replaceLocalSyncedData(validation.document)

    markLocalDataDirty()

  } catch (error) {

    return { status: 'failed', reason: 'storage-failed', detail: describeError(error) }

  }

  return {
    status: 'restored',
    patients: validation.document.patients.length,
    treatments: validation.document.savedTreatments.length,
    ...(warning === undefined ? {} : { warning }),
  }

}

/* ---------- listing what can be restored ---------- */

export type CopyRef = {
  side: SafetyCopySide
  /* Present for copies held on this device. */
  document?: CloudSyncDocument
  /* Present for copies held on OneDrive. */
  fileName?: string
}

export type SafetyCopyGroup = {
  resolutionId: string
  capturedAt: string
  kind: 'resolution' | 'before-restore'
  device: CopyRef | null
  cloud: CopyRef | null
  /* Where the copies of this group live. */
  heldOn: ('this-device' | 'onedrive')[]
}

/*
  Merges this device's entries and OneDrive's listing into one list,
  newest first. A resolution held in both places is one group; where
  the copy is available locally it is used from there (no download).
*/
export function buildSafetyCopyGroups(
  local: LocalSafetyCopyEntry[],
  cloud: CloudSafetyCopyListing[]
): SafetyCopyGroup[] {

  const groups = new Map<string, SafetyCopyGroup>()

  for (const entry of local) {

    const beforeRestore = entry.reason === 'before-restore'

    groups.set(entry.resolutionId, {
      resolutionId: entry.resolutionId,
      capturedAt: entry.capturedAt,
      kind: beforeRestore ? 'before-restore' : 'resolution',
      device: { side: 'device', document: entry.device },
      cloud: beforeRestore ? null : { side: 'cloud', document: entry.cloud },
      heldOn: ['this-device'],
    })

  }

  for (const listing of cloud) {

    const existing = groups.get(listing.resolutionId)

    if (existing) {

      if (existing.device && listing.deviceFile) {
        existing.device.fileName = listing.deviceFile
      }

      if (existing.cloud && listing.cloudFile) {
        existing.cloud.fileName = listing.cloudFile
      }

      if (!existing.heldOn.includes('onedrive')) {
        existing.heldOn.push('onedrive')
      }

      continue

    }

    groups.set(listing.resolutionId, {
      resolutionId: listing.resolutionId,
      capturedAt: listing.capturedAt,
      kind: 'resolution',
      device: listing.deviceFile ? { side: 'device', fileName: listing.deviceFile } : null,
      cloud: listing.cloudFile ? { side: 'cloud', fileName: listing.cloudFile } : null,
      heldOn: ['onedrive'],
    })

  }

  return [...groups.values()].sort((a, b) =>
    a.resolutionId < b.resolutionId ? 1 : -1
  )

}

export type LoadCopyResult =
  | { status: 'ok'; document: CloudSyncDocument }
  | { status: 'unavailable'; detail: string }

/* Local copies need no download; OneDrive ones are fetched and validated. */
export async function loadCopyDocument(ref: CopyRef): Promise<LoadCopyResult> {

  if (ref.document) {
    return { status: 'ok', document: ref.document }
  }

  if (!ref.fileName) {
    return { status: 'unavailable', detail: 'This copy is no longer available.' }
  }

  try {

    const result = await readCloudSafetyCopy(ref.fileName)

    if (result.status === 'ok') {
      return { status: 'ok', document: result.copy.document }
    }

    return {
      status: 'unavailable',
      detail:
        result.status === 'missing'
          ? 'This copy is no longer on OneDrive.'
          : "This copy on OneDrive couldn't be read.",
    }

  } catch (error) {

    return {
      status: 'unavailable',
      detail: `Couldn't reach OneDrive (${describeError(error)}).`,
    }

  }

}
