import { describe, expect, it } from 'vitest'

import type {
  Patient,
  SavedTreatment,
  ProcedureTemplate,
  Procedure,
  DeletionTombstone,
} from './App'

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  type CloudSyncDocument,
} from './cloudSync'

import {
  mergeCloudSyncDocuments,
  pruneExpiredTombstones,
  TOMBSTONE_EXPIRY_MS,
} from './cloudMerge'

/*
  Realistic factories for the actual application types (not `as any`)
  - every field a real Patient/SavedTreatment/ProcedureTemplate/
  Procedure/DeletionTombstone carries is filled in with a sensible
  default, so each test only needs to override the one or two fields
  it's actually exercising.
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

function makeTemplate(
  overrides: Partial<ProcedureTemplate> = {}
): ProcedureTemplate {
  return {
    id: 'template-1',
    name: 'Custom Template',
    isCustom: true,
    phases: [{ name: 'Phase 1', duration: 600 }],
    specializationId: 'general',
    procedureKey: 'general',
    typeId: 'general',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: 'procedure-1',
    name: 'Custom Procedure',
    isCustom: true,
    templateId: 'template-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

function makeDocument(
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
    deletionTombstones: [],
    ...overrides,
  }
}

describe('mergeCloudSyncDocuments - patients', () => {

  it('keeps a local-only patient', () => {

    const local = makeDocument({ patients: [makePatient({ id: 'a' })] })
    const remote = makeDocument()

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.patients.map(p => p.id)).toEqual(['a'])

  })

  it('keeps a remote-only patient', () => {

    const local = makeDocument()
    const remote = makeDocument({ patients: [makePatient({ id: 'a' })] })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.patients.map(p => p.id)).toEqual(['a'])

  })

  it('deduplicates the same patient UUID present on both sides', () => {

    const patient = makePatient({ id: 'a' })
    const local = makeDocument({ patients: [patient] })
    const remote = makeDocument({ patients: [{ ...patient }] })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.patients).toHaveLength(1)
    expect(result.document.patients[0]).toEqual(patient)

  })

  it('two different UUIDs sharing a patient number produce a conflict', () => {

    const local = makeDocument({
      patients: [makePatient({ id: 'a', patientNumber: 12 })],
    })

    const remote = makeDocument({
      patients: [makePatient({ id: 'b', patientNumber: 12 })],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.patientNumberConflicts).toEqual([
      { patientNumber: 12, patientIds: ['a', 'b'] },
    ])

  })

  it('does not renumber either patient when a conflict is found', () => {

    const local = makeDocument({
      patients: [makePatient({ id: 'a', patientNumber: 12 })],
    })

    const remote = makeDocument({
      patients: [makePatient({ id: 'b', patientNumber: 12 })],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    const numbers = result.document.patients
      .sort((x, y) => (x.id < y.id ? -1 : 1))
      .map(p => p.patientNumber)

    expect(numbers).toEqual([12, 12])

  })

})

describe('mergeCloudSyncDocuments - patient tombstones', () => {

  it('a patient tombstone suppresses the patient', () => {

    const local = makeDocument({
      patients: [makePatient({ id: 'a' })],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'a' }),
      ],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.patients).toEqual([])
    expect(result.document.deletionTombstones).toHaveLength(1)

  })

  it("a patient tombstone suppresses that patient's saved treatments", () => {

    const local = makeDocument({
      patients: [makePatient({ id: 'a' })],
      savedTreatments: [
        makeSavedTreatment({ id: 't1', patientId: 'a' }),
        makeSavedTreatment({ id: 't2', patientId: 'other-patient' }),
      ],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'a' }),
      ],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.savedTreatments.map(t => t.id)).toEqual(['t2'])

  })

  it('a remote tombstone suppresses a local live record', () => {

    const local = makeDocument({
      patients: [makePatient({ id: 'a' })],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'a' }),
      ],
    })

    const forward = mergeCloudSyncDocuments(local, remote)
    const reversed = mergeCloudSyncDocuments(remote, local)

    expect(forward.document.patients).toEqual([])
    expect(reversed.document.patients).toEqual([])

  })

})

describe('mergeCloudSyncDocuments - custom templates', () => {

  it('a template tombstone suppresses the custom template', () => {

    const local = makeDocument({
      customTemplates: [makeTemplate({ id: 'tmpl-a' })],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({
          entityType: 'procedureTemplate',
          entityId: 'tmpl-a',
        }),
      ],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.customTemplates).toEqual([])

  })

  it('a template tombstone does not delete a procedure referencing it', () => {

    const local = makeDocument({
      customTemplates: [makeTemplate({ id: 'tmpl-a' })],
      customProcedures: [
        makeProcedure({ id: 'proc-a', templateId: 'tmpl-a' }),
      ],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({
          entityType: 'procedureTemplate',
          entityId: 'tmpl-a',
        }),
      ],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.customTemplates).toEqual([])
    expect(result.document.customProcedures.map(p => p.id)).toEqual([
      'proc-a',
    ])

  })

  it('same template id: newer updatedAt wins', () => {

    const older = makeTemplate({
      id: 'tmpl-a',
      name: 'Older content',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const newer = makeTemplate({
      id: 'tmpl-a',
      name: 'Newer content',
      updatedAt: '2026-06-01T00:00:00.000Z',
    })

    const local = makeDocument({ customTemplates: [older] })
    const remote = makeDocument({ customTemplates: [newer] })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.customTemplates).toEqual([newer])

  })

  it('same template id: older updatedAt never overwrites newer content', () => {

    const older = makeTemplate({
      id: 'tmpl-a',
      name: 'Older content',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const newer = makeTemplate({
      id: 'tmpl-a',
      name: 'Newer content',
      updatedAt: '2026-06-01T00:00:00.000Z',
    })

    // Reversed argument order from the previous test.
    const local = makeDocument({ customTemplates: [newer] })
    const remote = makeDocument({ customTemplates: [older] })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.customTemplates).toEqual([newer])

  })

  it('equal updatedAt timestamps resolve deterministically both ways', () => {

    const templateA = makeTemplate({
      id: 'tmpl-a',
      name: 'Content A',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const templateB = makeTemplate({
      id: 'tmpl-a',
      name: 'Content B',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const forward = mergeCloudSyncDocuments(
      makeDocument({ customTemplates: [templateA] }),
      makeDocument({ customTemplates: [templateB] })
    )

    const reversed = mergeCloudSyncDocuments(
      makeDocument({ customTemplates: [templateB] }),
      makeDocument({ customTemplates: [templateA] })
    )

    expect(forward.document.customTemplates).toEqual(
      reversed.document.customTemplates
    )

    // Deterministic winner, not "whichever came first": running the
    // exact same forward comparison twice must pick the same template.
    const forwardAgain = mergeCloudSyncDocuments(
      makeDocument({ customTemplates: [templateA] }),
      makeDocument({ customTemplates: [templateB] })
    )

    expect(forward.document.customTemplates).toEqual(
      forwardAgain.document.customTemplates
    )

  })

})

describe('mergeCloudSyncDocuments - custom procedures (Phase 5.5)', () => {

  it('unions custom procedures by id from both sides', () => {

    const local = makeDocument({
      customProcedures: [makeProcedure({ id: 'proc-local' })],
    })

    const remote = makeDocument({
      customProcedures: [makeProcedure({ id: 'proc-remote' })],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(
      result.document.customProcedures.map(p => p.id).sort()
    ).toEqual(['proc-local', 'proc-remote'])

  })

  it('same procedure id: newer updatedAt wins', () => {

    const older = makeProcedure({
      id: 'proc-a',
      name: 'Older name',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const newer = makeProcedure({
      id: 'proc-a',
      name: 'Newer name',
      updatedAt: '2026-06-01T00:00:00.000Z',
    })

    const local = makeDocument({ customProcedures: [older] })
    const remote = makeDocument({ customProcedures: [newer] })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.customProcedures).toEqual([newer])

  })

  it('same procedure id: older updatedAt never overwrites newer content, regardless of argument order', () => {

    const older = makeProcedure({
      id: 'proc-a',
      name: 'Older name',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const newer = makeProcedure({
      id: 'proc-a',
      name: 'Newer name',
      updatedAt: '2026-06-01T00:00:00.000Z',
    })

    // Reversed argument order from the previous test.
    const local = makeDocument({ customProcedures: [newer] })
    const remote = makeDocument({ customProcedures: [older] })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.customProcedures).toEqual([newer])

  })

  it('equal updatedAt timestamps resolve deterministically both ways', () => {

    const procedureA = makeProcedure({
      id: 'proc-a',
      name: 'Name A',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const procedureB = makeProcedure({
      id: 'proc-a',
      name: 'Name B',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const forward = mergeCloudSyncDocuments(
      makeDocument({ customProcedures: [procedureA] }),
      makeDocument({ customProcedures: [procedureB] })
    )

    const reversed = mergeCloudSyncDocuments(
      makeDocument({ customProcedures: [procedureB] }),
      makeDocument({ customProcedures: [procedureA] })
    )

    expect(forward.document.customProcedures).toEqual(
      reversed.document.customProcedures
    )

  })

  it('a procedure tombstone suppresses the custom procedure, from either side', () => {

    const local = makeDocument({
      customProcedures: [makeProcedure({ id: 'proc-a' })],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({ entityType: 'procedure', entityId: 'proc-a' }),
      ],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.customProcedures).toEqual([])

    // Symmetric regardless of which side carries the tombstone.
    const reversed = mergeCloudSyncDocuments(remote, local)

    expect(reversed.document.customProcedures).toEqual([])

  })

  it('does not confuse a procedure tombstone with a template/patient/treatment tombstone for the same id', () => {

    const local = makeDocument({
      customProcedures: [makeProcedure({ id: 'shared-id' })],
      customTemplates: [makeTemplate({ id: 'shared-id' })],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'shared-id' }),
        makeTombstone({ entityType: 'treatment', entityId: 'shared-id' }),
      ],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    // Neither the procedure nor the template is suppressed - only a
    // 'procedure'/'procedureTemplate' tombstone (respectively) would do
    // that, and neither is present here.
    expect(result.document.customProcedures.map(p => p.id)).toEqual([
      'shared-id',
    ])
    expect(result.document.customTemplates.map(t => t.id)).toEqual([
      'shared-id',
    ])

  })

  /*
    CRITICAL CONSTRAINT (section 6 of this phase's brief): deleting a
    procedure must never affect a past treatment that already used it.
    SavedTreatment carries its own denormalized procedureId/
    procedureName snapshot - this merge engine's own survivingSaved
    Treatments filter (see mergeCloudSyncDocuments() itself) is never
    conditioned on tombstonedProcedureIds, only on
    tombstonedPatientIds/tombstonedTreatmentIds, so a treatment survives
    a procedure's tombstone completely untouched, on both sides of a
    merge.
  */
  it('a procedure tombstone never suppresses a saved treatment that used that procedure', () => {

    const treatment = makeSavedTreatment({
      id: 'treatment-1',
      procedureId: 'proc-a',
    })

    const local = makeDocument({
      customProcedures: [makeProcedure({ id: 'proc-a' })],
      savedTreatments: [treatment],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({ entityType: 'procedure', entityId: 'proc-a' }),
      ],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.customProcedures).toEqual([])
    expect(result.document.savedTreatments).toEqual([treatment])

  })

})

