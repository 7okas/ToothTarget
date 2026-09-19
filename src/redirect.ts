import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge'

/*
  MSAL POPUP REDIRECT BRIDGE

  This is the ONLY thing this page does. It is loaded solely because
  Microsoft's login popup navigates here after the dentist signs in -
  it is never opened directly, and it never renders any part of
  ToothTarget. broadcastResponseToMainFrame() reads the auth response
  out of this page's own URL and broadcasts it back to the main
  ToothTarget window/tab that opened the popup (msalInstance.
  loginPopup()'s internal wait), which then closes this popup itself.

  See src/auth.ts (signIn -> loginPopup) and src/authConfig.ts
  (redirectUri) for the rest of the flow this plugs into.
*/

broadcastResponseToMainFrame().catch(error => {

  /*
    Only reachable if this page is loaded without a real auth
    response in its URL (eg. someone navigates here directly) - there
    is nothing else on this page to recover to, so just log it rather
    than leaving an unhandled rejection.
  */

  console.error('MSAL redirect bridge failed.', error)

})
