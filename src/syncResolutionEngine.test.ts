import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  PHASE 6 - RESOLUTION ENGINE (prepare / apply / mark-in-sync / recovery)

  cloudStorage.ts is replaced by a small in-memory fake of OneDrive that
  behaves like the real thing where it matters here: the sync file has
  a real, changing ETag and writes are conditional (If-Match -> 'precondition-failed'),
  the App Folder holds the safety-copy files, and every failure the
  plan names can be injected (network drop before the write, a write
  that LANDS but whose response is lost, another device writing at the
  worst moment, a crash right after the write).
*/

type FakeWriteResult =
  | { status: 'written'; eTag: string | null }
  | { status: 'precondition-failed' }
  | { status: 'invalid-document'; detail: string }
  | { status: 'auth-failed' }
  | { status: 'permission-denied'; detail: string }
  | { status: 'network-unreachable'; detail: string }
  | { status: 'graph-error'; detail: string }

type FakeReadResult =
  | { status: 'not-found' }
  | { status: 'found'; document: unknown; eTag: string }
  | { status: 'malformed-json'; detail: string }
  | { status: 'invalid-document'; detail: string }
  | { status: 'network-unreachable'; detail: string }

const fake = {
  doc: null as unknown,
  etagCounter: 0,
  currentETag: null as string | null,
  syncWriteCalls: 0,
  readCalls: 0,
  files: new Map<string, unknown>(),
  failFileWrites: false,
  /* Returned instead of the real read, once, when set. */
  nextReadOverride: null as FakeReadResult | null,
  /* Runs at the start of every sync read (to simulate things happening "during" a read). */
  onRead: null as (() => void) | null,
  /* Runs inside a sync write, BEFORE the precondition check (another device sneaking in). */
  beforeWrite: null as (() => void) | null,
  /* How the next sync write fails; 'lose-response' lands the write and then reports a network error. */
  nextWriteMode: 'normal' as 'normal' | 'network-before' | 'lose-response' | 'crash-after',
  /* Runs inside a sync write after it landed, before returning (an edit during the write). */
  afterWriteLanded: null as (() => void) | null,
}

function externalWrite(doc: unknown): string {
  fake.etagCounter += 1
  fake.currentETag = `etag-${fake.etagCounter}`
  fake.doc = JSON.parse(JSON.stringify(doc))
  return fake.currentETag
}

vi.mock('./cloudStorage', () => ({

  readCloudSyncDocument: vi.fn(async (): Promise<FakeReadResult> => {

    fake.readCalls += 1

    fake.onRead?.()

    if (fake.nextReadOverride) {
      const override = fake.nextReadOverride
      fake.nextReadOverride = null
      return override
    }

    if (fake.doc === null) {
      return { status: 'not-found' }
    }

    return {
      status: 'found',
      document: JSON.parse(JSON.stringify(fake.doc)),
      eTag: fake.currentETag!,
    }

  }),

  writeCloudSyncDocument: vi.fn(
    async (document: unknown, expectedETag: string | null): Promise<FakeWriteResult> => {

      fake.syncWriteCalls += 1

      if (fake.nextWriteMode === 'network-before') {
        fake.nextWriteMode = 'normal'
        return { status: 'network-unreachable', detail: 'offline' }
      }

      fake.beforeWrite?.()

      if (expectedETag !== fake.currentETag) {
        return { status: 'precondition-failed' }
      }

      const mode = fake.nextWriteMode
      fake.nextWriteMode = 'normal'

      const eTag = externalWrite(document)

      if (mode === 'lose-response') {
        return { status: 'network-unreachable', detail: 'response lost' }
      }

      fake.afterWriteLanded?.()

      if (mode === 'crash-after') {
        throw new Error('simulated crash')
      }

      return { status: 'written', eTag }

    }
  ),

  listAppFolderFileNames: vi.fn(async () => [...fake.files.keys()]),

  readCloudData: vi.fn(async (name: string) =>
    fake.files.has(name) ? fake.files.get(name) : null
  ),

  writeCloudData: vi.fn(async (name: string, data: unknown) => {
    if (fake.failFileWrites) {
      throw new Error('upload failed')
    }
    fake.files.set(name, JSON.parse(JSON.stringify(data)))
  }),

  deleteCloudFile: vi.fn(async (name: string) => {
    fake.files.delete(name)
  }),

}))

