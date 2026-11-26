import { useSyncExternalStore } from 'react'
import { getAppUpdateState, subscribeAppUpdate } from './appUpdate'

/*
  The build/version label as small, faint text at the very bottom of the
  Settings screen. Display only: updates are applied from the update
  banner (UpdateBanner.tsx), not from here.
*/
export default function AppVersionFooter() {

  const state = useSyncExternalStore(subscribeAppUpdate, getAppUpdateState)

  return (

    <p className="settings-version-footer">
      {state.versionLabel ?? 'development build'}
    </p>

  )

}
