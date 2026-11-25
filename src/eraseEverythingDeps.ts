import { getActiveAccount } from './auth'
import {
  deleteCloudFile,
  listAppFolderFileNames,
  readCloudSyncDocument,
  writeCloudSyncDocument,
} from './cloudStorage'
import {
  pullCloudSnapshot,
  readLocalChangeCounter,
  recordCloudMatchesLocal,
} from './cloudSyncEngine'
import { hasPendingResolutionMarker } from './syncResolutionEngine'
import type { EraseDeps } from './eraseEverything'

/*
  The real wiring for eraseEverything.ts (kept apart so the guards can
  be tested with no Microsoft sign-in code loaded). Only
  EraseEverythingSection.tsx imports this.
*/

export function realEraseDeps(): EraseDeps {

  return {
    isSignedIn: () => getActiveAccount() !== null,
    hasPendingResolution: hasPendingResolutionMarker,
    syncFirst: pullCloudSnapshot,
    readCloud: readCloudSyncDocument,
    writeCloud: writeCloudSyncDocument,
    listFiles: listAppFolderFileNames,
    deleteFile: deleteCloudFile,
    recordInSync: recordCloudMatchesLocal,
    readChangeCounter: readLocalChangeCounter,
    storage: localStorage,
    now: () => new Date().toISOString(),
  }

}