import type { CloudSyncDocument } from './cloudSync'
import {
  isLocalDataDirty,
  hasCloudChangedSinceKnown,
  pushLocalSnapshot,
  isResolutionApplying,
} from './cloudSyncEngine'
import {
  prepareResolution,
  applyResolution,
  markInSync,
  finishPendingResolution,
  hasPendingResolutionMarker,
  PENDING_RESOLUTION_KEY,
  type ResolutionSession,
} from './syncResolutionEngine'
import { recordKey, decideAllFromDevice, decideAllFromCloud, type Decisions } from './syncResolve'
import {
  LOCAL_SAFETY_COPY_KEY,
  readLocalSafetyCopies,
  parseSafetyCopyFileName,
} from './syncResolutionSafetyCopy'
import {
  makePatient,
  makeDocument,
} from './syncResolutionTestUtils'

class LoggingStorage implements Storage {

  private map = new Map<string, string>()

  writes: string[] = []

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
    this.writes.push(`remove:${key}`)
    this.map.delete(key)
  }

  setItem(key: string, value: string) {

    if (this.failKeys.has(key)) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }

    this.writes.push(`set:${key}`)
    this.map.set(key, value)

  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map)
  }

}

let storage: LoggingStorage

const T0 = '2026-03-01T00:00:00.000Z' // last sync this device knows about
const CREATED_AFTER = '2026-04-01T12:00:00.000Z'
const CREATED_BEFORE = '2026-02-01T12:00:00.000Z'

function makeNow() {

  let n = 0

  return () => `2026-06-01T00:00:${String(n++).padStart(2, '0')}.000Z`

}

function seedLocal(doc: Pick<CloudSyncDocument, 'patients' | 'savedTreatments' | 'customTemplates' | 'customProcedures'>) {
  storage.setItem('toothTargetPatients', JSON.stringify(doc.patients))
  storage.setItem('toothTargetSavedTreatments', JSON.stringify(doc.savedTreatments))
  storage.setItem('toothTargetTemplates', JSON.stringify(doc.customTemplates))
  storage.setItem('toothTargetProcedures', JSON.stringify(doc.customProcedures))
}

function readLocalPatients(): { id: string; name: string; patientNumber: number }[] {
  return JSON.parse(storage.getItem('toothTargetPatients')!)
}

const deviceDoc = makeDocument({
  patients: [
    makePatient({ id: 'shared', patientNumber: 1, name: 'Ahmed S.', createdAt: CREATED_BEFORE, updatedAt: '2026-05-01T00:00:00.000Z' }),
    makePatient({ id: 'dev-only', patientNumber: 2, name: 'Sara K.', createdAt: CREATED_AFTER, updatedAt: CREATED_AFTER }),
  ],
})

const cloudDocNow = makeDocument({
  updatedAt: '2026-03-10T00:00:00.000Z',
  patients: [
    makePatient({ id: 'shared', patientNumber: 1, name: 'Ahmed Samy', createdAt: CREATED_BEFORE, updatedAt: '2026-04-20T00:00:00.000Z' }),
    makePatient({ id: 'cloud-only', patientNumber: 3, name: 'Lina M.', createdAt: CREATED_AFTER, updatedAt: CREATED_AFTER }),
  ],
})

/*
  A diverged device: dirty local data (counter 3 vs last-synced 1), a
  known cloud version (etag-0 / T0) that the cloud has since moved
  past (now etag-N), signed in as account A.
*/
function setUpDivergence() {

  seedLocal(deviceDoc)

  storage.setItem('toothTargetLocalChangeCounter', '3')
  storage.setItem('toothTargetLastSyncedChangeCounter', '1')
  storage.setItem('toothTargetCloudSyncETag', 'etag-known')
  storage.setItem('toothTargetCloudSyncUpdatedAt', T0)
  storage.setItem('toothTargetSyncedAccountId', 'account-A')

  externalWrite(cloudDocNow)

  storage.writes = []
  fake.syncWriteCalls = 0
  fake.readCalls = 0

}

async function openSession(): Promise<ResolutionSession> {

  const prepared = await prepareResolution()

  if (prepared.status !== 'ready' && prepared.status !== 'identical') {
    throw new Error(`expected a session, got ${prepared.status}`)
  }

  return prepared.session

}

function allFromDevice(session: ResolutionSession): Decisions {
  return decideAllFromDevice(session.diff)
}

beforeEach(() => {

  storage = new LoggingStorage()
  globalThis.localStorage = storage

  fake.doc = null
  fake.etagCounter = 0
  fake.currentETag = null
  fake.syncWriteCalls = 0
  fake.readCalls = 0
  fake.files = new Map()
  fake.failFileWrites = false
  fake.nextReadOverride = null
  fake.onRead = null
  fake.beforeWrite = null
  fake.nextWriteMode = 'normal'
  fake.afterWriteLanded = null

})

