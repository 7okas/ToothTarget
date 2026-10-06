import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  PHASE 5 - SINGLE-WRITER SYNC MODEL

  A dedicated test file for everything Phase 5 adds to
  cloudSyncEngine.ts, kept separate from cloudSyncEngine.test.ts (which
  still covers the OLD per-record-merge syncCloudNow()/
  reconcileSyncedAccount() behavior until Phase 7 removes it) so this
  phase's own coverage doesn't get mixed into a file that's about to be
  substantially rewritten in a later step of this same phase.

  Same cloudStorage.ts mock + in-memory Storage pattern
  cloudSyncEngine.test.ts already uses, for the same reason (see that
  file's own header comment).
*/

vi.mock('./cloudStorage', () => ({
  readCloudSyncDocument: vi.fn(),
  writeCloudSyncDocument: vi.fn(),
}))

import type { Patient, SavedTreatment } from './App'
import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  type CloudSyncDocument,
} from './cloudSync'
import {
  readCloudSyncDocument,
  writeCloudSyncDocument,
} from './cloudStorage'
import {
  markLocalDataDirty,
  isLocalDataDirty,
  writeLastSyncedChangeCounter,
  reconcileSyncedAccount,
  pushLocalSnapshot,
  pullCloudSnapshot,
} from './cloudSyncEngine'

const mockedRead = vi.mocked(readCloudSyncDocument)
const mockedWrite = vi.mocked(writeCloudSyncDocument)

class MemoryStorage implements Storage {

  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage()
  mockedRead.mockReset()
  mockedWrite.mockReset()
})

