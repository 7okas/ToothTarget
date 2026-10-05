import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  cloudStorage.ts is mocked (its own runtime import of ./auth touches
  `window`/MSAL at module scope - same reasoning as
  cloudBackupRotation.test.ts). The mock is backed by a tiny in-memory
  "OneDrive App Folder" so uploads, listings and deletes behave like
  the real thing.
*/

const folder = new Map<string, unknown>()

const failWrites: { when: (fileName: string) => boolean } = { when: () => false }
const failDeletes: { when: (fileName: string) => boolean } = { when: () => false }
const failList = { value: false }

vi.mock('./cloudStorage', () => ({
  listAppFolderFileNames: vi.fn(async () => {
    if (failList.value) {
      throw new Error('list failed')
    }
    return [...folder.keys()]
  }),
  readCloudData: vi.fn(async (fileName: string) =>
    folder.has(fileName) ? folder.get(fileName) : null
  ),
  writeCloudData: vi.fn(async (fileName: string, data: unknown) => {
    if (failWrites.when(fileName)) {
      throw new Error(`Could not write ${fileName}`)
    }
    folder.set(fileName, JSON.parse(JSON.stringify(data)))
  }),
  deleteCloudFile: vi.fn(async (fileName: string) => {
    if (failDeletes.when(fileName)) {
      throw new Error(`Could not delete ${fileName}`)
    }
    folder.delete(fileName)
  }),
}))

import {
  LOCAL_SAFETY_COPY_KEY,
  LOCAL_SAFETY_COPY_RETENTION,
  CLOUD_SAFETY_COPY_RETENTION,
  resolutionIdFor,
  safetyCopyFileName,
  parseSafetyCopyFileName,
  capturedAtFromResolutionId,
  validateSafetyCopy,
  buildSafetyCopy,
  selectFilesToPrune,
  readLocalSafetyCopies,
  saveLocalSafetyCopy,
  saveResolutionSafetyCopies,
  listCloudSafetyCopies,
  readCloudSafetyCopy,
} from './syncResolutionSafetyCopy'

import {
  parseBackupFileName,
  groupBackupFilesBySlot,
  type BackupSlotFile,
} from './cloudBackupRotation'

import { findNewestValidBackup, checkAllBackupSlots } from './cloudCorruptionRecovery'

import { makeDocument, makePatient } from './syncResolutionTestUtils'

class MemoryStorage implements Storage {

  private map = new Map<string, string>()

  failKey: string | null = null

  get length() {
    return this.map.size
  }

  clear() {
    this.map.clear()
  }

  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.map.delete(key)
  }

  setItem(key: string, value: string) {

    if (this.failKey === key) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }

    this.map.set(key, value)

  }

}

const deviceDoc = makeDocument({
  patients: [makePatient({ id: 'dev', name: 'Device Patient' })],
})

const cloudDoc = makeDocument({
  patients: [makePatient({ id: 'cld', name: 'Cloud Patient' })],
})

function at(minute: number): string {
  return `2026-10-06T01:${String(minute).padStart(2, '0')}:00.123Z`
}

let storage: MemoryStorage

beforeEach(() => {
  folder.clear()
  failWrites.when = () => false
  failDeletes.when = () => false
  failList.value = false
  storage = new MemoryStorage()
  globalThis.localStorage = storage
})

describe('file naming', () => {

  it('round-trips an id, a side and the capture time', () => {

    const id = resolutionIdFor('2026-10-06T01:20:45.123Z')

    expect(id).toBe('2026-10-06T01-20-45-123Z')
    expect(capturedAtFromResolutionId(id)).toBe('2026-10-06T01:20:45.123Z')

    const name = safetyCopyFileName(id, 'cloud')

    expect(name).toBe('toothtarget-resolution-2026-10-06T01-20-45-123Z-cloud.json')
    expect(parseSafetyCopyFileName(name)).toEqual({
      resolutionId: id,
      side: 'cloud',
      fileName: name,
    })

  })

  it('does not parse anything else as a safety copy', () => {

    for (const name of [
      'toothtarget-sync.json',
      'toothtarget-backup-A-2026-09-24.json',
      'toothtarget-resolution-bogus-device.json',
      'toothtarget-resolution-2026-10-06T01-20-45-123Z-other.json',
      'notes.txt',
    ]) {
      expect(parseSafetyCopyFileName(name)).toBeNull()
    }

  })

})

