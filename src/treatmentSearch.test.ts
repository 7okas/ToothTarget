import { describe, expect, it } from 'vitest'
import type { Patient, PhaseRecord, SavedTreatment } from './App'
import {
  buildTreatmentRows,
  searchTreatmentRows,
  sortRowsNewestFirst,
} from './treatmentSearch'

function phase(name: string, skipped = false): PhaseRecord {
  return {
    id: `${name}-record`,
    name,
    expectedDuration: 300,
    actualDuration: skipped ? 0 : 300,
    startedAt: null,
    completedAt: null,
    status: skipped ? 'skipped' : 'completed',
    skipped,
    pausedWhileActive: false,
  }
}

function makeTreatment(overrides: Partial<SavedTreatment> = {}): SavedTreatment {
  const phaseRecords = overrides.phaseRecords ?? [phase('A'), phase('B'), phase('C')]
  return {
    id: 't1',
    patientName: 'Jane Doe',
    patientId: 'p1',
    toothId: '16',
    procedureName: 'Root Canal',
    procedureId: 'rct',
    templateName: 'Molar RCT',
    templateId: 'rct-molar',
    phases: phaseRecords.map(record => ({ name: record.name, duration: record.expectedDuration })),
    date: '2026-01-15T10:00:00.000Z',
    completed: true,
    phaseTimes: [],
    actualTimes: [],
    phaseRecords,
    totalExpectedDuration: 900,
    totalActualDuration: 900,
    totalOvertimeDuration: 0,
    events: [],
    tags: ['Difficult'],
    chairEnteredAt: null,
    chairLeftAt: null,
    currentPhaseIndex: 2,
    startedAt: '2026-01-15T09:00:00.000Z',
    updatedAt: '2026-01-15T10:00:00.000Z',
    ...overrides,
  }
}

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'p1',
    patientNumber: 1,
    name: 'Jane Doe',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const upperMolarRct = makeTreatment({ id: 'upper-molar-rct', toothId: '16' })
const lowerMolarRct = makeTreatment({ id: 'lower-molar-rct', toothId: '36' })
const upperPremolarFilling = makeTreatment({
  id: 'upper-premolar-filling',
  toothId: '24',
  procedureName: 'Composite Filling',
  procedureId: 'composite',
  templateName: 'Class II',
})
const lowerAnteriorFilling = makeTreatment({
  id: 'lower-anterior-filling',
  toothId: '41',
  procedureName: 'Composite Filling',
  procedureId: 'composite',
  templateName: 'Class III',
})
const legacyUnknownTooth = makeTreatment({
  id: 'legacy-tooth',
  toothId: 'UNKNOWN',
  procedureName: 'General',
  procedureId: 'general',
  templateName: 'General Procedure',
})

const ALL = [
  upperMolarRct,
  lowerMolarRct,
  upperPremolarFilling,
  lowerAnteriorFilling,
  legacyUnknownTooth,
]

function ids(treatments: SavedTreatment[], query: string): string[] {
  const rows = buildTreatmentRows(treatments, [makePatient()])
  return searchTreatmentRows(rows, query).map(row => row.treatment.id)
}

describe('buildTreatmentRows', () => {

  it('derives the tooth label, region and arch from the tooth chart', () => {
    const [row] = buildTreatmentRows([upperMolarRct], [makePatient()])
    expect(row.toothLabel).toBe('UR6')
    expect(row.toothRegion).toBe('molar')
    expect(row.toothArch).toBe('upper')
  })

  it('keeps an unrecognised old tooth as its preserved text, with no region or arch', () => {
    const [row] = buildTreatmentRows([legacyUnknownTooth], [makePatient()])
    expect(row.toothLabel).toBe('UNKNOWN')
    expect(row.toothRegion).toBeNull()
    expect(row.toothArch).toBeNull()
  })

  it('takes the case type from the patient, defaulting to Clinical (missing field or deleted patient)', () => {
    const practice = makePatient({ id: 'p-practice', caseType: 'Practice' })
    const rows = buildTreatmentRows(
      [
        makeTreatment({ id: 'a', patientId: 'p-practice' }),
        makeTreatment({ id: 'b', patientId: 'p1' }),
        makeTreatment({ id: 'c', patientId: 'gone' }),
      ],
      [practice, makePatient()]
    )
    expect(rows.map(row => row.caseType)).toEqual(['Practice', 'Clinical', 'Clinical'])
  })

  it('counts phases tracked out of phases total and flags skipped ones', () => {
    const [full, partial] = buildTreatmentRows(
      [
        makeTreatment({ id: 'full' }),
        makeTreatment({
          id: 'partial',
          phaseRecords: [phase('A'), phase('B', true), phase('C', true)],
        }),
      ],
      [makePatient()]
    )
    expect(full.phasesTracked).toBe(3)
    expect(full.phasesTotal).toBe(3)
    expect(full.hasSkippedPhases).toBe(false)
    expect(partial.phasesTracked).toBe(1)
    expect(partial.phasesTotal).toBe(3)
    expect(partial.hasSkippedPhases).toBe(true)
  })

  it('does not change or drop any treatment', () => {
    const rows = buildTreatmentRows(ALL, [makePatient()])
    expect(rows.map(row => row.treatment)).toEqual(ALL)
  })

})

