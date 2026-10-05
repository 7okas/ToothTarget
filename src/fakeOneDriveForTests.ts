import { vi } from 'vitest'

/*
  An in-memory stand-in for cloudStorage.ts, shared by tests that need
  TWO devices talking to ONE OneDrive (syncResolution.integration.test.ts).
  Behaves like the real thing where it matters: the sync file has a real,
  changing ETag and writes are conditional on it, and the App Folder
  holds extra files (the safety copies). Test support only - never
  imported by production code.
*/

export const oneDrive = {
  doc: null as unknown,
  etagCounter: 0,
  currentETag: null as string | null,
  syncWrites: 0,
  files: new Map<string, unknown>(),
}

export function resetOneDrive(): void {
  oneDrive.doc = null
  oneDrive.etagCounter = 0
  oneDrive.currentETag = null
  oneDrive.syncWrites = 0
  oneDrive.files = new Map()
}

export function putSyncDocument(doc: unknown): string {
  oneDrive.etagCounter += 1
  oneDrive.currentETag = `etag-${oneDrive.etagCounter}`
  oneDrive.doc = JSON.parse(JSON.stringify(doc))
  return oneDrive.currentETag
}

export const cloudStorageMock = {

  readCloudSyncDocument: vi.fn(async () =>
    oneDrive.doc === null
      ? { status: 'not-found' as const }
      : {
          status: 'found' as const,
          document: JSON.parse(JSON.stringify(oneDrive.doc)),
          eTag: oneDrive.currentETag!,
        }
  ),

  writeCloudSyncDocument: vi.fn(async (document: unknown, expected: string | null) => {

    oneDrive.syncWrites += 1

    if (expected !== oneDrive.currentETag) {
      return { status: 'precondition-failed' as const }
    }

    return { status: 'written' as const, eTag: putSyncDocument(document) }

  }),

  listAppFolderFileNames: vi.fn(async () => [...oneDrive.files.keys()]),

  readCloudData: vi.fn(async (name: string) =>
    oneDrive.files.has(name) ? oneDrive.files.get(name) : null
  ),

  writeCloudData: vi.fn(async (name: string, data: unknown) => {
    oneDrive.files.set(name, JSON.parse(JSON.stringify(data)))
  }),

  deleteCloudFile: vi.fn(async (name: string) => {
    oneDrive.files.delete(name)
  }),

}
