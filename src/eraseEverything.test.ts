import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_CACHE_KEY_PREFIX,
  ERASE_LOCAL_KEYS,
  buildEmptySyncDocument,
  clearLocalData,
  executeErase,
  prepareErase,
  selectFilesToDelete,
  type EraseDeps,
  type ErasePlan,
} from './eraseEverything'
import { validateCloudSyncDocument } from './cloudSync'

/*
  Every guard of the temporary "Erase everything" action: when it
  refuses, NOTHING may have been touched (no cloud write, no delete,
  no local key removed). The real Microsoft wiring is never loaded -
  every dependency is a fake.
*/

class FakeStorage {

  private map = new Map<string, string>()

  get length() {
    return this.map.size
  }

  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null
  }

  getItem(key: string) {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.map.set(key, value)
  }

  removeItem(key: string) {
    this.map.delete(key)
  }

}

type Fakes = {
  deps: EraseDeps
  storage: FakeStorage
  writeCloud: ReturnType<typeof vi.fn>
  deleteFile: ReturnType<typeof vi.fn>
  recordInSync: ReturnType<typeof vi.fn>
  syncFirst: ReturnType<typeof vi.fn>
  readCloud: ReturnType<typeof vi.fn>
  listFiles: ReturnType<typeof vi.fn>
}

const NOW = '2026-11-25T10:00:00.000Z'

function makeFakes(overrides: Partial<EraseDeps> = {}): Fakes {

  const storage = new FakeStorage()

  ERASE_LOCAL_KEYS.forEach(key => storage.setItem(key, '[]'))
  storage.setItem('toothTargetActiveTreatment', 'null')
  storage.setItem(`${ACCOUNT_CACHE_KEY_PREFIX}abc`, '{}')
  storage.setItem(`${ACCOUNT_CACHE_KEY_PREFIX}def`, '{}')
  storage.setItem('toothTargetPrivacyLock', 'on')
  storage.setItem('toothTargetCloudSyncETag', 'old')

  const syncFirst = vi.fn(async () => ({ status: 'synced' as const }))
  const readCloud = vi.fn(async () => ({
    status: 'found' as const,
    eTag: 'etag-1',
    document: buildEmptySyncDocument('2026-01-01T00:00:00.000Z'),
  }))
  const listFiles = vi.fn(async () => [
    'toothtarget-sync.json',
    'toothtarget-backup-A-2026-11-24.json',
    'toothtarget-backup-B-2026-11-20.json',
    'unrelated.docx',
  ])
  const writeCloud = vi.fn(async () => ({
    status: 'written' as const,
    eTag: 'etag-2',
  }))
  const deleteFile = vi.fn(async () => {})
  const recordInSync = vi.fn()

  const deps: EraseDeps = {
    isSignedIn: () => true,
    hasPendingResolution: () => false,
    syncFirst,
    readCloud,
    writeCloud,
    listFiles,
    deleteFile,
    recordInSync,
    readChangeCounter: () => 7,
    storage,
    now: () => NOW,
    ...overrides,
  }

  return {
    deps,
    storage,
    writeCloud,
    deleteFile,
    recordInSync,
    syncFirst,
    readCloud,
    listFiles,
  }

}

function expectNothingTouched(fakes: Fakes) {

  expect(fakes.writeCloud).not.toHaveBeenCalled()
  expect(fakes.deleteFile).not.toHaveBeenCalled()
  expect(fakes.recordInSync).not.toHaveBeenCalled()
  expect(fakes.storage.getItem('toothTargetPatients')).toBe('[]')
  expect(fakes.storage.getItem(`${ACCOUNT_CACHE_KEY_PREFIX}abc`)).toBe('{}')

}

let plan: ErasePlan

beforeEach(() => {
  plan = {
    eTag: 'etag-1',
    filesToDelete: ['toothtarget-backup-A-2026-11-24.json'],
  }
})

