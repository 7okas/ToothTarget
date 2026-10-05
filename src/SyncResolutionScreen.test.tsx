import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

/*
  RENDER SMOKE TESTS for the resolution screen.

  This project has no DOM test harness, so these render the real
  component to static HTML (react-dom/server) from the real controller
  state, against an in-memory OneDrive - enough to prove the plain-
  language wording the screen promises is actually on screen at each
  step, that nothing starts preselected, and that the always-visible
  controls (decided count, Review summary, Decide later) are present.
  Button behaviour itself is covered by syncResolutionController.test.ts.
*/

const fake = {
  doc: null as unknown,
  etagCounter: 0,
  currentETag: null as string | null,
}

function externalWrite(doc: unknown): void {
  fake.etagCounter += 1
  fake.currentETag = `etag-${fake.etagCounter}`
  fake.doc = JSON.parse(JSON.stringify(doc))
}

vi.mock('./cloudStorage', () => ({
  readCloudSyncDocument: vi.fn(async () =>
    fake.doc === null
      ? { status: 'not-found' }
      : { status: 'found', document: JSON.parse(JSON.stringify(fake.doc)), eTag: fake.currentETag }
  ),
  writeCloudSyncDocument: vi.fn(),
  listAppFolderFileNames: vi.fn(async () => []),
  readCloudData: vi.fn(async () => null),
  writeCloudData: vi.fn(async () => undefined),
  deleteCloudFile: vi.fn(),
}))

vi.mock('./cloudSyncScheduler', () => ({
  reportResolutionApplied: vi.fn(),
  requestCloudPullIfSignedIn: vi.fn(),
  requestCloudSync: vi.fn(),
  notifyLocalDataReplaced: vi.fn(),
}))

import SyncResolutionScreen from './SyncResolutionScreen'
import SafetyCopiesScreen from './SafetyCopiesScreen'
import {
  openController,
  setChoice,
  chooseAllFromDevice,
  goToSummary,
  __resetControllerForTests,
} from './syncResolutionController'
import {
  openResolutionScreen,
  openSafetyCopiesScreen,
  __resetResolutionStoreForTests,
} from './syncResolutionStore'
import { recordKey } from './syncResolve'
import { makePatient, makeSavedTreatment, makeDocument } from './syncResolutionTestUtils'

class MemoryStorage implements Storage {

  private map = new Map<string, string>()

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
    this.map.set(key, value)
  }

}

const T0 = '2026-03-01T00:00:00.000Z'
const AFTER = '2026-04-01T12:00:00.000Z'
const BEFORE = '2026-02-01T12:00:00.000Z'

function setUp() {

  const storage = new MemoryStorage()
  globalThis.localStorage = storage

  const device = makeDocument({
    patients: [
      makePatient({ id: 'new-d', patientNumber: 2, name: 'Sara K.', createdAt: AFTER, updatedAt: AFTER }),
      makePatient({ id: 'old-d', patientNumber: 3, name: 'Omar F.', createdAt: BEFORE, updatedAt: BEFORE }),
      makePatient({ id: 'both', patientNumber: 1, name: 'Ahmed S.' }),
    ],
    savedTreatments: [
      makeSavedTreatment({ id: 't1', patientId: 'new-d', patientName: 'Sara K.', procedureName: 'Root canal', toothId: '36', completedAt: AFTER, updatedAt: AFTER }),
    ],
  })

  const cloud = makeDocument({
    updatedAt: '2026-03-10T00:00:00.000Z',
    patients: [
      makePatient({ id: 'new-c', patientNumber: 4, name: 'Lina M.', createdAt: AFTER, updatedAt: AFTER }),
      makePatient({ id: 'both', patientNumber: 1, name: 'Ahmed Samy' }),
    ],
  })

  storage.setItem('toothTargetPatients', JSON.stringify(device.patients))
  storage.setItem('toothTargetSavedTreatments', JSON.stringify(device.savedTreatments))
  storage.setItem('toothTargetTemplates', '[]')
  storage.setItem('toothTargetProcedures', '[]')
  storage.setItem('toothTargetLocalChangeCounter', '3')
  storage.setItem('toothTargetLastSyncedChangeCounter', '1')
  storage.setItem('toothTargetCloudSyncETag', 'etag-known')
  storage.setItem('toothTargetCloudSyncUpdatedAt', T0)

  externalWrite(cloud)

}

