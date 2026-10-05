import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  The controller is the framework-free brain of the resolution screen,
  so the screen's rules are tested here, end to end, against a small
  in-memory OneDrive (same shape as syncResolutionEngine.test.ts's) and
  a logging localStorage: nothing is written until Apply, "Decide
  later" writes nothing, a changed cloud keeps what still applies, and
  so on.
*/

type ReadResult =
  | { status: 'not-found' }
  | { status: 'found'; document: unknown; eTag: string }
  | { status: 'network-unreachable'; detail: string }

const fake = {
  doc: null as unknown,
  etagCounter: 0,
  currentETag: null as string | null,
  syncWriteCalls: 0,
  files: new Map<string, unknown>(),
  nextWriteNetworkDown: false,
  nextReadOverride: null as ReadResult | null,
}

function externalWrite(doc: unknown): string {
  fake.etagCounter += 1
  fake.currentETag = `etag-${fake.etagCounter}`
  fake.doc = JSON.parse(JSON.stringify(doc))
  return fake.currentETag
}

vi.mock('./cloudStorage', () => ({
  readCloudSyncDocument: vi.fn(async (): Promise<ReadResult> => {
    if (fake.nextReadOverride) {
      const override = fake.nextReadOverride
      fake.nextReadOverride = null
      return override
    }
    if (fake.doc === null) {
      return { status: 'not-found' }
    }
    return { status: 'found', document: JSON.parse(JSON.stringify(fake.doc)), eTag: fake.currentETag! }
  }),
  writeCloudSyncDocument: vi.fn(async (document: unknown, expected: string | null) => {
    fake.syncWriteCalls += 1
    if (fake.nextWriteNetworkDown) {
      fake.nextWriteNetworkDown = false
      return { status: 'network-unreachable', detail: 'offline' }
    }
    if (expected !== fake.currentETag) {
      return { status: 'precondition-failed' }
    }
    return { status: 'written', eTag: externalWrite(document) }
  }),
  listAppFolderFileNames: vi.fn(async () => [...fake.files.keys()]),
  readCloudData: vi.fn(async (name: string) => (fake.files.has(name) ? fake.files.get(name) : null)),
  writeCloudData: vi.fn(async (name: string, data: unknown) => {
    fake.files.set(name, JSON.parse(JSON.stringify(data)))
  }),
  deleteCloudFile: vi.fn(async (name: string) => {
    fake.files.delete(name)
  }),
}))

vi.mock('./cloudSyncScheduler', () => ({
  reportResolutionApplied: vi.fn(),
  requestCloudPullIfSignedIn: vi.fn(),
}))

import { reportResolutionApplied, requestCloudPullIfSignedIn } from './cloudSyncScheduler'
import { isLocalDataDirty } from './cloudSyncEngine'
import type { CloudSyncDocument } from './cloudSync'
import {
  getControllerState,
  openController,
  setChoice,
  chooseAllFromDevice,
  chooseAllFromCloud,
  keepCreatedSinceLastSync,
  chooseNumberKeeper,
  setManualPatientNumber,
  keepPatientForTreatments,
  leaveOutTreatments,
  setAcknowledged,
  goToSummary,
  backToDeciding,
  decideLater,
  applyNow,
  markInSyncNow,
  closeFinished,
  __resetControllerForTests,
} from './syncResolutionController'
import {
  getResolutionScreenOpen,
  openResolutionScreen,
  subscribeResolutionResolved,
  __resetResolutionStoreForTests,
} from './syncResolutionStore'
import { recordKey } from './syncResolve'
import { makePatient, makeSavedTreatment, makeDocument } from './syncResolutionTestUtils'

class LoggingStorage implements Storage {

  private map = new Map<string, string>()

  writes: string[] = []

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
    this.writes.push(`set:${key}`)
    this.map.set(key, value)
  }

}

let storage: LoggingStorage

const T0 = '2026-03-01T00:00:00.000Z'
const CREATED_AFTER = '2026-04-01T12:00:00.000Z'
const CREATED_BEFORE = '2026-02-01T12:00:00.000Z'