describe('prepareErase guards (nothing is ever touched)', () => {

  it.each(['', 'erase', 'Erase', 'ERASE ', ' ERASE', 'ERAS', 'yes'])(
    'refuses when the typed text is %j',
    async typed => {

      const fakes = makeFakes()

      const result = await prepareErase(typed, fakes.deps)

      expect(result).toMatchObject({ status: 'refused', reason: 'wrong-text' })
      expect(fakes.syncFirst).not.toHaveBeenCalled()
      expectNothingTouched(fakes)

    }
  )

  it('refuses when signed out, before syncing', async () => {

    const fakes = makeFakes({ isSignedIn: () => false })

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'signed-out' })
    expect(fakes.syncFirst).not.toHaveBeenCalled()
    expectNothingTouched(fakes)

  })

  it('refuses while a sync conflict is waiting to be resolved', async () => {

    const fakes = makeFakes({ hasPendingResolution: () => true })

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'resolution-pending',
    })
    expect(fakes.syncFirst).not.toHaveBeenCalled()
    expectNothingTouched(fakes)

  })

  it('refuses when the sync reports a conflict (diverged)', async () => {

    const fakes = makeFakes()
    fakes.syncFirst.mockResolvedValue({ status: 'diverged', detail: 'x' })

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'conflict' })
    expect(fakes.listFiles).not.toHaveBeenCalled()
    expectNothingTouched(fakes)

  })

  it.each([
    { status: 'auth-failed' },
    { status: 'network-unreachable', detail: 'offline' },
    { status: 'graph-error', detail: '500' },
    { status: 'validation-failed', detail: 'bad' },
    { status: 'cloud-invalid', detail: 'bad' },
    { status: 'cloud-committed-locally-pending', detail: 'x' },
  ])('refuses when the sync ends as $status', async syncResult => {

    const fakes = makeFakes()
    fakes.syncFirst.mockResolvedValue(syncResult)

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'sync-failed' })
    expectNothingTouched(fakes)

  })

  it('refuses when the sync throws', async () => {

    const fakes = makeFakes()
    fakes.syncFirst.mockRejectedValue(new Error('boom'))

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'sync-failed' })
    expectNothingTouched(fakes)

  })

  it('refuses while a treatment is running on this device', async () => {

    const fakes = makeFakes()
    fakes.storage.setItem('toothTargetActiveTreatment', '{"id":"x"}')

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'active-treatment',
    })
    expect(fakes.syncFirst).not.toHaveBeenCalled()

  })

  it('refuses when the sync file cannot be read or is invalid', async () => {

    const fakes = makeFakes()
    fakes.readCloud.mockResolvedValue({
      status: 'invalid-document',
      detail: 'bad',
    })

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'cloud-read-failed',
    })
    expectNothingTouched(fakes)

  })

  it('refuses when the folder cannot be listed', async () => {

    const fakes = makeFakes()
    fakes.listFiles.mockRejectedValue(new Error('no'))

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'list-failed' })
    expectNothingTouched(fakes)

  })

})

describe('prepareErase when every guard passes', () => {

  it('only lists - it changes nothing - and never includes the sync file', async () => {

    const fakes = makeFakes()

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toEqual({
      status: 'ready',
      plan: {
        eTag: 'etag-1',
        filesToDelete: [
          'toothtarget-backup-A-2026-11-24.json',
          'toothtarget-backup-B-2026-11-20.json',
        ],
      },
    })

    expect(fakes.syncFirst).toHaveBeenCalledTimes(1)
    expectNothingTouched(fakes)

  })

  it('works when the cloud has no sync file yet (eTag null)', async () => {

    const fakes = makeFakes()
    fakes.readCloud.mockResolvedValue({ status: 'not-found' })

    const result = await prepareErase('ERASE', fakes.deps)

    expect(result).toMatchObject({ status: 'ready', plan: { eTag: null } })

  })

})

describe('executeErase guards (nothing is ever touched)', () => {

  it('refuses when the typed text is not ERASE', async () => {

    const fakes = makeFakes()

    const result = await executeErase('erase', plan, fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'wrong-text' })
    expectNothingTouched(fakes)

  })

  it('refuses when signed out', async () => {

    const fakes = makeFakes({ isSignedIn: () => false })

    const result = await executeErase('ERASE', plan, fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'signed-out' })
    expectNothingTouched(fakes)

  })

  it('refuses when a conflict is waiting', async () => {

    const fakes = makeFakes({ hasPendingResolution: () => true })

    const result = await executeErase('ERASE', plan, fakes.deps)

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'resolution-pending',
    })
    expectNothingTouched(fakes)

  })

  it('refuses, touching nothing, when OneDrive changed since step 1 (412)', async () => {

    const fakes = makeFakes()
    fakes.writeCloud.mockResolvedValue({ status: 'precondition-failed' })

    const result = await executeErase('ERASE', plan, fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'cloud-changed' })
    expect(fakes.deleteFile).not.toHaveBeenCalled()
    expect(fakes.recordInSync).not.toHaveBeenCalled()
    expect(fakes.storage.getItem('toothTargetPatients')).toBe('[]')
    expect(fakes.storage.getItem(`${ACCOUNT_CACHE_KEY_PREFIX}abc`)).toBe('{}')

  })

  it.each([
    { status: 'auth-failed' },
    { status: 'network-unreachable', detail: 'offline' },
    { status: 'invalid-document', detail: 'bad' },
  ])('refuses, touching nothing, when the empty write ends as $status', async writeResult => {

    const fakes = makeFakes()
    fakes.writeCloud.mockResolvedValue(writeResult)

    const result = await executeErase('ERASE', plan, fakes.deps)

    expect(result).toMatchObject({ status: 'refused', reason: 'write-failed' })
    expect(fakes.deleteFile).not.toHaveBeenCalled()
    expect(fakes.recordInSync).not.toHaveBeenCalled()
    expect(fakes.storage.getItem(`${ACCOUNT_CACHE_KEY_PREFIX}abc`)).toBe('{}')

  })

})