function seed(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'patient-1',
    patientNumber: 1,
    name: 'Jane Doe',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSavedTreatment(
  overrides: Partial<SavedTreatment> = {}
): SavedTreatment {
  return {
    id: 'treatment-1',
    patientName: 'Jane Doe',
    patientId: 'patient-1',
    toothId: '16',
    procedureName: 'RCT',
    procedureId: 'rct',
    templateName: 'Molar Root Canal',
    templateId: 'rct-molar',
    phases: [{ name: 'Access', duration: 480 }],
    date: '2026-01-01T00:00:00.000Z',
    completed: true,
    phaseTimes: [480],
    actualTimes: [500],
    phaseRecords: [
      {
        id: 'phase-1',
        name: 'Access',
        expectedDuration: 480,
        actualDuration: 500,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:08:20.000Z',
        status: 'completed',
        skipped: false,
        pausedWhileActive: false,
      },
    ],
    totalExpectedDuration: 480,
    totalActualDuration: 500,
    totalOvertimeDuration: 20,
    events: [],
    tags: [],
    chairEnteredAt: null,
    chairLeftAt: null,
    currentPhaseIndex: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:08:20.000Z',
    updatedAt: '2026-01-01T00:08:20.000Z',
    ...overrides,
  }
}

function makeCloudDocument(
  overrides: Partial<CloudSyncDocument> = {}
): CloudSyncDocument {
  return {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    app: CLOUD_SYNC_APP,
    updatedAt: '2026-01-01T00:00:00.000Z',
    patients: [],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
    ...overrides,
  }
}

function seedLocalSynchronizedData(overrides: {
  patients?: Patient[]
  savedTreatments?: SavedTreatment[]
}): void {
  seed('toothTargetPatients', overrides.patients ?? [])
  seed('toothTargetSavedTreatments', overrides.savedTreatments ?? [])
  seed('toothTargetTemplates', [])
  seed('toothTargetProcedures', [])
  seed('toothTargetDeletionTombstones', [])
}

describe('isLocalDataDirty - missing-flag default (Amendment 1)', () => {

  it('never-synced device with existing patients is treated as dirty', () => {

    seed('toothTargetPatients', [{ id: 'p1' }])

    expect(isLocalDataDirty()).toBe(true)

  })

  it('never-synced device with existing saved treatments (no patients) is treated as dirty', () => {

    seed('toothTargetSavedTreatments', [{ id: 't1' }])

    expect(isLocalDataDirty()).toBe(true)

  })

  it('never-synced device with NO patients and NO saved treatments is treated as clean', () => {

    expect(isLocalDataDirty()).toBe(false)

  })

})

describe('markLocalDataDirty / isLocalDataDirty - counter-based tracking (Amendment 2)', () => {

  it('marking dirty on a freshly-synced (lastSynced recorded) device makes it dirty', () => {

    localStorage.setItem('toothTargetLocalChangeCounter', '5')
    localStorage.setItem('toothTargetLastSyncedChangeCounter', '5')

    expect(isLocalDataDirty()).toBe(false)

    markLocalDataDirty()

    expect(isLocalDataDirty()).toBe(true)

  })

  it('multiple markLocalDataDirty() calls still compare correctly against the recorded lastSynced value', () => {

    localStorage.setItem('toothTargetLocalChangeCounter', '0')
    localStorage.setItem('toothTargetLastSyncedChangeCounter', '0')

    markLocalDataDirty()
    markLocalDataDirty()
    markLocalDataDirty()

    expect(localStorage.getItem('toothTargetLocalChangeCounter')).toBe('3')
    expect(isLocalDataDirty()).toBe(true)

  })

  it('writeLastSyncedChangeCounter() records the counter value passed to it, not the live counter', () => {

    markLocalDataDirty() // counter -> 1
    markLocalDataDirty() // counter -> 2

    const counterAtStart = 1 // simulates a push that captured the counter before the second edit landed

    writeLastSyncedChangeCounter(counterAtStart)

    // Still dirty: the live counter (2) disagrees with the recorded "as of" value (1).
    expect(isLocalDataDirty()).toBe(true)

    writeLastSyncedChangeCounter(2)

    expect(isLocalDataDirty()).toBe(false)

  })

})

describe('reconcileSyncedAccount - carries the new change-tracking fields per account (Amendment 2 + account isolation)', () => {

  it('round-trips localChangeCounter/lastSyncedChangeCounter through a switch away and back', () => {

    seed('toothTargetPatients', [{ id: 'a' }])

    reconcileSyncedAccount('account-1')

    markLocalDataDirty() // counter -> 1
    markLocalDataDirty() // counter -> 2
    writeLastSyncedChangeCounter(2) // account-1 is clean as of counter 2

    reconcileSyncedAccount('account-2') // switches away - account-1's state is cached

    expect(isLocalDataDirty()).toBe(false) // fresh, never-seen, empty account-2

    reconcileSyncedAccount('account-1') // switches back

    expect(localStorage.getItem('toothTargetLocalChangeCounter')).toBe('2')
    expect(localStorage.getItem('toothTargetLastSyncedChangeCounter')).toBe('2')
    expect(isLocalDataDirty()).toBe(false)

  })

  it('switching to a never-seen-before account resets both keys, not just the synced collections', () => {

    seed('toothTargetPatients', [{ id: 'a' }])

    reconcileSyncedAccount('account-1')

    markLocalDataDirty()
    writeLastSyncedChangeCounter(0) // account-1 still dirty (counter 1 != lastSynced 0)

    reconcileSyncedAccount('account-2')

    expect(localStorage.getItem('toothTargetLocalChangeCounter')).toBeNull()
    expect(localStorage.getItem('toothTargetLastSyncedChangeCounter')).toBeNull()

    // account-2 has no patients/treatments either - correctly clean, not
    // incorrectly inheriting account-1's dirty state.
    expect(isLocalDataDirty()).toBe(false)

  })

})

describe('pushLocalSnapshot - first push (cloud absent)', () => {

  it('writes with expectedETag null, stamps a fresh updatedAt, never writes deletionTombstones, and records success locally', async () => {

    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'a' })],
      savedTreatments: [makeSavedTreatment()],
    })
    seed('toothTargetDeletionTombstones', [
      { id: 'tomb-1', entityType: 'patient', entityId: 'x', deletedAt: '2026-01-01T00:00:00.000Z' },
    ])
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({ status: 'not-found' })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e1"' })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('synced')

    expect(mockedWrite).toHaveBeenCalledTimes(1)
    const [writtenDocument, expectedETag] = mockedWrite.mock.calls[0]
    expect(expectedETag).toBeNull()
    expect('deletionTombstones' in writtenDocument).toBe(false)
    expect(writtenDocument.patients).toEqual([makePatient({ id: 'a' })])
    expect(writtenDocument.savedTreatments).toEqual([makeSavedTreatment()])

    expect(localStorage.getItem('toothTargetCloudSyncUpdatedAt')).toBe(writtenDocument.updatedAt)
    expect(isLocalDataDirty()).toBe(false)
    expect(localStorage.getItem('toothTargetDeviceLastSyncAt')).not.toBeNull()

  })

})