const deviceDoc = makeDocument({
  patients: [
    makePatient({ id: 'shared', patientNumber: 1, name: 'Ahmed S.', createdAt: CREATED_BEFORE, updatedAt: '2026-05-01T00:00:00.000Z' }),
    makePatient({ id: 'dev-only', patientNumber: 2, name: 'Sara K.', createdAt: CREATED_AFTER, updatedAt: CREATED_AFTER }),
  ],
  savedTreatments: [
    makeSavedTreatment({ id: 't-dev', patientId: 'dev-only', patientName: 'Sara K.', completedAt: CREATED_AFTER, updatedAt: CREATED_AFTER }),
  ],
})

const cloudDocNow = makeDocument({
  updatedAt: '2026-03-10T00:00:00.000Z',
  patients: [
    makePatient({ id: 'shared', patientNumber: 1, name: 'Ahmed Samy', createdAt: CREATED_BEFORE, updatedAt: '2026-04-20T00:00:00.000Z' }),
    makePatient({ id: 'cloud-only', patientNumber: 3, name: 'Lina M.', createdAt: CREATED_AFTER, updatedAt: CREATED_AFTER }),
  ],
})

function seedLocal(doc: CloudSyncDocument) {
  storage.setItem('toothTargetPatients', JSON.stringify(doc.patients))
  storage.setItem('toothTargetSavedTreatments', JSON.stringify(doc.savedTreatments))
  storage.setItem('toothTargetTemplates', JSON.stringify(doc.customTemplates))
  storage.setItem('toothTargetProcedures', JSON.stringify(doc.customProcedures))
}

function setUpDivergence(local: CloudSyncDocument = deviceDoc, cloud: CloudSyncDocument = cloudDocNow) {

  seedLocal(local)
  storage.setItem('toothTargetLocalChangeCounter', '3')
  storage.setItem('toothTargetLastSyncedChangeCounter', '1')
  storage.setItem('toothTargetCloudSyncETag', 'etag-known')
  storage.setItem('toothTargetCloudSyncUpdatedAt', T0)
  storage.setItem('toothTargetSyncedAccountId', 'account-A')

  externalWrite(cloud)

  storage.writes = []
  fake.syncWriteCalls = 0

}

/* Decides every row the simple way: keep device-only, bring cloud-only, use the cloud's shared version. */
function decideEverything() {

  const state = getControllerState()

  for (const section of state.view!.sections) {
    for (const group of Object.values(section.groups)) {
      for (const row of group.rows) {
        setChoice(
          row.key,
          row.kind === 'device-only' ? 'device' : row.kind === 'cloud-only' ? 'cloud' : 'cloud'
        )
      }
    }
  }

}

beforeEach(() => {

  storage = new LoggingStorage()
  globalThis.localStorage = storage

  fake.doc = null
  fake.etagCounter = 0
  fake.currentETag = null
  fake.syncWriteCalls = 0
  fake.files = new Map()
  fake.nextWriteNetworkDown = false
  fake.nextReadOverride = null

  __resetControllerForTests()
  __resetResolutionStoreForTests()

  vi.mocked(reportResolutionApplied).mockClear()
  vi.mocked(requestCloudPullIfSignedIn).mockClear()

})

describe('opening the screen is read-only', () => {

  it('loads the diff and starts with every row undecided; writes nothing anywhere', async () => {

    setUpDivergence()

    const loading = openController()

    expect(getControllerState().phase).toBe('loading')

    await loading

    const state = getControllerState()

    expect(state.phase).toBe('deciding')
    expect(state.view!.totalRows).toBe(4)
    expect(state.view!.decidedRows).toBe(0)
    expect(state.canReviewSummary).toBe(false)
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.writes).toEqual([])

  })

  it('nothing diverged any more: a plain message, and the ordinary flow is asked to pick it up', async () => {

    setUpDivergence()
    storage.setItem('toothTargetCloudSyncETag', fake.currentETag!)

    await openController()

    expect(getControllerState().phase).toBe('message')
    expect(getControllerState().message?.title).toBe('Nothing to resolve any more')
    expect(requestCloudPullIfSignedIn).toHaveBeenCalledWith(true)

  })

  it('a corrupt or unreachable cloud shows the existing plain-language message with a retry', async () => {

    setUpDivergence()
    fake.nextReadOverride = { status: 'network-unreachable', detail: 'offline' }

    await openController()

    const state = getControllerState()

    expect(state.phase).toBe('message')
    expect(state.message?.tone).toBe('error')
    expect(state.message?.retryable).toBe(true)
    expect(state.message?.message).toContain('Nothing was changed')

  })

})