/* ============================================================ */

describe('prepareResolution - READ-ONLY', () => {

  it('writes NOTHING: no cloud sync write, no safety-copy file, no localStorage write', async () => {

    setUpDivergence()

    const prepared = await prepareResolution()

    expect(prepared.status).toBe('ready')
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.writes).toEqual([])
    expect(hasPendingResolutionMarker()).toBe(false)

  })

  it('returns a fresh session: both snapshots, the ETag, the counter and the diff', async () => {

    setUpDivergence()

    const prepared = await prepareResolution()

    if (prepared.status !== 'ready') {
      throw new Error('expected ready')
    }

    expect(prepared.session.counterAtOpen).toBe(3)
    expect(prepared.session.cloudETag).toBe(fake.currentETag)
    expect(prepared.session.lastSyncAt).toBe(T0)
    expect(prepared.session.device.patients.map(p => p.id).sort()).toEqual(['dev-only', 'shared'])
    expect(prepared.session.cloud.patients.map(p => p.id).sort()).toEqual(['cloud-only', 'shared'])
    expect(prepared.session.diff.deviceOnly.map(i => i.id)).toEqual(['dev-only'])
    expect(prepared.session.diff.cloudOnly.map(i => i.id)).toEqual(['cloud-only'])
    expect(prepared.session.diff.different.map(i => i.id)).toEqual(['shared'])

  })

  it('not-diverged when the cloud is unchanged since the known ETag', async () => {

    setUpDivergence()
    storage.setItem('toothTargetCloudSyncETag', fake.currentETag!)

    expect((await prepareResolution()).status).toBe('not-diverged')

  })

  it('not-diverged when this device has nothing unsynced', async () => {

    setUpDivergence()
    storage.setItem('toothTargetLastSyncedChangeCounter', '3')

    expect((await prepareResolution()).status).toBe('not-diverged')

  })

  it('no-cloud-document when OneDrive has no sync file', async () => {

    setUpDivergence()
    fake.doc = null
    fake.currentETag = null

    expect((await prepareResolution()).status).toBe('no-cloud-document')

  })

  it('a corrupt cloud document routes to the existing cloud-invalid result (not a resolution)', async () => {

    setUpDivergence()
    fake.nextReadOverride = { status: 'invalid-document', detail: 'bad shape' }

    const prepared = await prepareResolution()

    expect(prepared).toEqual({
      status: 'failed',
      result: { status: 'cloud-invalid', detail: 'bad shape', diagnosis: undefined },
    })

  })

  it('a transport failure is reported in the existing shape', async () => {

    setUpDivergence()
    fake.nextReadOverride = { status: 'network-unreachable', detail: 'offline' }

    expect(await prepareResolution()).toEqual({
      status: 'failed',
      result: { status: 'network-unreachable', detail: 'offline' },
    })

  })

  it('invalid LOCAL data fails before the cloud is even read', async () => {

    setUpDivergence()
    storage.setItem('toothTargetPatients', JSON.stringify([{ nope: true }]))
    fake.readCalls = 0

    const prepared = await prepareResolution()

    expect(prepared.status).toBe('failed')
    expect(fake.readCalls).toBe(0)

  })

  it("'identical' when both sides hold the same data (ignoring timestamps)", async () => {

    setUpDivergence()
    externalWrite({ ...deviceDoc, updatedAt: '2026-03-12T00:00:00.000Z' })

    expect((await prepareResolution()).status).toBe('identical')

  })

})

/* ============================================================ */

