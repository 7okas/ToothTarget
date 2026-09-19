import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  BrowserAuthError,
  EventType,
  type AccountInfo,
  type AuthenticationResult,
} from '@azure/msal-browser'
import { msalConfig, loginRequest } from './authConfig'

/*
  MICROSOFT AUTHENTICATION (MSAL)

  This is authentication only - it never touches OneDrive/Graph data
  and is never read by any existing ToothTarget screen, timer,
  template, or localStorage key. Signing in only makes a Microsoft
  account available for a later, separate feature; every existing
  patient/treatment/template flow keeps working exactly as before,
  signed in or not.

  msalInstance is created once, at module load, and exported so both
  the app's entry point (to initialize it before React renders) and
  the auth UI (to read/react to sign-in state) share the exact same
  instance - MSAL does not support multiple independent instances
  safely sharing one localStorage cache.
*/

export const msalInstance = new PublicClientApplication(msalConfig)

/*
  msalInstance.initialize() (and handleRedirectPromise(), which MSAL
  docs recommend calling once even in a popup-only app) must resolve
  before any other MSAL method is called. initializeMsal() is safe to
  call from multiple places (the entry point, and independently from
  the auth UI on mount) - the underlying promise is only created once
  and awaited every time after that.
*/

let initPromise: Promise<void> | null = null

export function initializeMsal(): Promise<void> {

  if (!initPromise) {

    initPromise = msalInstance
      .initialize()
      .then(() => msalInstance.handleRedirectPromise())
      .then(result => {

        if (result?.account) {
          msalInstance.setActiveAccount(result.account)
        }

        if (!msalInstance.getActiveAccount()) {

          const [firstAccount] = msalInstance.getAllAccounts()

          if (firstAccount) {
            msalInstance.setActiveAccount(firstAccount)
          }

        }

      })
      .catch(error => {

        /*
          Initialization failing (eg. a corrupted localStorage cache
          entry from a previous session) should leave the dentist
          signed-out, never crash the app - every screen in
          ToothTarget works fine with no Microsoft account present.
        */

        console.error(
          'MSAL initialization failed - continuing signed out.',
          error
        )

      })

  }

  return initPromise

}

/*
  Keeps the "active" account in sync whenever MSAL completes a
  sign-in on its own (eg. a silent SSO/token refresh that resolves to
  a different account than the one currently marked active).
*/

msalInstance.addEventCallback(event => {

  if (
    (event.eventType === EventType.LOGIN_SUCCESS ||
      event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS) &&
    event.payload &&
    'account' in event.payload &&
    event.payload.account
  ) {

    msalInstance.setActiveAccount(
      event.payload.account as AccountInfo
    )

  }

})


/*
  CURRENT ACCOUNT

  MSAL's own getActiveAccount()/getAllAccounts() build a brand new
  object on every call (even when nothing has changed), which is
  exactly what React's useSyncExternalStore is not allowed to do -
  its getSnapshot must return the same reference until the value it
  represents actually changes, or React can re-render in a loop.
  This caches the last snapshot and only replaces it when the active
  account's identity (homeAccountId) actually changes, so components
  can safely read this via useSyncExternalStore.
*/

let cachedAccount: AccountInfo | null = null
let cachedAccountKey: string | null = null

export function getActiveAccount(): AccountInfo | null {

  const account =
    msalInstance.getActiveAccount() ??
    msalInstance.getAllAccounts()[0] ??
    null

  const key = account?.homeAccountId ?? null

  if (key !== cachedAccountKey) {
    cachedAccountKey = key
    cachedAccount = account
  }

  return cachedAccount

}

/*
  LIVE ACCOUNT SUBSCRIPTION (for React's useSyncExternalStore)

  MSAL emits ACTIVE_ACCOUNT_CHANGED from setActiveAccount() itself -
  covering every place this file calls it: the restoration logic in
  initializeMsal(), signIn(), signOut(), and the LOGIN_SUCCESS/
  ACQUIRE_TOKEN_SUCCESS sync above. A component subscribed via this
  always re-reads getActiveAccount() when MSAL's own state changes,
  instead of keeping its own separate copy that could drift out of
  sync depending on exactly when initialization, events, and that
  component's mount happen to interleave.
*/

export function subscribeToActiveAccount(onChange: () => void): () => void {

  const callbackId = msalInstance.addEventCallback(event => {

    if (event.eventType === EventType.ACTIVE_ACCOUNT_CHANGED) {
      onChange()
    }

  })

  return () => {

    if (callbackId) {
      msalInstance.removeEventCallback(callbackId)
    }

  }

}


/*
  SIGN IN

  Uses a popup rather than a full-page redirect so the dentist never
  loses their place in ToothTarget (an in-progress timer, an open
  screen) while signing in. Every failure mode - the popup being
  blocked, the dentist closing/cancelling it, or any other login
  failure - resolves to a friendly, displayable message instead of
  throwing, so a failed sign-in can never blank the app.
*/