describe('"Decide later" writes nothing', () => {

  it('after choices and even a reviewed summary, closing writes nothing and leaves the diverged state intact', async () => {

    setUpDivergence()
    await openController()
    openResolutionScreen()

    decideEverything()
    goToSummary()

    expect(getControllerState().phase).toBe('summary')

    storage.writes = []

    decideLater()

    expect(getControllerState().phase).toBe('idle')
    expect(getResolutionScreenOpen()).toBe(false)
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(storage.writes).toEqual([])
    expect(isLocalDataDirty()).toBe(true)
    expect(storage.getItem('toothTargetCloudSyncETag')).toBe('etag-known')
    expect(reportResolutionApplied).not.toHaveBeenCalled()

  })

  it('works from the very first moment (nothing decided yet)', async () => {

    setUpDivergence()
    await openController()
    openResolutionScreen()

    decideLater()

    expect(getResolutionScreenOpen()).toBe(false)
    expect(storage.writes).toEqual([])

  })

  it('closing while still loading discards the late result instead of reopening anything', async () => {

    setUpDivergence()

    const loading = openController()

    decideLater()

    await loading

    expect(getControllerState().phase).toBe('idle')

  })

})

describe('choosing and the shortcuts', () => {

  it('Review summary stays locked until every row is decided', async () => {

    setUpDivergence()
    await openController()

    setChoice(recordKey('patient', 'dev-only'), 'device')

    expect(getControllerState().view!.progressLabel).toBe('1 of 4 decided')
    expect(getControllerState().canReviewSummary).toBe(false)

    goToSummary()

    expect(getControllerState().phase).toBe('deciding')

  })

  it('"Use everything from this device / OneDrive" only FILL the choices and change nothing else', async () => {

    setUpDivergence()
    await openController()

    chooseAllFromDevice()

    expect(getControllerState().view!.allDecided).toBe(true)
    expect(getControllerState().phase).toBe('deciding')
    expect(fake.syncWriteCalls).toBe(0)
    expect(storage.writes).toEqual([])

    chooseAllFromCloud()

    expect(getControllerState().decisions[recordKey('patient', 'dev-only')]).toBe('omit')
    expect(getControllerState().decisions[recordKey('patient', 'cloud-only')]).toBe('cloud')

  })

  it('the bulk "created since last sync" button fills only those rows and keeps existing choices', async () => {

    setUpDivergence()
    await openController()

    setChoice(recordKey('patient', 'dev-only'), 'omit')
    keepCreatedSinceLastSync(null)

    const { decisions } = getControllerState()

    expect(decisions[recordKey('patient', 'dev-only')]).toBe('omit')
    expect(decisions[recordKey('patient', 'cloud-only')]).toBe('cloud')
    expect(decisions[recordKey('treatment', 't-dev')]).toBe('device')
    expect(decisions[recordKey('patient', 'shared')]).toBeUndefined()

  })

  it('going back from the summary keeps every choice', async () => {

    setUpDivergence()
    await openController()
    decideEverything()
    goToSummary()
    backToDeciding()

    expect(getControllerState().phase).toBe('deciding')
    expect(getControllerState().view!.allDecided).toBe(true)

  })

})