describe('applyResolution - nothing is written until confirmed decisions arrive', () => {

  it('undecided rows -> blocked, ZERO writes anywhere', async () => {

    setUpDivergence()
    const session = await openSession()

    const result = await applyResolution(session, {}, { now: makeNow() })

    expect(result.status).toBe('blocked')
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.writes).toEqual([])

  })

  it('a patient-number collision blocks the apply, ZERO writes', async () => {

    setUpDivergence()
    externalWrite({
      ...cloudDocNow,
      patients: [
        makePatient({ id: 'shared', patientNumber: 1, name: 'Ahmed Samy', createdAt: CREATED_BEFORE, updatedAt: '2026-04-20T00:00:00.000Z' }),
        makePatient({ id: 'cloud-only', patientNumber: 2, name: 'Lina M.', createdAt: CREATED_AFTER, updatedAt: CREATED_AFTER }),
      ],
    })
    storage.writes = []

    const session = await openSession()

    const decisions: Decisions = {
      [recordKey('patient', 'shared')]: 'device',
      [recordKey('patient', 'dev-only')]: 'device',
      [recordKey('patient', 'cloud-only')]: 'cloud',
    }

    const result = await applyResolution(session, decisions, { now: makeNow() })

    expect(result.status).toBe('blocked')
    expect(result.status === 'blocked' && result.result.collisions).toHaveLength(1)
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.writes).toEqual([])

    // ...and a chosen number fix lets it through.
    const fixed = await applyResolution(session, decisions, {
      now: makeNow(),
      numberFixes: { 'cloud-only': 4 },
    })

    expect(fixed.status).toBe('applied')

  })

  it('a probably-deleted record coming back needs the acknowledgement; ZERO writes without it', async () => {

    setUpDivergence()
    // A device-only patient that already existed at the last sync -> probably deleted on OneDrive.
    seedLocal({
      ...deviceDoc,
      patients: [
        ...deviceDoc.patients,
        makePatient({ id: 'old', patientNumber: 9, name: 'Omar F.', createdAt: CREATED_BEFORE, updatedAt: CREATED_BEFORE }),
      ],
    })
    storage.writes = []

    const session = await openSession()

    const decisions = allFromDevice(session)

    const blocked = await applyResolution(session, decisions, { now: makeNow() })

    expect(blocked.status).toBe('needs-acknowledgement')
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.writes).toEqual([])

    const applied = await applyResolution(session, decisions, {
      now: makeNow(),
      acknowledgedResurrection: true,
    })

    expect(applied.status).toBe('applied')

  })

})

describe('applyResolution - happy path', () => {

  it('writes both safety copies, pushes the resolved snapshot, commits locally and updates ALL tracking', async () => {

    setUpDivergence()
    const session = await openSession()

    const decisions: Decisions = {
      [recordKey('patient', 'shared')]: 'cloud',
      [recordKey('patient', 'dev-only')]: 'device',
      [recordKey('patient', 'cloud-only')]: 'cloud',
    }

    const result = await applyResolution(session, decisions, { now: makeNow() })

    expect(result.status).toBe('applied')

    // Cloud holds the resolved document.
    const cloudDoc = fake.doc as CloudSyncDocument

    expect(cloudDoc.patients.map(p => `${p.id}:${p.name}`).sort()).toEqual([
      'cloud-only:Lina M.',
      'dev-only:Sara K.',
      'shared:Ahmed Samy',
    ])
    expect('deletionTombstones' in cloudDoc).toBe(false)

    // Local data replaced to match.
    expect(readLocalPatients().map(p => p.id).sort()).toEqual(['cloud-only', 'dev-only', 'shared'])

    // Tracking: known ETag/updatedAt, counter, next patient number.
    expect(storage.getItem('toothTargetCloudSyncETag')).toBe(fake.currentETag)
    expect(storage.getItem('toothTargetCloudSyncUpdatedAt')).toBe(cloudDoc.updatedAt)
    expect(storage.getItem('toothTargetLastSyncedChangeCounter')).toBe('3')
    expect(storage.getItem('toothTargetNextPatientNumber')).toBe('4')
    expect(storage.getItem('toothTargetDeviceLastSyncAt')).not.toBeNull()

    // State is genuinely "in sync": clean, and the cloud matches what this device knows.
    expect(isLocalDataDirty()).toBe(false)
    expect(hasCloudChangedSinceKnown(cloudDoc.updatedAt, fake.currentETag!)).toBe(false)

    // Marker cleaned up, resolution flag released.
    expect(hasPendingResolutionMarker()).toBe(false)
    expect(isResolutionApplying()).toBe(false)

  })

  it('saved BOTH sides first (OneDrive files + local entry) with the pre-resolution data', async () => {

    setUpDivergence()
    const session = await openSession()

    await applyResolution(session, allFromDevice(session), { now: makeNow() })

    const names = [...fake.files.keys()]

    expect(names).toHaveLength(2)
    expect(names.every(name => parseSafetyCopyFileName(name) !== null)).toBe(true)
    expect(names.some(name => name.endsWith('-device.json'))).toBe(true)
    expect(names.some(name => name.endsWith('-cloud.json'))).toBe(true)

    const local = readLocalSafetyCopies()

    expect(local).toHaveLength(1)
    expect(local[0].device.patients.map(p => p.name).sort()).toEqual(['Ahmed S.', 'Sara K.'])
    expect(local[0].cloud.patients.map(p => p.name).sort()).toEqual(['Ahmed Samy', 'Lina M.'])

  })

  it('the cloud write is conditional on the ETag the dentist looked at', async () => {

    setUpDivergence()
    const session = await openSession()

    const { writeCloudSyncDocument } = await import('./cloudStorage')

    await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(vi.mocked(writeCloudSyncDocument).mock.calls.at(-1)?.[1]).toBe(session.cloudETag)

  })

  it('"use everything from OneDrive" results in local == cloud data', async () => {

    setUpDivergence()
    const session = await openSession()

    const result = await applyResolution(session, decideAllFromCloud(session.diff), {
      now: makeNow(),
    })

    expect(result.status).toBe('applied')
    expect(readLocalPatients().map(p => p.name).sort()).toEqual(['Ahmed Samy', 'Lina M.'])

  })

  it('background push/pull are paused for the duration of the apply (no extra write)', async () => {

    setUpDivergence()
    const session = await openSession()

    let pushResult: unknown = null

    fake.afterWriteLanded = () => {
      // Fire-and-forget is enough: the guard answers synchronously on its first line.
      void pushLocalSnapshot().then(result => {
        pushResult = result
      })
    }

    await applyResolution(session, allFromDevice(session), { now: makeNow() })
    await Promise.resolve()

    expect(pushResult).toMatchObject({ status: 'diverged' })
    expect(fake.syncWriteCalls).toBe(1)

  })

})

