import { useEffect, useState } from 'react'
import {
  BACKUP_NOTE,
  STORAGE_STATUS_TEXT,
  readStorageStatus,
  requestPersistence,
  type StorageStatus,
} from './persistentStorage'

export default function StorageSettings() {

  const [status, setStatus] = useState<StorageStatus | null>(null)

  useEffect(() => {

    let active = true

    readStorageStatus().then(result => {
      if (active) setStatus(result)
    })

    return () => {
      active = false
    }

  }, [])

  return (

    <>

      <h2 className="settings-section-title">
        Storage
      </h2>

      <p className="settings-section-description" role="status">
        {status === null ? 'Checking...' : STORAGE_STATUS_TEXT[status]}
      </p>

      {/*
        Only offered when protection is not granted yet or cannot be
        confirmed. Hidden while still checking (no flash of the button)
        and once the device already keeps the data.
      */}

      {(status === 'not-protected' || status === 'unknown') && (

        <div className="options-menu-list settings-actions">

          <button
            type="button"
            onClick={() => {
              requestPersistence().then(setStatus)
            }}
          >
            Request protection
          </button>

        </div>

      )}

      <p className="settings-section-description">
        {BACKUP_NOTE}
      </p>

    </>

  )

}
