import { describe, expect, it } from 'vitest'
import { migrateCloudSyncDocumentShape } from './cloudSyncSchemaMigration'
import {
  validateCloudSyncDocument,
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
} from './cloudSync'

/*
  Returns a shallow copy of `obj` with the named keys removed -  used
  throughout this file to build a "record missing field X" fixture
  without a `const { x: _drop, ...rest } = obj` destructure, which
  leaves `_drop` an unused binding (@typescript-eslint/no-unused-vars).
*/
function omit<T extends Record<string, unknown>>(
  obj: T,
  ...keys: (keyof T)[]
): Record<string, unknown> {

  const clone: Record<string, unknown> = { ...obj }

  for (const key of keys) {
    delete clone[key as string]
  }

  return clone

}

/*
  What every migrateCloudSyncDocumentShape() result this file inspects
  actually needs to expose - a precise stand-in for the real return
  type (`unknown`, since that function's own input can be anything -
  see its own header comment) so these tests can read
  `.patients[0].createdAt` etc. without `as any`.
*/
type MigratedDocument = {
  patients: Record<string, unknown>[]
  savedTreatments: Record<string, unknown>[]
  customProcedures: Record<string, unknown>[]
}

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

function makeProcedure(overrides: Record<string, unknown> = {}) {
  return {
    id: 'procedure-1',
    name: 'Custom Procedure',
    isCustom: true,
    templateId: 'template-1',
    updatedAt: '2025-02-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('migrateCloudSyncDocumentShape - patient createdAt backfill', () => {

  it('backfills a missing createdAt from the patient\'s own updatedAt, and the migrated document then passes strict validation', () => {

    const patientWithoutCreatedAt = omit(
      makePatient({ updatedAt: '2025-06-01T00:00:00.000Z' }),
      'createdAt'
    )

    const document = makeDocument({ patients: [patientWithoutCreatedAt] })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

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

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.patients[0].createdAt).toBe('2024-01-01T00:00:00.000Z')

  })

  it('leaves a patient untouched (no fabricated createdAt) when updatedAt is ALSO missing, so validation still correctly rejects it', () => {

    const bothMissing = omit(makePatient(), 'createdAt', 'updatedAt')

    const document = makeDocument({ patients: [bothMissing] })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.patients[0].createdAt).toBeUndefined()

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(false)

  })

})

describe('migrateCloudSyncDocumentShape - saved treatment updatedAt backfill', () => {

  it('backfills a missing updatedAt from completedAt, and the migrated document then passes strict validation', () => {

    const treatmentWithoutUpdatedAt = omit(
      makeTreatment({ completedAt: '2025-03-05T00:00:00.000Z' }),
      'updatedAt'
    )

    const document = makeDocument({
      savedTreatments: [treatmentWithoutUpdatedAt],
    })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.savedTreatments[0].updatedAt).toBe('2025-03-05T00:00:00.000Z')

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(true)

  })

  it('falls back to date when completedAt is also missing/invalid', () => {

    const treatment = omit(
      makeTreatment({ date: '2025-03-09' }),
      'updatedAt',
      'completedAt'
    )

    const document = makeDocument({ savedTreatments: [treatment] })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.savedTreatments[0].updatedAt).toBe('2025-03-09')

  })

  it('never overwrites an updatedAt that is already a valid, different timestamp', () => {

    const treatment = makeTreatment({
      updatedAt: '2025-04-01T00:00:00.000Z',
      completedAt: '2025-03-01T00:00:00.000Z',
    })

    const document = makeDocument({ savedTreatments: [treatment] })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.savedTreatments[0].updatedAt).toBe('2025-04-01T00:00:00.000Z')

  })

  it('leaves a treatment untouched (no fabricated updatedAt) when completedAt and date are ALSO missing, so validation still correctly rejects it', () => {

    const treatment = omit(
      makeTreatment(),
      'updatedAt',
      'completedAt',
      'date'
    )

    const document = makeDocument({ savedTreatments: [treatment] })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.savedTreatments[0].updatedAt).toBeUndefined()

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(false)

  })

})

describe('migrateCloudSyncDocumentShape - procedure updatedAt backfill (Phase 5.5)', () => {

  it('backfills a missing updatedAt from the document\'s own top-level updatedAt, and the migrated document then passes strict validation', () => {

    const procedureWithoutUpdatedAt = omit(makeProcedure(), 'updatedAt')

    const document = makeDocument({
      updatedAt: '2026-07-01T00:00:00.000Z',
      customProcedures: [procedureWithoutUpdatedAt],
    })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.customProcedures[0].updatedAt).toBe('2026-07-01T00:00:00.000Z')

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(true)

  })

  it('backfills every procedure missing updatedAt with the same document-level timestamp', () => {

    const procA = omit(makeProcedure({ id: 'proc-a' }), 'updatedAt')
    const procB = omit(makeProcedure({ id: 'proc-b' }), 'updatedAt')

    const document = makeDocument({
      updatedAt: '2026-07-01T00:00:00.000Z',
      customProcedures: [procA, procB],
    })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.customProcedures[0].updatedAt).toBe('2026-07-01T00:00:00.000Z')
    expect(migrated.customProcedures[1].updatedAt).toBe('2026-07-01T00:00:00.000Z')

  })

  it('never overwrites an updatedAt that is already a valid, different timestamp', () => {

    const procedure = makeProcedure({ updatedAt: '2025-04-01T00:00:00.000Z' })

    const document = makeDocument({
      updatedAt: '2026-07-01T00:00:00.000Z',
      customProcedures: [procedure],
    })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.customProcedures[0].updatedAt).toBe('2025-04-01T00:00:00.000Z')

  })

  it('leaves a procedure untouched (no fabricated updatedAt) when the document-level updatedAt is ALSO missing/invalid, so validation still correctly rejects it', () => {

    const procedureWithoutUpdatedAt = omit(makeProcedure(), 'updatedAt')

    const document = makeDocument({
      updatedAt: '',
      customProcedures: [procedureWithoutUpdatedAt],
    })

    const migrated = migrateCloudSyncDocumentShape(document) as MigratedDocument

    expect(migrated.customProcedures[0].updatedAt).toBeUndefined()

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

  it('still rejects a document where a procedure has a wrong-typed field unrelated to updatedAt', () => {

    const corruptProcedure = makeProcedure({ isCustom: 'not-a-boolean' })

    const document = makeDocument({ customProcedures: [corruptProcedure] })

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
    const procedure = makeProcedure()

    const document = makeDocument({
      patients: [patient],
      savedTreatments: [treatment],
      customProcedures: [procedure],
    })

    const migrated = migrateCloudSyncDocumentShape(document)

    expect(migrated).toEqual(document)

    const validation = validateCloudSyncDocument(migrated)
    expect(validation.valid).toBe(true)

  })

})