describe('applyResolution - cloud or device changed while deciding', () => {

  it('cloud changed: nothing is written, fresh session returned, untouched choices kept, changed ones reset', async () => {

    setUpDivergence()
    const session = await openSession()

    const decisions: Decisions = {
      [recordKey('patient', 'shared')]: 'device',
      [recordKey('patient', 'dev-only')]: 'device',
      [recordKey('patient', 'cloud-only')]: 'cloud',
    }

    // Another device edits the shared patient AGAIN while the dentist is deciding.
    externalWrite({
      ...cloudDocNow,
      updatedAt: '2026-03-20T00:00:00.000Z',
      patients: [
        makePatient({ id: 'shared', patientNumber: 1, name: 'Ahmed Samy II', createdAt: CREATED_BEFORE, updatedAt: '2026-05-20T00:00:00.000Z' }),
        cloudDocNow.patients[1],
      ],
    })

    storage.writes = []

    const result = await applyResolution(session, decisions, { now: makeNow() })

    expect(result.status).toBe('changed-while-deciding')

    if (result.status !== 'changed-while-deciding') {
      return
    }

    expect(result.reset).toEqual([recordKey('patient', 'shared')])
    expect(result.decisions).toEqual({
      [recordKey('patient', 'dev-only')]: 'device',
      [recordKey('patient', 'cloud-only')]: 'cloud',
    })
    expect(result.session.cloudETag).toBe(fake.currentETag)
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.writes).toEqual([])

  })

  it('this device changed (counter moved): nothing is written, fresh session', async () => {

    setUpDivergence()
    const session = await openSession()

    storage.setItem('toothTargetLocalChangeCounter', '4')
    storage.writes = []

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result.status).toBe('changed-while-deciding')
    expect(result.status === 'changed-while-deciding' && result.session.counterAtOpen).toBe(4)
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.writes).toEqual([])

  })

  it('a 412 on the write itself (another device wins the last-instant race): marker cleared, their data untouched, nothing local changed', async () => {

    setUpDivergence()
    const session = await openSession()

    const theirs = makeDocument({
      updatedAt: '2026-03-25T00:00:00.000Z',
      patients: [makePatient({ id: 'theirs', patientNumber: 7, name: 'Theirs' })],
    })

    fake.beforeWrite = () => {
      fake.beforeWrite = null
      externalWrite(theirs)
    }

    const localBefore = storage.snapshot()

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result.status).toBe('changed-while-deciding')
    expect((fake.doc as CloudSyncDocument).patients.map(p => p.id)).toEqual(['theirs'])
    expect(hasPendingResolutionMarker()).toBe(false)
    expect(storage.getItem('toothTargetPatients')).toBe(localBefore['toothTargetPatients'])
    expect(storage.getItem('toothTargetCloudSyncETag')).toBe('etag-known')

  })

  it('the cloud document vanished: reported, nothing written', async () => {

    setUpDivergence()
    const session = await openSession()

    fake.doc = null
    fake.currentETag = null
    storage.writes = []

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result.status).toBe('failed')
    expect(fake.syncWriteCalls).toBe(0)
    expect(storage.writes).toEqual([])

  })

})