describe('pushLocalSnapshot - normal push (cloud found, unchanged since last known)', () => {

  it('writes using the freshly-read ETag when the cloud updatedAt matches what this device last knew', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-02-01T00:00:00.000Z')
    localStorage.setItem('toothTargetCloudSyncETag', '"current-etag"')
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-02-01T00:00:00.000Z' }),
      eTag: '"current-etag"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('synced')

    const [, expectedETag] = mockedWrite.mock.calls[0]
    expect(expectedETag).toBe('"current-etag"')

  })

})

describe('hasCloudChangedSinceKnown - old-system migration bridge', () => {

  it('(1) old-system device (updatedAt present, ETag/counters absent) with a matching cloud updatedAt: NOT diverged, pushes, and records a real ETag', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    // toothTargetCloudSyncETag, toothTargetLocalChangeCounter, and
    // toothTargetLastSyncedChangeCounter are all deliberately absent -
    // exactly how a device last synced under the OLD engine looks the
    // first time it runs this code.
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-01-01T00:00:00.000Z' }),
      eTag: '"bridge-etag"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"new-etag"' })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('synced')
    expect(mockedWrite).toHaveBeenCalledTimes(1)
    // The freshly-read ETag was used as the conditional write's
    // expectedETag - the bridge only decided "unchanged", it never
    // invented an ETag to write with.
    expect(mockedWrite.mock.calls[0][1]).toBe('"bridge-etag"')
    expect(localStorage.getItem('toothTargetCloudSyncETag')).toBe('"new-etag"')

  })

  it('(2) same old-system device, but the cloud updatedAt differs: diverges, writes nothing', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-02-01T00:00:00.000Z' }),
      eTag: '"someone-elses-write"',
    })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(localStorage.getItem('toothTargetCloudSyncETag')).toBeNull()

  })

  it('(3) after the bridge is used once, a later push compares the real ETag, not the bridge, even when updatedAt would coincidentally still match', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-01-01T00:00:00.000Z' }),
      eTag: '"bridge-etag"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"recorded-etag"' })

    const firstResult = await pushLocalSnapshot()

    expect(firstResult.status).toBe('synced')
    expect(localStorage.getItem('toothTargetCloudSyncETag')).toBe('"recorded-etag"')

    const recordedUpdatedAt = localStorage.getItem('toothTargetCloudSyncUpdatedAt')!

    markLocalDataDirty()

    /*
      The cloud now reports the EXACT updatedAt this device itself
      just recorded - if the bridge were still being consulted (ie. if
      recording a real ETag hadn't actually retired it), this would be
      misread as "unchanged". But a genuinely different ETag is also
      present (someone else wrote in between) - proving the real ETag
      comparison, not the bridge, is what runs once an ETag exists.
    */
    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: recordedUpdatedAt }),
      eTag: '"someone-elses-write"',
    })

    const secondResult = await pushLocalSnapshot()

    expect(secondResult.status).toBe('diverged')

  })

  it('(4) a brand-new device (neither ETag nor the old updatedAt marker) still diverges when the cloud already has a document - the bridge never fires without the old marker', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    // Neither toothTargetCloudSyncUpdatedAt nor toothTargetCloudSyncETag
    // has ever been set on this device.
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-01-01T00:00:00.000Z' }),
      eTag: '"pre-existing"',
    })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).not.toHaveBeenCalled()

  })

  it('(5) the same bridge applies through pullCloudSnapshot()\'s own entry path - an old-system device with a matching cloud updatedAt is not diverged', async () => {

    /*
      Local is "dirty" by isLocalDataDirty()'s own existing (unchanged)
      fallback rule, since toothTargetLastSyncedChangeCounter is absent
      and local has real data - this test is specifically about
      hasCloudChangedSinceKnown() inside pullCloudSnapshot(), not about
      isLocalDataDirty() at all. With the cloud reported as unchanged
      (via the bridge), pull should fall through to a push rather than
      diverging - exactly the false alarm reported on a normal app open.
    */

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')
    markLocalDataDirty()

    const sharedDocument = makeCloudDocument({ updatedAt: '2026-01-01T00:00:00.000Z' })

    mockedRead
      .mockResolvedValueOnce({ status: 'found', document: sharedDocument, eTag: '"bridge-etag"' })
      .mockResolvedValueOnce({ status: 'found', document: sharedDocument, eTag: '"bridge-etag"' })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"new-etag"' })

    const result = await pullCloudSnapshot()

    expect(result.status).toBe('synced')
    expect(mockedWrite).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('toothTargetCloudSyncETag')).toBe('"new-etag"')

  })

})

