import { describe, expect, it } from 'vitest'
import { validateCloudSyncDocument } from './cloudSync'

/*
  deletionTombstones is a retired field. Old documents (local data, OneDrive
  files, A/B/C backups, safety copies) still carry it; new ones don't. It
  must never decide validity, and it must not survive into the validated
  document.
*/

function baseDocument(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    app: 'ToothTarget',
    updatedAt: '2026-01-01T00:00:00.000Z',
    patients: [],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
  }
}

describe('retired deletionTombstones field', () => {

  it('accepts an old-format document with a well-formed tombstone list', () => {
    const result = validateCloudSyncDocument({
      ...baseDocument(),
      deletionTombstones: [
        {
          id: 't1',
          entityType: 'patient',
          entityId: 'p1',
          deletedAt: '2025-12-01T00:00:00.000Z',
        },
      ],
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect("deletionTombstones" in result.document).toBe(false)
    }
  })

  it('accepts a document without the field', () => {
    expect(validateCloudSyncDocument(baseDocument()).valid).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an object', { a: 1 }],
    ['a list of junk', [1, null, { entityType: 'not-a-real-type' }]],
  ])('accepts a document whose tombstones are %s', (_label, junk) => {
    const result = validateCloudSyncDocument({
      ...baseDocument(),
      deletionTombstones: junk,
    })
    expect(result.valid).toBe(true)
  })

})