describe('applyResolution - network and crash failures', () => {

  it('network drops BEFORE the write lands: local untouched, retryable, and the retry works without duplicating safety copies', async () => {

    setUpDivergence()
    const session = await openSession()
    const now = makeNow()

    fake.nextWriteMode = 'network-before'

    const localBefore = storage.getItem('toothTargetPatients')

    const first = await applyResolution(session, allFromDevice(session), { now })

    expect(first).toMatchObject({ status: 'failed', retryable: true })
    expect(storage.getItem('toothTargetPatients')).toBe(localBefore)
    expect(storage.getItem('toothTargetCloudSyncETag')).toBe('etag-known')
    expect(fake.files.size).toBe(2)

    const second = await applyResolution(session, allFromDevice(session), { now })

    expect(second.status).toBe('applied')
    expect(fake.files.size).toBe(2)
    expect(fake.syncWriteCalls).toBe(2)

  })

  it('a LOST RESPONSE (the write landed): a retry recognises it, does not write again, and finishes locally', async () => {

    setUpDivergence()
    const session = await openSession()
    const now = makeNow()

    fake.nextWriteMode = 'lose-response'

    const first = await applyResolution(session, allFromDevice(session), { now })

    expect(first).toMatchObject({ status: 'failed', retryable: true })
    expect(hasPendingResolutionMarker()).toBe(true)
    expect(fake.syncWriteCalls).toBe(1)

    const second = await applyResolution(session, allFromDevice(session), { now })

    expect(second.status).toBe('applied')
    expect(fake.syncWriteCalls).toBe(1)
    expect(hasPendingResolutionMarker()).toBe(false)
    expect(isLocalDataDirty()).toBe(false)
    expect(readLocalPatients().map(p => p.id).sort()).toEqual(['dev-only', 'shared'])

  })

  it('CRASH after the cloud write, before the local commit: startup recovery finishes it', async () => {

    setUpDivergence()
    const session = await openSession()

    fake.nextWriteMode = 'crash-after'

    await expect(
      applyResolution(session, allFromDevice(session), { now: makeNow() })
    ).rejects.toThrow('simulated crash')

    // The "process died": local data is still the old data, the marker is there.
    expect(readLocalPatients().map(p => p.name).sort()).toEqual(['Ahmed S.', 'Sara K.'])
    expect(hasPendingResolutionMarker()).toBe(true)
    expect(isResolutionApplying()).toBe(false)

    const recovery = await finishPendingResolution({ now: makeNow() })

    expect(recovery).toEqual({ status: 'completed' })
    expect(readLocalPatients().map(p => p.id).sort()).toEqual(['dev-only', 'shared'])
    expect(isLocalDataDirty()).toBe(false)
    expect(storage.getItem('toothTargetCloudSyncETag')).toBe(fake.currentETag)
    expect(hasPendingResolutionMarker()).toBe(false)

  })

  it('an EDIT DURING THE WRITE is never overwritten: cloud written, local kept, tracking untouched, next sync diverged again', async () => {

    setUpDivergence()
    const session = await openSession()

    fake.afterWriteLanded = () => {
      // The dentist saves a new patient while the push is in flight.
      storage.setItem(
        'toothTargetPatients',
        JSON.stringify([
          ...readLocalPatients(),
          makePatient({ id: 'typed-during', patientNumber: 50, name: 'Typed During' }),
        ])
      )
      storage.setItem('toothTargetLocalChangeCounter', '4')
    }

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result.status).toBe('cloud-written-local-changed')
    expect(readLocalPatients().map(p => p.id)).toContain('typed-during')
    expect(storage.getItem('toothTargetCloudSyncETag')).toBe('etag-known')
    expect(isLocalDataDirty()).toBe(true)
    expect(hasPendingResolutionMarker()).toBe(false)

    // The next look: diverged again, small diff (just the edit).
    const next = await prepareResolution()

    expect(next.status).toBe('ready')
    expect(next.status === 'ready' && next.session.diff.deviceOnly.map(i => i.id)).toEqual(['typed-during'])

  })

  it('an OneDrive safety copy failure BLOCKS the apply: no sync write, no marker, local untouched', async () => {

    setUpDivergence()
    const session = await openSession()

    fake.failFileWrites = true
    storage.writes = []

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result.status).toBe('safety-copy-failed')
    expect(fake.syncWriteCalls).toBe(0)
    expect(hasPendingResolutionMarker()).toBe(false)
    expect(storage.writes).toEqual([])

  })

  it('only the LOCAL safety copy failing (quota) ALLOWS the apply, with a warning', async () => {

    setUpDivergence()
    const session = await openSession()

    storage.failKeys.add(LOCAL_SAFETY_COPY_KEY)

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result.status).toBe('applied')
    expect(result.status === 'applied' && result.warning).toContain('OneDrive copies are enough')
    expect(fake.files.size).toBe(2)

  })

  it('a pending marker that cannot be stored BLOCKS the apply before anything reaches the cloud', async () => {

    setUpDivergence()
    const session = await openSession()

    storage.failKeys.add(PENDING_RESOLUTION_KEY)

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result.status).toBe('marker-failed')
    expect(fake.syncWriteCalls).toBe(0)

  })

  it('local save failing after the cloud write is reported honestly, marker kept for recovery', async () => {

    setUpDivergence()
    const session = await openSession()

    storage.failKeys.add('toothTargetPatients')

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result.status).toBe('cloud-committed-locally-pending')
    expect(hasPendingResolutionMarker()).toBe(true)

  })

  it('a corrupt cloud document found at apply time routes to cloud-invalid, nothing written', async () => {

    setUpDivergence()
    const session = await openSession()

    fake.nextReadOverride = { status: 'malformed-json', detail: 'bad json' }
    storage.writes = []

    const result = await applyResolution(session, allFromDevice(session), { now: makeNow() })

    expect(result).toMatchObject({
      status: 'failed',
      result: { status: 'cloud-invalid' },
    })
    expect(fake.syncWriteCalls).toBe(0)
    expect(storage.writes).toEqual([])

  })

})