describe('apply', () => {

  it('writes only after Apply: safety copies, cloud, local, tracking; then reports done', async () => {

    setUpDivergence()
    await openController()
    decideEverything()
    goToSummary()

    expect(getControllerState().summary!.lines).toHaveLength(4)
    expect(getControllerState().summary!.safetyNote).toContain('last 5 resolutions')
    expect(fake.syncWriteCalls).toBe(0)
    expect(storage.writes).toEqual([])

    const resolved = vi.fn()
    subscribeResolutionResolved(resolved)

    await applyNow()

    expect(getControllerState().phase).toBe('done')
    expect(getControllerState().message?.tone).toBe('success')
    expect(fake.syncWriteCalls).toBe(1)
    expect(fake.files.size).toBe(2)
    expect(isLocalDataDirty()).toBe(false)
    expect(reportResolutionApplied).toHaveBeenCalledTimes(1)
    expect(resolved).toHaveBeenCalledTimes(1)

  })

  it('closing the finished screen resets everything and closes it', async () => {

    setUpDivergence()
    await openController()
    openResolutionScreen()
    decideEverything()
    goToSummary()
    await applyNow()

    closeFinished()

    expect(getControllerState().phase).toBe('idle')
    expect(getResolutionScreenOpen()).toBe(false)

  })

  it('a probably-deleted record coming back needs the tick; without it nothing is written', async () => {

    const local = makeDocument({
      patients: [
        ...deviceDoc.patients,
        makePatient({ id: 'old', patientNumber: 9, name: 'Omar F.', createdAt: CREATED_BEFORE, updatedAt: CREATED_BEFORE }),
      ],
      savedTreatments: deviceDoc.savedTreatments,
    })

    setUpDivergence(local)
    await openController()

    chooseAllFromDevice()
    goToSummary()

    const summary = getControllerState().summary!

    expect(summary.requiresAcknowledgement).toBe(true)
    expect(summary.resurrectedWarning).toBe('1 record that was probably deleted will come back.')

    await applyNow()

    expect(getControllerState().phase).toBe('summary')
    expect(getControllerState().message?.title).toBe('Please confirm the deleted records')
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)

    setAcknowledged(true)
    await applyNow()

    expect(getControllerState().phase).toBe('done')

  })

  it('a dropped network keeps you on the summary with a retry, and the retry works', async () => {

    setUpDivergence()
    await openController()
    decideEverything()
    goToSummary()

    fake.nextWriteNetworkDown = true

    await applyNow()

    let state = getControllerState()

    expect(state.phase).toBe('summary')
    expect(state.message?.retryable).toBe(true)
    expect(state.message?.message).toContain('unchanged')
    expect(isLocalDataDirty()).toBe(true)

    await applyNow()

    state = getControllerState()

    expect(state.phase).toBe('done')
    expect(isLocalDataDirty()).toBe(false)

  })

  it('if OneDrive changed while deciding: back to deciding, choices kept, changed rows highlighted, nothing written', async () => {

    setUpDivergence()
    await openController()
    decideEverything()
    goToSummary()

    externalWrite({
      ...cloudDocNow,
      patients: [
        makePatient({ id: 'shared', patientNumber: 1, name: 'Ahmed Samy II', createdAt: CREATED_BEFORE, updatedAt: '2026-06-20T00:00:00.000Z' }),
        cloudDocNow.patients[1],
      ],
    })

    storage.writes = []

    await applyNow()

    const state = getControllerState()

    expect(state.phase).toBe('deciding')
    expect(state.changedKeys).toEqual([recordKey('patient', 'shared')])
    expect(state.decisions[recordKey('patient', 'dev-only')]).toBe('device')
    expect(state.decisions[recordKey('patient', 'shared')]).toBeUndefined()
    expect(state.canReviewSummary).toBe(false)
    expect(state.message?.title).toBe('Things changed while you were deciding')
    expect(fake.syncWriteCalls).toBe(0)
    expect(storage.writes).toEqual([])

    // Choosing the changed row clears its highlight.
    setChoice(recordKey('patient', 'shared'), 'device')

    expect(getControllerState().changedKeys).toEqual([])
    expect(getControllerState().canReviewSummary).toBe(true)

  })

  it('an edit during the write is kept; the ordinary flow is asked to re-check', async () => {

    setUpDivergence()
    await openController()
    decideEverything()
    goToSummary()

    const { writeCloudSyncDocument } = await import('./cloudStorage')

    vi.mocked(writeCloudSyncDocument).mockImplementationOnce(async (document, expected) => {
      fake.syncWriteCalls += 1
      const eTag = (expected === fake.currentETag) ? externalWrite(document) : null
      storage.setItem('toothTargetLocalChangeCounter', '4')
      return eTag ? { status: 'written', eTag } : { status: 'precondition-failed' }
    })

    await applyNow()

    expect(getControllerState().phase).toBe('done')
    expect(getControllerState().message?.title).toBe('OneDrive was updated, but you saved something meanwhile')
    expect(requestCloudPullIfSignedIn).toHaveBeenCalledWith(true)
    expect(reportResolutionApplied).not.toHaveBeenCalled()
    expect(isLocalDataDirty()).toBe(true)

  })

})

