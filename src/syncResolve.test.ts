import { describe, expect, it } from 'vitest'

import {
  resolveSnapshots,
  recordKey,
  decideAllFromDevice,
  decideAllFromCloud,
  decideCreatedSinceLastSync,
  decisionsKeepingPatientWithTreatments,
  decisionsOmittingTreatments,
  carryOverDecisions,
  suggestNumberFixes,
  type Decisions,
} from './syncResolve'

import { diffSnapshots } from './syncDiff'

import {
  makePatient,
  makeSavedTreatment,
  makeTemplate,
  makeProcedure,
  makeDocument,
} from './syncResolutionTestUtils'

const NOW = '2026-06-01T00:00:00.000Z'
const LAST_SYNC = '2026-03-01T00:00:00.000Z'
const BEFORE = '2026-02-01T12:00:00.000Z'
const AFTER = '2026-04-01T12:00:00.000Z'

function resolve(
  device: ReturnType<typeof makeDocument>,
  cloud: ReturnType<typeof makeDocument>,
  decisions: Decisions,
  extra: { numberFixes?: Record<string, number>; lastSyncAt?: string } = {}
) {
  return resolveSnapshots(device, cloud, decisions, { nowIso: NOW, ...extra })
}

describe('resolveSnapshots - choices', () => {

  it('nothing is decided -> blocked, document is null, rows are listed as undecided', () => {

    const result = resolve(
      makeDocument({ patients: [makePatient({ id: 'a', patientNumber: 1 })] }),
      makeDocument({ patients: [makePatient({ id: 'b', patientNumber: 2 })] }),
      {}
    )

    expect(result.canApply).toBe(false)
    expect(result.document).toBeNull()
    expect(result.undecided.map(item => item.id).sort()).toEqual(['a', 'b'])

  })

  it('each choice puts the right record in the result', () => {

    const result = resolve(
      makeDocument({
        patients: [
          makePatient({ id: 'keep', patientNumber: 1, name: 'Keep' }),
          makePatient({ id: 'drop', patientNumber: 2, name: 'Drop' }),
          makePatient({ id: 'both', patientNumber: 3, name: 'Device Name' }),
        ],
      }),
      makeDocument({
        patients: [
          makePatient({ id: 'bring', patientNumber: 4, name: 'Bring' }),
          makePatient({ id: 'skip', patientNumber: 5, name: 'Skip' }),
          makePatient({ id: 'both', patientNumber: 3, name: 'Cloud Name' }),
        ],
      }),
      {
        [recordKey('patient', 'keep')]: 'device',
        [recordKey('patient', 'drop')]: 'omit',
        [recordKey('patient', 'bring')]: 'cloud',
        [recordKey('patient', 'skip')]: 'omit',
        [recordKey('patient', 'both')]: 'cloud',
      }
    )

    expect(result.canApply).toBe(true)

    const names = result.document!.patients.map(patient => patient.name).sort()

    expect(names).toEqual(['Bring', 'Cloud Name', 'Keep'])
    expect(result.tally.patient).toEqual({
      fromDevice: 1,
      fromCloud: 2,
      identical: 0,
      leftOut: 2,
      total: 3,
    })

  })

  it('rejects an illegal choice (cloud on a device-only row; omit on a both-sides row)', () => {

    const result = resolve(
      makeDocument({
        patients: [
          makePatient({ id: 'a', patientNumber: 1 }),
          makePatient({ id: 'both', patientNumber: 2, name: 'X' }),
        ],
      }),
      makeDocument({ patients: [makePatient({ id: 'both', patientNumber: 2, name: 'Y' })] }),
      {
        [recordKey('patient', 'a')]: 'cloud',
        [recordKey('patient', 'both')]: 'omit',
      }
    )

    expect(result.canApply).toBe(false)
    expect(result.problems.filter(p => p.kind === 'invalid-choice')).toHaveLength(2)

  })

  it('identical records are always kept, later updatedAt wins', () => {

    const result = resolve(
      makeDocument({ patients: [makePatient({ updatedAt: '2026-05-01T00:00:00.000Z' })] }),
      makeDocument({ patients: [makePatient({ updatedAt: '2026-02-01T00:00:00.000Z' })] }),
      {}
    )

    expect(result.canApply).toBe(true)
    expect(result.document!.patients[0].updatedAt).toBe('2026-05-01T00:00:00.000Z')
    expect(result.tally.patient.identical).toBe(1)

  })

  it('result is a valid v2 document with fresh updatedAt and no tombstone field', () => {

    const result = resolve(makeDocument(), makeDocument(), {})

    expect(result.document).toMatchObject({
      schemaVersion: 2,
      app: 'ToothTarget',
      updatedAt: NOW,
    })

    expect('deletionTombstones' in result.document!).toBe(false)

  })

})

