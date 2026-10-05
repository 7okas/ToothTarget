import { beforeEach, describe, expect, it } from 'vitest'
import type { Patient, Procedure } from './App'
import {
  CLOUD_BACKUP_SCHEMA_VERSION,
  createCloudBackup,
  validateCloudBackup,
  mergeProceduresForRestore,
  type CloudBackup,
} from './cloudBackup'

/*
  Follow-up to Phase 2 of the Sync & Statistics Redesign: the manual
  Backup/Restore feature used to only ever back up/restore procedures
  with isCustom === true, silently dropping any rename/archive of the
  original five "built-in" tags on restore. These tests cover the fix
  - createCloudBackup() now includes every procedure, and restoring
  (via the pure mergeProceduresForRestore() helper applyCloudRestore()
  delegates to - see that file for why the impure wrapper itself isn't
  unit-tested here) applies every procedure the backup mentions while
  leaving anything it doesn't mention untouched, which is what makes
  an OLDER backup (only ever-custom ids, no status field) still safe
  to restore without disturbing the device's own original five tags.

  Minimal, fully-typed in-memory Storage - see cloudSyncEngine.test.ts/
  cloudMerge.test.ts for the same pattern used elsewhere in this
  project's test suite. cloudBackup.ts has no runtime dependency on
  anything window/document-shaped for the functions exercised here
  (createCloudBackup/validateCloudBackup/mergeProceduresForRestore are
  all pure reads/computations), so no other mocking is needed.
*/

class MemoryStorage implements Storage {

  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage()
})

function seed(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: 'custom-1',
    name: 'Custom Procedure',
    isCustom: true,
    templateId: 'template-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeBuiltinProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: 'rct',
    name: 'Root Canal Treatment',
    isCustom: false,
    templateId: 'rct-molar',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'patient-1',
    patientNumber: 1,
    name: 'Jane Doe',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeBackup(overrides: Partial<CloudBackup> = {}): CloudBackup {
  return {
    schemaVersion: CLOUD_BACKUP_SCHEMA_VERSION,
    app: 'ToothTarget',
    exportedAt: '2026-01-01T00:00:00.000Z',
    patients: [],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
    ...overrides,
  }
}

describe('createCloudBackup - procedures', () => {

  it('includes every procedure, including a former "built-in", with its status', () => {

    seed('toothTargetProcedures', [
      makeBuiltinProcedure({ status: 'archived' }),
      makeProcedure({ id: 'custom-1' }),
    ])

    const backup = createCloudBackup()

    expect(backup.customProcedures.map(p => p.id).sort()).toEqual(
      ['custom-1', 'rct']
    )

    expect(
      backup.customProcedures.find(p => p.id === 'rct')?.status
    ).toBe('archived')

  })

  it('includes a built-in with no status field at all exactly as persisted (active is only ever implied, never written)', () => {

    seed('toothTargetProcedures', [makeBuiltinProcedure()])

    const backup = createCloudBackup()

    expect(backup.customProcedures).toEqual([makeBuiltinProcedure()])
    expect(backup.customProcedures[0].status).toBeUndefined()

  })

})

describe('validateCloudBackup - procedure status backward compatibility', () => {

  it('accepts an older-shaped procedure record (isCustom present, no status field at all)', () => {

    const result = validateCloudBackup(
      makeBackup({
        customProcedures: [makeProcedure()],
      })
    )

    expect(result.valid).toBe(true)

  })

  it('accepts a newer-shaped procedure record with an explicit active/archived status', () => {

    const result = validateCloudBackup(
      makeBackup({
        customProcedures: [
          makeBuiltinProcedure({ status: 'archived' }),
          makeProcedure({ status: 'active' }),
        ],
      })
    )

    expect(result.valid).toBe(true)

  })

  it('rejects a procedure with an invalid status value', () => {

    const result = validateCloudBackup(
      makeBackup({
        customProcedures: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          makeProcedure({ status: 'deleted' as any }),
        ],
      })
    )

    expect(result.valid).toBe(false)

  })

})

