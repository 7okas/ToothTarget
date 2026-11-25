import { useState, useSyncExternalStore } from 'react'
import {
  applyUpdate,
  checkForUpdates,
  getAppUpdateState,
  resetAppCache,
  subscribeAppUpdate,
} from './appUpdate'
import { UPDATE_TEXT } from './appUpdateRules'

const CHECK_TEXT = {
  idle: '',
  checking: 'Checking...',
  'up-to-date': 'You have the latest version.',
  'update-ready': 'A new version is ready.',
  error: 'Could not check for updates (offline, or not installed yet).',
} as const

export default function AppUpdateSettings() {

  const state = useSyncExternalStore(subscribeAppUpdate, getAppUpdateState)

  const [confirmingReset, setConfirmingReset] = useState(false)

  return (

    <>

      <h2 className="settings-section-title">
        App Version
      </h2>

      <p className="settings-section-description">
        Version: {state.versionLabel ?? 'development build'}
      </p>

      <div className="options-menu-list settings-actions">

        <button
          type="button"
          onClick={checkForUpdates}
          disabled={state.checkStatus === 'checking'}
        >
          Check for updates
        </button>

        {state.updateReady && (
          <button type="button" onClick={applyUpdate}>
            {UPDATE_TEXT}
          </button>
        )}

        <button
          type="button"
          onClick={() => setConfirmingReset(true)}
        >
          Reset app cache
        </button>

      </div>

      {state.checkStatus !== 'idle' && (
        <p className="settings-section-description" role="status">
          {CHECK_TEXT[state.checkStatus]}
        </p>
      )}

      {confirmingReset && (

        <div className="modal-overlay">

          <div className="modal-card">

            <h2>
              Reset app cache?
            </h2>

            <p>
              This removes the app's offline copy and reloads the page
              once. Your patients, treatments and sign-in are not
              touched.
            </p>

            <div className="modal-actions">

              <button
                type="button"
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </button>

              <button
                type="button"
                className="button-danger"
                onClick={() => {
                  void resetAppCache()
                }}
              >
                Reset
              </button>

            </div>

          </div>

        </div>

      )}

    </>

  )

}