describe('A/B/C rotation and corruption recovery ignore safety copies', () => {

  const aBackup = 'toothtarget-backup-A-2026-09-24.json'

  const safetyNames = [
    safetyCopyFileName(resolutionIdFor(at(1)), 'device'),
    safetyCopyFileName(resolutionIdFor(at(1)), 'cloud'),
  ]

  it('parseBackupFileName / groupBackupFilesBySlot never see them', () => {

    for (const name of safetyNames) {
      expect(parseBackupFileName(name)).toBeNull()
    }

    const files = [aBackup, ...safetyNames]
      .map(parseBackupFileName)
      .filter((file): file is BackupSlotFile => file !== null)

    expect(files).toHaveLength(1)

    expect(groupBackupFilesBySlot(files)).toEqual({
      A: { slot: 'A', date: '2026-09-24', fileName: aBackup },
      B: null,
      C: null,
    })

  })

  it('findNewestValidBackup and checkAllBackupSlots never read them', async () => {

    const { listAppFolderFileNames, readCloudData } = await import('./cloudStorage')

    folder.set(aBackup, {
      schemaVersion: 1,
      app: 'ToothTarget',
      exportedAt: '2026-09-24T00:00:00.000Z',
      patients: [],
      savedTreatments: [],
      customTemplates: [],
      customProcedures: [],
    })

    for (const name of safetyNames) {
      folder.set(name, { kind: 'resolution-safety-copy' })
    }

    vi.mocked(readCloudData).mockClear()

    const newest = await findNewestValidBackup()
    const slots = await checkAllBackupSlots()

    expect(newest?.file.fileName).toBe(aBackup)
    expect(slots.map(slot => slot.status)).toEqual(['valid', 'missing', 'missing'])

    const readNames = vi.mocked(readCloudData).mock.calls.map(call => call[0])

    expect(readNames.every(name => name === aBackup)).toBe(true)
    expect(vi.mocked(listAppFolderFileNames)).toHaveBeenCalled()

  })

  it('pruning only ever deletes safety-copy files, never the sync file or A/B/C backups', () => {

    const others = [
      'toothtarget-sync.json',
      aBackup,
      'toothtarget-backup-B-2026-09-20.json',
      'toothtarget-backup-C-2026-09-18.json',
    ]

    const manyResolutions = Array.from({ length: 8 }, (_, i) => [
      safetyCopyFileName(resolutionIdFor(at(i)), 'device'),
      safetyCopyFileName(resolutionIdFor(at(i)), 'cloud'),
    ]).flat()

    const doomed = selectFilesToPrune([...others, ...manyResolutions])

    expect(doomed.every(name => parseSafetyCopyFileName(name) !== null)).toBe(true)
    expect(doomed.some(name => others.includes(name))).toBe(false)

  })

})

describe('validateSafetyCopy', () => {

  it('accepts a well-formed copy and validates the wrapped document', () => {

    const copy = buildSafetyCopy('device', 'id', at(1), 'etag-1', deviceDoc)

    expect(validateSafetyCopy(JSON.parse(JSON.stringify(copy)))).toMatchObject({
      valid: true,
      copy: { side: 'device', cloudETag: 'etag-1' },
    })

  })

  it('rejects junk, wrong kind, and an invalid inner document', () => {

    expect(validateSafetyCopy(null).valid).toBe(false)
    expect(validateSafetyCopy({ kind: 'nope' }).valid).toBe(false)

    const bad = {
      ...buildSafetyCopy('cloud', 'id', at(1), null, deviceDoc),
      document: { app: 'Something Else' },
    }

    expect(validateSafetyCopy(bad).valid).toBe(false)

  })

})

describe('retention - pure selection', () => {

  it('keeps the newest N resolutions (both files of each) and prunes the rest', () => {

    const names = [3, 1, 5, 2, 4, 6, 7].flatMap(minute => [
      safetyCopyFileName(resolutionIdFor(at(minute)), 'device'),
      safetyCopyFileName(resolutionIdFor(at(minute)), 'cloud'),
    ])

    const doomed = selectFilesToPrune(names, 5)

    expect(doomed.sort()).toEqual(
      [1, 2].flatMap(minute => [
        safetyCopyFileName(resolutionIdFor(at(minute)), 'cloud'),
        safetyCopyFileName(resolutionIdFor(at(minute)), 'device'),
      ]).sort()
    )

  })

  it('nothing is pruned at or under the limit', () => {

    const names = [1, 2, 3, 4, 5].flatMap(minute => [
      safetyCopyFileName(resolutionIdFor(at(minute)), 'device'),
      safetyCopyFileName(resolutionIdFor(at(minute)), 'cloud'),
    ])

    expect(selectFilesToPrune(names)).toEqual([])
    expect(CLOUD_SAFETY_COPY_RETENTION).toBe(5)

  })

})