describe('shortcuts - result equals the chosen side exactly', () => {

  const device = makeDocument({
    patients: [
      makePatient({ id: 'd-only', patientNumber: 1, name: 'D' }),
      makePatient({ id: 'both', patientNumber: 2, name: 'Device Version' }),
    ],
    savedTreatments: [
      makeSavedTreatment({ id: 't-d', patientId: 'd-only', patientName: 'D' }),
    ],
    customTemplates: [makeTemplate({ id: 'tpl-d' })],
    customProcedures: [makeProcedure({ id: 'pr-d', templateId: 'tpl-d' })],
  })

  const cloud = makeDocument({
    patients: [
      makePatient({ id: 'c-only', patientNumber: 3, name: 'C' }),
      makePatient({ id: 'both', patientNumber: 2, name: 'Cloud Version' }),
    ],
    savedTreatments: [
      makeSavedTreatment({ id: 't-c', patientId: 'c-only', patientName: 'C' }),
    ],
    customTemplates: [makeTemplate({ id: 'tpl-c' })],
    customProcedures: [makeProcedure({ id: 'pr-c', templateId: 'tpl-c' })],
  })

  function ids(records: { id: string }[]) {
    return records.map(record => record.id).sort()
  }

  it('use everything from this device', () => {

    const diff = diffSnapshots(device, cloud)
    const result = resolve(device, cloud, decideAllFromDevice(diff))

    expect(result.canApply).toBe(true)
    expect(ids(result.document!.patients)).toEqual(ids(device.patients))
    expect(ids(result.document!.savedTreatments)).toEqual(ids(device.savedTreatments))
    expect(ids(result.document!.customTemplates)).toEqual(ids(device.customTemplates))
    expect(ids(result.document!.customProcedures)).toEqual(ids(device.customProcedures))
    expect(
      result.document!.patients.find(patient => patient.id === 'both')!.name
    ).toBe('Device Version')

  })

  it('use everything from OneDrive', () => {

    const diff = diffSnapshots(device, cloud)
    const result = resolve(device, cloud, decideAllFromCloud(diff))

    expect(result.canApply).toBe(true)
    expect(ids(result.document!.patients)).toEqual(ids(cloud.patients))
    expect(ids(result.document!.savedTreatments)).toEqual(ids(cloud.savedTreatments))
    expect(ids(result.document!.customTemplates)).toEqual(ids(cloud.customTemplates))
    expect(ids(result.document!.customProcedures)).toEqual(ids(cloud.customProcedures))
    expect(
      result.document!.patients.find(patient => patient.id === 'both')!.name
    ).toBe('Cloud Version')

  })

})

