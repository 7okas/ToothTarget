import { describe, expect, it } from 'vitest'

import type { Patient, SavedTreatment, DeletionTombstone } from './App'
import { findStaleReviewCandidates } from './staleRecordReview'

/*
  Realistic factories, same pattern cloudMerge.test.ts/
  cloudSyncEngine.test.ts already use.
*/

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
    phaseRecords: [],
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

function makeTombstone(
  overrides: Partial<DeletionTombstone> = {}
): DeletionTombstone {
  return {
    id: 'tombstone-1',
    entityType: 'patient',
    entityId: 'patient-1',
    deletedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('findStaleReviewCandidates', () => {

  it('flags a local patient absent from the cloud and untombstoned as a candidate', () => {

    const localOnly = makePatient({ id: 'local-only', patientNumber: 5 })

    const candidates = findStaleReviewCandidates({
      localPatients: [localOnly],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [],
      remoteTombstones: [],
    })

    expect(candidates).toEqual([
      {
        patientId: 'local-only',
        patientNumber: 5,
        name: 'Jane Doe',
        completedTreatmentCount: 0,
        lastEditedAt: '2026-01-01T00:00:00.000Z',
      },
    ])

  })

  it('never flags a patient already present on the cloud document', () => {

    const synced = makePatient({ id: 'already-synced' })

    const candidates = findStaleReviewCandidates({
      localPatients: [synced],
      localSavedTreatments: [],
      remotePatients: [synced],
      localTombstones: [],
      remoteTombstones: [],
    })

    expect(candidates).toEqual([])

  })

  it('never flags a patient with a LOCAL deletion tombstone (already headed for deletion)', () => {

    const patient = makePatient({ id: 'locally-deleted' })

    const candidates = findStaleReviewCandidates({
      localPatients: [patient],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'locally-deleted' }),
      ],
      remoteTombstones: [],
    })

    expect(candidates).toEqual([])

  })

  it('never flags a patient with a REMOTE deletion tombstone either', () => {

    const patient = makePatient({ id: 'deleted-on-cloud' })

    const candidates = findStaleReviewCandidates({
      localPatients: [patient],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [],
      remoteTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'deleted-on-cloud' }),
      ],
    })

    expect(candidates).toEqual([])

  })

  it('ignores a tombstone for a different entity type with the same id', () => {

    const patient = makePatient({ id: 'shared-id' })

    const candidates = findStaleReviewCandidates({
      localPatients: [patient],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [
        makeTombstone({ entityType: 'procedureTemplate', entityId: 'shared-id' }),
      ],
      remoteTombstones: [],
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0].patientId).toBe('shared-id')

  })

  it('counts only THIS patient\'s completed treatments', () => {

    const patient = makePatient({ id: 'p1' })
    const otherPatient = makePatient({ id: 'p2', patientNumber: 2 })

    const candidates = findStaleReviewCandidates({
      localPatients: [patient, otherPatient],
      localSavedTreatments: [
        makeSavedTreatment({ id: 't1', patientId: 'p1' }),
        makeSavedTreatment({ id: 't2', patientId: 'p1' }),
        makeSavedTreatment({ id: 't3', patientId: 'p2' }),
      ],
      remotePatients: [],
      localTombstones: [],
      remoteTombstones: [],
    })

    const forP1 = candidates.find(candidate => candidate.patientId === 'p1')
    const forP2 = candidates.find(candidate => candidate.patientId === 'p2')

    expect(forP1?.completedTreatmentCount).toBe(2)
    expect(forP2?.completedTreatmentCount).toBe(1)

  })

  it('is a decision AID only - a candidate with an old lastEditedAt is still returned, never auto-skipped', () => {

    const veryOldPatient = makePatient({
      id: 'ancient',
      updatedAt: '2020-01-01T00:00:00.000Z',
    })

    const candidates = findStaleReviewCandidates({
      localPatients: [veryOldPatient],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [],
      remoteTombstones: [],
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0].lastEditedAt).toBe('2020-01-01T00:00:00.000Z')

  })

  it('sorts candidates by patient number for a stable, predictable review order', () => {

    const candidates = findStaleReviewCandidates({
      localPatients: [
        makePatient({ id: 'c', patientNumber: 30 }),
        makePatient({ id: 'a', patientNumber: 10 }),
        makePatient({ id: 'b', patientNumber: 20 }),
      ],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [],
      remoteTombstones: [],
    })

    expect(candidates.map(candidate => candidate.patientId)).toEqual([
      'a',
      'b',
      'c',
    ])

  })

  it('returns no candidates when local and remote patient sets already match', () => {

    const patient = makePatient()

    const candidates = findStaleReviewCandidates({
      localPatients: [patient],
      localSavedTreatments: [],
      remotePatients: [patient],
      localTombstones: [],
      remoteTombstones: [],
    })

    expect(candidates).toEqual([])

  })

  /*
    KEEP / DISCARD BEHAVIOR AT THE DATA LAYER

    This project has no React test harness (see
    patientDeletionCascade.ts's own header comment) - App.tsx's actual
    "Keep"/"Discard" buttons are thin UI wrappers with no decision logic
    of their own; the only genuine LOGIC behind each choice is exactly
    what this pure module already computes candidates from. These two
    tests exercise that logic directly, the same way this project tests
    every other UI-adjacent decision (patientDeletionCascade.test.ts,
    patientRenameCascade.test.ts): "discard" is modeled as the app's
    normal deletion path having already run (a tombstone now exists,
    reusing deletePatientRecordAndCascade() - see App.tsx), and "keep"
    is modeled as the patient having successfully reached the cloud on
    the resumed sync (see cloudSyncEngine.test.ts's own end-to-end
    stale-review-gate tests for the full round trip through real
    production code).
  */

  it('models "discard": once a candidate is tombstoned, it no longer appears on the next check', () => {

    const patient = makePatient({ id: 'to-discard' })

    const beforeDiscard = findStaleReviewCandidates({
      localPatients: [patient],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [],
      remoteTombstones: [],
    })

    expect(beforeDiscard).toHaveLength(1)

    // App.tsx's confirmDiscardStaleReviewPatient() -> deletePatientRecordAndCascade()
    // removes the patient locally and records exactly this tombstone.
    const afterDiscard = findStaleReviewCandidates({
      localPatients: [],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'to-discard' }),
      ],
      remoteTombstones: [],
    })

    expect(afterDiscard).toEqual([])

  })

  it('models "keep": once a kept candidate reaches the cloud, it no longer appears on the next check', () => {

    const patient = makePatient({ id: 'to-keep' })

    const beforeSync = findStaleReviewCandidates({
      localPatients: [patient],
      localSavedTreatments: [],
      remotePatients: [],
      localTombstones: [],
      remoteTombstones: [],
    })

    expect(beforeSync).toHaveLength(1)

    // "Keep" writes nothing - the patient simply reaches the cloud on
    // the resumed (skip-gate) sync, exactly like any ordinary patient.
    const afterSync = findStaleReviewCandidates({
      localPatients: [patient],
      localSavedTreatments: [],
      remotePatients: [patient],
      localTombstones: [],
      remoteTombstones: [],
    })

    expect(afterSync).toEqual([])

  })

})