describe('patient-number collisions', () => {

  const collidingCloud = makeDocument({
    updatedAt: '2026-03-10T00:00:00.000Z',
    patients: [
      makePatient({ id: 'cloud-twelve', patientNumber: 12, name: 'Cloud Twelve', createdAt: CREATED_AFTER, updatedAt: CREATED_AFTER }),
    ],
  })

  const collidingLocal = makeDocument({
    patients: [
      makePatient({ id: 'dev-twelve', patientNumber: 12, name: 'Device Twelve', createdAt: CREATED_AFTER, updatedAt: CREATED_AFTER }),
    ],
  })

  it('blocks the summary, offers a keeper, suggests the next free number, and applies the fix', async () => {

    setUpDivergence(collidingLocal, collidingCloud)
    await openController()

    chooseAllFromDevice()
    setChoice(recordKey('patient', 'cloud-twelve'), 'cloud')

    let state = getControllerState()

    expect(state.view!.allDecided).toBe(true)
    expect(state.base!.collisions).toHaveLength(1)

    // The default keeper keeps #12 and the other patient is suggested the next free number,
    // so the collision is already resolvable - but the dentist can pick who keeps it.
    chooseNumberKeeper(12, 'cloud-twelve')

    state = getControllerState()

    expect(Object.keys(state.numberFixes)).toEqual(['dev-twelve'])
    expect(state.numberFixes['dev-twelve']).toBe(13)
    expect(state.canReviewSummary).toBe(true)

    goToSummary()

    expect(getControllerState().summary!.renumbered).toEqual(['Device Twelve: #12 -> #13'])

    await applyNow()

    expect(getControllerState().phase).toBe('done')

    const stored = JSON.parse(storage.getItem('toothTargetPatients')!) as { id: string; patientNumber: number }[]

    expect(Object.fromEntries(stored.map(p => [p.id, p.patientNumber]))).toEqual({
      'cloud-twelve': 12,
      'dev-twelve': 13,
    })

  })

  it('a manual number that is still taken keeps the apply blocked', async () => {

    setUpDivergence(collidingLocal, collidingCloud)
    await openController()

    chooseAllFromDevice()
    setChoice(recordKey('patient', 'cloud-twelve'), 'cloud')

    const defaultFix = getControllerState().numberFixes

    const loser = Object.keys(defaultFix)[0]

    setManualPatientNumber(loser, 12)

    expect(getControllerState().canReviewSummary).toBe(false)

    setManualPatientNumber(loser, 40)

    expect(getControllerState().canReviewSummary).toBe(true)

  })

})

describe('a treatment whose patient was left out', () => {

  it('blocks the summary and both offered fixes resolve it', async () => {

    setUpDivergence()
    await openController()

    chooseAllFromDevice()
    setChoice(recordKey('patient', 'dev-only'), 'omit')

    let state = getControllerState()

    expect(state.view!.allDecided).toBe(true)
    expect(state.final!.problems.some(p => p.kind === 'treatment-needs-patient')).toBe(true)
    expect(state.canReviewSummary).toBe(false)

    keepPatientForTreatments('dev-only')

    state = getControllerState()

    expect(state.decisions[recordKey('patient', 'dev-only')]).toBe('device')
    expect(state.canReviewSummary).toBe(true)

    // ...or the other way: leave the patient out and drop their treatments too.
    setChoice(recordKey('patient', 'dev-only'), 'omit')
    leaveOutTreatments(['t-dev'])

    expect(getControllerState().decisions[recordKey('treatment', 't-dev')]).toBe('omit')
    expect(getControllerState().canReviewSummary).toBe(true)

  })

})

describe('identical content', () => {

  it('offers "Mark as in sync" and does it without writing to OneDrive', async () => {

    setUpDivergence()
    externalWrite({ ...deviceDoc, updatedAt: '2026-03-12T00:00:00.000Z' })
    fake.syncWriteCalls = 0

    await openController()

    expect(getControllerState().phase).toBe('identical')

    await markInSyncNow()

    expect(getControllerState().phase).toBe('done')
    expect(fake.syncWriteCalls).toBe(0)
    expect(fake.files.size).toBe(0)
    expect(isLocalDataDirty()).toBe(false)
    expect(reportResolutionApplied).toHaveBeenCalledTimes(1)

  })

})
