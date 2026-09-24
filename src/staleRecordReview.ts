import type { Patient, SavedTreatment, DeletionTombstone } from './App'

/*
  STALE-RECORD REVIEW (Phase 4.7)

  Pure candidate-detection for the stale-device review screen -
  extracted out of cloudSyncEngine.ts for the same reason
  patientDeletionCascade.ts/patientRenameCascade.ts were: it can be
  unit-tested directly, with no localStorage, no network, and no
  dependency on App.tsx's own runtime module graph (only type-only
  imports are taken from it, erased at compile time under
  verbatimModuleSyntax - same pattern every other pure decision module
  in this project already follows).

  WHAT COUNTS AS A CANDIDATE
  ============================================================
  Only called once cloudSyncEngine.ts's own isDeviceSyncStale() check
  (deviceSyncTracking.ts) has already confirmed this device hasn't
  completed a real sync in over the stale threshold - this module has
  no opinion on timing at all, purely on WHICH local patients are
  worth asking the dentist about.

  A patient is a candidate when it exists in this device's local data
  but:
    - is NOT present (by id) in the cloud document this sync attempt
      just read, AND
    - has NO deletion tombstone anywhere (locally recorded, or already
      on the cloud) targeting its id.

  That combination means "this device is the only place that knows
  this patient exists, and nothing has decided to delete it" - exactly
  the situation where a device that's been out of the loop for a long
  time could otherwise silently upload a patient nobody else has ever
  reviewed (a genuinely new patient entered while offline, which is
  fine - but also, potentially, stale test/mistake data nobody got
  around to cleaning up before the device went quiet). A patient that
  already carries a tombstone is excluded on purpose: it's already
  headed for deletion through the normal merge/suppression path
  (cloudMerge.ts), so asking the dentist to re-decide it here would be
  redundant, not protective.

  lastEditedAt/completedTreatmentCount are included purely as a
  decision AID for the review screen to display - this module never
  uses either one to filter, sort out, or auto-decide any candidate;
  every patient that matches the two conditions above is returned,
  full stop, per this phase's own requirement that the date must never
  silently skip a patient from review.
*/

export type StaleReviewCandidate = {
  patientId: string
  patientNumber: number
  name: string
  completedTreatmentCount: number
  lastEditedAt: string
}

export function findStaleReviewCandidates(input: {
  localPatients: Patient[]
  localSavedTreatments: SavedTreatment[]
  remotePatients: Patient[]
  localTombstones: DeletionTombstone[]
  remoteTombstones: DeletionTombstone[]
}): StaleReviewCandidate[] {

  const remotePatientIds = new Set(
    input.remotePatients.map(patient => patient.id)
  )

  const tombstonedPatientIds = new Set(
    [...input.localTombstones, ...input.remoteTombstones]
      .filter(tombstone => tombstone.entityType === 'patient')
      .map(tombstone => tombstone.entityId)
  )

  const candidates = input.localPatients.filter(
    patient =>
      !remotePatientIds.has(patient.id) &&
      !tombstonedPatientIds.has(patient.id)
  )

  return candidates
    .map(patient => ({
      patientId: patient.id,
      patientNumber: patient.patientNumber,
      name: patient.name,
      completedTreatmentCount: input.localSavedTreatments.filter(
        treatment => treatment.patientId === patient.id
      ).length,
      lastEditedAt: patient.updatedAt,
    }))
    .sort((a, b) => a.patientNumber - b.patientNumber)

}
