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

import { mergeCloudSyncDocuments } from './cloudMerge'

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