describe('mergeCloudSyncDocuments - saved treatments', () => {

  it('deduplicates the same saved-treatment UUID present on both sides', () => {

    const treatment = makeSavedTreatment({ id: 't1' })

    const local = makeDocument({ savedTreatments: [treatment] })
    const remote = makeDocument({ savedTreatments: [{ ...treatment }] })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.savedTreatments).toHaveLength(1)
    expect(result.document.savedTreatments[0]).toEqual(treatment)

  })

  it('Phase 4.6: a same-id disagreement prefers the newer updatedAt (an edited treatment), not an arbitrary content pick', () => {

    const staleTreatment = makeSavedTreatment({
      id: 't1',
      totalActualDuration: 500,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const editedTreatment = makeSavedTreatment({
      id: 't1',
      totalActualDuration: 700,
      updatedAt: '2026-02-01T00:00:00.000Z',
    })

    // Symmetric regardless of which side is "local" vs "remote".
    const resultA = mergeCloudSyncDocuments(
      makeDocument({ savedTreatments: [staleTreatment] }),
      makeDocument({ savedTreatments: [editedTreatment] })
    )

    const resultB = mergeCloudSyncDocuments(
      makeDocument({ savedTreatments: [editedTreatment] }),
      makeDocument({ savedTreatments: [staleTreatment] })
    )

    expect(resultA.document.savedTreatments).toEqual([editedTreatment])
    expect(resultB.document.savedTreatments).toEqual([editedTreatment])

  })

})

describe('mergeCloudSyncDocuments - tombstone identity', () => {

  it('duplicate logical tombstones collapse to one', () => {

    const local = makeDocument({
      deletionTombstones: [
        makeTombstone({
          id: 'tomb-local',
          entityType: 'patient',
          entityId: 'a',
          deletedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({
          id: 'tomb-remote',
          entityType: 'patient',
          entityId: 'a',
          deletedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.deletionTombstones).toHaveLength(1)

    // Equal deletedAt -> lexicographically smaller tombstone id wins.
    expect(result.document.deletionTombstones[0].id).toBe('tomb-local')

  })

  it('different tombstone UUIDs for the same (entityType, entityId) are one logical deletion', () => {

    const local = makeDocument({
      deletionTombstones: [
        makeTombstone({
          id: 'tomb-1',
          entityType: 'procedureTemplate',
          entityId: 'tmpl-a',
          deletedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    })

    const remote = makeDocument({
      deletionTombstones: [
        makeTombstone({
          id: 'tomb-2',
          entityType: 'procedureTemplate',
          entityId: 'tmpl-a',
          deletedAt: '2026-02-01T00:00:00.000Z',
        }),
      ],
      customTemplates: [makeTemplate({ id: 'tmpl-a' })],
    })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.deletionTombstones).toHaveLength(1)
    // Newer deletedAt wins as the representative.
    expect(result.document.deletionTombstones[0].id).toBe('tomb-2')
    // And it still suppresses the template either way.
    expect(result.document.customTemplates).toEqual([])

  })

})

describe('mergeCloudSyncDocuments - purity and determinism', () => {

  it('does not mutate either input document', () => {

    const local = makeDocument({
      patients: [makePatient({ id: 'a' })],
      savedTreatments: [makeSavedTreatment({ id: 't1', patientId: 'a' })],
      customTemplates: [makeTemplate({ id: 'tmpl-a' })],
      customProcedures: [makeProcedure({ id: 'proc-a' })],
      deletionTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'zzz' }),
      ],
    })

    const remote = makeDocument({
      patients: [makePatient({ id: 'b', patientNumber: 2 })],
    })

    const localSnapshot = JSON.parse(JSON.stringify(local))
    const remoteSnapshot = JSON.parse(JSON.stringify(remote))

    mergeCloudSyncDocuments(local, remote)

    expect(local).toEqual(localSnapshot)
    expect(remote).toEqual(remoteSnapshot)

  })

  it('produces deterministic ordering independent of input order', () => {

    const local = makeDocument({
      patients: [
        makePatient({ id: 'b', patientNumber: 2 }),
        makePatient({ id: 'a', patientNumber: 1 }),
      ],
      savedTreatments: [
        makeSavedTreatment({ id: 't2', patientId: 'b' }),
        makeSavedTreatment({ id: 't1', patientId: 'a' }),
      ],
      customTemplates: [
        makeTemplate({ id: 'tmpl-b' }),
        makeTemplate({ id: 'tmpl-a' }),
      ],
      customProcedures: [
        makeProcedure({ id: 'proc-b' }),
        makeProcedure({ id: 'proc-a' }),
      ],
    })

    const remote = makeDocument()

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.patients.map(p => p.id)).toEqual(['a', 'b'])
    expect(result.document.savedTreatments.map(t => t.id)).toEqual([
      't1',
      't2',
    ])
    expect(result.document.customTemplates.map(t => t.id)).toEqual([
      'tmpl-a',
      'tmpl-b',
    ])
    expect(result.document.customProcedures.map(p => p.id)).toEqual([
      'proc-a',
      'proc-b',
    ])

  })

  it('running the merge with arguments reversed produces the same logical result', () => {

    const local = makeDocument({
      updatedAt: '2026-01-01T00:00:00.000Z',
      patients: [
        makePatient({ id: 'a', patientNumber: 1 }),
        makePatient({ id: 'shared', patientNumber: 5 }),
      ],
      savedTreatments: [makeSavedTreatment({ id: 't1', patientId: 'a' })],
      customTemplates: [
        makeTemplate({
          id: 'tmpl-a',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      customProcedures: [makeProcedure({ id: 'proc-a' })],
      deletionTombstones: [
        makeTombstone({ entityType: 'patient', entityId: 'deleted-1' }),
      ],
    })

    const remote = makeDocument({
      updatedAt: '2026-02-01T00:00:00.000Z',
      patients: [
        makePatient({ id: 'b', patientNumber: 6 }),
        makePatient({ id: 'shared', patientNumber: 5 }),
      ],
      savedTreatments: [makeSavedTreatment({ id: 't2', patientId: 'b' })],
      customTemplates: [
        makeTemplate({
          id: 'tmpl-a',
          name: 'Updated remotely',
          updatedAt: '2026-03-01T00:00:00.000Z',
        }),
      ],
      customProcedures: [makeProcedure({ id: 'proc-b' })],
      deletionTombstones: [],
    })

    const forward = mergeCloudSyncDocuments(local, remote)
    const reversed = mergeCloudSyncDocuments(remote, local)

    expect(forward.document).toEqual(reversed.document)
    expect(forward.patientNumberConflicts).toEqual(
      reversed.patientNumberConflicts
    )

  })

})

describe('mergeCloudSyncDocuments - document metadata', () => {

  it('keeps schemaVersion and app fixed and uses the newer updatedAt', () => {

    const local = makeDocument({ updatedAt: '2026-01-01T00:00:00.000Z' })
    const remote = makeDocument({ updatedAt: '2026-06-01T00:00:00.000Z' })

    const result = mergeCloudSyncDocuments(local, remote)

    expect(result.document.schemaVersion).toBe(CLOUD_SYNC_SCHEMA_VERSION)
    expect(result.document.app).toBe(CLOUD_SYNC_APP)
    expect(result.document.updatedAt).toBe('2026-06-01T00:00:00.000Z')

  })

})

describe('pruneExpiredTombstones', () => {

  const NOW = '2026-06-15T00:00:00.000Z'

  it('keeps a tombstone younger than the expiry window', () => {

    const recent = makeTombstone({
      id: 'recent',
      deletedAt: '2026-06-10T00:00:00.000Z', // 5 days old
    })

    expect(pruneExpiredTombstones([recent], NOW)).toEqual([recent])

  })

  it('drops a tombstone older than the expiry window', () => {

    const ancient = makeTombstone({
      id: 'ancient',
      deletedAt: '2026-01-01T00:00:00.000Z', // ~5 months old
    })

    expect(pruneExpiredTombstones([ancient], NOW)).toEqual([])

  })

  it('keeps a tombstone exactly at the boundary, drops one just past it', () => {

    const atBoundary = makeTombstone({
      id: 'at-boundary',
      deletedAt: new Date(
        Date.parse(NOW) - TOMBSTONE_EXPIRY_MS
      ).toISOString(),
    })

    const justPast = makeTombstone({
      id: 'just-past',
      deletedAt: new Date(
        Date.parse(NOW) - TOMBSTONE_EXPIRY_MS - 1
      ).toISOString(),
    })

    const result = pruneExpiredTombstones([atBoundary, justPast], NOW)

    expect(result.map(tombstone => tombstone.id)).toEqual(['at-boundary'])

  })

  it('respects a custom maxAgeMs override', () => {

    const tenDaysOld = makeTombstone({
      id: 'ten-days',
      deletedAt: '2026-06-05T00:00:00.000Z',
    })

    const oneDayMs = 24 * 60 * 60 * 1000

    expect(pruneExpiredTombstones([tenDaysOld], NOW, oneDayMs)).toEqual([])
    expect(
      pruneExpiredTombstones([tenDaysOld], NOW, 30 * oneDayMs)
    ).toEqual([tenDaysOld])

  })

  it('keeps a tombstone with an unparseable deletedAt rather than guessing', () => {

    const malformed = makeTombstone({
      id: 'malformed',
      deletedAt: 'not-a-real-date',
    })

    expect(pruneExpiredTombstones([malformed], NOW)).toEqual([malformed])

  })

  it('prunes a mix of expired and live tombstones independently, preserving order', () => {

    const live1 = makeTombstone({ id: 'live-1', deletedAt: '2026-06-14T00:00:00.000Z' })
    const expired = makeTombstone({ id: 'expired', deletedAt: '2025-01-01T00:00:00.000Z' })
    const live2 = makeTombstone({ id: 'live-2', deletedAt: '2026-06-01T00:00:00.000Z' })

    const result = pruneExpiredTombstones([live1, expired, live2], NOW)

    expect(result.map(tombstone => tombstone.id)).toEqual(['live-1', 'live-2'])

  })

  it('never mutates the input array', () => {

    const tombstones = [
      makeTombstone({ id: 'a', deletedAt: '2020-01-01T00:00:00.000Z' }),
    ]

    const snapshot = [...tombstones]

    pruneExpiredTombstones(tombstones, NOW)

    expect(tombstones).toEqual(snapshot)

  })

})
