import { describe, expect, it, vi } from 'vitest'

/*
  Only cloudStorage.ts is mocked (its own runtime import of ./auth -
  MSAL/window at module scope - is what needs avoiding here, same
  reasoning as cloudBackupRotation.test.ts's own header comment).
  cloudBackup.ts is left as the REAL module: it has no problematic
  runtime import (only type-only imports from App.tsx, erased at
  compile time), and using its real createCloudBackup()/
  validateCloudBackup() here means "correctly picks the newest valid
  backup" is verified against the actual validator this feature
  relies on, not a stand-in that could silently drift from it.
*/

vi.mock('./cloudStorage', () => ({
  listAppFolderFileNames: vi.fn(),
  readCloudData: vi.fn(),
  writeCloudData: vi.fn(),
  deleteCloudFile: vi.fn(),
}))

import { listAppFolderFileNames, readCloudData } from './cloudStorage'
import { createCloudBackup, type CloudBackup } from './cloudBackup'
import {
  isCorruptedSyncOutcome,
  findNewestValidBackup,
  checkAllBackupSlots,
} from './cloudCorruptionRecovery'
import type { SyncOutcomeReason, SyncOutcomeType } from './syncOutcome'

const mockedListFiles = vi.mocked(listAppFolderFileNames)
const mockedReadData = vi.mocked(readCloudData)

function makeBackup(exportedAt: string): CloudBackup {
  return {
    schemaVersion: 1,
    app: 'ToothTarget',
    exportedAt,
    patients: [],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
  }
}

describe('isCorruptedSyncOutcome - correctly identifies an unreadable live sync file', () => {

  it('is true for the cloud-data-corrupted outcome, and only that one', () => {

    const allTypes: SyncOutcomeType[] = [
      'synced',
      'synced-after-conflict',
      'patient-number-conflicts',
      'review-needed',
      'save-incomplete',
      'sync-busy',
      'cloud-data-corrupted',
      'local-data-invalid',
      'not-signed-in',
      'sign-in-denied',
      'offline',
      'onedrive-unavailable',
    ]

    for (const type of allTypes) {

      const reason: SyncOutcomeReason = { type }

      expect(isCorruptedSyncOutcome(reason)).toBe(type === 'cloud-data-corrupted')

    }

  })

  it('is false when there is no outcome yet (null)', () => {
    expect(isCorruptedSyncOutcome(null)).toBe(false)
  })

  it('is false for local-data-invalid - a real failure, but not "the cloud file is unreadable"', () => {
    expect(isCorruptedSyncOutcome({ type: 'local-data-invalid' })).toBe(false)
  })

})

describe('findNewestValidBackup - picks the newest VALID backup among A/B/C', () => {

  it('returns null when no dated backup file exists at all', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-sync.json',
      'toothtarget-data.json',
    ])

    expect(await findNewestValidBackup()).toBeNull()

  })

  it('picks the newest by the date baked into the filename, not by call order', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-backup-A-2026-09-10.json',
      'toothtarget-backup-B-2026-09-24.json',
      'toothtarget-backup-C-2026-09-18.json',
    ])

    mockedReadData.mockImplementation(async (fileName: string) => {

      if (fileName === 'toothtarget-backup-B-2026-09-24.json') {
        return makeBackup('2026-09-24T08:00:00.000Z')
      }

      throw new Error('should not need to read an older candidate first')

    })

    const result = await findNewestValidBackup()

    expect(result?.file).toEqual({
      slot: 'B',
      date: '2026-09-24',
      fileName: 'toothtarget-backup-B-2026-09-24.json',
    })

    expect(result?.backup.exportedAt).toBe('2026-09-24T08:00:00.000Z')

  })

  it('skips a newer file that fails validation and falls back to the next-newest valid one', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-backup-A-2026-09-10.json',
      'toothtarget-backup-B-2026-09-24.json',
    ])

    mockedReadData.mockImplementation(async (fileName: string) => {

      if (fileName === 'toothtarget-backup-B-2026-09-24.json') {
        // Newest, but not shaped like a real backup - eg. genuinely corrupt.
        return { not: 'a backup' }
      }

      if (fileName === 'toothtarget-backup-A-2026-09-10.json') {
        return makeBackup('2026-09-10T08:00:00.000Z')
      }

      throw new Error('unexpected file name: ' + fileName)

    })

    const result = await findNewestValidBackup()

    expect(result?.file.fileName).toBe('toothtarget-backup-A-2026-09-10.json')

  })

  it('skips a candidate that throws while reading and falls back to the next one', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-backup-A-2026-09-10.json',
      'toothtarget-backup-B-2026-09-24.json',
    ])

    mockedReadData.mockImplementation(async (fileName: string) => {

      if (fileName === 'toothtarget-backup-B-2026-09-24.json') {
        throw new Error('network blip reading this one')
      }

      return makeBackup('2026-09-10T08:00:00.000Z')

    })

    const result = await findNewestValidBackup()

    expect(result?.file.fileName).toBe('toothtarget-backup-A-2026-09-10.json')

  })

  it('returns null when every dated backup file fails to validate', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-backup-A-2026-09-10.json',
      'toothtarget-backup-B-2026-09-24.json',
    ])

    mockedReadData.mockResolvedValue({ not: 'a backup' })

    expect(await findNewestValidBackup()).toBeNull()

  })

  it('a real createCloudBackup() snapshot always validates (sanity check that this test uses the real validator)', async () => {

    const realSnapshot = createCloudBackup()

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-backup-A-2026-09-24.json',
    ])

    mockedReadData.mockResolvedValueOnce(realSnapshot)

    const result = await findNewestValidBackup()

    expect(result?.backup).toEqual(realSnapshot)

  })

})

