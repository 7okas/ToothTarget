import { beforeEach, describe, expect, it, vi } from 'vitest'

const folder = new Map<string, unknown>()

vi.mock('./cloudStorage', () => ({
  readCloudSyncDocument: vi.fn(),
  writeCloudSyncDocument: vi.fn(),
  listAppFolderFileNames: vi.fn(async () => [...folder.keys()]),
  readCloudData: vi.fn(async (name: string) => {
    if (name === 'network-down.json') {
      throw new Error('offline')
    }
    return folder.has(name) ? folder.get(name) : null
  }),
  writeCloudData: vi.fn(),
  deleteCloudFile: vi.fn(),
}))

import { isLocalDataDirty } from './cloudSyncEngine'
import {
  restoreDocumentToDevice,
  buildSafetyCopyGroups,
  loadCopyDocument,
} from './syncResolutionRestore'
import {
  LOCAL_SAFETY_COPY_KEY,
  readLocalSafetyCopies,
  buildSafetyCopy,
  safetyCopyFileName,
  resolutionIdFor,
  type LocalSafetyCopyEntry,
} from './syncResolutionSafetyCopy'
import {
  makePatient,
  makeSavedTreatment,
  makeTemplate,
  makeDocument,
} from './syncResolutionTestUtils'

class MemoryStorage implements Storage {

  private map = new Map<string, string>()

  failKeys = new Set<string>()

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

    if (this.failKeys.has(key)) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }

    this.map.set(key, value)

  }

}

let storage: MemoryStorage

beforeEach(() => {
  folder.clear()
  storage = new MemoryStorage()
  globalThis.localStorage = storage
})

const currentLocal = makeDocument({
  patients: [makePatient({ id: 'now', patientNumber: 5, name: 'Current Patient' })],
})

const copyDoc = makeDocument({
  patients: [
    makePatient({ id: 'old-1', patientNumber: 1, name: 'Old One' }),
    makePatient({ id: 'old-2', patientNumber: 2, name: 'Old Two' }),
  ],
  savedTreatments: [makeSavedTreatment({ id: 'ot', patientId: 'old-1', patientName: 'Old One' })],
  customTemplates: [makeTemplate({ id: 'tpl-old' })],
})

function seedLocal() {
  storage.setItem('toothTargetPatients', JSON.stringify(currentLocal.patients))
  storage.setItem('toothTargetSavedTreatments', JSON.stringify([]))
  storage.setItem(
    'toothTargetTemplates',
    JSON.stringify([{ ...makeTemplate({ id: 'builtin-1', isCustom: false }) }])
  )
  storage.setItem('toothTargetProcedures', JSON.stringify([]))
  storage.setItem('toothTargetLocalChangeCounter', '4')
  storage.setItem('toothTargetLastSyncedChangeCounter', '4')
  storage.setItem('toothTargetCloudSyncETag', 'etag-known')
  storage.setItem('toothTargetCloudSyncUpdatedAt', '2026-03-01T00:00:00.000Z')
  storage.setItem('toothTargetNextPatientNumber', '6')
}

describe('restoreDocumentToDevice', () => {

  it('replaces local data with the copy, keeps built-in templates, and reconciles the next patient number upward', () => {

    seedLocal()

    const result = restoreDocumentToDevice(copyDoc)

    expect(result).toEqual({ status: 'restored', patients: 2, treatments: 1 })

    expect(JSON.parse(storage.getItem('toothTargetPatients')!).map((p: { id: string }) => p.id)).toEqual(['old-1', 'old-2'])
    expect(JSON.parse(storage.getItem('toothTargetSavedTreatments')!)).toHaveLength(1)

    const templates = JSON.parse(storage.getItem('toothTargetTemplates')!) as { id: string }[]

    expect(templates.map(t => t.id).sort()).toEqual(['builtin-1', 'tpl-old'])

    // Never lowered: the device had already handed out numbers up to 5.
    expect(storage.getItem('toothTargetNextPatientNumber')).toBe('6')

  })

  it('marks local data as having unsynced changes and touches NO sync-tracking value', () => {

    seedLocal()

    expect(isLocalDataDirty()).toBe(false)

    restoreDocumentToDevice(copyDoc)

    expect(isLocalDataDirty()).toBe(true)
    expect(storage.getItem('toothTargetCloudSyncETag')).toBe('etag-known')
    expect(storage.getItem('toothTargetCloudSyncUpdatedAt')).toBe('2026-03-01T00:00:00.000Z')
    expect(storage.getItem('toothTargetLastSyncedChangeCounter')).toBe('4')

  })

  it('saves this device\'s CURRENT data first, as a before-restore copy, so a restore can be undone', () => {

    seedLocal()

    restoreDocumentToDevice(copyDoc, { now: () => '2026-06-01T00:00:00.000Z' })

    const entries = readLocalSafetyCopies()

    expect(entries).toHaveLength(1)
    expect(entries[0].reason).toBe('before-restore')
    expect(entries[0].device.patients.map(p => p.id)).toEqual(['now'])

  })

  it('is REFUSED, changing nothing, if that safety copy cannot be saved', () => {

    seedLocal()
    storage.failKeys.add(LOCAL_SAFETY_COPY_KEY)

    const result = restoreDocumentToDevice(copyDoc)

    expect(result).toMatchObject({ status: 'failed', reason: 'safety-copy-failed' })
    expect(JSON.parse(storage.getItem('toothTargetPatients')!).map((p: { id: string }) => p.id)).toEqual(['now'])
    expect(isLocalDataDirty()).toBe(false)

  })

  it('rejects a copy that is not a valid document, changing nothing', () => {

    seedLocal()

    const result = restoreDocumentToDevice({ app: 'nope' } as never)

    expect(result).toMatchObject({ status: 'failed', reason: 'invalid-copy' })
    expect(JSON.parse(storage.getItem('toothTargetPatients')!).map((p: { id: string }) => p.id)).toEqual(['now'])

  })

  it('still restores, with a warning, when the current local data is itself unreadable', () => {

    storage.setItem('toothTargetPatients', JSON.stringify([{ broken: true }]))

    const result = restoreDocumentToDevice(copyDoc)

    expect(result.status).toBe('restored')
    expect(result.status === 'restored' && result.warning).toContain('could not be read')
    expect(readLocalSafetyCopies()).toEqual([])

  })

  it('never writes to OneDrive', async () => {

    seedLocal()

    const { writeCloudSyncDocument, writeCloudData } = await import('./cloudStorage')

    restoreDocumentToDevice(copyDoc)

    expect(vi.mocked(writeCloudSyncDocument)).not.toHaveBeenCalled()
    expect(vi.mocked(writeCloudData)).not.toHaveBeenCalled()

  })

})