describe('pushLocalSnapshot - diverged (Amendment 4 / Phase 6 hook)', () => {

  it('diverges on a DIFFERENT write that happens to share the exact same updatedAt millisecond (ETag, not updatedAt, is the real comparison)', async () => {

    /*
      Regression test for a real bug this suite's own flakiness
      surfaced: two genuinely different writes can share an identical
      updatedAt string (millisecond resolution), but the ETag the fake
      transport (and real OneDrive) hands back never collides like
      that - the divergence check must use it, or a same-millisecond
      write from elsewhere would silently be treated as "unchanged"
      and get overwritten.
    */

    const collidingTimestamp = '2026-02-01T00:00:00.000Z'

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', collidingTimestamp)
    localStorage.setItem('toothTargetCloudSyncETag', '"etag-when-last-known"')
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      // Same updatedAt millisecond as what this device last knew, but
      // a genuinely different (newer) ETag - a real other write.
      document: makeCloudDocument({ updatedAt: collidingTimestamp }),
      eTag: '"etag-after-someone-elses-write"',
    })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).not.toHaveBeenCalled()

  })

  it('diverges without writing when the cloud updatedAt differs from what this device last knew', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-02-01T00:00:00.000Z')
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-03-01T00:00:00.000Z' }),
      eTag: '"someone-elses-write"',
    })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).not.toHaveBeenCalled()

  })

  it('diverges when this device has never confirmed a cloud version but the cloud already has a document', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    // toothTargetCloudSyncUpdatedAt is deliberately absent.
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-03-01T00:00:00.000Z' }),
      eTag: '"pre-existing"',
    })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).not.toHaveBeenCalled()

  })

  it('precondition-failed, retry read still matches what this device knew: retries once and succeeds', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-02-01T00:00:00.000Z')
    localStorage.setItem('toothTargetCloudSyncETag', '"stale-etag"')
    markLocalDataDirty()

    mockedRead
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({ updatedAt: '2026-02-01T00:00:00.000Z' }),
        eTag: '"stale-etag"',
      })
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({ updatedAt: '2026-02-01T00:00:00.000Z' }),
        eTag: '"fresh-etag"',
      })

    mockedWrite
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValueOnce({ status: 'written', eTag: '"e3"' })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('synced')
    expect(mockedWrite).toHaveBeenCalledTimes(2)
    expect(mockedWrite.mock.calls[1][1]).toBe('"fresh-etag"')

  })

  it('precondition-failed, retry read shows a DIFFERENT updatedAt: diverges, no second write attempt', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-02-01T00:00:00.000Z')
    localStorage.setItem('toothTargetCloudSyncETag', '"stale-etag"')
    markLocalDataDirty()

    mockedRead
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({ updatedAt: '2026-02-01T00:00:00.000Z' }),
        eTag: '"stale-etag"',
      })
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({ updatedAt: '2026-04-01T00:00:00.000Z' }),
        eTag: '"someone-elses-write"',
      })

    mockedWrite.mockResolvedValueOnce({ status: 'precondition-failed' })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).toHaveBeenCalledTimes(1)

  })

  it('precondition-failed again on the retry write itself: diverges, no infinite loop', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-02-01T00:00:00.000Z')
    localStorage.setItem('toothTargetCloudSyncETag', '"stale-etag"')
    markLocalDataDirty()

    mockedRead
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({ updatedAt: '2026-02-01T00:00:00.000Z' }),
        eTag: '"stale-etag"',
      })
      .mockResolvedValueOnce({
        status: 'found',
        document: makeCloudDocument({ updatedAt: '2026-02-01T00:00:00.000Z' }),
        eTag: '"fresh-etag"',
      })

    mockedWrite
      .mockResolvedValueOnce({ status: 'precondition-failed' })
      .mockResolvedValueOnce({ status: 'precondition-failed' })

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).toHaveBeenCalledTimes(2)

  })

})

