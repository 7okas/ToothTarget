import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  PHASE 6 - TWO-DEVICE INTEGRATION TEST

  Two simulated devices (each with its OWN localStorage, swapped in as
  the global one while that device "acts") share ONE fake OneDrive. The
  real engine code runs unmodified: pushLocalSnapshot()/
  pullCloudSnapshot() decide when the devices have diverged, the real
  controller walks the resolution flow, and the scenarios end with both
  devices clean, equal to each other and to OneDrive.
*/

vi.mock('./cloudStorage', async () => (await import('./fakeOneDriveForTests')).cloudStorageMock)

vi.mock('./cloudSyncScheduler', () => ({
  reportResolutionApplied: vi.fn(),
  requestCloudPullIfSignedIn: vi.fn(),
}))

import { oneDrive, resetOneDrive, putSyncDocument } from './fakeOneDriveForTests'
import type { CloudSyncDocument } from './cloudSync'
import {
  isLocalDataDirty,
  markLocalDataDirty,
  pullCloudSnapshot,
  pushLocalSnapshot,
  buildLocalCloudSyncDocument,
} from './cloudSyncEngine'
import {
  applyNow,
  chooseAllFromCloud,
  chooseAllFromDevice,
  chooseNumberKeeper,
  getControllerState,
  goToSummary,
  openController,
  setChoice,
  __resetControllerForTests,
} from './syncResolutionController'
import { __resetResolutionStoreForTests } from './syncResolutionStore'
import { recordKey } from './syncResolve'
import { makePatient, makeDocument } from './syncResolutionTestUtils'

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

type Device = 'A' | 'B'

const storages: Record<Device, MemoryStorage> = {
  A: new MemoryStorage(),
  B: new MemoryStorage(),
}

/* Make `device` the one whose localStorage the engine sees. */
function actAs(device: Device): void {
  globalThis.localStorage = storages[device]
  __resetControllerForTests()
}

function localPatients(): { id: string; name: string; patientNumber: number }[] {
  return JSON.parse(localStorage.getItem('toothTargetPatients') ?? '[]')
}

function setLocalPatients(patients: unknown[]): void {
  localStorage.setItem('toothTargetPatients', JSON.stringify(patients))
  markLocalDataDirty()
}

function localSnapshot(): CloudSyncDocument {

  const built = buildLocalCloudSyncDocument()

  if (!built.valid) {
    throw new Error(built.error)
  }

  return built.document

}

function patientView(doc: { patients: { id: string; name: string; patientNumber: number }[] }) {
  return Object.fromEntries(doc.patients.map(p => [p.id, `${p.patientNumber}:${p.name}`]))
}

const BASE = '2026-03-01T00:00:00.000Z'

/*
  Both devices start in sync with OneDrive at version `base`: the cloud
  holds it, each device holds the same data, knows the cloud's ETag and
  has nothing unsynced.
*/
function startInSync(patients: ReturnType<typeof makePatient>[]): void {

  resetOneDrive()

  const base = makeDocument({ updatedAt: BASE, patients })

  const eTag = putSyncDocument(base)

  for (const device of ['A', 'B'] as Device[]) {

    storages[device] = new MemoryStorage()

    const s = storages[device]

    s.setItem('toothTargetPatients', JSON.stringify(patients))
    s.setItem('toothTargetSavedTreatments', '[]')
    s.setItem('toothTargetTemplates', '[]')
    s.setItem('toothTargetProcedures', '[]')
    s.setItem('toothTargetLocalChangeCounter', '0')
    s.setItem('toothTargetLastSyncedChangeCounter', '0')
    s.setItem('toothTargetCloudSyncETag', eTag)
    s.setItem('toothTargetCloudSyncUpdatedAt', BASE)
    s.setItem('toothTargetSyncedAccountId', 'account-1')

  }

}

async function resolveOnThisDevice(
  choose: () => void
): Promise<void> {

  await openController()

  expect(getControllerState().phase).toBe('deciding')

  choose()

  expect(getControllerState().canReviewSummary).toBe(true)

  goToSummary()

  expect(getControllerState().phase).toBe('summary')

  // A probably-deleted record may need the tick; tick it when asked.
  if (getControllerState().summary?.requiresAcknowledgement) {
    const { setAcknowledged } = await import('./syncResolutionController')
    setAcknowledged(true)
  }

  await applyNow()

  expect(getControllerState().phase).toBe('done')

}

