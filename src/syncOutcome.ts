import type { CloudSyncResult } from './cloudSyncEngine'
import type { CloudSyncCorruptionDiagnosis } from './cloudSyncCorruptionDiagnosis'

/*
  SYNC OUTCOME CLASSIFICATION (Phase 6)

  Pure, standalone module (same reasoning as staleRecordReview.ts/
  patientDeletionCascade.ts's own extraction: directly unit-testable,
  no React/DOM, no localStorage) that turns the sync engine's own
  CloudSyncResult - which already distinguishes every failure mode the
  pipeline can produce, see cloudSyncEngine.ts/cloudStorage.ts - into
  exactly what the dentist needs to know: a short plain-language label,
  and whether this outcome is something THEY need to act on or
  something the app will simply resolve on its own.

  Every CloudSyncResult status maps to its own SyncOutcomeType here -
  none of them fall through to a generic "Sync error" catch-all. This
  is the one place that decision is made; cloudSyncScheduler.ts stores
  whatever this produces (see its own lastSyncOutcome store) and
  SyncStatusIndicator.tsx only ever reads the result, never
  re-interprets a CloudSyncResult itself.

  Deliberately does NOT change, retry, or react to anything - this
  module has no side effects and makes no decision that affects sync
  behavior. It only describes, after the fact, an outcome the real
  pipeline (unchanged by this phase) already produced.
*/

export type SyncOutcomeType =
  | 'synced'
  | 'synced-after-conflict'
  | 'patient-number-conflicts'
  | 'review-needed'
  | 'save-incomplete'
  | 'sync-busy'
  | 'cloud-data-corrupted'
  | 'local-data-invalid'
  | 'not-signed-in'
  | 'sign-in-denied'
  | 'offline'
  | 'onedrive-unavailable'

export type SyncOutcomeReason = {
  type: SyncOutcomeType
  /*
    Only ever set when type === 'cloud-data-corrupted' - kept optional
    (rather than a discriminated union keyed on type) so every
    existing `{ type: someType }` SyncOutcomeReason literal already
    written across this project's own test suite (SyncStatusIndicator.test.ts,
    syncOutcome.test.ts, etc.) keeps compiling unchanged.
    CloudCorruptionRecoveryDialog.tsx is the one real consumer that
    reads it, to explain WHY the cloud file was rejected, not just
    THAT it was.
  */
  diagnosis?: CloudSyncCorruptionDiagnosis
}

/*
  classifySyncOutcome() is an exhaustive switch over
  CloudSyncResult['status'] - if cloudSyncEngine.ts ever adds a new
  status, TypeScript's own control-flow analysis (every branch must
  return a SyncOutcomeReason) fails to compile until a case is added
  here too, the same safety net cloudSyncEngine.ts's own read-result
  switch already relies on.
*/

export function classifySyncOutcome(
  result: CloudSyncResult
): SyncOutcomeReason {

  switch (result.status) {

    case 'synced':
      return {
        type: result.recoveredFromConflict
          ? 'synced-after-conflict'
          : 'synced',
      }

    case 'synced-with-conflicts':
      return { type: 'patient-number-conflicts' }

    case 'stale-review-required':
      return { type: 'review-needed' }

    case 'cloud-committed-locally-pending':
      return { type: 'save-incomplete' }

    case 'contention':
      return { type: 'sync-busy' }

    case 'cloud-invalid':
      return { type: 'cloud-data-corrupted', diagnosis: result.diagnosis }

    case 'validation-failed':
      return { type: 'local-data-invalid' }

    case 'auth-failed':
      return { type: 'not-signed-in' }

    case 'permission-denied':
      return { type: 'sign-in-denied' }

    case 'network-unreachable':
      return { type: 'offline' }

    case 'graph-error':
      return { type: 'onedrive-unavailable' }

  }

}

export type SyncOutcomeCopy = {
  /*
    Short enough for the persistent top-right badge (a single-line,
    nowrap pill - see SyncStatusIndicator.tsx) - plain language, no
    jargon ("ETag", "schema", "422", HTTP status codes, "Graph API").
  */
  label: string
  /*
    Longer, still plain-language explanation - shown as the label's
    title attribute (a native hover/long-press tooltip), so the short
    badge text never has to sacrifice clarity for brevity.
  */
  detail: string
  /*
    true only for outcomes the app cannot fix by itself - the dentist
    needs to actually do something (sign in again, resolve a patient-
    number conflict, get in touch about corrupted data). false covers
    both a completely clean sync AND every failure mode this app will
    simply retry on its own without any dentist action - see each
    entry's own comment below for why it's classified the way it is.
  */
  needsAttention: boolean
}

