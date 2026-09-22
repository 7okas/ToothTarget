import { getActiveAccount } from './auth'
import { requestCloudSyncIfSignedIn } from './cloudSyncScheduler'

/*
  ONLINE RETRY (Phase 3)

  A network drop during a sync already surfaces as a normal, typed
  failure (see cloudStorage.ts's describeNetworkFailure() /
  cloudSyncScheduler.ts's 'unavailable' status) - nothing was ever at
  risk of being lost (the mutation that triggered the sync had already
  been committed to localStorage before requestCloudSync() was ever
  called, per cloudSyncScheduler.ts's own header comment). What was
  missing was a prompt RETRY once connectivity actually returns: before
  this phase, the next sync only happened whenever some unrelated
  mutation (a new patient, a completed treatment) next called
  requestCloudSync() - which could be a long time, or never, in a
  session that made no further changes.

  This listens for the browser's own 'online' event (fired when the
  OS/browser regains network connectivity) and, when it fires, asks for
  exactly one more sync attempt - reusing requestCloudSyncIfSignedIn()
  from Phase 2 so a dentist who has never connected a Microsoft account
  still gets zero sync activity here too, not even an attempted one.

  No new debounce/coalescing logic was added for a rapidly flapping
  connection: every call this makes still goes through
  requestCloudSyncIfSignedIn() -> requestCloudSync(), which already
  coalesces same-tick bursts into one sync and, for calls spread across
  a running sync's lifetime, allows at most one queued follow-up
  regardless of how many arrive meanwhile (see cloudSyncScheduler.ts's
  own header comment) - the exact same guarantee every other automatic
  trigger already relies on.
*/

export function attachOnlineRetryListener(): () => void {

  function handleOnline(): void {
    requestCloudSyncIfSignedIn(Boolean(getActiveAccount()))
  }

  window.addEventListener('online', handleOnline)

  return () => {
    window.removeEventListener('online', handleOnline)
  }

}