function expectEverythingConverged(): void {

  actAs('A')
  const a = localSnapshot()
  const aDirty = isLocalDataDirty()

  actAs('B')
  const b = localSnapshot()
  const bDirty = isLocalDataDirty()

  const cloud = oneDrive.doc as CloudSyncDocument

  expect(aDirty).toBe(false)
  expect(bDirty).toBe(false)
  expect(patientView(a)).toEqual(patientView(b))
  expect(patientView(a)).toEqual(patientView(cloud))

}

beforeEach(() => {
  __resetControllerForTests()
  __resetResolutionStoreForTests()
})

describe('two devices diverge, resolve, and end clean', () => {

  const shared = makePatient({
    id: 'shared',
    patientNumber: 1,
    name: 'Ahmed S.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  it('device A pushes first; device B, offline meanwhile, finds itself diverged, resolves "keep everything from this device", and both end identical', async () => {

    startInSync([shared])

    // A adds a patient and syncs normally (cloud had not moved: a plain push).
    actAs('A')
    setLocalPatients([
      ...localPatients(),
      makePatient({ id: 'a-new', patientNumber: 2, name: 'Added On A', createdAt: '2026-04-01T09:00:00.000Z', updatedAt: '2026-04-01T09:00:00.000Z' }),
    ])
    expect((await pushLocalSnapshot()).status).toBe('synced')

    // B, which never saw that, added its own patient and renamed the shared one.
    actAs('B')
    setLocalPatients([
      { ...localPatients()[0], name: 'Ahmed Samy', updatedAt: '2026-04-02T09:00:00.000Z' },
      makePatient({ id: 'b-new', patientNumber: 3, name: 'Added On B', createdAt: '2026-04-02T10:00:00.000Z', updatedAt: '2026-04-02T10:00:00.000Z' }),
    ])

    // B's next sync refuses to overwrite: diverged, nothing written.
    const writesBefore = oneDrive.syncWrites
    expect((await pullCloudSnapshot()).status).toBe('diverged')
    expect(oneDrive.syncWrites).toBe(writesBefore)

    // The dentist resolves on B: keep B's own data, and bring over what A added too.
    await resolveOnThisDevice(() => {
      chooseAllFromDevice()
      setChoice(recordKey('patient', 'a-new'), 'cloud')
    })

    // OneDrive now has B's rename + both added patients; B is clean.
    const cloud = oneDrive.doc as CloudSyncDocument

    expect(patientView(cloud)).toEqual({
      shared: '1:Ahmed Samy',
      'a-new': '2:Added On A',
      'b-new': '3:Added On B',
    })

    // A catches up through the ordinary pull and converges.
    actAs('A')
    expect((await pullCloudSnapshot()).status).toBe('synced')

    expectEverythingConverged()

  })

  it('the other way: B resolves with "use everything from OneDrive" and A\'s data wins; B\'s own additions are only kept in the safety copy', async () => {

    startInSync([shared])

    actAs('A')
    setLocalPatients([
      { ...localPatients()[0], name: 'Ahmed (A edit)', updatedAt: '2026-04-01T09:00:00.000Z' },
    ])
    await pushLocalSnapshot()

    actAs('B')
    setLocalPatients([
      ...localPatients(),
      makePatient({ id: 'b-new', patientNumber: 2, name: 'Added On B', createdAt: '2026-04-02T10:00:00.000Z', updatedAt: '2026-04-02T10:00:00.000Z' }),
    ])

    expect((await pullCloudSnapshot()).status).toBe('diverged')

    await resolveOnThisDevice(() => chooseAllFromCloud())

    expect(patientView(oneDrive.doc as CloudSyncDocument)).toEqual({
      shared: '1:Ahmed (A edit)',
    })

    // A already matches OneDrive; a plain sync keeps everything equal.
    actAs('A')
    await pullCloudSnapshot()

    expectEverythingConverged()

    // B's discarded patient is not lost: it is in the safety copies on OneDrive and on B.
    const savedNames = [...oneDrive.files.keys()]

    expect(savedNames.filter(n => n.endsWith('-device.json'))).toHaveLength(1)

    const deviceCopy = oneDrive.files.get(savedNames.find(n => n.endsWith('-device.json'))!) as {
      document: CloudSyncDocument
    }

    expect(deviceCopy.document.patients.map(p => p.id).sort()).toEqual(['b-new', 'shared'])

    actAs('B')
    const { readLocalSafetyCopies } = await import('./syncResolutionSafetyCopy')

    expect(readLocalSafetyCopies()[0].device.patients.map(p => p.id).sort()).toEqual(['b-new', 'shared'])

  })

  it('both devices handed out the same patient number: the collision is caught, fixed during the resolution, and both end clean', async () => {

    startInSync([shared])

    actAs('A')
    setLocalPatients([
      ...localPatients(),
      makePatient({ id: 'a-five', patientNumber: 5, name: 'Five On A', createdAt: '2026-04-01T09:00:00.000Z', updatedAt: '2026-04-01T09:00:00.000Z' }),
    ])
    await pushLocalSnapshot()

    actAs('B')
    setLocalPatients([
      ...localPatients(),
      makePatient({ id: 'b-five', patientNumber: 5, name: 'Five On B', createdAt: '2026-04-02T09:00:00.000Z', updatedAt: '2026-04-02T09:00:00.000Z' }),
    ])

    expect((await pullCloudSnapshot()).status).toBe('diverged')

    await openController()

    // Keep both new patients: that puts two different patients on #5.
    chooseAllFromDevice()
    setChoice(recordKey('patient', 'a-five'), 'cloud')

    expect(getControllerState().base!.collisions).toHaveLength(1)

    // Until it is fixed, the summary cannot be reviewed - so nothing can be applied.
    // The default keeper keeps #5 and the other patient gets the next free number;
    // here the dentist makes A's patient keep it.
    chooseNumberKeeper(5, 'a-five')

    expect(getControllerState().numberFixes).toEqual({ 'b-five': 6 })
    expect(getControllerState().canReviewSummary).toBe(true)

    goToSummary()

    expect(getControllerState().summary!.renumbered).toEqual(['Five On B: #5 -> #6'])

    await applyNow()

    expect(getControllerState().phase).toBe('done')

    actAs('A')
    await pullCloudSnapshot()

    expect(patientView(oneDrive.doc as CloudSyncDocument)).toEqual({
      shared: '1:Ahmed S.',
      'a-five': '5:Five On A',
      'b-five': '6:Five On B',
    })

    expectEverythingConverged()

  })

  it('a patient deleted on A and untouched on B shows as "only on this device" with the probably-deleted warning, and is NOT resurrected unless chosen and acknowledged', async () => {

    const gone = makePatient({
      id: 'gone',
      patientNumber: 2,
      name: 'Deleted On A',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })

    startInSync([shared, gone])

    // A deletes the patient and syncs.
    actAs('A')
    setLocalPatients(localPatients().filter(p => p.id !== 'gone'))
    await pushLocalSnapshot()

    // B edits something else, so B is dirty while the cloud has moved.
    actAs('B')
    setLocalPatients([
      { ...localPatients()[0], name: 'Ahmed Edited On B', updatedAt: '2026-04-02T09:00:00.000Z' },
      localPatients()[1],
    ])

    expect((await pullCloudSnapshot()).status).toBe('diverged')

    await openController()

    const state = getControllerState()

    const goneRow = state.view!.sections[0].groups.deviceOnly.rows.find(row => row.id === 'gone')!

    expect(goneRow.warn).toBe(true)
    expect(goneRow.hint).toContain('probably DELETED from OneDrive')
    expect(goneRow.undecided).toBe(true)

    // Leave it out: the deletion stands.
    setChoice(recordKey('patient', 'gone'), 'omit')
    setChoice(recordKey('patient', 'shared'), 'device')

    goToSummary()

    expect(getControllerState().summary!.requiresAcknowledgement).toBe(false)

    await applyNow()

    expect(patientView(oneDrive.doc as CloudSyncDocument)).toEqual({
      shared: '1:Ahmed Edited On B',
    })

    actAs('A')
    await pullCloudSnapshot()

    expectEverythingConverged()

  })

})
