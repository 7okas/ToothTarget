import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SyncStatusIndicator from './SyncStatusIndicator.tsx'
import StartupGateScreen from './StartupGateScreen.tsx'
import CloudCorruptionRecoveryDialog from './CloudCorruptionRecoveryDialog.tsx'
import { initializeMsal } from './auth.ts'

/*
  MSAL must finish initializing (and process any redirect response)
  before anything calls loginPopup/acquireTokenSilent/etc. - but
  ToothTarget's existing patient/treatment/template functionality
  does not depend on it at all, so a slow or failing MSAL init (eg.
  offline on first load) must never delay or block the app from
  rendering. initializeMsal() already catches its own errors and
  resolves regardless, so .finally() here is just "render now" in
  both the success and failure case.
*/

initializeMsal().finally(() => {

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SyncStatusIndicator />
      <App />
      <StartupGateScreen />
      <CloudCorruptionRecoveryDialog />
    </StrictMode>,
  )

})

/*
  Registered after load so it never delays first render. Scoped via
  BASE_URL because the production build is served from /ToothTarget/,
  not the site root - registering "/sw.js" there would 404.
*/
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
  })
}