describe('saveResolutionSafetyCopies - both sides saved', () => {

  it('writes device + cloud files to OneDrive and a combined local entry', async () => {

    const result = await saveResolutionSafetyCopies({
      device: deviceDoc,
      cloud: cloudDoc,
      cloudETag: 'etag-9',
      nowIso: at(1),
    })

    expect(result).toEqual({
      ok: true,
      resolutionId: resolutionIdFor(at(1)),
      localSaved: true,
    })

    const id = resolutionIdFor(at(1))

    const deviceCopy = validateSafetyCopy(folder.get(safetyCopyFileName(id, 'device')))
    const cloudCopy = validateSafetyCopy(folder.get(safetyCopyFileName(id, 'cloud')))

    expect(deviceCopy.valid && deviceCopy.copy.document.patients[0].id).toBe('dev')
    expect(cloudCopy.valid && cloudCopy.copy.document.patients[0].id).toBe('cld')
    expect(cloudCopy.valid && cloudCopy.copy.cloudETag).toBe('etag-9')

    const local = readLocalSafetyCopies()

    expect(local).toHaveLength(1)
    expect(local[0].device.patients[0].id).toBe('dev')
    expect(local[0].cloud.patients[0].id).toBe('cld')

  })

  it('never writes the live sync file or an A/B/C backup', async () => {

    await saveResolutionSafetyCopies({
      device: deviceDoc,
      cloud: cloudDoc,
      cloudETag: null,
      nowIso: at(1),
    })

    expect([...folder.keys()].every(name => parseSafetyCopyFileName(name) !== null)).toBe(true)

  })

})

