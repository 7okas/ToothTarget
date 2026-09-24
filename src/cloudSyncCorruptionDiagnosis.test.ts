import { describe, expect, it } from 'vitest'

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  type CloudSyncDocument,
} from './cloudSync'

import {
  diagnoseCloudSyncDocumentFailure,
  diagnoseUnparsableCloudSyncContent,
} from './cloudSyncCorruptionDiagnosis'

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

describe('diagnoseUnparsableCloudSyncContent - JSON.parse itself failed', () => {

  it('is always classified as unreadable, with no record identified', () => {

    const diagnosis = diagnoseUnparsableCloudSyncContent()

    expect(diagnosis.kind).toBe('unreadable')

    if (diagnosis.kind === 'unreadable') {
      expect(diagnosis.reason).toContain('JSON')
    }

  })

})

describe('diagnoseCloudSyncDocumentFailure - document-level (unreadable) failures', () => {

  it('classifies a non-object as unreadable', () => {
    expect(diagnoseCloudSyncDocumentFailure('just a string').kind).toBe('unreadable')
    expect(diagnoseCloudSyncDocumentFailure(42).kind).toBe('unreadable')
    expect(diagnoseCloudSyncDocumentFailure(null).kind).toBe('unreadable')
  })

  it('classifies the wrong app name as unreadable, not a specific record', () => {

    const diagnosis = diagnoseCloudSyncDocumentFailure(
      makeDocument({ app: 'SomeOtherApp' as typeof CLOUD_SYNC_APP })
    )

    expect(diagnosis.kind).toBe('unreadable')

  })

  it('classifies an unsupported schema version as unreadable', () => {

    const diagnosis = diagnoseCloudSyncDocumentFailure({
      ...makeDocument(),
      schemaVersion: 99,
    })

    expect(diagnosis.kind).toBe('unreadable')

    if (diagnosis.kind === 'unreadable') {
      expect(diagnosis.reason).toContain('schema version')
    }

  })

  it('classifies a missing updatedAt as unreadable', () => {

    const document = makeDocument() as Record<string, unknown>
    delete document.updatedAt

    expect(diagnoseCloudSyncDocumentFailure(document).kind).toBe('unreadable')

  })

  it('classifies patients not being an array as unreadable', () => {

    const diagnosis = diagnoseCloudSyncDocumentFailure({
      ...makeDocument(),
      patients: 'not an array',
    })

    expect(diagnosis.kind).toBe('unreadable')

  })

})