describe('searchTreatmentRows - what the box matches', () => {

  it('an empty or blank query matches every row', () => {
    expect(ids(ALL, '')).toHaveLength(ALL.length)
    expect(ids(ALL, '   ')).toHaveLength(ALL.length)
  })

  it('matches the procedure name, ignoring case and partial words', () => {
    expect(ids(ALL, 'root')).toEqual(['upper-molar-rct', 'lower-molar-rct'])
    expect(ids(ALL, 'COMPOSITE')).toEqual(['upper-premolar-filling', 'lower-anterior-filling'])
  })

  it('matches the template name', () => {
    expect(ids(ALL, 'class iii')).toEqual(['lower-anterior-filling'])
    expect(ids(ALL, 'class')).toEqual(['upper-premolar-filling', 'lower-anterior-filling'])
  })

  it('matches an FDI tooth number as a whole value', () => {
    expect(ids(ALL, '16')).toEqual(['upper-molar-rct'])
    expect(ids(ALL, '41')).toEqual(['lower-anterior-filling'])
  })

  it('a short number never matches every tooth that merely contains it', () => {
    expect(ids(ALL, '1')).toEqual([])
    expect(ids(ALL, '6')).toEqual([])
  })

  it('matches UR/UL/LR/LL names, ignoring case', () => {
    expect(ids(ALL, 'UR6')).toEqual(['upper-molar-rct'])
    expect(ids(ALL, 'ul4')).toEqual(['upper-premolar-filling'])
    expect(ids(ALL, 'LL6')).toEqual(['lower-molar-rct'])
    expect(ids(ALL, 'LR1')).toEqual(['lower-anterior-filling'])
  })

  it('matches the category words, singular or plural', () => {
    expect(ids(ALL, 'molar')).toEqual(['upper-molar-rct', 'lower-molar-rct'])
    expect(ids(ALL, 'molars')).toEqual(['upper-molar-rct', 'lower-molar-rct'])
    expect(ids(ALL, 'premolar')).toEqual(['upper-premolar-filling'])
    expect(ids(ALL, 'premolars')).toEqual(['upper-premolar-filling'])
    expect(ids(ALL, 'anterior')).toEqual(['lower-anterior-filling'])
  })

  it('matches upper and lower', () => {
    expect(ids(ALL, 'upper')).toEqual(['upper-molar-rct', 'upper-premolar-filling'])
    expect(ids(ALL, 'lower')).toEqual(['lower-molar-rct', 'lower-anterior-filling'])
  })

  it('"molar" does not match a premolar (whole category words only)', () => {
    expect(ids([upperPremolarFilling], 'molar')).toEqual([])
  })

  it('matches an old unrecognised tooth by its preserved text, as a whole value only', () => {
    expect(ids(ALL, 'unknown')).toEqual(['legacy-tooth'])
    expect(ids(ALL, 'unk')).toEqual([])
  })

  it('does NOT match the patient name', () => {
    expect(ids(ALL, 'jane')).toEqual([])
    expect(ids(ALL, 'doe')).toEqual([])
  })

  it('does NOT match descriptive treatment tags like "Difficult"', () => {
    expect(ids(ALL, 'difficult')).toEqual([])
  })

})

describe('searchTreatmentRows - several words must ALL match', () => {

  it('narrows with every extra word', () => {
    expect(ids(ALL, 'upper molar')).toEqual(['upper-molar-rct'])
    expect(ids(ALL, 'lower molar root')).toEqual(['lower-molar-rct'])
    expect(ids(ALL, 'composite lower')).toEqual(['lower-anterior-filling'])
  })

  it('a word that matches nothing makes the whole search empty', () => {
    expect(ids(ALL, 'upper molar zzz')).toEqual([])
  })

  it('word order does not matter, and extra spaces are ignored', () => {
    expect(ids(ALL, '  molar   upper ')).toEqual(['upper-molar-rct'])
  })

  it('mixes a tooth number with a procedure word', () => {
    expect(ids(ALL, '16 root')).toEqual(['upper-molar-rct'])
    expect(ids(ALL, '16 composite')).toEqual([])
  })

})

describe('sortRowsNewestFirst', () => {

  it('orders by completion date, newest first, unreadable dates last, without mutating the input', () => {
    const rows = buildTreatmentRows(
      [
        makeTreatment({ id: 'old', date: '2026-01-01T00:00:00.000Z' }),
        makeTreatment({ id: 'bad', date: 'not a date' }),
        makeTreatment({ id: 'new', date: '2026-03-01T00:00:00.000Z' }),
      ],
      [makePatient()]
    )
    const sorted = sortRowsNewestFirst(rows)
    expect(sorted.map(row => row.treatment.id)).toEqual(['new', 'old', 'bad'])
    expect(rows.map(row => row.treatment.id)).toEqual(['old', 'bad', 'new'])
  })

})