describe('pushLocalSnapshot - transport and corruption failures are forwarded unchanged', () => {

  it('network-unreachable on the initial read', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockResolvedValueOnce({
      status: 'network-unreachable',
      detail: 'Failed to fetch',
    })

    const result = await pushLocalSnapshot()

    expect(result).toEqual({ status: 'network-unreachable', detail: 'Failed to fetch' })
    expect(mockedWrite).not.toHaveBeenCalled()

  })

  it('cloud-invalid (corrupted remote document) carries its diagnosis through', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    const diagnosis = {
      kind: 'invalid-record' as const,
      recordType: 'patient' as const,
      recordDescription: 'Patient "Jane Doe" (id abc)',
      reason: 'is missing a name',
    }

    mockedRead.mockResolvedValueOnce({
      status: 'invalid-document',
      detail: 'bad shape',
      diagnosis,
    })

    const result = await pushLocalSnapshot()

    expect(result).toEqual({
      status: 'cloud-invalid',
      detail: 'bad shape',
      diagnosis,
    })

  })

  it('auth-failed on the write itself', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    mockedRead.mockResolvedValueOnce({ status: 'not-found' })
    mockedWrite.mockResolvedValueOnce({ status: 'auth-failed' })

    const result = await pushLocalSnapshot()

    expect(result).toEqual({ status: 'auth-failed' })

  })

})

describe('pushLocalSnapshot - local validation', () => {

  it('validation-failed when local synchronized data is malformed, before any network call', async () => {

    seed('toothTargetPatients', [{ id: 'a' /* missing required fields */ }])
    seed('toothTargetSavedTreatments', [])
    seed('toothTargetTemplates', [])
    seed('toothTargetProcedures', [])
    seed('toothTargetDeletionTombstones', [])

    const result = await pushLocalSnapshot()

    expect(result.status).toBe('validation-failed')
    expect(mockedRead).not.toHaveBeenCalled()
    expect(mockedWrite).not.toHaveBeenCalled()

  })

})

describe('pushLocalSnapshot - crash safety (local commit throws after the cloud write already succeeded)', () => {

  it('reports cloud-committed-locally-pending rather than throwing or claiming a silent "synced"', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({ status: 'not-found' })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e1"' })

    const originalSetItem = localStorage.setItem.bind(localStorage)

    localStorage.setItem = (key: string, value: string) => {
      if (key === 'toothTargetCloudSyncUpdatedAt') {
        throw new Error('quota exceeded')
      }
      originalSetItem(key, value)
    }

    try {

      const result = await pushLocalSnapshot()

      expect(result.status).toBe('cloud-committed-locally-pending')

    } finally {
      localStorage.setItem = originalSetItem
    }

  })

})

