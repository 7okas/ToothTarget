import { describe, expect, it, vi } from 'vitest'

/*
  cloudStorage.ts (which this module's orchestration half imports) has
  its own runtime import of ./auth (MSAL/window at module scope) -
  mocked here purely so importing cloudBackupRotation.ts at all
  doesn't pull that in, the same reasoning cloudSyncEngine.test.ts's
  own header comment already documents. Every test below exercises
  only the PURE decision functions (nextSlot/parseBackupFileName/
  backupFileName/groupBackupFilesBySlot/findMostRecentBackupFile/
  decideBackupRotation) - maybeRotateBackup() itself (the Graph
  orchestration) is intentionally not exercised here, same as this
  project's other "thin orchestration over a tested pure core" modules
  (see startupGate.test.ts's own header comment for the same
  reasoning applied elsewhere).
*/

vi.mock('./cloudStorage', () => ({
  listAppFolderFileNames: vi.fn(),
  writeCloudData: vi.fn(),
  deleteCloudFile: vi.fn(),
  readCloudData: vi.fn(),
}))

vi.mock('./cloudBackup', () => ({
  createCloudBackup: vi.fn(),
}))

import {
  nextSlot,
  backupFileName,
  parseBackupFileName,
  groupBackupFilesBySlot,
  findMostRecentBackupFile,
  decideBackupRotation,
  type BackupSlotFile,
} from './cloudBackupRotation'

describe('nextSlot - fixed A -> B -> C -> A rotation order', () => {

  it('A -> B', () => {
    expect(nextSlot('A')).toBe('B')
  })

  it('B -> C', () => {
    expect(nextSlot('B')).toBe('C')
  })

  it('C -> A (wraps around)', () => {
    expect(nextSlot('C')).toBe('A')
  })

})

describe('backupFileName - the exact dated filename format', () => {

  it('bakes the slot and date directly into the name', () => {
    expect(backupFileName('A', '2026-09-24')).toBe(
      'toothtarget-backup-A-2026-09-24.json'
    )
  })

  it('produces a distinct name per slot for the same date', () => {
    expect(backupFileName('B', '2026-09-24')).toBe(
      'toothtarget-backup-B-2026-09-24.json'
    )
    expect(backupFileName('C', '2026-09-24')).toBe(
      'toothtarget-backup-C-2026-09-24.json'
    )
  })

})

describe('parseBackupFileName - the inverse of backupFileName', () => {

  it('parses a well-formed dated backup filename', () => {
    expect(parseBackupFileName('toothtarget-backup-A-2026-09-24.json')).toEqual({
      slot: 'A',
      date: '2026-09-24',
      fileName: 'toothtarget-backup-A-2026-09-24.json',
    })
  })

  it('round-trips through backupFileName() for every slot', () => {

    for (const slot of ['A', 'B', 'C'] as const) {

      const fileName = backupFileName(slot, '2026-01-05')

      expect(parseBackupFileName(fileName)).toEqual({
        slot,
        date: '2026-01-05',
        fileName,
      })

    }

  })

  it('returns null for an unrelated file name in the same folder', () => {
    expect(parseBackupFileName('toothtarget-sync.json')).toBeNull()
    expect(parseBackupFileName('toothtarget-data.json')).toBeNull()
    expect(parseBackupFileName('some-other-app-file.json')).toBeNull()
  })

  it('returns null for a slot letter outside A/B/C', () => {
    expect(parseBackupFileName('toothtarget-backup-D-2026-09-24.json')).toBeNull()
  })

  it('returns null for a malformed date', () => {
    expect(parseBackupFileName('toothtarget-backup-A-2026-9-24.json')).toBeNull()
    expect(parseBackupFileName('toothtarget-backup-A-not-a-date.json')).toBeNull()
  })

})