beforeEach(() => {
  fake.doc = null
  fake.etagCounter = 0
  fake.currentETag = null
  __resetControllerForTests()
  __resetResolutionStoreForTests()
})

describe('SyncResolutionScreen render', () => {

  it('renders nothing when the screen is closed', () => {

    expect(renderToString(<SyncResolutionScreen />)).toBe('')

  })

  it('deciding view: plain-language header, sections, groups, hints, buttons, decided count, locked Review summary', async () => {

    setUp()
    openResolutionScreen()
    await openController()

    const html = renderToString(<SyncResolutionScreen />)

    expect(html).toContain('Resolve differences with OneDrive')
    expect(html).toContain('Nothing has been changed yet.')
    expect(html).toContain('Decide later')
    expect(html).toContain('Use everything from this device')
    expect(html).toContain('Use everything from OneDrive')
    expect(html).toContain('Only on this device')
    expect(html).toContain('Only in OneDrive')
    expect(html).toContain('On both, but different')
    expect(html).toContain('Keep it')
    expect(html).toContain('Leave it out')
    expect(html).toContain('Bring to this device')
    expect(html).toContain("Use this device&#x27;s")
    expect(html).toContain("Use OneDrive&#x27;s")
    expect(html).toContain('Keep / bring everything created since the last sync')
    expect(html).toContain('Created since last sync')
    expect(html).toContain('probably DELETED from OneDrive')
    expect(html).toMatch(/Patient: (<!-- -->)?Sara K./)
    expect(html).toContain('0 of 5 decided')
    expect(html).toContain('Decide every row to continue.')

    // Review summary is present but locked.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Review summary/)

  })

  it('nothing starts preselected: every choice button is unpressed', async () => {

    setUp()
    openResolutionScreen()
    await openController()

    const html = renderToString(<SyncResolutionScreen />)

    expect(html).not.toContain('aria-pressed="true"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('res-choice-selected')

  })

  it('a chosen button shows as pressed and the count advances', async () => {

    setUp()
    openResolutionScreen()
    await openController()

    setChoice(recordKey('patient', 'new-d'), 'device')

    const html = renderToString(<SyncResolutionScreen />)

    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('1 of 5 decided')

  })

  it('summary view: exact-plan text, the amber warning with the tick box, and the safety-copy retention promise', async () => {

    setUp()
    openResolutionScreen()
    await openController()

    chooseAllFromDevice()
    goToSummary()

    const html = renderToString(<SyncResolutionScreen />)

    expect(html).toContain('Here is exactly what will happen')
    expect(html).toContain('Patients: ')
    expect(html).toContain('from this device')
    expect(html).toContain('from OneDrive')
    expect(html).toContain('left out')
    expect(html).toContain('1 record that was probably deleted will come back.')
    expect(html).toContain('I understand these deleted records will come back.')
    expect(html).toContain('safety copy of BOTH sides')
    expect(html).toContain('last 5 resolutions')
    expect(html).toContain('Apply and sync')
    // Apply is locked until the tick.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply and sync/)

  })

  it('layout hooks for iPad/phone are present: a scrolling body and a sticky footer', async () => {

    setUp()
    openResolutionScreen()
    await openController()

    const html = renderToString(<SyncResolutionScreen />)

    expect(html).toContain('class="res-body"')
    expect(html).toContain('class="res-footer"')
    expect(html).toContain('class="res-header"')

  })

  it('not-diverged: shows the plain message with a Close button', async () => {

    setUp()
    localStorage.setItem('toothTargetCloudSyncETag', fake.currentETag!)
    openResolutionScreen()
    await openController()

    const html = renderToString(<SyncResolutionScreen />)

    expect(html).toContain('Nothing to resolve any more')
    expect(html).toContain('Close')

  })

})

describe('SafetyCopiesScreen render', () => {

  it('renders nothing when closed; when open explains retention and offers no restore before any copy exists', () => {

    globalThis.localStorage = new MemoryStorage()

    expect(renderToString(<SafetyCopiesScreen />)).toBe('')

    openSafetyCopiesScreen()

    const html = renderToString(<SafetyCopiesScreen />)

    expect(html).toContain('Safety copies')
    expect(html).toContain('last 5 resolutions')
    expect(html).toContain('this device the last 2')
    expect(html).not.toContain('Restore this device')

  })

})