describe('integrity - treatments and patients', () => {

  it('a kept treatment whose patient was left out is a BLOCKING problem (never auto-resurrected)', () => {

    const device = makeDocument({
      patients: [makePatient({ id: 'p', patientNumber: 1, name: 'Omar' })],
      savedTreatments: [makeSavedTreatment({ id: 't', patientId: 'p', patientName: 'Omar' })],
    })

    const result = resolve(device, makeDocument(), {
      [recordKey('patient', 'p')]: 'omit',
      [recordKey('treatment', 't')]: 'device',
    })

    expect(result.canApply).toBe(false)
    expect(result.document).toBeNull()
    expect(result.problems).toContainEqual({
      kind: 'treatment-needs-patient',
      patientId: 'p',
      patientName: 'Omar',
      treatmentIds: ['t'],
      patientExistsOn: ['device'],
    })

  })

  it('fix A: keep the patient (from the side that has them) -> resolves', () => {

    const device = makeDocument({
      patients: [makePatient({ id: 'p', patientNumber: 1, name: 'Omar' })],
      savedTreatments: [makeSavedTreatment({ id: 't', patientId: 'p', patientName: 'Omar' })],
    })

    const diff = diffSnapshots(device, makeDocument())

    const decisions = decisionsKeepingPatientWithTreatments(
      diff,
      {
        [recordKey('patient', 'p')]: 'omit',
        [recordKey('treatment', 't')]: 'device',
      },
      'p'
    )

    expect(resolve(device, makeDocument(), decisions).canApply).toBe(true)

  })

  it('fix B: leave the treatments out too -> resolves', () => {

    const device = makeDocument({
      patients: [makePatient({ id: 'p', patientNumber: 1, name: 'Omar' })],
      savedTreatments: [makeSavedTreatment({ id: 't', patientId: 'p', patientName: 'Omar' })],
    })

    const diff = diffSnapshots(device, makeDocument())

    const decisions = decisionsOmittingTreatments(
      {
        [recordKey('patient', 'p')]: 'omit',
        [recordKey('treatment', 't')]: 'device',
      },
      diff,
      ['t']
    )

    const result = resolve(device, makeDocument(), decisions)

    expect(result.canApply).toBe(true)
    expect(result.document!.patients).toHaveLength(0)
    expect(result.document!.savedTreatments).toHaveLength(0)

  })

  it('a treatment from one side for a patient chosen from the OTHER side is fine', () => {

    const device = makeDocument({
      savedTreatments: [makeSavedTreatment({ id: 't', patientId: 'p', patientName: 'Old' })],
    })

    const cloud = makeDocument({
      patients: [makePatient({ id: 'p', patientNumber: 1, name: 'New Name' })],
    })

    const result = resolve(device, cloud, {
      [recordKey('treatment', 't')]: 'device',
      [recordKey('patient', 'p')]: 'cloud',
    })

    expect(result.canApply).toBe(true)
    // ...and its stored patient name is rewritten to the chosen patient's.
    expect(result.document!.savedTreatments[0].patientName).toBe('New Name')
    expect(result.document!.savedTreatments[0].updatedAt).toBe(NOW)
    expect(result.renamedTreatmentIds).toEqual(['t'])

  })

  it('treatments already carrying the right patient name are untouched', () => {

    const doc = makeDocument({
      patients: [makePatient()],
      savedTreatments: [makeSavedTreatment()],
    })

    const result = resolve(doc, structuredClone(doc), {})

    expect(result.renamedTreatmentIds).toEqual([])
    expect(result.document!.savedTreatments[0].updatedAt).toBe(
      doc.savedTreatments[0].updatedAt
    )

  })

  it('an orphan treatment (patient on neither side) is only a warning', () => {

    const doc = makeDocument({
      savedTreatments: [makeSavedTreatment({ id: 'o', patientId: 'nobody' })],
    })

    const result = resolve(doc, structuredClone(doc), {})

    expect(result.canApply).toBe(true)
    expect(result.warnings).toContainEqual({
      kind: 'orphan-treatment',
      treatmentId: 'o',
      patientId: 'nobody',
    })

  })

})

