import type { CloudSyncResult } from './cloudSyncEngine'
import type { CloudSyncCorruptionDiagnosis } from './cloudSyncCorruptionDiagnosis'

/*
  SYNC OUTCOME CLASSIFICATION

  Pure, standalone module (directly unit-testable, no React/DOM, no
  localStorage) that turns the sync engine's own CloudSyncResult - which
  distinguishes every failure mode the pipeline can produce, see
  cloudSyncEngine.ts/cloudStorage.ts - into exactly what the dentist
  needs to know: one of four states, and one line of plain-language
  detail saying why.

  THE FOUR SYNC STATES
  ============================================================
    synced       - nothing to do.
    offline      - the app will retry by itself (no connection, OneDrive
                   unavailable, or a local save that will be retried).
    conflict     - this device and OneDrive both changed; the dentist
                   decides in the resolution screen.
    needs-input  - the dentist has to act (sign in again, a corrupted
                   cloud file, invalid data on this device).

  The specific reason is never a state of its own - it is the `detail`
  line (the startup gate, the badge and Settings all show it). The
  corruption dialog's explanation travels as `diagnosis`, also plain
  data.

  This is the one place that decision is made; cloudSyncScheduler.ts
  stores whatever this produces (see its own lastSyncOutcome store) and
  the UI only ever reads the result, never re-interprets a
  CloudSyncResult itself. Deliberately has no side effects.
*/

export type SyncState = 'synced' | 'offline' | 'conflict' | 'needs-input'

export const SYNC_STATE_HEADING: Record<SyncState, string> = {
  synced: 'Synced',
  offline: 'Offline, will retry',
  conflict: 'Sync conflict',
  'needs-input': 'Needs your input',
}

export type SyncOutcomeReason = {
  state: SyncState
  /*
    One line, plain language, no jargon ("ETag", "schema", "422", HTTP
    status codes, "Graph API").
  */
  detail: string
  /*
    Only set for the corrupted-cloud-file case - the corruption dialog
    reads it to explain WHY the file was rejected, not just THAT it was.
  */
  diagnosis?: CloudSyncCorruptionDiagnosis
}

const GENERIC_CORRUPTION_DIAGNOSIS: CloudSyncCorruptionDiagnosis = {
  kind: 'unreadable',
  reason: 'The cloud file failed validation.',
}

/*
  classifySyncOutcome() is an exhaustive switch over
  CloudSyncResult['status'] - if cloudSyncEngine.ts ever adds a new
  status, TypeScript fails to compile until a case is added here too.
*/

export function classifySyncOutcome(
  result: CloudSyncResult
): SyncOutcomeReason {

  switch (result.status) {

    case 'synced':
      return { state: 'synced', detail: 'Synced' }

    /*
      The cloud write genuinely succeeded, but saving it back to THIS
      device's own local storage failed (eg. a storage quota error). The
      next sync converges safely on its own, so this is worded as
      in-progress, not broken.
    */
    case 'cloud-committed-locally-pending':
      return {
        state: 'offline',
        detail:
          "Synced to the cloud, but couldn't finish saving on this device — will retry automatically",
      }

    /*
      The cloud document could not be read as a valid sync document.
      Retrying can never fix this - the same bad document is still there
      - so a person has to look at it (the corruption dialog offers a
      backup restore).
    */
    case 'cloud-invalid':
      return {
        state: 'needs-input',
        detail: 'Cloud data looks corrupted — this needs attention',
        diagnosis: result.diagnosis ?? GENERIC_CORRUPTION_DIAGNOSIS,
      }

    /*
      This device's OWN data failed validation - a real problem with
      local storage, not the cloud. Retrying changes nothing.
    */
    case 'validation-failed':
      return {
        state: 'needs-input',
        detail: "Something's wrong with this device's data — this needs attention",
      }

    /*
      The Microsoft sign-in this device had is no longer valid. Automatic
      sync never opens an interactive sign-in window on its own.
    */
    case 'auth-failed':
      return {
        state: 'needs-input',
        detail: 'Your Microsoft sign-in has expired — please sign in again',
      }

    /* OneDrive refused for a permissions reason (a 403). */
    case 'permission-denied':
      return {
        state: 'needs-input',
        detail: 'OneDrive access was denied — please sign in again',
      }

    /*
      fetch() failed before reaching OneDrive. The app retries by itself
      when the browser reports it is back online (cloudSyncOnlineRetry.ts).
    */
    case 'network-unreachable':
      return {
        state: 'offline',
        detail: "No internet connection — will sync once you're back online",
      }

    /*
      OneDrive answered with something other than success (not a sign-in
      problem) - typically a transient server error.
    */
    case 'graph-error':
      return {
        state: 'offline',
        detail: "Couldn't reach OneDrive — will try again automatically",
      }

    /*
      This device has unsynced changes AND OneDrive moved to something it
      never confirmed. Neither side was overwritten; the resolution
      screen is the way forward.
    */
    case 'diverged':
      return {
        state: 'conflict',
        detail:
          'This device and OneDrive both have changes; nothing was overwritten. ' +
          'Tap to review the differences.',
      }

  }

}

export type SyncOutcomeCopy = {
  /* The state's own heading - what the badge and the gate show. */
  label: string
  detail: string
  /*
    true only for states the app cannot resolve by itself: the dentist
    has to decide or act (conflict, needs-input).
  */
  needsAttention: boolean
}

export function describeSyncOutcome(reason: SyncOutcomeReason): SyncOutcomeCopy {
  return {
    label: SYNC_STATE_HEADING[reason.state],
    detail: reason.detail,
    needsAttention: reason.state === 'conflict' || reason.state === 'needs-input',
  }
}