describe('markInSync - identical content advances tracking only', () => {

  it('writes nothing to the cloud and does not touch the data, but records the cloud version', async () => {

    setUpDivergence()
    externalWrite({ ...deviceDoc, updatedAt: '2026-03-12T00:00:00.000Z' })

    const session = await openSession()

    const dataBefore = {
      patients: storage.getItem('toothTargetPatients'),
      treatments: storage.getItem('toothTargetSavedTreatments'),
      templates: storage.getItem('toothTargetTemplates'),
      procedures: storage.getItem('toothTargetProcedures'),
    }

    const result = await markInSync(session, { now: makeNow() })

    expect(result).toEqual({ status: 'in-sync' })
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.getItem('toothTargetPatients')).toBe(dataBefore.patients)
    expect(storage.getItem('toothTargetSavedTreatments')).toBe(dataBefore.treatments)
    expect(storage.getItem('toothTargetTemplates')).toBe(dataBefore.templates)
    expect(storage.getItem('toothTargetProcedures')).toBe(dataBefore.procedures)

    expect(storage.getItem('toothTargetCloudSyncETag')).toBe(fake.currentETag)
    expect(storage.getItem('toothTargetCloudSyncUpdatedAt')).toBe('2026-03-12T00:00:00.000Z')
    expect(storage.getItem('toothTargetLastSyncedChangeCounter')).toBe('3')
    expect(isLocalDataDirty()).toBe(false)

  })

  it('if the cloud moved meanwhile, nothing is recorded', async () => {

    setUpDivergence()
    externalWrite({ ...deviceDoc, updatedAt: '2026-03-12T00:00:00.000Z' })

    const session = await openSession()

    externalWrite({ ...cloudDocNow, updatedAt: '2026-03-30T00:00:00.000Z' })
    storage.writes = []

    const result = await markInSync(session, { now: makeNow() })

    expect(result.status).toBe('changed-while-deciding')
    expect(storage.writes).toEqual([])

  })

})

/* ============================================================ */