describe('integrity - procedures and templates', () => {

  it('a kept procedure auto-includes its custom template from either side', () => {

    const device = makeDocument({
      customProcedures: [makeProcedure({ id: 'pr', name: 'Bleaching', templateId: 'tpl' })],
    })

    const cloud = makeDocument({
      customTemplates: [makeTemplate({ id: 'tpl', name: 'Bleach plan' })],
    })

    const result = resolve(device, cloud, {
      [recordKey('procedure', 'pr')]: 'device',
      [recordKey('template', 'tpl')]: 'omit',
    })

    expect(result.canApply).toBe(true)
    expect(result.document!.customTemplates.map(t => t.id)).toEqual(['tpl'])
    expect(result.autoIncluded).toEqual([
      { entity: 'template', id: 'tpl', name: 'Bleach plan', neededBy: ['Bleaching'] },
    ])

  })

  it('a templateId on neither side is assumed built-in and left alone', () => {

    const device = makeDocument({
      customProcedures: [makeProcedure({ id: 'pr', templateId: 'builtin-rct' })],
    })

    const result = resolve(device, makeDocument(), {
      [recordKey('procedure', 'pr')]: 'device',
    })

    expect(result.canApply).toBe(true)
    expect(result.autoIncluded).toEqual([])
    expect(result.document!.customTemplates).toEqual([])

  })

  it('region template ids are honoured too', () => {

    const device = makeDocument({
      customProcedures: [
        makeProcedure({
          id: 'pr',
          templateId: 'builtin',
          regionTemplateIds: { anterior: 'a', premolar: 'b', molar: 'c' },
        }),
      ],
      customTemplates: [makeTemplate({ id: 'c', name: 'Molar' })],
    })

    const result = resolve(device, makeDocument(), {
      [recordKey('procedure', 'pr')]: 'device',
      [recordKey('template', 'c')]: 'omit',
    })

    expect(result.autoIncluded.map(item => item.id)).toEqual(['c'])

  })

  it('a treatment pointing at a procedure that was left out is a warning, not a block', () => {

    const device = makeDocument({
      patients: [makePatient()],
      savedTreatments: [makeSavedTreatment({ procedureId: 'pr' })],
      customProcedures: [makeProcedure({ id: 'pr' })],
    })

    const result = resolve(
      device,
      makeDocument({ patients: [makePatient()], savedTreatments: [makeSavedTreatment({ procedureId: 'pr' })] }),
      { [recordKey('procedure', 'pr')]: 'omit' }
    )

    expect(result.canApply).toBe(true)
    expect(result.warnings).toContainEqual({
      kind: 'treatment-procedure-missing',
      treatmentId: 'treatment-1',
      procedureId: 'pr',
    })

  })

})

describe('patient-number collisions block the apply', () => {

  const device = makeDocument({
    patients: [makePatient({ id: 'dev', patientNumber: 12, name: 'Device Twelve' })],
    savedTreatments: [makeSavedTreatment({ id: 't1', patientId: 'dev', patientName: 'Device Twelve' })],
  })

  const cloud = makeDocument({
    patients: [makePatient({ id: 'cld', patientNumber: 12, name: 'Cloud Twelve' })],
  })

  const keepBoth: Decisions = {
    [recordKey('patient', 'dev')]: 'device',
    [recordKey('patient', 'cld')]: 'cloud',
    [recordKey('treatment', 't1')]: 'device',
  }

  it('two different patients from opposite sides with the same number are caught', () => {

    const result = resolve(device, cloud, keepBoth)

    expect(result.canApply).toBe(false)
    expect(result.document).toBeNull()
    expect(result.collisions).toEqual([
      {
        patientNumber: 12,
        patients: [
          { id: 'dev', name: 'Device Twelve', treatmentCount: 1 },
          { id: 'cld', name: 'Cloud Twelve', treatmentCount: 0 },
        ],
      },
    ])
    expect(result.problems).toContainEqual({
      kind: 'number-collision',
      patientNumber: 12,
      patientIds: ['cld', 'dev'],
    })

  })

  it('a collision with a patient that is left out does not exist', () => {

    const result = resolve(device, cloud, {
      ...keepBoth,
      [recordKey('patient', 'cld')]: 'omit',
    })

    expect(result.collisions).toEqual([])
    expect(result.canApply).toBe(true)

  })

  it('suggestNumberFixes: keeper keeps the number, the other gets the next free one', () => {

    const blocked = resolve(device, cloud, keepBoth)

    const fixes = suggestNumberFixes(blocked.candidatePatients, blocked.collisions, {
      12: 'dev',
    })

    expect(fixes).toEqual({ cld: 13 })

    const resolved = resolve(device, cloud, keepBoth, { numberFixes: fixes })

    expect(resolved.canApply).toBe(true)

    const renumbered = resolved.document!.patients.find(patient => patient.id === 'cld')!

    expect(renumbered.patientNumber).toBe(13)
    expect(renumbered.updatedAt).toBe(NOW)
    expect(resolved.renumbered).toEqual([
      { patientId: 'cld', name: 'Cloud Twelve', from: 12, to: 13 },
    ])

    const kept = resolved.document!.patients.find(patient => patient.id === 'dev')!

    expect(kept.patientNumber).toBe(12)
    expect(kept.updatedAt).toBe(device.patients[0].updatedAt)

  })

  it('two renumbered patients never land on the same new number', () => {

    const triple = makeDocument({
      patients: [
        makePatient({ id: 'a', patientNumber: 5 }),
        makePatient({ id: 'b', patientNumber: 5 }),
        makePatient({ id: 'c', patientNumber: 5 }),
        makePatient({ id: 'z', patientNumber: 9 }),
      ],
    })

    const blocked = resolve(triple, makeDocument(), {
      [recordKey('patient', 'a')]: 'device',
      [recordKey('patient', 'b')]: 'device',
      [recordKey('patient', 'c')]: 'device',
      [recordKey('patient', 'z')]: 'device',
    })

    const fixes = suggestNumberFixes(blocked.candidatePatients, blocked.collisions, {
      5: 'a',
    })

    expect(fixes).toEqual({ b: 10, c: 11 })

  })

  it('an invalid manual number fix is rejected', () => {

    const result = resolve(device, cloud, keepBoth, { numberFixes: { cld: 0 } })

    expect(result.canApply).toBe(false)
    expect(result.problems).toContainEqual({
      kind: 'invalid-number-fix',
      patientId: 'cld',
      newNumber: 0,
    })

  })

  it('a manual fix to a number that is already taken is still a collision', () => {

    const result = resolve(device, cloud, keepBoth, { numberFixes: { cld: 12 } })

    expect(result.canApply).toBe(false)
    expect(result.collisions).toHaveLength(1)

  })

})

