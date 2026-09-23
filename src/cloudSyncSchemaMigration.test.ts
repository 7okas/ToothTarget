import { describe, expect, it } from 'vitest'
import { migrateCloudSyncDocumentShape } from './cloudSyncSchemaMigration'
import {
  validateCloudSyncDocument,
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
} from './cloudSync'

function makeDocument(overrides: Record<string, unknown> = {}) {
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

function makePatient(overrides: Record<string, unknown> = {}) {
  return {
    id: 'patient-1',
    patientNumber: 1,
    name: 'Jane Doe',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeTreatment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'treatment-1',
    patientId: 'patient-1',
    patientName: 'Jane Doe',
    toothId: '11',
    phases: [],
    completedAt: '2025-03-01T00:00:00.000Z',
    date: '2025-03-01',
    updatedAt: '2025-03-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('migrateCloudSyncDocumentShape - patient createdAt backfill', () => {

  it('backfills a missing createdAt from the patient\'s own updatedAt, and the migrated document then passes strict validation', () => {

    const { createdAt: _drop, ...patientWithoutCreatedAt } =
      makePatient({ updatedAt: '2025-06-01T00:00:00.000Z' })

    const document = makeDocument({ patients: [patientWithoutCreatedAt] })

    const migrated = migrateCloudSyncDocumentShape(document) as any

    expect(migrated.patients[0].createdAt).toBe('2025-06-01T00:00:00.000Z')

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(true)

  })

  it('never overwrites a createdAt that is already a valid, different timestamp', () => {

    const patient = makePatient({
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
    })

    const document = makeDocument({ patients: [patient] })

    const migrated = migrateCloudSyncDocumentShape(document) as any

    expect(migrated.patients[0].createdAt).toBe('2024-01-01T00:00:00.000Z')

  })

  it('leaves a patient untouched (no fabricated createdAt) when updatedAt is ALSO missing, so validation still correctly rejects it', () => {

    const { createdAt: _drop, updatedAt: _drop2, ...bothMissing } =
      makePatient()

    const document = makeDocument({ patients: [bothMissing] })

    const migrated = migrateCloudSyncDocumentShape(document) as any

    expect(migrated.patients[0].createdAt).toBeUndefined()

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(false)

  })

})

describe('migrateCloudSyncDocumentShape - saved treatment updatedAt backfill', () => {

  it('backfills a missing updatedAt from completedAt, and the migrated document then passes strict validation', () => {

    const { updatedAt: _drop, ...treatmentWithoutUpdatedAt } =
      makeTreatment({ completedAt: '2025-03-05T00:00:00.000Z' })

    const document = makeDocument({
      savedTreatments: [treatmentWithoutUpdatedAt],
    })

    const migrated = migrateCloudSyncDocumentShape(document) as any

    expect(migrated.savedTreatments[0].updatedAt).toBe('2025-03-05T00:00:00.000Z')

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(true)

  })

  it('falls back to date when completedAt is also missing/invalid', () => {

    const { updatedAt: _drop, completedAt: _drop2, ...treatment } =
      makeTreatment({ date: '2025-03-09' })

    const document = makeDocument({ savedTreatments: [treatment] })

    const migrated = migrateCloudSyncDocumentShape(document) as any

    expect(migrated.savedTreatments[0].updatedAt).toBe('2025-03-09')

  })

  it('never overwrites an updatedAt that is already a valid, different timestamp', () => {

    const treatment = makeTreatment({
      updatedAt: '2025-04-01T00:00:00.000Z',
      completedAt: '2025-03-01T00:00:00.000Z',
    })

    const document = makeDocument({ savedTreatments: [treatment] })

    const migrated = migrateCloudSyncDocumentShape(document) as any

    expect(migrated.savedTreatments[0].updatedAt).toBe('2025-04-01T00:00:00.000Z')

  })

  it('leaves a treatment untouched (no fabricated updatedAt) when completedAt and date are ALSO missing, so validation still correctly rejects it', () => {

    const { updatedAt: _drop, completedAt: _drop2, date: _drop3, ...treatment } =
      makeTreatment()

    const document = makeDocument({ savedTreatments: [treatment] })

    const migrated = migrateCloudSyncDocumentShape(document) as any

    expect(migrated.savedTreatments[0].updatedAt).toBeUndefined()

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(false)

  })

})

describe('migrateCloudSyncDocumentShape - genuine corruption is never masked', () => {

  it('still rejects a document where a patient has a wrong-typed field unrelated to the backfilled fields', () => {

    const corruptPatient = makePatient({ patientNumber: 'not-a-number' })

    const document = makeDocument({ patients: [corruptPatient] })

    const migrated = migrateCloudSyncDocumentShape(document)

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(false)

  })

  it('still rejects a document where a saved treatment has a wrong-typed field unrelated to updatedAt', () => {

    const corruptTreatment = makeTreatment({ phases: 'not-an-array' })

    const document = makeDocument({ savedTreatments: [corruptTreatment] })

    const migrated = migrateCloudSyncDocumentShape(document)

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(false)

  })

  it('does not throw and passes non-document input straight through untouched', () => {

    expect(migrateCloudSyncDocumentShape(null)).toBe(null)
    expect(migrateCloudSyncDocumentShape('not a document')).toBe('not a document')
    expect(migrateCloudSyncDocumentShape(42)).toBe(42)

  })

})

describe('migrateCloudSyncDocumentShape - already up-to-date document', () => {

  it('passes a fully current document through with every field unchanged', () => {

    const patient = makePatient()
    const treatment = makeTreatment()

    const document = makeDocument({
      patients: [patient],
      savedTreatments: [treatment],
    })

    const migrated = migrateCloudSyncDocumentShape(document)

    expect(migrated).toEqual(document)

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(true)

  })

})
