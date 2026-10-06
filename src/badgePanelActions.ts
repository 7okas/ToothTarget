import type { CloudSyncStatus } from './cloudSyncScheduler'
import { canTriggerManualSync } from './syncStatusIndicatorState'

/*
  WHAT THE BADGE PANEL'S BUTTONS DO (pure apart from the injected calls)

  Which button to show comes from badgePanelButton()
  (syncStatusIndicatorState.ts). This file is what each button then does,
  with the real functions passed in, so the decisions can be tested
  without Microsoft's sign-in library or a running sync.

  "SYNC NOW" - the PULL-FIRST route, the same one the startup gate's Retry
  uses (requestCloudPullIfSignedIn), deliberately NOT requestCloudSync():
  that one first marks this device as having changed data, and a push can
  then report a false conflict when nothing here was actually edited. A
  pull adopts the cloud copy when this device is clean, pushes when only
  this device changed, and reports a conflict only when both did. It does
  nothing while a sync is already running or queued
  (canTriggerManualSync), so a second tap can never start a second one.

  "SIGN IN AGAIN" - the existing sign-in flow, step for step as the
  Settings screen and the startup gate already do it: sign in (the same
  popup), check whether the account changed (reload if so, so the new
  account's own data is loaded), then request a pull. Nothing new is
  invented here.

  Neither marks local data as changed, forces, or overwrites anything.
*/

export function startSyncNow(
  status: CloudSyncStatus,
  deps: { requestPull: (isSignedIn: boolean) => void }
): 'started' | 'blocked' {

  if (!canTriggerManualSync(status)) {
    return 'blocked'
  }

  // The badge's panel only exists while signed in, so `true` is accurate.
  deps.requestPull(true)

  return 'started'

}

export type SignInAgainDeps = {
  signIn: () => Promise<
    | { account: { homeAccountId: string }; error: null }
    | { account: null; error: string }
  >
  reconcileAccount: (accountId: string) => string
  requestPull: (isSignedIn: boolean) => void
}

export type SignInAgainResult =
  | { kind: 'signed-in' }
  | { kind: 'switched-account' }
  | { kind: 'failed'; message: string }

export async function signInAgain(
  deps: SignInAgainDeps
): Promise<SignInAgainResult> {

  const result = await deps.signIn()

  if (result.error) {
    return { kind: 'failed', message: result.error }
  }

  if (!result.account) {
    return { kind: 'failed', message: 'Sign-in did not complete.' }
  }

  // A different Microsoft account than this device's data belongs to:
  // the caller reloads, exactly as the Settings screen and the gate do.
  if (deps.reconcileAccount(result.account.homeAccountId) === 'switched-account') {
    return { kind: 'switched-account' }
  }

  deps.requestPull(true)

  return { kind: 'signed-in' }

}