describe('deleted-record acknowledgement lists', () => {

  it('kept records that existed at the last sync are listed as resurrected; changed-since as maybe', () => {

    const device = makeDocument({
      patients: [
        makePatient({ id: 'old', patientNumber: 1, createdAt: BEFORE, updatedAt: BEFORE }),
        makePatient({ id: 'fresh', patientNumber: 2, createdAt: AFTER, updatedAt: AFTER }),
      ],
      customTemplates: [makeTemplate({ id: 'tpl', updatedAt: AFTER })],
    })

    const result = resolve(
      device,
      makeDocument(),
      {
        [recordKey('patient', 'old')]: 'device',
        [recordKey('patient', 'fresh')]: 'device',
        [recordKey('template', 'tpl')]: 'device',
      },
      { lastSyncAt: LAST_SYNC }
    )

    expect(result.resurrected.map(item => item.id)).toEqual(['old'])
    expect(result.maybeResurrected.map(item => item.id)).toEqual(['tpl'])

  })

  it('a record left out is not listed', () => {

    const device = makeDocument({
      patients: [makePatient({ id: 'old', createdAt: BEFORE, updatedAt: BEFORE })],
    })

    const result = resolve(
      device,
      makeDocument(),
      { [recordKey('patient', 'old')]: 'omit' },
      { lastSyncAt: LAST_SYNC }
    )

    expect(result.resurrected).toEqual([])

  })

})

describe('decideCreatedSinceLastSync - the per-section bulk button', () => {

  const device = makeDocument({
    patients: [
      makePatient({ id: 'new-d', patientNumber: 1, createdAt: AFTER, updatedAt: AFTER }),
      makePatient({ id: 'old-d', patientNumber: 2, createdAt: BEFORE, updatedAt: BEFORE }),
      makePatient({ id: 'diff', patientNumber: 4, name: 'Device', createdAt: AFTER, updatedAt: AFTER }),
    ],
    customTemplates: [makeTemplate({ id: 'tpl-changed', updatedAt: AFTER })],
    savedTreatments: [
      makeSavedTreatment({ id: 't-new', patientId: 'new-d', completedAt: AFTER, updatedAt: AFTER }),
    ],
  })

  const cloud = makeDocument({
    patients: [
      makePatient({ id: 'new-c', patientNumber: 3, createdAt: AFTER, updatedAt: AFTER }),
      makePatient({ id: 'diff', patientNumber: 4, name: 'Cloud', createdAt: AFTER, updatedAt: AFTER }),
    ],
  })

  const diff = diffSnapshots(device, cloud, { lastSyncAt: LAST_SYNC })

  it('fills ONLY created-since rows: keep device-side, bring cloud-side', () => {

    const decisions = decideCreatedSinceLastSync(diff, null, {})

    expect(decisions).toEqual({
      [recordKey('patient', 'new-d')]: 'device',
      [recordKey('patient', 'new-c')]: 'cloud',
      [recordKey('treatment', 't-new')]: 'device',
    })

  })

  it('never touches probably-deleted, changed-since or both-sides rows', () => {

    const decisions = decideCreatedSinceLastSync(diff, null, {})

    expect(decisions[recordKey('patient', 'old-d')]).toBeUndefined()
    expect(decisions[recordKey('template', 'tpl-changed')]).toBeUndefined()

  })

  it('is limited to one section when asked', () => {

    expect(decideCreatedSinceLastSync(diff, 'treatment', {})).toEqual({
      [recordKey('treatment', 't-new')]: 'device',
    })

  })

  it('leaves choices the dentist already made exactly as they were', () => {

    const decisions = decideCreatedSinceLastSync(diff, null, {
      [recordKey('patient', 'new-d')]: 'omit',
    })

    expect(decisions[recordKey('patient', 'new-d')]).toBe('omit')
    expect(decisions[recordKey('patient', 'new-c')]).toBe('cloud')

  })

  it('no row is preselected by the diff or the resolver on its own', () => {

    const result = resolve(device, cloud, {}, { lastSyncAt: LAST_SYNC })

    expect(result.undecided.length).toBe(
      diff.deviceOnly.length + diff.cloudOnly.length + diff.different.length
    )

  })

})

