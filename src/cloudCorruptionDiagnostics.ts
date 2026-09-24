/*
  CLOUD CORRUPTION DIAGNOSTICS

  A single, overwritten-in-place snapshot of the most recent corrupt
  live cloud sync file this device has seen - never a growing log.
  Captured the moment cloudStorage.ts's readCloudSyncDocument()
  detects the live sync file is unreadable (not valid JSON) or fails
  schema validation, purely so the exact raw content and error are
  available for later inspection/support if needed.

  Deliberately separate from CloudSyncCorruptionDiagnosis
  (cloudSyncCorruptionDiagnosis.ts), which is the short, plain-
  language classification CloudCorruptionRecoveryDialog.tsx actually
  displays - this module is not read by that dialog at all. It exists
  purely as a raw evidence capture, keyed off the sync outcome the
  dialog already reacts to, not as UI content itself.

  A new occurrence always overwrites the previous one (a plain
  localStorage.setItem(), never appended to), matching this feature's
  own "overwrite, don't accumulate" requirement.
*/

const DIAGNOSTICS_KEY = 'toothTargetCloudCorruptionDiagnostics'

export type CloudCorruptionDiagnosticsRecord = {
  rawContent: string
  error: string
  capturedAt: string
}

/*
  Best-effort only, and deliberately silent on failure (eg. a storage
  quota error) - a diagnostics write failing must never affect the
  actual corruption detection/classification/reporting this module
  has nothing to do with; readCloudSyncDocument() still returns its
  own status/diagnosis regardless of whether this succeeds.
*/
export function captureCloudCorruptionDiagnostics(
  record: CloudCorruptionDiagnosticsRecord
): void {

  try {

    localStorage.setItem(DIAGNOSTICS_KEY, JSON.stringify(record))

  } catch {
    // Best-effort - see this file's header comment.
  }

}

export function readCloudCorruptionDiagnostics():
  CloudCorruptionDiagnosticsRecord | null {

  try {

    const raw = localStorage.getItem(DIAGNOSTICS_KEY)

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const candidate = parsed as Partial<CloudCorruptionDiagnosticsRecord>

    if (
      typeof candidate.rawContent !== 'string' ||
      typeof candidate.error !== 'string' ||
      typeof candidate.capturedAt !== 'string'
    ) {
      return null
    }

    return {
      rawContent: candidate.rawContent,
      error: candidate.error,
      capturedAt: candidate.capturedAt,
    }

  } catch {

    return null

  }

}