describe('pushLocalSnapshot - counter race (Amendment 2)', () => {

  it('a new local edit landing WHILE the push is in flight leaves local still dirty afterward', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })
    markLocalDataDirty() // counter -> 1

    let resolveRead!: (value: {
      status: 'not-found'
    }) => void

    mockedRead.mockImplementationOnce(
      () => new Promise(resolve => { resolveRead = resolve })
    )
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e1"' })

    const pushPromise = pushLocalSnapshot()

    // Simulate a save committed WHILE the network read is still in flight.
    markLocalDataDirty() // counter -> 2

    resolveRead({ status: 'not-found' })

    const result = await pushPromise

    expect(result.status).toBe('synced')
    // The push only accounted for the data as of counter 1 - the edit
    // that landed at counter 2 is correctly still unsynced.
    expect(isLocalDataDirty()).toBe(true)

  })

})

describe('pullCloudSnapshot - cloud absent', () => {

  it('delegates to pushLocalSnapshot() - empty local pushes an empty document', async () => {

    seedLocalSynchronizedData({})

    mockedRead
      .mockResolvedValueOnce({ status: 'not-found' }) // pull's own read
      .mockResolvedValueOnce({ status: 'not-found' }) // the delegated push's own read
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e1"' })

    const result = await pullCloudSnapshot()

    expect(result.status).toBe('synced')
    expect(mockedWrite).toHaveBeenCalledTimes(1)
    expect(mockedWrite.mock.calls[0][0].patients).toEqual([])

  })

  it('delegates to pushLocalSnapshot() - pre-existing local-only data gets pushed up (first sign-in)', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'a' })] })

    mockedRead
      .mockResolvedValueOnce({ status: 'not-found' })
      .mockResolvedValueOnce({ status: 'not-found' })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e1"' })

    const result = await pullCloudSnapshot()

    expect(result.status).toBe('synced')
    expect(mockedWrite.mock.calls[0][0].patients).toEqual([makePatient({ id: 'a' })])

  })

})

describe('pullCloudSnapshot - clean local, cloud found: adopts wholesale (Amendment 3)', () => {

  it('replaces patients/savedTreatments/custom templates/procedures with the cloud snapshot, drops the retired tombstone key, and writes a pre-adopt safety copy of the OLD local data', async () => {

    seedLocalSynchronizedData({
      patients: [makePatient({ id: 'old-local-patient' })],
      savedTreatments: [],
    })
    seed('toothTargetTemplates', [
      { id: 'general', name: 'General', isCustom: false, phases: [], specializationId: 'general', procedureKey: 'general', typeId: 'general', updatedAt: '2026-01-01T00:00:00.000Z' },
    ])
    seed('toothTargetDeletionTombstones', [
      { id: 'tomb-1', entityType: 'patient', entityId: 'x', deletedAt: '2026-01-01T00:00:00.000Z' },
    ])
    // Never synced before, but local has nothing dirty of its own -
    // seeded explicitly as clean via a matching counter pair, since
    // this device DOES have patients (amendment 1 would otherwise treat
    // a never-synced device with data as dirty).
    localStorage.setItem('toothTargetLocalChangeCounter', '0')
    localStorage.setItem('toothTargetLastSyncedChangeCounter', '0')
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')

    const cloudDocument = makeCloudDocument({
      updatedAt: '2026-01-01T00:00:00.000Z',
      patients: [makePatient({ id: 'cloud-patient' })],
      customTemplates: [
        { id: 'custom-t', name: 'Custom', isCustom: true, phases: [], specializationId: 'general', procedureKey: 'general', typeId: 'general', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    })

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: cloudDocument,
      eTag: '"cloud-etag"',
    })

    const result = await pullCloudSnapshot()

    expect(result.status).toBe('synced')
    expect(mockedWrite).not.toHaveBeenCalled()

    expect(JSON.parse(localStorage.getItem('toothTargetPatients')!)).toEqual(
      [makePatient({ id: 'cloud-patient' })]
    )

    const templates = JSON.parse(localStorage.getItem('toothTargetTemplates')!)
    expect(templates.map((t: { id: string }) => t.id).sort()).toEqual(['custom-t', 'general'])

    // The retired tombstone key is dropped on adopt.
    expect(localStorage.getItem('toothTargetDeletionTombstones')).toBeNull()

    // The pre-adopt safety copy holds what local had BEFORE this overwrite.
    const safetyCopy = JSON.parse(localStorage.getItem('toothTargetPreAdoptSafetyCopy')!)
    expect(safetyCopy.patients).toEqual([makePatient({ id: 'old-local-patient' })])

    expect(localStorage.getItem('toothTargetCloudSyncUpdatedAt')).toBe('2026-01-01T00:00:00.000Z')
    expect(isLocalDataDirty()).toBe(false)

  })

})

