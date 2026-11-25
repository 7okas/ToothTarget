import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SyncStatusIndicator from './SyncStatusIndicator.tsx'
import StartupGateScreen from './StartupGateScreen.tsx'
import CloudCorruptionRecoveryDialog from './CloudCorruptionRecoveryDialog.tsx'
import SyncResolutionScreen from './SyncResolutionScreen.tsx'
import SafetyCopiesScreen from './SafetyCopiesScreen.tsx'
import { initializeMsal } from './auth.ts'
import UpdateBanner from './UpdateBanner.tsx'
import { startAppUpdates } from './appUpdate.ts'
import { ensurePersistenceOnLaunch } from './persistentStorage.ts'

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
      <UpdateBanner />
      <SyncStatusIndicator />
      <App />
      <StartupGateScreen />
      <CloudCorruptionRecoveryDialog />
      <SyncResolutionScreen />
      <SafetyCopiesScreen />
    </StrictMode>,
  )

})

/*
  Service worker registration and update tracking (production only) -
  see appUpdate.ts and public/sw.js.
*/
startAppUpdates()

/*
  Quietly asks the browser to keep this site's data (see
  persistentStorage.ts). Never shows anything and never reads app data.
*/
void ensurePersistenceOnLaunch()
