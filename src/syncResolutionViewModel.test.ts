import { describe, expect, it, vi } from 'vitest'

/*
  The view model only imports TYPES from the engine, but its
  safety-copy constants live in a module whose chain reaches
  cloudStorage -> auth (MSAL/window at module scope), so that is mocked
  like everywhere else in this suite.
*/
vi.mock('./cloudStorage', () => ({
  listAppFolderFileNames: vi.fn(),
  readCloudData: vi.fn(),
  writeCloudData: vi.fn(),
  deleteCloudFile: vi.fn(),
}))

import { diffSnapshots } from './syncDiff'
import {
  resolveSnapshots,
  recordKey,
  decideAllFromDevice,
  decideCreatedSinceLastSync,
  type Decisions,
} from './syncResolve'
import {
  buildViewModel,
  buildSummary,
  choiceOptionsFor,
  describeApplyResult,
  describePrepareResult,
  CREATED_SINCE_BUTTON_LABEL,
} from './syncResolutionViewModel'
import {
  makePatient,
  makeSavedTreatment,
  makeTemplate,
  makeDocument,
} from './syncResolutionTestUtils'

const LAST_SYNC = '2026-03-01T00:00:00.000Z'
const BEFORE = '2026-02-01T12:00:00.000Z'
const AFTER = '2026-04-01T12:00:00.000Z'
const NOW = '2026-06-01T00:00:00.000Z'

const device = makeDocument({
  patients: [
    makePatient({ id: 'new-d', patientNumber: 1, name: 'Sara K.', createdAt: AFTER, updatedAt: AFTER }),
    makePatient({ id: 'old-d', patientNumber: 2, name: 'Omar F.', createdAt: BEFORE, updatedAt: BEFORE }),
    makePatient({ id: 'both', patientNumber: 3, name: 'Ahmed S.' }),
  ],
  savedTreatments: [
    makeSavedTreatment({ id: 't2', patientId: 'new-d', patientName: 'Sara K.', procedureName: 'B proc', completedAt: AFTER, updatedAt: AFTER }),
    makeSavedTreatment({ id: 't1', patientId: 'both', patientName: 'Ahmed S.', procedureName: 'A proc', completedAt: AFTER, updatedAt: AFTER }),
  ],
})

const cloud = makeDocument({
  patients: [
    makePatient({ id: 'new-c', patientNumber: 4, name: 'Lina M.', createdAt: AFTER, updatedAt: AFTER }),
    makePatient({ id: 'both', patientNumber: 3, name: 'Ahmed Samy' }),
  ],
  customTemplates: [makeTemplate({ id: 'tpl', updatedAt: AFTER })],
})

const diff = diffSnapshots(device, cloud, { lastSyncAt: LAST_SYNC })

describe('choiceOptionsFor - button wording', () => {

  it('one-sided rows never say "use this"; "Leave it out" is the delete', () => {

    expect(choiceOptionsFor('device-only')).toEqual([
      { choice: 'device', label: 'Keep it' },
      { choice: 'omit', label: 'Leave it out' },
    ])

    expect(choiceOptionsFor('cloud-only')).toEqual([
      { choice: 'cloud', label: 'Bring to this device' },
      { choice: 'omit', label: 'Leave it out' },
    ])

  })

  it('both-sides rows are a plain either/or with no omit', () => {

    expect(choiceOptionsFor('different')).toEqual([
      { choice: 'device', label: "Use this device's" },
      { choice: 'cloud', label: "Use OneDrive's" },
    ])

  })

})

