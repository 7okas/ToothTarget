import type { CloudSyncResult } from './cloudSyncEngine'

/*
  SIGN-OUT WITH BEST-EFFORT SYNC (Phase 4)

  This account's own per-account cache (see cloudSyncEngine.ts's
  reconcileSyncedAccount()) already guarantees nothing is LOST when
  the dentist signs out - whatever hasn't reached the cloud yet is
  still safe on this device and will get another chance to sync the
  next time this device signs into this same account. But relying on
  that alone means a change could sit local-only, invisible to any
  OTHER device signed into this account, for as long as this device
  happens to stay on a different account.

  Attempting one more sync right before sign-out - while the outgoing
  account's token is still valid - maximizes the chance that anything
  not yet synced reaches the cloud immediately instead. Deliberately
  best-effort: any failure (offline, auth, a Graph error, anything) is
  swallowed here rather than blocking or interrupting sign-out, since
  the per-account cache already makes this a nice-to-have, not a
  safety requirement.

  Takes both steps as parameters (dependency injection) rather than
  importing syncCloudNow()/signOut() directly, so this module has zero
  real runtime imports of its own - only a type-only import, erased at
  compile time - and is trivially testable with plain mock functions,
  no vi.mock() of auth.ts/cloudSyncEngine.ts needed at all.
*/

export async function signOutWithBestEffortSync(
  attemptSync: () => Promise<CloudSyncResult>,
  performSignOut: () => Promise<void>
): Promise<void> {

  try {

    await attemptSync()

  } catch {

    // Deliberately ignored - see this file's header comment.

  }

  await performSignOut()

}
