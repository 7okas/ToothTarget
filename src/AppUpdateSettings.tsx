import { useSyncExternalStore } from 'react'
import {
  applyUpdate,
  getAppUpdateState,
  subscribeAppUpdate,
} from './appUpdate'
import { UPDATE_TEXT } from './appUpdateRules'

export default function AppUpdateSettings() {

  const state = useSyncExternalStore(subscribeAppUpdate, getAppUpdateState)

  return (

    <>

      <h2 className="settings-section-title">
        App Version
      </h2>

      <p className="settings-section-description">
        Version: {state.versionLabel ?? 'development build'}
      </p>

      <div className="options-menu-list settings-actions">

        {state.updateReady && (
          <button type="button" onClick={applyUpdate}>
            {UPDATE_TEXT}
          </button>
        )}

      </div>

    </>

  )

}