describe('buildSafetyCopyGroups', () => {

  const id1 = resolutionIdFor('2026-06-01T01:00:00.000Z')
  const id2 = resolutionIdFor('2026-06-02T01:00:00.000Z')
  const id3 = resolutionIdFor('2026-06-03T01:00:00.000Z')

  const localEntry = (id: string, reason?: 'before-restore'): LocalSafetyCopyEntry => ({
    resolutionId: id,
    capturedAt: '2026-06-01T01:00:00.000Z',
    cloudETag: null,
    device: currentLocal,
    cloud: copyDoc,
    ...(reason ? { reason } : {}),
  })

  it('merges local and OneDrive, newest first, one group per resolution', () => {

    const groups = buildSafetyCopyGroups(
      [localEntry(id2)],
      [
        { resolutionId: id2, capturedAt: 'x', deviceFile: safetyCopyFileName(id2, 'device'), cloudFile: safetyCopyFileName(id2, 'cloud') },
        { resolutionId: id1, capturedAt: '2026-06-01T01:00:00.000Z', deviceFile: safetyCopyFileName(id1, 'device'), cloudFile: safetyCopyFileName(id1, 'cloud') },
        { resolutionId: id3, capturedAt: '2026-06-03T01:00:00.000Z', deviceFile: safetyCopyFileName(id3, 'device'), cloudFile: null },
      ]
    )

    expect(groups.map(g => g.resolutionId)).toEqual([id3, id2, id1])
    expect(groups[1].heldOn).toEqual(['this-device', 'onedrive'])
    expect(groups[1].device?.document).toBeDefined()
    expect(groups[1].device?.fileName).toBe(safetyCopyFileName(id2, 'device'))
    expect(groups[0].heldOn).toEqual(['onedrive'])
    expect(groups[0].cloud).toBeNull()

  })

  it('a before-restore entry has only this device\'s data', () => {

    const groups = buildSafetyCopyGroups([localEntry(id1, 'before-restore')], [])

    expect(groups[0].kind).toBe('before-restore')
    expect(groups[0].device).not.toBeNull()
    expect(groups[0].cloud).toBeNull()

  })

})

describe('loadCopyDocument', () => {

  it('uses a local copy without any download', async () => {

    const { readCloudData } = await import('./cloudStorage')

    expect(await loadCopyDocument({ side: 'device', document: copyDoc })).toEqual({
      status: 'ok',
      document: copyDoc,
    })
    expect(vi.mocked(readCloudData)).not.toHaveBeenCalled()

  })

  it('downloads and validates a OneDrive copy', async () => {

    const id = resolutionIdFor('2026-06-01T01:00:00.000Z')
    const name = safetyCopyFileName(id, 'cloud')

    folder.set(name, buildSafetyCopy('cloud', id, '2026-06-01T01:00:00.000Z', null, copyDoc))

    const result = await loadCopyDocument({ side: 'cloud', fileName: name })

    expect(result.status).toBe('ok')
    expect(result.status === 'ok' && result.document.patients).toHaveLength(2)

  })

  it('reports a missing, invalid or unreachable copy in plain language', async () => {

    expect(await loadCopyDocument({ side: 'cloud', fileName: 'gone.json' })).toEqual({
      status: 'unavailable',
      detail: 'This copy is no longer on OneDrive.',
    })

    folder.set('bad.json', { kind: 'resolution-safety-copy' })

    expect(await loadCopyDocument({ side: 'cloud', fileName: 'bad.json' })).toMatchObject({
      status: 'unavailable',
      detail: "This copy on OneDrive couldn't be read.",
    })

    expect(await loadCopyDocument({ side: 'cloud', fileName: 'network-down.json' })).toMatchObject({
      status: 'unavailable',
    })

    expect(await loadCopyDocument({ side: 'cloud' })).toMatchObject({ status: 'unavailable' })

  })

})