describe('buildViewModel', () => {

  it('builds sections in order, three groups each, skipping empty sections', () => {

    const model = buildViewModel(diff, {})

    expect(model.sections.map(section => section.label)).toEqual([
      'Patients',
      'Treatments',
      'Templates',
    ])

    const patients = model.sections[0]

    expect(patients.groups.deviceOnly.title).toBe('Only on this device')
    expect(patients.groups.cloudOnly.title).toBe('Only in OneDrive')
    expect(patients.groups.different.title).toBe('On both, but different')
    expect(patients.groups.deviceOnly.rows.map(row => row.id).sort()).toEqual(['new-d', 'old-d'])
    expect(patients.groups.cloudOnly.rows.map(row => row.id)).toEqual(['new-c'])
    expect(patients.groups.different.rows.map(row => row.id)).toEqual(['both'])

  })

  it('NO row is preselected: everything starts undecided and the review step is locked', () => {

    const model = buildViewModel(diff, {})

    expect(model.decidedRows).toBe(0)
    expect(model.allDecided).toBe(false)
    expect(model.progressLabel).toBe(`0 of ${model.totalRows} decided`)

    for (const section of model.sections) {
      for (const group of Object.values(section.groups)) {
        for (const row of group.rows) {
          expect(row.undecided).toBe(true)
          expect(row.choice).toBeUndefined()
        }
      }
    }

  })

  it('tracks progress and unlocks only when every row is decided', () => {

    const partial = buildViewModel(diff, { [recordKey('patient', 'new-d')]: 'device' })

    expect(partial.decidedRows).toBe(1)
    expect(partial.allDecided).toBe(false)

    const complete = buildViewModel(diff, decideAllFromDevice(diff))

    expect(complete.allDecided).toBe(true)
    expect(complete.progressLabel).toBe(`${complete.totalRows} of ${complete.totalRows} decided`)

  })

  it('marks probably-deleted rows as warnings and carries the exact hint', () => {

    const rows = buildViewModel(diff, {}).sections[0].groups.deviceOnly.rows

    const old = rows.find(row => row.id === 'old-d')!
    const fresh = rows.find(row => row.id === 'new-d')!

    expect(old.warn).toBe(true)
    expect(old.hint).toContain('probably DELETED from OneDrive')
    expect(fresh.warn).toBe(false)
    expect(fresh.hint).toBe('Created since last sync')

  })

  it('both-sides rows carry both summaries, the change lines and which side is newer', () => {

    const row = buildViewModel(diff, {}).sections[0].groups.different.rows[0]

    expect(row.deviceSummary).toContain('Ahmed S.')
    expect(row.cloudSummary).toContain('Ahmed Samy')
    expect(row.changes).toEqual(['Name: "Ahmed S." vs "Ahmed Samy"'])

  })

  it('treatments are grouped by patient, then by summary', () => {

    const rows = buildViewModel(diff, {}).sections[1].groups.deviceOnly.rows

    expect(rows.map(row => row.groupLabel)).toEqual(['Ahmed S.', 'Sara K.'])

  })

  it('counts the undecided "created since last sync" rows per section for the bulk button', () => {

    const model = buildViewModel(diff, {})

    expect(CREATED_SINCE_BUTTON_LABEL).toBe('Keep / bring everything created since the last sync')
    expect(model.sections[0].createdSinceUndecided).toBe(2) // new-d, new-c
    expect(model.sections[1].createdSinceUndecided).toBe(2) // both treatments
    expect(model.sections[2].createdSinceUndecided).toBe(0) // template: changed-since only

    const after = buildViewModel(diff, decideCreatedSinceLastSync(diff, 'patient', {}))

    expect(after.sections[0].createdSinceUndecided).toBe(0)
    expect(after.sections[1].createdSinceUndecided).toBe(2)

  })

})