describe('pullCloudSnapshot - crash safety (adoption throws partway through)', () => {

  it('reports cloud-committed-locally-pending rather than throwing', async () => {

    seedLocalSynchronizedData({})
    localStorage.setItem('toothTargetLocalChangeCounter', '0')
    localStorage.setItem('toothTargetLastSyncedChangeCounter', '0')

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ patients: [makePatient({ id: 'cloud-patient' })] }),
      eTag: '"e1"',
    })

    const originalSetItem = localStorage.setItem.bind(localStorage)

    localStorage.setItem = (key: string, value: string) => {
      if (key === 'toothTargetPatients') {
        throw new Error('quota exceeded')
      }
      originalSetItem(key, value)
    }

    try {

      const result = await pullCloudSnapshot()

      expect(result.status).toBe('cloud-committed-locally-pending')

    } finally {
      localStorage.setItem = originalSetItem
    }

  })

})

describe('pullCloudSnapshot - dirty local, cloud unchanged: pushes instead of overwriting', () => {

  it('flushes local changes up rather than discarding them (offline edits, flushed on reopen)', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'local-edit' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')
    localStorage.setItem('toothTargetCloudSyncETag', '"e1"')
    localStorage.setItem('toothTargetLocalChangeCounter', '0')
    localStorage.setItem('toothTargetLastSyncedChangeCounter', '0')
    markLocalDataDirty() // a real local edit since the last sync

    const unchangedCloudDocument = makeCloudDocument({
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    mockedRead
      .mockResolvedValueOnce({ status: 'found', document: unchangedCloudDocument, eTag: '"e1"' })
      .mockResolvedValueOnce({ status: 'found', document: unchangedCloudDocument, eTag: '"e1"' })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    const result = await pullCloudSnapshot()

    expect(result.status).toBe('synced')
    expect(mockedWrite).toHaveBeenCalledTimes(1)
    expect(mockedWrite.mock.calls[0][0].patients).toEqual([makePatient({ id: 'local-edit' })])

    // Local was NEVER overwritten - still the edit, not the (identical,
    // in this case) cloud document.
    expect(JSON.parse(localStorage.getItem('toothTargetPatients')!)).toEqual(
      [makePatient({ id: 'local-edit' })]
    )

  })

})

describe('pullCloudSnapshot - diverged (Amendment 4 / Phase 6 hook)', () => {

  it('both sides changed: diverges, writes nothing locally or to the cloud', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'local-edit' })] })
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')
    localStorage.setItem('toothTargetLocalChangeCounter', '0')
    localStorage.setItem('toothTargetLastSyncedChangeCounter', '0')
    markLocalDataDirty()

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-05-01T00:00:00.000Z' }),
      eTag: '"someone-elses-write"',
    })

    const result = await pullCloudSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('toothTargetPatients')!)).toEqual(
      [makePatient({ id: 'local-edit' })]
    )

  })

  it('first sign-in with pre-existing local AND pre-existing cloud data (two independent histories): diverges', async () => {

    seedLocalSynchronizedData({ patients: [makePatient({ id: 'local-only' })] })
    // toothTargetCloudSyncUpdatedAt deliberately absent - never synced before.

    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({
        updatedAt: '2026-05-01T00:00:00.000Z',
        patients: [makePatient({ id: 'cloud-only' })],
      }),
      eTag: '"pre-existing"',
    })

    const result = await pullCloudSnapshot()

    expect(result.status).toBe('diverged')
    expect(mockedWrite).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('toothTargetPatients')!)).toEqual(
      [makePatient({ id: 'local-only' })]
    )

  })

})