describe('executeErase when confirmed', () => {

  it('writes an empty, valid sync document conditional on the ETag from step 1', async () => {

    const fakes = makeFakes()

    await executeErase('ERASE', plan, fakes.deps)

    expect(fakes.writeCloud).toHaveBeenCalledTimes(1)

    const [document, eTag] = fakes.writeCloud.mock.calls[0]

    expect(eTag).toBe('etag-1')
    expect(document).toEqual(buildEmptySyncDocument(NOW))
    expect(validateCloudSyncDocument(document).valid).toBe(true)

  })

  it('never deletes the sync file; deletes exactly the planned files', async () => {

    const fakes = makeFakes()

    const result = await executeErase('ERASE', plan, fakes.deps)

    expect(fakes.deleteFile.mock.calls.map(call => call[0])).toEqual([
      'toothtarget-backup-A-2026-11-24.json',
    ])

    expect(result).toEqual({
      status: 'erased',
      deletedFiles: ['toothtarget-backup-A-2026-11-24.json'],
      failedFiles: [],
    })

  })

  it('writes the cloud first, then deletes, then clears local data', async () => {

    const order: string[] = []

    const fakes = makeFakes()

    fakes.writeCloud.mockImplementation(async () => {
      order.push('write')
      return { status: 'written', eTag: 'etag-2' }
    })

    fakes.deleteFile.mockImplementation(async () => {
      order.push('delete')
    })

    fakes.recordInSync.mockImplementation(() => {
      order.push(
        fakes.storage.getItem('toothTargetPatients') === null
          ? 'record-after-clear'
          : 'record-before-clear'
      )
    })

    await executeErase('ERASE', plan, fakes.deps)

    expect(order).toEqual(['write', 'delete', 'record-after-clear'])

  })

  it('clears every listed local key and every account cache, keeping unrelated keys', async () => {

    const fakes = makeFakes()

    await executeErase('ERASE', plan, fakes.deps)

    ERASE_LOCAL_KEYS.forEach(key => {
      expect(fakes.storage.getItem(key)).toBeNull()
    })

    expect(fakes.storage.getItem(`${ACCOUNT_CACHE_KEY_PREFIX}abc`)).toBeNull()
    expect(fakes.storage.getItem(`${ACCOUNT_CACHE_KEY_PREFIX}def`)).toBeNull()
    expect(fakes.storage.getItem('toothTargetPrivacyLock')).toBe('on')

  })

  it('records the empty cloud version as in sync, with the counter from the start', async () => {

    const fakes = makeFakes()

    await executeErase('ERASE', plan, fakes.deps)

    expect(fakes.recordInSync).toHaveBeenCalledWith(
      buildEmptySyncDocument(NOW),
      NOW,
      7,
      'etag-2'
    )

  })

  it('still clears this device when a backup file cannot be deleted, and reports it', async () => {

    const fakes = makeFakes()
    fakes.deleteFile.mockRejectedValue(new Error('locked'))

    const result = await executeErase('ERASE', plan, fakes.deps)

    expect(result).toEqual({
      status: 'erased',
      deletedFiles: [],
      failedFiles: [
        {
          fileName: 'toothtarget-backup-A-2026-11-24.json',
          detail: 'locked',
        },
      ],
    })

    expect(fakes.storage.getItem('toothTargetPatients')).toBeNull()
    expect(fakes.recordInSync).toHaveBeenCalledTimes(1)

  })

})

describe('helpers', () => {

  it('selectFilesToDelete keeps only toothtarget-* files except the sync file', () => {

    expect(
      selectFilesToDelete([
        'toothtarget-sync.json',
        'toothtarget-backup-C-2026-11-01.json',
        'ToothTarget-old.json',
        'notes.txt',
      ])
    ).toEqual(['ToothTarget-old.json', 'toothtarget-backup-C-2026-11-01.json'])

  })

  it('clearLocalData with nothing stored does not throw', () => {

    expect(() => clearLocalData(new FakeStorage())).not.toThrow()

  })

})