describe('groupBackupFilesBySlot / findMostRecentBackupFile', () => {

  function file(slot: 'A' | 'B' | 'C', date: string): BackupSlotFile {
    return { slot, date, fileName: backupFileName(slot, date) }
  }

  it('groups an empty list into all-null slots', () => {
    expect(groupBackupFilesBySlot([])).toEqual({ A: null, B: null, C: null })
  })

  it('places each file under its own slot', () => {

    const grouped = groupBackupFilesBySlot([
      file('A', '2026-09-18'),
      file('B', '2026-09-20'),
      file('C', '2026-09-22'),
    ])

    expect(grouped.A).toEqual(file('A', '2026-09-18'))
    expect(grouped.B).toEqual(file('B', '2026-09-20'))
    expect(grouped.C).toEqual(file('C', '2026-09-22'))

  })

  it('findMostRecentBackupFile returns null when nothing exists yet', () => {
    expect(findMostRecentBackupFile({ A: null, B: null, C: null })).toBeNull()
  })

  it('findMostRecentBackupFile picks the latest date regardless of slot letter', () => {

    const grouped = groupBackupFilesBySlot([
      file('A', '2026-09-18'),
      file('B', '2026-09-24'),
      file('C', '2026-09-20'),
    ])

    expect(findMostRecentBackupFile(grouped)).toEqual(file('B', '2026-09-24'))

  })

})

describe('decideBackupRotation - the one rotation decision, kept pure', () => {

  function file(slot: 'A' | 'B' | 'C', date: string): BackupSlotFile {
    return { slot, date, fileName: backupFileName(slot, date) }
  }

  it('starts the very first rotation at slot A when nothing exists yet', () => {

    expect(
      decideBackupRotation({ A: null, B: null, C: null }, '2026-09-24')
    ).toEqual({ shouldWrite: true, slot: 'A', oldFileToDelete: null })

  })

  it('does not fire a second time the same calendar day', () => {

    const grouped = groupBackupFilesBySlot([file('A', '2026-09-24')])

    expect(decideBackupRotation(grouped, '2026-09-24')).toEqual({
      shouldWrite: false,
    })

  })

  it('does not fire again the same day no matter how many times it is checked', () => {

    const grouped = groupBackupFilesBySlot([
      file('A', '2026-09-20'),
      file('B', '2026-09-24'),
    ])

    // B is most recent and already dated today - global gate, regardless of slot.
    expect(decideBackupRotation(grouped, '2026-09-24')).toEqual({
      shouldWrite: false,
    })

  })

  it('advances to the next slot once the calendar day has changed', () => {

    const grouped = groupBackupFilesBySlot([file('A', '2026-09-20')])

    expect(decideBackupRotation(grouped, '2026-09-24')).toEqual({
      shouldWrite: true,
      slot: 'B',
      oldFileToDelete: null,
    })

  })

  it('wraps C -> A and marks A\'s existing old dated file for deletion', () => {

    const grouped = groupBackupFilesBySlot([
      file('A', '2026-09-10'),
      file('B', '2026-09-15'),
      file('C', '2026-09-20'),
    ])

    expect(decideBackupRotation(grouped, '2026-09-24')).toEqual({
      shouldWrite: true,
      slot: 'A',
      oldFileToDelete: 'toothtarget-backup-A-2026-09-10.json',
    })

  })

  it('does not try to delete anything when the target slot has no prior file', () => {

    const grouped = groupBackupFilesBySlot([file('A', '2026-09-20')])

    const decision = decideBackupRotation(grouped, '2026-09-24')

    expect(decision).toEqual({
      shouldWrite: true,
      slot: 'B',
      oldFileToDelete: null,
    })

  })

  it('does not "catch up" missed days - one write per triggering call, regardless of how many days elapsed', () => {

    // Last written 10 days ago - still just advances ONE slot, not ten.
    const grouped = groupBackupFilesBySlot([file('C', '2026-09-14')])

    expect(decideBackupRotation(grouped, '2026-09-24')).toEqual({
      shouldWrite: true,
      slot: 'A',
      oldFileToDelete: null,
    })

  })

})