export const SYNC_OUTCOME_COPY: Record<SyncOutcomeType, SyncOutcomeCopy> = {

  synced: {
    label: 'Synced',
    detail: 'Synced',
    needsAttention: false,
  },

  /*
    The sync succeeded - the dentist's data IS fully up to date - but
    only after this device's own write collided with another device's
    (a 412/409 from OneDrive) and was automatically re-read, re-merged,
    and retried. Framed as resolved, not as a problem, because it is
    one: nothing was lost, nothing needs a decision.
  */
  'synced-after-conflict': {
    label: 'Synced (conflict resolved)',
    detail: 'Sync conflict — resolved automatically',
    needsAttention: false,
  },

  /*
    Distinct from a plain conflict retry above: this is
    patientNumberConflicts, a case where two DIFFERENT patients now
    share the same patient number (eg. both devices allocated the same
    number while offline). The sync itself succeeded, but the app
    cannot decide on its own which patient should keep the number -
    that is exactly what the existing conflict-resolution screen
    (App.tsx's conflict browser) is for.
  */
  'patient-number-conflicts': {
    label: 'Synced — needs attention',
    detail: 'Synced, but some patient numbers need your attention',
    needsAttention: true,
  },

  /*
    This device hasn't synced in a while and has local-only patients
    the dentist needs to review before syncing can continue (Phase
    4.7's stale-record review screen already owns the full explanation
    and the banner on Home) - this badge entry exists purely so the
    small persistent indicator never falls back to a generic failure
    message while that review is pending.
  */
  'review-needed': {
    label: 'Review needed',
    detail: 'Review needed before syncing can continue',
    needsAttention: true,
  },

  /*
    The cloud write genuinely succeeded - OneDrive already has the
    merged data - but saving it back to THIS device's own local storage
    failed (eg. a storage quota error). The next sync re-reads the
    cloud and converges safely on its own (see cloudSyncEngine.ts's own
    commitLocalState()/crash-safety comment), so this is worded as
    in-progress, not broken.
  */
  'save-incomplete': {
    label: 'Saving — will retry',
    detail:
      "Synced to the cloud, but couldn't finish saving on this device — will retry automatically",
    needsAttention: false,
  },

  /*
    Every attempt in this sync ran into another device writing at the
    same moment (repeated 412/409s) and none of the (bounded) retries
    won the race. Purely a timing collision between devices, not a
    real problem with either device's data - the very next sync
    attempt (triggered by the next mutation, or the scheduler's own
    retry-on-reconnect) starts completely fresh and has no reason to
    collide again.
  */
  'sync-busy': {
    label: 'Busy — retrying',
    detail: 'Busy syncing with another device — will try again shortly',
    needsAttention: false,
  },

  /*
    The cloud document could not be read as a valid ToothTarget sync
    document (either it wasn't parseable JSON at all, or it didn't
    match the expected shape even after the app's own backfill
    migrations for older documents - see cloudSync.ts's
    validateCloudSyncDocument()/cloudSyncSchemaMigration.ts). Retrying
    automatically can never fix this - the same bad document is still
    there - so this is the one case that genuinely needs a human to
    look at the OneDrive file itself.
  */
  'cloud-data-corrupted': {
    label: 'Cloud data corrupted',
    detail: 'Cloud data looks corrupted — this needs attention',
    needsAttention: true,
  },

  /*
    This device's OWN local data failed validation before a sync could
    even attempt to read or write anything on OneDrive (see
    cloudSyncEngine.ts's buildLocalCloudSyncDocument()) - a real
    problem with this device's local storage, not the cloud. Retrying
    automatically changes nothing, since the same invalid local data is
    still there.
  */
  'local-data-invalid': {
    label: 'Device data error',
    detail: "Something's wrong with this device's data — this needs attention",
    needsAttention: true,
  },

  /*
    The Microsoft sign-in this device already had is no longer valid
    (the cached token expired or was revoked, and automatic sync is
    never allowed to pop open an interactive sign-in window on its own
    - see auth.ts's getAccessToken()). Distinct from having no account
    signed in at all, which SyncStatusIndicator.tsx already shows its
    own "Sign in needed" message for, well before a sync is ever even
    attempted.
  */
  'not-signed-in': {
    label: 'Sign-in expired',
    detail: 'Your Microsoft sign-in has expired — please sign in again',
    needsAttention: true,
  },

  /*
    OneDrive rejected the request for a permissions reason (a Graph 403)
    - eg. the App Folder access this app depends on was revoked. Won't
    resolve itself by retrying; the dentist needs to sign in again (or
    check with whoever manages the Microsoft account) to restore access.
  */
  'sign-in-denied': {
    label: 'Access denied',
    detail: 'OneDrive access was denied — please sign in again',
    needsAttention: true,
  },

  /*
    fetch() itself failed before ever reaching OneDrive - offline, DNS
    failure, airplane mode, etc. (see cloudStorage.ts's own
    'network-unreachable' status). The app already listens for the
    browser's 'online' event and retries automatically the moment
    connectivity returns (cloudSyncOnlineRetry.ts) - nothing for the
    dentist to do.
  */
  offline: {
    label: 'No internet connection',
    detail: "No internet connection — will sync once you're back online",
    needsAttention: false,
  },

  /*
    A request DID reach OneDrive, but it responded with something
    other than a clean success (excluding the 401/403 cases above,
    which get their own distinct messages) - eg. a transient server
    error. Typically self-resolves; the next sync attempt tries again
    from scratch.
  */
  'onedrive-unavailable': {
    label: "Can't reach OneDrive",
    detail: "Couldn't reach OneDrive — will try again automatically",
    needsAttention: false,
  },

}

export function describeSyncOutcome(reason: SyncOutcomeReason): SyncOutcomeCopy {
  return SYNC_OUTCOME_COPY[reason.type]
}
