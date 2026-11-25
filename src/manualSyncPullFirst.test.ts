import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  The manual "Sync now" buttons (Settings and the badge) run the
  pull-first route: startSyncNow() -> requestCloudPullIfSignedIn() ->
  the real scheduler -> the real pullCloudSnapshot(). Only the cloud
  transport and the A/B/C backup rotation are mocked, so these tests
  cover what the dentist actually gets from a tap, in each situation:
  cloud older, cloud identical, cloud newer, both changed, and failing.
*/

vi.mock('./cloudStorage', () => ({
  readCloudSyncDocument: vi.fn(),
  writeCloudSyncDocument: vi.fn(),
}))

vi.mock('./cloudBackupRotation', () => ({
  maybeRotateBackup: vi.fn(),
}))

import { CLOUD_SYNC_APP, CLOUD_SYNC_SCHEMA_VERSION, type CloudSyncDocument } from './cloudSync'
import { readCloudSyncDocument, writeCloudSyncDocument } from './cloudStorage'
import { maybeRotateBackup } from './cloudBackupRotation'
import { startSyncNow } from './badgePanelActions'
import {
  __resetCloudSyncSchedulerForTests,
  getCloudSyncStatus,
  getLastSyncOutcome,
  requestCloudPullIfSignedIn,
} from './cloudSyncScheduler'

const mockedRead = vi.mocked(readCloudSyncDocument)
const mockedWrite = vi.mocked(writeCloudSyncDocument)
const mockedRotate = vi.mocked(maybeRotateBackup)

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number { return this.store.size }
  clear(): void { this.store.clear() }
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null }
  removeItem(key: string): void { this.store.delete(key) }
  setItem(key: string, value: string): void { this.store.set(key, value) }
}

const PATIENTS = 'toothTargetPatients'

function patient(id: string) {
  return {
    id,
    patientNumber: 1,
    name: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function cloudDoc(patients: unknown[], updatedAt: string): CloudSyncDocument {
  return {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    app: CLOUD_SYNC_APP,
    updatedAt,
    patients: patients as CloudSyncDocument['patients'],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
  }
}

/*
  A device that last synced against ETag "v1", with (unsynced) or
  without edits made since.
*/
function seedDevice(localPatients: unknown[], unsynced: boolean): void {
  localStorage.setItem(PATIENTS, JSON.stringify(localPatients))
  localStorage.setItem('toothTargetSavedTreatments', '[]')
  localStorage.setItem('toothTargetTemplates', '[]')
  localStorage.setItem('toothTargetProcedures', '[]')
  localStorage.setItem('toothTargetCloudSyncETag', '"v1"')
  localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')
  localStorage.setItem('toothTargetLastSyncedChangeCounter', '5')
  localStorage.setItem('toothTargetLocalChangeCounter', unsynced ? '6' : '5')
}

async function tapSyncNow(): Promise<void> {

  expect(
    startSyncNow(getCloudSyncStatus(), { requestPull: requestCloudPullIfSignedIn })
  ).toBe('started')

  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    const status = getCloudSyncStatus()
    if (status !== 'pending' && status !== 'syncing') {
      break
    }
  }

}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage()
  mockedRead.mockReset()
  mockedWrite.mockReset()
  mockedRotate.mockReset()
  mockedRotate.mockResolvedValue(undefined as never)
  __resetCloudSyncSchedulerForTests()
})

describe('manual Sync now (pull-first)', () => {

  it('cloud identical, nothing edited here: no conflict, nothing written to the cloud, data unchanged', async () => {
    seedDevice([patient('a')], false)
    mockedRead.mockResolvedValue({
      status: 'found',
      document: cloudDoc([patient('a')], '2026-01-01T00:00:00.000Z'),
      eTag: '"v1"',
    })

    await tapSyncNow()

    expect(getCloudSyncStatus()).toBe('synced')
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(PATIENTS)!)).toEqual([patient('a')])
  })

  it('cloud newer (another device synced), nothing edited here: takes the cloud copy instead of reporting a conflict', async () => {
    seedDevice([patient('a')], false)
    mockedRead.mockResolvedValue({
      status: 'found',
      document: cloudDoc([patient('a'), patient('b')], '2026-05-01T00:00:00.000Z'),
      eTag: '"v2"',
    })

    await tapSyncNow()

    expect(getCloudSyncStatus()).toBe('synced')
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(PATIENTS)!)).toEqual([patient('a'), patient('b')])
    expect(localStorage.getItem('toothTargetCloudSyncETag')).toBe('"v2"')
  })

  it('cloud older (unchanged since last sync), edits made here: pushes them, no conflict, backup rotation still runs', async () => {
    seedDevice([patient('a'), patient('new')], true)
    mockedRead.mockResolvedValue({
      status: 'found',
      document: cloudDoc([patient('a')], '2026-01-01T00:00:00.000Z'),
      eTag: '"v1"',
    })
    mockedWrite.mockResolvedValue({ status: 'written', eTag: '"v3"' })

    await tapSyncNow()

    expect(getCloudSyncStatus()).toBe('synced')
    expect(mockedWrite).toHaveBeenCalledTimes(1)
    expect(mockedWrite.mock.calls[0][1]).toBe('"v1"')
    expect(mockedWrite.mock.calls[0][0].patients).toEqual([patient('a'), patient('new')])
    expect(mockedRotate).toHaveBeenCalled()
  })

  it('both sides really changed: shows the conflict, writes nothing anywhere, never resolves it by itself', async () => {
    seedDevice([patient('a'), patient('local-edit')], true)
    mockedRead.mockResolvedValue({
      status: 'found',
      document: cloudDoc([patient('a'), patient('cloud-edit')], '2026-05-01T00:00:00.000Z'),
      eTag: '"v2"',
    })

    await tapSyncNow()

    expect(getCloudSyncStatus()).toBe('conflict')
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(PATIENTS)!)).toEqual([patient('a'), patient('local-edit')])
    expect(localStorage.getItem('toothTargetCloudSyncETag')).toBe('"v1"')
  })

  it('tapping with nothing edited does not mark this device as changed (the cause of the false conflict)', async () => {
    seedDevice([patient('a')], false)
    mockedRead.mockResolvedValue({
      status: 'found',
      document: cloudDoc([patient('a')], '2026-01-01T00:00:00.000Z'),
      eTag: '"v1"',
    })

    await tapSyncNow()

    expect(localStorage.getItem('toothTargetLocalChangeCounter')).toBe('5')
  })

  it('sync failing (network down): reports it, keeps local data and the unsynced marker, writes nothing', async () => {
    seedDevice([patient('a'), patient('local-edit')], true)
    mockedRead.mockResolvedValue({ status: 'network-unreachable', detail: 'offline' })

    await tapSyncNow()

    expect(getCloudSyncStatus()).toBe('offline')
    expect(getLastSyncOutcome()).not.toBeNull()
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(PATIENTS)!)).toEqual([patient('a'), patient('local-edit')])
    expect(localStorage.getItem('toothTargetLocalChangeCounter')).toBe('6')
  })

})