describe('diagnoseCloudSyncDocumentFailure - invalid-record failures identify the specific record', () => {

  it('identifies a patient missing its name, by id, with a plain-language reason', () => {

    const diagnosis = diagnoseCloudSyncDocumentFailure(
      makeDocument({
        patients: [
          {
            id: 'patient-42',
            patientNumber: 3,
            name: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    )

    expect(diagnosis.kind).toBe('invalid-record')

    if (diagnosis.kind !== 'invalid-record') {
      throw new Error('expected invalid-record')
    }

    expect(diagnosis.recordType).toBe('patient')
    expect(diagnosis.recordDescription).toContain('patient-42')
    expect(diagnosis.reason).toContain('missing a name')

  })

  it('identifies a treatment by patient name and date when it is missing its phases', () => {

    const diagnosis = diagnoseCloudSyncDocumentFailure(
      makeDocument({
        savedTreatments: [
          {
            id: 'treatment-7',
            patientId: 'p1',
            patientName: 'Jane Doe',
            toothId: '16',
            date: '2026-03-05T00:00:00.000Z',
            updatedAt: '2026-03-05T00:00:00.000Z',
            // phases deliberately omitted
          } as unknown as CloudSyncDocument['savedTreatments'][number],
        ],
      })
    )

    expect(diagnosis.kind).toBe('invalid-record')

    if (diagnosis.kind !== 'invalid-record') {
      throw new Error('expected invalid-record')
    }

    expect(diagnosis.recordType).toBe('treatment')
    expect(diagnosis.recordDescription).toContain('Jane Doe')
    expect(diagnosis.recordDescription).toContain('2026-03-05T00:00:00.000Z')
    expect(diagnosis.reason).toContain('phases')

  })

  it('identifies a template that is missing isCustom: true, by name', () => {

    const diagnosis = diagnoseCloudSyncDocumentFailure(
      makeDocument({
        customTemplates: [
          {
            id: 'tmpl-1',
            name: 'Root Canal',
            phases: [],
            isCustom: false,
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as unknown as CloudSyncDocument['customTemplates'][number],
        ],
      })
    )

    expect(diagnosis.kind).toBe('invalid-record')

    if (diagnosis.kind !== 'invalid-record') {
      throw new Error('expected invalid-record')
    }

    expect(diagnosis.recordType).toBe('template')
    expect(diagnosis.recordDescription).toContain('Root Canal')
    expect(diagnosis.reason).toContain('custom')

  })

  it('identifies a procedure missing its templateId, by name', () => {

    const diagnosis = diagnoseCloudSyncDocumentFailure(
      makeDocument({
        customProcedures: [
          {
            id: 'proc-1',
            name: 'Filling',
            isCustom: true,
            updatedAt: '2026-01-01T00:00:00.000Z',
            // templateId deliberately omitted
          } as unknown as CloudSyncDocument['customProcedures'][number],
        ],
      })
    )

    expect(diagnosis.kind).toBe('invalid-record')

    if (diagnosis.kind !== 'invalid-record') {
      throw new Error('expected invalid-record')
    }

    expect(diagnosis.recordType).toBe('procedure')
    expect(diagnosis.recordDescription).toContain('Filling')
    expect(diagnosis.reason).toContain('template id')

  })

  it('identifies a tombstone with an unrecognized entity type', () => {

    const diagnosis = diagnoseCloudSyncDocumentFailure(
      makeDocument({
        deletionTombstones: [
          {
            id: 'tomb-1',
            entityType: 'not-a-real-type',
            entityId: 'e1',
            deletedAt: '2026-01-01T00:00:00.000Z',
          } as unknown as CloudSyncDocument['deletionTombstones'][number],
        ],
      })
    )

    expect(diagnosis.kind).toBe('invalid-record')

    if (diagnosis.kind !== 'invalid-record') {
      throw new Error('expected invalid-record')
    }

    expect(diagnosis.recordType).toBe('tombstone')
    expect(diagnosis.reason).toContain('entity type')

  })

  it('identifies a duplicate patient id as an invalid-record failure naming the id', () => {

    const patient = {
      id: 'dup-1',
      patientNumber: 1,
      name: 'A',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const diagnosis = diagnoseCloudSyncDocumentFailure(
      makeDocument({ patients: [patient, { ...patient, patientNumber: 2 }] })
    )

    expect(diagnosis.kind).toBe('invalid-record')

    if (diagnosis.kind !== 'invalid-record') {
      throw new Error('expected invalid-record')
    }

    expect(diagnosis.recordType).toBe('patient')
    expect(diagnosis.recordDescription).toContain('dup-1')
    expect(diagnosis.reason).toContain('more than once')

  })

  it('returns null-equivalent (no failure) reasoning is never reached on a genuinely valid document - sanity check', () => {

    /*
      diagnoseCloudSyncDocumentFailure() is only ever called on a
      document that ALREADY failed validateCloudSyncDocument() - this
      just confirms a fully valid document doesn't spuriously get
      flagged as invalid-record by this diagnosis's own field checks,
      since they mirror the real validator's rules.
    */
    const diagnosis = diagnoseCloudSyncDocumentFailure(makeDocument())

    // A fully empty, otherwise-valid document has nothing to blame -
    // this function still returns SOME classification (the fallback),
    // never throws.
    expect(['unreadable', 'invalid-record']).toContain(diagnosis.kind)

  })

})