describe('saveResolutionSafetyCopies - failure rules', () => {

  it('blocks when the OneDrive copy of the DEVICE side fails; nothing is left behind', async () => {

    failWrites.when = name => name.endsWith('-device.json')

    const result = await saveResolutionSafetyCopies({
      device: deviceDoc,
      cloud: cloudDoc,
      cloudETag: null,
      nowIso: at(1),
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('onedrive-copy-failed')
    expect(folder.size).toBe(0)
    expect(readLocalSafetyCopies()).toEqual([])

  })

  it('blocks when the OneDrive copy of the CLOUD side fails, and removes the device file it had uploaded', async () => {

    failWrites.when = name => name.endsWith('-cloud.json')

    const result = await saveResolutionSafetyCopies({
      device: deviceDoc,
      cloud: cloudDoc,
      cloudETag: null,
      nowIso: at(1),
    })

    expect(result.ok).toBe(false)
    expect(folder.size).toBe(0)
    expect(readLocalSafetyCopies()).toEqual([])

  })

  it('a failed cleanup of the half-uploaded file does not turn the block into a crash', async () => {

    failWrites.when = name => name.endsWith('-cloud.json')
    failDeletes.when = () => true

    const result = await saveResolutionSafetyCopies({
      device: deviceDoc,
      cloud: cloudDoc,
      cloudETag: null,
      nowIso: at(1),
    })

    expect(result.ok).toBe(false)

  })

  it('ALLOWS the apply with a warning when both OneDrive copies upload but the local copy fails (quota)', async () => {

    storage.failKey = LOCAL_SAFETY_COPY_KEY

    const result = await saveResolutionSafetyCopies({
      device: deviceDoc,
      cloud: cloudDoc,
      cloudETag: null,
      nowIso: at(1),
    })

    expect(result.ok).toBe(true)

    if (result.ok) {
      expect(result.localSaved).toBe(false)
      expect(result.warning).toContain('could not be saved on this device')
      expect(result.warning).toContain('OneDrive copies are enough')
    }

    expect(folder.size).toBe(2)

  })

  it('a failing prune (list or delete) never fails the apply', async () => {

    failList.value = true

    const listFailed = await saveResolutionSafetyCopies({
      device: deviceDoc,
      cloud: cloudDoc,
      cloudETag: null,
      nowIso: at(1),
    })

    expect(listFailed.ok).toBe(true)

    failList.value = false
    failDeletes.when = () => true

    for (let minute = 2; minute <= 8; minute += 1) {

      const result = await saveResolutionSafetyCopies({
        device: deviceDoc,
        cloud: cloudDoc,
        cloudETag: null,
        nowIso: at(minute),
      })

      expect(result.ok).toBe(true)

    }

  })

})

describe('saveResolutionSafetyCopies - retention', () => {

  it('keeps the last 5 resolutions on OneDrive (10 files), newest survive', async () => {

    for (let minute = 1; minute <= 7; minute += 1) {

      await saveResolutionSafetyCopies({
        device: deviceDoc,
        cloud: cloudDoc,
        cloudETag: null,
        nowIso: at(minute),
      })

    }

    expect(folder.size).toBe(10)

    const listing = await listCloudSafetyCopies()

    expect(listing.map(item => item.resolutionId)).toEqual(
      [7, 6, 5, 4, 3].map(minute => resolutionIdFor(at(minute)))
    )

  })

  it('keeps the last 2 resolutions on this device', async () => {

    for (let minute = 1; minute <= 4; minute += 1) {

      await saveResolutionSafetyCopies({
        device: deviceDoc,
        cloud: cloudDoc,
        cloudETag: null,
        nowIso: at(minute),
      })

    }

    expect(LOCAL_SAFETY_COPY_RETENTION).toBe(2)
    expect(readLocalSafetyCopies().map(entry => entry.resolutionId)).toEqual([
      resolutionIdFor(at(4)),
      resolutionIdFor(at(3)),
    ])

  })

  it('pruning never touches the sync file or the A/B/C backups in the folder', async () => {

    folder.set('toothtarget-sync.json', { keep: true })
    folder.set('toothtarget-backup-A-2026-09-24.json', { keep: true })

    for (let minute = 1; minute <= 7; minute += 1) {

      await saveResolutionSafetyCopies({
        device: deviceDoc,
        cloud: cloudDoc,
        cloudETag: null,
        nowIso: at(minute),
      })

    }

    expect(folder.has('toothtarget-sync.json')).toBe(true)
    expect(folder.has('toothtarget-backup-A-2026-09-24.json')).toBe(true)

  })

})

describe('local copies - robustness', () => {

  it('a corrupt local value reads as empty, never throws', () => {

    storage.setItem(LOCAL_SAFETY_COPY_KEY, '{not json')
    expect(readLocalSafetyCopies()).toEqual([])

    storage.setItem(LOCAL_SAFETY_COPY_KEY, JSON.stringify([{ nope: 1 }]))
    expect(readLocalSafetyCopies()).toEqual([])

  })

  it('a rejected local write leaves the previous entries untouched', () => {

    saveLocalSafetyCopy({
      resolutionId: resolutionIdFor(at(1)),
      capturedAt: at(1),
      cloudETag: null,
      device: deviceDoc,
      cloud: cloudDoc,
    })

    storage.failKey = LOCAL_SAFETY_COPY_KEY

    expect(() =>
      saveLocalSafetyCopy({
        resolutionId: resolutionIdFor(at(2)),
        capturedAt: at(2),
        cloudETag: null,
        device: deviceDoc,
        cloud: cloudDoc,
      })
    ).toThrow()

    storage.failKey = null

    expect(readLocalSafetyCopies().map(entry => entry.resolutionId)).toEqual([
      resolutionIdFor(at(1)),
    ])

  })

})

describe('reading copies back from OneDrive', () => {

  it('lists newest first, pairing device and cloud files per resolution', async () => {

    await saveResolutionSafetyCopies({
      device: deviceDoc, cloud: cloudDoc, cloudETag: null, nowIso: at(1),
    })

    await saveResolutionSafetyCopies({
      device: deviceDoc, cloud: cloudDoc, cloudETag: null, nowIso: at(2),
    })

    folder.set('toothtarget-sync.json', {})

    const listing = await listCloudSafetyCopies()

    expect(listing).toHaveLength(2)
    expect(listing[0]).toEqual({
      resolutionId: resolutionIdFor(at(2)),
      capturedAt: at(2),
      deviceFile: safetyCopyFileName(resolutionIdFor(at(2)), 'device'),
      cloudFile: safetyCopyFileName(resolutionIdFor(at(2)), 'cloud'),
    })

  })

  it('reads and validates one copy; reports missing and invalid files', async () => {

    await saveResolutionSafetyCopies({
      device: deviceDoc, cloud: cloudDoc, cloudETag: null, nowIso: at(1),
    })

    const id = resolutionIdFor(at(1))

    const ok = await readCloudSafetyCopy(safetyCopyFileName(id, 'device'))

    expect(ok.status).toBe('ok')

    expect((await readCloudSafetyCopy('toothtarget-resolution-nope.json')).status).toBe('missing')

    folder.set('bad.json', { kind: 'resolution-safety-copy' })

    expect((await readCloudSafetyCopy('bad.json')).status).toBe('invalid')

  })

})