describe('carryOverDecisions - cloud changed while deciding', () => {

  const deviceDoc = makeDocument({
    patients: [
      makePatient({ id: 'stay', patientNumber: 1, name: 'Stay' }),
      makePatient({ id: 'edited', patientNumber: 2, name: 'Mine' }),
    ],
  })

  const cloudBefore = makeDocument({
    patients: [makePatient({ id: 'edited', patientNumber: 2, name: 'Theirs' })],
  })

  const previous = diffSnapshots(deviceDoc, cloudBefore)

  const decisions: Decisions = {
    [recordKey('patient', 'stay')]: 'device',
    [recordKey('patient', 'edited')]: 'device',
  }

  it('keeps choices for records nothing touched', () => {

    const next = diffSnapshots(deviceDoc, structuredClone(cloudBefore))

    const result = carryOverDecisions(previous, next, decisions)

    expect(result.decisions).toEqual(decisions)
    expect(result.reset).toEqual([])

  })

  it('resets a record whose cloud version changed, keeps the rest', () => {

    const cloudAfter = makeDocument({
      patients: [
        makePatient({
          id: 'edited',
          patientNumber: 2,
          name: 'Theirs again',
          updatedAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
    })

    const next = diffSnapshots(deviceDoc, cloudAfter)

    const result = carryOverDecisions(previous, next, decisions)

    expect(result.decisions).toEqual({
      [recordKey('patient', 'stay')]: 'device',
    })
    expect(result.reset).toEqual([recordKey('patient', 'edited')])

  })

  it('a timestamp-only bump still counts as changed (not the version you looked at)', () => {

    const cloudAfter = makeDocument({
      patients: [
        makePatient({
          id: 'edited',
          patientNumber: 2,
          name: 'Theirs',
          updatedAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
    })

    const result = carryOverDecisions(
      previous,
      diffSnapshots(deviceDoc, cloudAfter),
      decisions
    )

    // Same content (so the diff may even drop the row as identical-ish):
    // either way the old choice must not silently carry over.
    expect(result.decisions[recordKey('patient', 'edited')]).toBeUndefined()

  })

  it('a brand-new difference arrives undecided', () => {

    const cloudAfter = makeDocument({
      patients: [
        ...cloudBefore.patients,
        makePatient({ id: 'surprise', patientNumber: 9 }),
      ],
    })

    const result = carryOverDecisions(
      previous,
      diffSnapshots(deviceDoc, cloudAfter),
      decisions
    )

    expect(result.reset).toContain(recordKey('patient', 'surprise'))
    expect(result.decisions[recordKey('patient', 'surprise')]).toBeUndefined()

  })

  it('a row that changed kind (device-only -> both) is reset', () => {

    const cloudAfter = makeDocument({
      patients: [
        ...cloudBefore.patients,
        makePatient({ id: 'stay', patientNumber: 1, name: 'Stay but different' }),
      ],
    })

    const result = carryOverDecisions(
      previous,
      diffSnapshots(deviceDoc, cloudAfter),
      decisions
    )

    expect(result.reset).toContain(recordKey('patient', 'stay'))

  })

})