describe('buildSummary', () => {

  function resolve(decisions: Decisions, numberFixes?: Record<string, number>) {
    return resolveSnapshots(device, cloud, decisions, {
      nowIso: NOW,
      lastSyncAt: LAST_SYNC,
      numberFixes,
    })
  }

  it('one plain-language line per kind with from-device / from-OneDrive / left-out / total', () => {

    const result = resolve({
      [recordKey('patient', 'new-d')]: 'device',
      [recordKey('patient', 'old-d')]: 'omit',
      [recordKey('patient', 'new-c')]: 'cloud',
      [recordKey('patient', 'both')]: 'cloud',
      [recordKey('treatment', 't1')]: 'device',
      [recordKey('treatment', 't2')]: 'device',
      [recordKey('template', 'tpl')]: 'omit',
    })

    const summary = buildSummary(result)

    expect(summary.lines[0]).toBe(
      'Patients: 1 from this device, 2 from OneDrive, 1 left out - 3 in total'
    )
    expect(summary.lines[1]).toBe(
      'Treatments: 2 from this device, 0 from OneDrive, 0 left out - 2 in total'
    )
    expect(summary.requiresAcknowledgement).toBe(false)
    expect(summary.resurrectedWarning).toBeNull()

  })

  it('flags probably-deleted records coming back and requires acknowledgement', () => {

    const result = resolve({
      [recordKey('patient', 'new-d')]: 'device',
      [recordKey('patient', 'old-d')]: 'device',
      [recordKey('patient', 'new-c')]: 'omit',
      [recordKey('patient', 'both')]: 'device',
      [recordKey('treatment', 't1')]: 'device',
      [recordKey('treatment', 't2')]: 'device',
      [recordKey('template', 'tpl')]: 'cloud',
    })

    const summary = buildSummary(result)

    expect(summary.requiresAcknowledgement).toBe(true)
    expect(summary.resurrectedWarning).toBe('1 record that was probably deleted will come back.')
    expect(summary.resurrectedNames).toHaveLength(1)
    expect(summary.resurrectedNames[0]).toContain('Omar F.')
    expect(summary.maybeResurrectedNote).toBe(
      '1 kept record changed since the last sync and may have been deleted on the other side.'
    )

  })

  it('lists renumbered patients and auto-included templates', () => {

    const dev = makeDocument({
      patients: [makePatient({ id: 'a', patientNumber: 12, name: 'Device Twelve' })],
      customProcedures: [
        {
          id: 'pr',
          name: 'Bleaching',
          isCustom: true,
          templateId: 'tpl-x',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })

    const cld = makeDocument({
      patients: [makePatient({ id: 'b', patientNumber: 12, name: 'Cloud Twelve' })],
      customTemplates: [makeTemplate({ id: 'tpl-x', name: 'Bleach plan' })],
    })

    const result = resolveSnapshots(
      dev,
      cld,
      {
        [recordKey('patient', 'a')]: 'device',
        [recordKey('patient', 'b')]: 'cloud',
        [recordKey('procedure', 'pr')]: 'device',
        [recordKey('template', 'tpl-x')]: 'omit',
      },
      { nowIso: NOW, numberFixes: { b: 13 } }
    )

    const summary = buildSummary(result)

    expect(summary.renumbered).toEqual(['Cloud Twelve: #12 -> #13'])
    expect(summary.autoIncluded).toEqual(['Template "Bleach plan" (needed by Bleaching)'])

  })

  it('states the retention promise: last 5 on OneDrive, last 2 on this device', () => {

    const summary = buildSummary(resolve(decideAllFromDevice(diff)))

    expect(summary.safetyNote).toContain('safety copy of BOTH sides')
    expect(summary.safetyNote).toContain('last 5 resolutions')
    expect(summary.safetyNote).toContain('last 2')

  })

})

describe('plain-language outcomes', () => {

  const doc = makeDocument()

  it('applied: success, or a warning when only the local safety copy failed', () => {

    expect(describeApplyResult({ status: 'applied', resolved: doc })).toMatchObject({
      tone: 'success',
      retryable: false,
    })

    expect(
      describeApplyResult({ status: 'applied', resolved: doc, warning: 'local copy failed' })
    ).toMatchObject({ tone: 'warning', message: 'local copy failed' })

  })

  it('changed while deciding: says nothing was changed and asks for a refresh', () => {

    const outcome = describeApplyResult({
      status: 'changed-while-deciding',
      session: {} as never,
      decisions: {},
      reset: ['patient:a', 'patient:b'],
    })

    expect(outcome.needsRefresh).toBe(true)
    expect(outcome.message).toContain('2 rows changed')
    expect(outcome.message).toContain('Nothing was changed')

  })

  it('network failures are retryable and say the data is unchanged', () => {

    const outcome = describeApplyResult({
      status: 'failed',
      result: { status: 'network-unreachable', detail: 'offline' },
      retryable: true,
    })

    expect(outcome.retryable).toBe(true)
    expect(outcome.message).toContain('unchanged')
    expect(outcome.message).toContain('try again')
    expect(outcome.message).not.toMatch(/\.\./)

  })

  it('a failed OneDrive safety copy is retryable and says nothing was applied', () => {

    const outcome = describeApplyResult({ status: 'safety-copy-failed', detail: 'x' })

    expect(outcome.retryable).toBe(true)
    expect(outcome.message).toContain('nothing was applied')

  })

  it('an edit during the write keeps the newest change and asks for a refresh', () => {

    const outcome = describeApplyResult({ status: 'cloud-written-local-changed', resolved: doc })

    expect(outcome.message).toContain('was not overwritten')
    expect(outcome.needsRefresh).toBe(true)

  })

  it('every apply status has a message with no technical jargon', () => {

    const results = [
      { status: 'applied', resolved: doc },
      { status: 'blocked', result: {} },
      { status: 'needs-acknowledgement', result: {} },
      { status: 'changed-while-deciding', session: {}, decisions: {}, reset: [] },
      { status: 'failed', result: { status: 'graph-error', detail: 'x' }, retryable: true },
      { status: 'safety-copy-failed', detail: 'x' },
      { status: 'marker-failed', detail: 'x' },
      { status: 'cloud-written-local-changed', resolved: doc },
      { status: 'cloud-committed-locally-pending', detail: 'x' },
    ] as never[]

    for (const result of results) {

      const outcome = describeApplyResult(result)

      expect(`${outcome.title} ${outcome.message}`).not.toMatch(
        /ETag|412|409|schema|Graph|marker|precondition/i
      )

    }

  })

  it('prepare outcomes: ready has no message; the others explain themselves', () => {

    expect(describePrepareResult({ status: 'ready', session: {} as never })).toBeNull()
    expect(describePrepareResult({ status: 'identical', session: {} as never })?.tone).toBe('success')
    expect(describePrepareResult({ status: 'not-diverged' })?.tone).toBe('info')
    expect(describePrepareResult({ status: 'no-cloud-document' })?.tone).toBe('info')

    expect(
      describePrepareResult({
        status: 'failed',
        result: { status: 'cloud-invalid', detail: 'bad' },
      })
    ).toMatchObject({ tone: 'error', retryable: true })

  })

})