describe('pullCloudSnapshot - race guard (Amendment 2, pull side)', () => {

  it('a local edit landing WHILE the cloud read is in flight aborts adoption and pushes instead', async () => {

    seedLocalSynchronizedData({})
    localStorage.setItem('toothTargetCloudSyncUpdatedAt', '2026-01-01T00:00:00.000Z')
    localStorage.setItem('toothTargetCloudSyncETag', '"e1"')
    localStorage.setItem('toothTargetLocalChangeCounter', '0')
    localStorage.setItem('toothTargetLastSyncedChangeCounter', '0')
    // Clean at the moment the pull starts.
    expect(isLocalDataDirty()).toBe(false)

    let resolveRead!: (value: {
      status: 'found'
      document: CloudSyncDocument
      eTag: string
    }) => void

    mockedRead.mockImplementationOnce(
      () => new Promise(resolve => { resolveRead = resolve })
    )

    const pullPromise = pullCloudSnapshot()

    // A save commits WHILE the cloud read is still in flight.
    seed('toothTargetPatients', [makePatient({ id: 'new-edit' })])
    markLocalDataDirty()

    resolveRead({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-01-01T00:00:00.000Z' }),
      eTag: '"e1"',
    })

    // The push this falls through to will itself re-read the cloud.
    mockedRead.mockResolvedValueOnce({
      status: 'found',
      document: makeCloudDocument({ updatedAt: '2026-01-01T00:00:00.000Z' }),
      eTag: '"e1"',
    })
    mockedWrite.mockResolvedValueOnce({ status: 'written', eTag: '"e2"' })

    const result = await pullPromise

    expect(result.status).toBe('synced')
    expect(mockedWrite).toHaveBeenCalledTimes(1)
    // The edit survived - it was pushed, never overwritten by an adoption.
    expect(mockedWrite.mock.calls[0][0].patients).toEqual([makePatient({ id: 'new-edit' })])
    expect(JSON.parse(localStorage.getItem('toothTargetPatients')!)).toEqual(
      [makePatient({ id: 'new-edit' })]
    )

  })

})

describe('pullCloudSnapshot - transport and corruption failures are forwarded unchanged', () => {

  it('graph-error', async () => {

    seedLocalSynchronizedData({})

    mockedRead.mockResolvedValueOnce({ status: 'graph-error', detail: '503' })

    const result = await pullCloudSnapshot()

    expect(result).toEqual({ status: 'graph-error', detail: '503' })
    expect(mockedWrite).not.toHaveBeenCalled()

  })

  it('malformed-json carries its diagnosis through as cloud-invalid', async () => {

    seedLocalSynchronizedData({})

    const diagnosis = { kind: 'unreadable' as const, reason: 'not valid json' }

    mockedRead.mockResolvedValueOnce({
      status: 'malformed-json',
      detail: 'not valid json',
      diagnosis,
    })

    const result = await pullCloudSnapshot()

    expect(result).toEqual({
      status: 'cloud-invalid',
      detail: 'not valid json',
      diagnosis,
    })

  })

})
