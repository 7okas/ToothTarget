/*
  PERSISTENT STORAGE

  Asks the browser to keep this site's data (localStorage included) even
  when the device runs low on space. This only ever calls
  navigator.storage.persisted() / persist() - it never reads or writes
  any ToothTarget data - and it never throws: unsupported or refused
  just means "not protected" or "unknown".
*/

export type StorageStatus = 'protected' | 'not-protected' | 'unknown'

export type StorageLike = {
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
}

export const STORAGE_STATUS_TEXT: Record<StorageStatus, string> = {
  protected: 'Protected: this device is set to keep your data',
  'not-protected':
    'Not protected: your device may clear app data if storage runs low',
  unknown: 'Unknown (not supported here)',
}

export const BACKUP_NOTE =
  'Export a backup before clearing Safari data or deleting the app icon.'

function defaultStorage(): StorageLike | undefined {

  return typeof navigator === 'undefined' ? undefined : navigator.storage

}

function toStatus(isPersistent: boolean): StorageStatus {

  return isPersistent ? 'protected' : 'not-protected'

}

export async function readStorageStatus(
  storage: StorageLike | undefined = defaultStorage()
): Promise<StorageStatus> {

  if (!storage || typeof storage.persisted !== 'function') {
    return 'unknown'
  }

  try {
    return toStatus(await storage.persisted())
  } catch {
    return 'unknown'
  }

}

/*
  Asks again and reports where things stand afterwards. A refusal (or an
  error) falls back to whatever persisted() says, so the text never claims
  more than the browser confirmed.
*/
export async function requestPersistence(
  storage: StorageLike | undefined = defaultStorage()
): Promise<StorageStatus> {

  if (!storage || typeof storage.persist !== 'function') {
    return readStorageStatus(storage)
  }

  try {

    if (await storage.persist()) {
      return 'protected'
    }

  } catch {
    // Fall through to the plain status check below.
  }

  return readStorageStatus(storage)

}

/*
  Once per launch, quietly. Already persistent => nothing to ask.
*/
export async function ensurePersistenceOnLaunch(
  storage: StorageLike | undefined = defaultStorage()
): Promise<void> {

  if (
    !storage ||
    typeof storage.persisted !== 'function' ||
    typeof storage.persist !== 'function'
  ) {
    return
  }

  try {

    if (!(await storage.persisted())) {
      await storage.persist()
    }

  } catch {
    // Unsupported or refused: nothing to show, nothing to do.
  }

}