export type SignInResult =
  | { account: AccountInfo; error: null }
  | { account: null; error: string }

export async function signIn(): Promise<SignInResult> {

  try {

    const result: AuthenticationResult =
      await msalInstance.loginPopup(loginRequest)

    if (!result.account) {
      return {
        account: null,
        error: 'Sign-in did not return an account. Please try again.',
      }
    }

    msalInstance.setActiveAccount(result.account)

    return { account: result.account, error: null }

  } catch (error) {

    return { account: null, error: describeAuthError(error) }

  }

}


/*
  SIGN OUT

  logoutPopup() clears this account's cache (localStorage) and, on
  success, also signs it out of the Microsoft session in the popup.
  If the popup itself fails (blocked, closed, network) the local
  active account is still cleared below, so "Sign Out" always at
  least returns ToothTarget to a signed-out state on this device.
*/

export async function signOut(): Promise<void> {

  const account = getActiveAccount()

  try {

    await msalInstance.logoutPopup({
      account: account ?? undefined,
    })

  } catch (error) {

    console.error(
      'Microsoft sign-out popup failed - clearing local session anyway.',
      error
    )

  } finally {

    msalInstance.setActiveAccount(null)

  }

}


/*
  ACCESS TOKEN

  Tries a silent (no user interaction) token acquisition first, which
  succeeds whenever the cached session is still valid - this is the
  common case and never shows any UI. Only falls back to an
  interactive popup when MSAL reports that interaction is actually
  required (eg. consent was revoked, or the refresh token expired).
  Returns null rather than throwing on any failure, since no existing
  ToothTarget feature currently depends on a token - a failure here
  must never block or crash the app.

  allowInteraction (default true) exists for Phase 7's automatic cloud
  sync: every EXISTING caller of this function (Backup to Cloud/Load
  from Cloud, the Test Cloud Storage/Test Cloud Data File buttons) is
  already an explicit, dentist-initiated action, where popping open a
  Microsoft sign-in window on an expired token is expected and fine -
  those callers pass no options and keep this exact behavior
  unchanged. Automatic background sync is different: it can fire from
  routine dental workflows (completing a treatment, saving a template)
  that have nothing to do with signing in, so it must never surprise
  the dentist with a login popup. cloudStorage.ts's
  readCloudSyncDocument()/writeCloudSyncDocument() - used only by the
  automatic sync engine, never by the manual backup UI - pass
  { allowInteraction: false } so a token that needs interactive
  refresh simply resolves to null (surfaced as the sync engine's own
  'auth-failed' status) instead of opening a popup.
*/

export async function getAccessToken(
  options: { allowInteraction?: boolean } = {}
): Promise<string | null> {

  const { allowInteraction = true } = options

  const account = getActiveAccount()

  if (!account) {
    return null
  }

  try {

    const result = await msalInstance.acquireTokenSilent({
      ...loginRequest,
      account,
    })

    return result.accessToken

  } catch (error) {

    if (error instanceof InteractionRequiredAuthError) {

      if (!allowInteraction) {
        return null
      }

      try {

        const result = await msalInstance.acquireTokenPopup(
          loginRequest
        )

        return result.accessToken

      } catch (interactiveError) {

        console.error(
          'Interactive token acquisition failed.',
          interactiveError
        )

        return null

      }

    }

    console.error('Silent token acquisition failed.', error)

    return null

  }

}


/*
  Turns an MSAL error into a short, dentist-facing message. Falls
  back to a generic message for anything not specifically recognized
  rather than surfacing raw MSAL error text.
*/

function describeAuthError(error: unknown): string {

  console.error('Microsoft sign-in failed.', error)

  if (error instanceof BrowserAuthError) {

    if (error.errorCode === 'popup_window_error') {
      return 'Your browser blocked the Microsoft sign-in popup. Please allow popups for this site and try again.'
    }

    if (
      error.errorCode === 'user_cancelled' ||
      error.errorCode === 'empty_window_error'
    ) {
      return 'Sign-in was cancelled.'
    }

    if (error.errorCode === 'interaction_in_progress') {
      return 'A previous sign-in attempt is still in progress. Reload this page and try again.'
    }

    if (error.errorCode === 'timed_out') {
      return 'The Microsoft sign-in popup never loaded and timed out. This is usually a browser extension (ad blocker / tracking protection) blocking it - try again in a private/incognito window, or disable extensions for this site.'
    }

    /*
      Any other MSAL error: show the real code/message instead of a
      generic one, so a problem can be diagnosed from this screen
      alone, without needing the browser console.
    */
    return `Microsoft sign-in failed (${error.errorCode}): ${error.errorMessage || error.message}`

  }

  if (error instanceof Error) {
    return `Microsoft sign-in failed: ${error.message}`
  }

  return 'Microsoft sign-in failed. Please try again.'

}