describe('validateCloudBackup - patient caseType backward compatibility (Phase 3)', () => {

  it('accepts an older-shaped patient record (no caseType field at all)', () => {

    const result = validateCloudBackup(
      makeBackup({
        patients: [makePatient()],
      })
    )

    expect(result.valid).toBe(true)

  })

  it('accepts a patient explicitly marked Clinical or Practice', () => {

    const result = validateCloudBackup(
      makeBackup({
        patients: [
          makePatient({ id: 'patient-1', caseType: 'Clinical' }),
          makePatient({ id: 'patient-2', caseType: 'Practice' }),
        ],
      })
    )

    expect(result.valid).toBe(true)

  })

  it('rejects a patient with an invalid caseType value', () => {

    const result = validateCloudBackup(
      makeBackup({
        patients: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          makePatient({ caseType: 'Extracted' as any }),
        ],
      })
    )

    expect(result.valid).toBe(false)

  })

})

describe('mergeProceduresForRestore', () => {

  it('restoring an older-shaped backup (only ever-custom ids) leaves the device\'s original five tags completely untouched', () => {

    const currentDeviceProcedures: Procedure[] = [
      makeBuiltinProcedure({ id: 'rct', name: 'Root Canal Treatment' }),
      makeBuiltinProcedure({ id: 'cr', name: 'Composite Restoration', templateId: 'cr-default' }),
      makeBuiltinProcedure({ id: 'sp', name: 'Scaling & Polishing', templateId: 'sp-default' }),
      makeBuiltinProcedure({ id: 'ext', name: 'Extraction', templateId: 'ext-default' }),
      makeBuiltinProcedure({ id: 'irprep', name: 'Indirect Restoration Preparation', templateId: 'irprep-default' }),
      makeProcedure({ id: 'custom-old', name: 'Stale Custom Name' }),
    ]

    /*
      An old-shape backup: only ever contained procedures that were
      isCustom === true at export time, and no status field at all.
    */
    const oldShapeBackupProcedures: Procedure[] = [
      makeProcedure({ id: 'custom-old', name: 'Fresh Custom Name' }),
    ]

    const result = mergeProceduresForRestore(
      currentDeviceProcedures,
      oldShapeBackupProcedures
    )

    // The original five, never mentioned by the old backup, are untouched.
    expect(result.find(p => p.id === 'rct')).toEqual(currentDeviceProcedures[0])
    expect(result.find(p => p.id === 'cr')).toEqual(currentDeviceProcedures[1])
    expect(result.find(p => p.id === 'sp')).toEqual(currentDeviceProcedures[2])
    expect(result.find(p => p.id === 'ext')).toEqual(currentDeviceProcedures[3])
    expect(result.find(p => p.id === 'irprep')).toEqual(currentDeviceProcedures[4])

    // The custom procedure the backup DOES mention is restored from it.
    expect(result.find(p => p.id === 'custom-old')?.name).toBe('Fresh Custom Name')

    expect(result).toHaveLength(6)

  })

  it('restoring a newer-shaped backup brings back a renamed and an archived original tag', () => {

    const currentDeviceProcedures: Procedure[] = [
      makeBuiltinProcedure({ id: 'rct', name: 'Root Canal Treatment (current, unrenamed)' }),
      makeBuiltinProcedure({ id: 'cr', name: 'Composite Restoration', templateId: 'cr-default' }),
    ]

    /*
      A new-shape backup taken BEFORE the device's current state - at
      that point, 'rct' had already been renamed and 'cr' had already
      been archived.
    */
    const newShapeBackupProcedures: Procedure[] = [
      makeBuiltinProcedure({
        id: 'rct',
        name: 'Root Canal Treatment (renamed in backup)',
        status: 'active',
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
      makeBuiltinProcedure({
        id: 'cr',
        name: 'Composite Restoration',
        templateId: 'cr-default',
        status: 'archived',
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
      makeProcedure({ id: 'custom-1' }),
    ]

    const result = mergeProceduresForRestore(
      currentDeviceProcedures,
      newShapeBackupProcedures
    )

    expect(result.find(p => p.id === 'rct')?.name).toBe(
      'Root Canal Treatment (renamed in backup)'
    )

    expect(result.find(p => p.id === 'cr')?.status).toBe('archived')

    // A custom procedure the device never had locally is also restored.
    expect(result.find(p => p.id === 'custom-1')).toBeDefined()

    expect(result).toHaveLength(3)

  })

  it('a procedure id present on the device but absent from the backup is preserved, not dropped', () => {

    const currentDeviceProcedures: Procedure[] = [
      makeProcedure({ id: 'only-on-device' }),
    ]

    const result = mergeProceduresForRestore(currentDeviceProcedures, [])

    expect(result).toEqual(currentDeviceProcedures)

  })

})
