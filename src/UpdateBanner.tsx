import { useSyncExternalStore } from 'react'
import {
  applyUpdate,
  getAppUpdateState,
  subscribeAppUpdate,
} from './appUpdate'
import {
  LOAD_ERROR_TEXT,
  UPDATE_TEXT,
  bannerKind,
} from './appUpdateRules'

/*
  Never reloads on its own - the button is the only trigger. Hidden
  while the timer screen has an active treatment (see bannerKind()).
*/
export default function UpdateBanner() {

  const state = useSyncExternalStore(subscribeAppUpdate, getAppUpdateState)

  const kind = bannerKind(state)

  if (kind === 'none') {
    return null
  }

  return (

    <div
      className={
        kind === 'load-error'
          ? 'update-banner update-banner-error'
          : 'update-banner'
      }
      role={kind === 'load-error' ? 'alert' : 'status'}
    >

      <span>
        {kind === 'load-error' ? LOAD_ERROR_TEXT : UPDATE_TEXT}
      </span>

      <button
        type="button"
        onClick={() => {
          if (kind === 'load-error') {
            window.location.reload()
          } else {
            applyUpdate()
          }
        }}
      >
        Reload
      </button>

    </div>

  )

}