describe('checkAllBackupSlots - reports pass/fail + date for ALL THREE slots, not just the newest valid one', () => {

  it('reports "missing" for every slot when no dated backup file exists at all', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-sync.json',
    ])

    const result = await checkAllBackupSlots()

    expect(result).toEqual([
      { slot: 'A', status: 'missing' },
      { slot: 'B', status: 'missing' },
      { slot: 'C', status: 'missing' },
    ])

  })

  it('reports each of A/B/C independently - valid, invalid, and missing all at once', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-backup-A-2026-09-20.json',
      'toothtarget-backup-B-2026-09-22.json',
      // C deliberately absent
    ])

    mockedReadData.mockImplementation(async (fileName: string) => {

      if (fileName === 'toothtarget-backup-A-2026-09-20.json') {
        return makeBackup('2026-09-20T08:00:00.000Z')
      }

      if (fileName === 'toothtarget-backup-B-2026-09-22.json') {
        return { not: 'a backup' }
      }

      throw new Error('unexpected file name: ' + fileName)

    })

    const result = await checkAllBackupSlots()

    expect(result).toEqual([
      {
        slot: 'A',
        status: 'valid',
        date: '2026-09-20',
        fileName: 'toothtarget-backup-A-2026-09-20.json',
      },
      {
        slot: 'B',
        status: 'invalid',
        date: '2026-09-22',
        fileName: 'toothtarget-backup-B-2026-09-22.json',
        error: expect.any(String),
      },
      { slot: 'C', status: 'missing' },
    ])

  })

  it('reports "unreadable" (with the underlying error) for a slot that throws while being read', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-backup-A-2026-09-24.json',
    ])

    mockedReadData.mockRejectedValueOnce(new Error('network blip'))

    const result = await checkAllBackupSlots()

    expect(result).toEqual([
      {
        slot: 'A',
        status: 'unreadable',
        date: '2026-09-24',
        fileName: 'toothtarget-backup-A-2026-09-24.json',
        error: 'network blip',
      },
      { slot: 'B', status: 'missing' },
      { slot: 'C', status: 'missing' },
    ])

  })

  it('a slot whose newer valid twin exists does not hide an invalid other slot - all three are always reported', async () => {

    mockedListFiles.mockResolvedValueOnce([
      'toothtarget-backup-A-2026-09-10.json',
      'toothtarget-backup-B-2026-09-24.json',
      'toothtarget-backup-C-2026-09-18.json',
    ])

    mockedReadData.mockImplementation(async (fileName: string) => {

      if (fileName === 'toothtarget-backup-B-2026-09-24.json') {
        // Newest, and INVALID - findNewestValidBackup() would skip
        // straight past this to C, but checkAllBackupSlots() must
        // still report it explicitly rather than hiding it.
        return { not: 'a backup' }
      }

      return makeBackup('2026-01-01T00:00:00.000Z')

    })

    const result = await checkAllBackupSlots()

    const bSlot = result.find(entry => entry.slot === 'B')

    expect(bSlot?.status).toBe('invalid')

    const aSlot = result.find(entry => entry.slot === 'A')
    const cSlot = result.find(entry => entry.slot === 'C')

    expect(aSlot?.status).toBe('valid')
    expect(cSlot?.status).toBe('valid')

  })

})
