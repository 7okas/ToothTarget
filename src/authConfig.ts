import type { Configuration } from '@azure/msal-browser'

/*
  MICROSOFT ENTRA ID (MSAL) CONFIGURATION

  ToothTarget authenticates via delegated (browser/PWA) auth only -
  there is no client secret and never should be one, since this app
  has no backend server to keep a secret on. Every credential here is
  safe to ship to the browser: the client ID and tenant ID are public
  identifiers, not secrets, and MSAL's auth code + PKCE flow is
  designed specifically for public clients like this one.

  This file only configures MSAL - it does not create the
  PublicClientApplication instance or touch any existing app state/
  screens. That wiring is a separate, later step.
*/

export const msalConfig: Configuration = {
  auth: {
    clientId: 'd0d97e78-db77-4653-8d52-a30a4e0770a2',
    authority:
      'https://login.microsoftonline.com/consumers',
    /*
      Must point at the dedicated MSAL popup redirect bridge page
      (src/redirect.html + src/redirect.ts), NOT at the app itself -
      this is what the Microsoft login popup navigates to after the
      dentist signs in, and it must run ONLY MSAL's own
      broadcastResponseToMainFrame() bridge, never ToothTarget's
      normal main.tsx/App.

      Local development uses:
      http://localhost:5173/src/redirect.html

      GitHub Pages uses:
      https://7okas.github.io/ToothTarget/src/redirect.html

      Both exact URLs must be registered as Single-page application
      redirect URIs in the Entra app registration.
    */
    redirectUri: window.location.hostname === 'localhost'
      ? `${window.location.origin}/src/redirect.html`
      : `${window.location.origin}/ToothTarget/src/redirect.html`,
  },
  cache: {
    /*
      localStorage (rather than MSAL's default sessionStorage) keeps
      the dentist signed in across tabs and after closing/reopening
      the browser - consistent with how the rest of ToothTarget
      already persists everything to localStorage.
    */
    cacheLocation: 'localStorage',
  },
}

/*
  LOGIN SCOPES

  Requested together at sign-in so the dentist consents once:
  - User.Read: basic profile, used to identify who is signed in.
  - Files.ReadWrite.AppFolder: read/write access limited to this
    app's own dedicated folder in the user's OneDrive - never the
    user's full drive.
*/
export const loginRequest = {
  scopes: ['User.Read', 'Files.ReadWrite.AppFolder'],
}