describe('finishPendingResolution - crash recovery conditions (amendment 2)', () => {

  /*
    Builds the state a crash leaves behind: the cloud holds the
    resolved document (stamp S), the marker exists (account A, counter
    C0 = 3), local still holds the old data.
  */
  async function crashAfterWrite(): Promise<void> {

    setUpDivergence()
    const session = await openSession()

    fake.nextWriteMode = 'crash-after'

    await applyResolution(session, allFromDevice(session), { now: makeNow() }).catch(() => {})

    fake.nextWriteMode = 'normal'
    fake.readCalls = 0

  }

  it('does NOTHING when no marker exists: no read, no write, no promise of work', async () => {

    setUpDivergence()

    const result = await finishPendingResolution()

    expect(result).toEqual({ status: 'none' })
    expect(fake.readCalls).toBe(0)
    expect(storage.writes).toEqual([])

  })

  it('completes when the account matches, cloud updatedAt == stamp, and the counter == C0', async () => {

    await crashAfterWrite()

    expect(await finishPendingResolution({ now: makeNow() })).toEqual({ status: 'completed' })
    expect(isLocalDataDirty()).toBe(false)

  })

  it('DROPS the marker when the account differs - local data untouched', async () => {

    await crashAfterWrite()

    storage.setItem('toothTargetSyncedAccountId', 'account-B')
    const before = storage.getItem('toothTargetPatients')

    expect(await finishPendingResolution({ now: makeNow() })).toEqual({
      status: 'dropped',
      reason: 'different-account',
    })
    expect(storage.getItem('toothTargetPatients')).toBe(before)
    expect(hasPendingResolutionMarker()).toBe(false)

  })

  it('DROPS the marker when the caller reports a different active account', async () => {

    await crashAfterWrite()

    expect(
      await finishPendingResolution({ activeAccountId: 'account-B', now: makeNow() })
    ).toEqual({ status: 'dropped', reason: 'different-account' })

  })

  it('DROPS the marker when the cloud updatedAt != stamp (cloud changed again)', async () => {

    await crashAfterWrite()

    externalWrite({ ...cloudDocNow, updatedAt: '2026-07-01T00:00:00.000Z' })
    const before = storage.getItem('toothTargetPatients')

    expect(await finishPendingResolution({ now: makeNow() })).toEqual({
      status: 'dropped',
      reason: 'cloud-does-not-match',
    })
    expect(storage.getItem('toothTargetPatients')).toBe(before)
    expect(hasPendingResolutionMarker()).toBe(false)

  })

  it('DROPS the marker when the cloud document is gone', async () => {

    await crashAfterWrite()

    fake.doc = null
    fake.currentETag = null

    expect(await finishPendingResolution({ now: makeNow() })).toEqual({
      status: 'dropped',
      reason: 'cloud-does-not-match',
    })

  })

  it('DROPS the marker when the local counter != C0 - without even reading the cloud', async () => {

    await crashAfterWrite()

    storage.setItem('toothTargetLocalChangeCounter', '4')
    const before = storage.getItem('toothTargetPatients')

    expect(await finishPendingResolution({ now: makeNow() })).toEqual({
      status: 'dropped',
      reason: 'local-changed',
    })
    expect(fake.readCalls).toBe(0)
    expect(storage.getItem('toothTargetPatients')).toBe(before)
    expect(hasPendingResolutionMarker()).toBe(false)

  })

  it('DROPS the marker when an edit lands WHILE the cloud is being read', async () => {

    await crashAfterWrite()

    fake.onRead = () => {
      storage.setItem('toothTargetLocalChangeCounter', '4')
    }

    const before = storage.getItem('toothTargetPatients')

    expect(await finishPendingResolution({ now: makeNow() })).toEqual({
      status: 'dropped',
      reason: 'local-changed',
    })
    expect(storage.getItem('toothTargetPatients')).toBe(before)

  })

  it('after a dropped marker the state is simply diverged again (nothing lost)', async () => {

    await crashAfterWrite()

    storage.setItem('toothTargetSyncedAccountId', 'account-B')
    await finishPendingResolution({ now: makeNow() })
    storage.setItem('toothTargetSyncedAccountId', 'account-A')

    expect(isLocalDataDirty()).toBe(true)

    // Still not in sync from this device's point of view (known ETag is stale),
    // so a fresh look finds it again. Here the resolution was "everything from this
    // device", so the cloud now equals the device: 'identical' (mark-in-sync only).
    expect((await prepareResolution()).status).toBe('identical')

  })

  it('DEFERS (marker kept) when the cloud cannot be reached', async () => {

    await crashAfterWrite()

    fake.nextReadOverride = { status: 'network-unreachable', detail: 'offline' }

    expect(await finishPendingResolution({ now: makeNow() })).toEqual({
      status: 'deferred',
      result: { status: 'network-unreachable', detail: 'offline' },
    })
    expect(hasPendingResolutionMarker()).toBe(true)

  })

  it('drops an unreadable marker', async () => {

    setUpDivergence()
    storage.setItem(PENDING_RESOLUTION_KEY, '{broken')

    expect(await finishPendingResolution()).toEqual({
      status: 'dropped',
      reason: 'unreadable-marker',
    })
    expect(hasPendingResolutionMarker()).toBe(false)

  })

})

describe('the no-marker startup path is inert', () => {

  it('hasPendingResolutionMarker is false on a fresh device, and reading it writes nothing', () => {

    expect(hasPendingResolutionMarker()).toBe(false)
    expect(storage.writes).toEqual([])

  })

})
