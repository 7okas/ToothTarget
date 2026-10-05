import { describe, expect, it } from 'vitest'

import {
  diffSnapshots,
  classifyAge,
  describeAge,
  isDiffEmpty,
  findSameNameDifferentId,
} from './syncDiff'

import {
  makePatient,
  makeSavedTreatment,
  makeTemplate,
  makeProcedure,
  makeDocument,
} from './syncResolutionTestUtils'

const LAST_SYNC = '2026-03-01T00:00:00.000Z'
const BEFORE = '2026-02-01T12:00:00.000Z'
const AFTER = '2026-04-01T12:00:00.000Z'

describe('diffSnapshots - buckets', () => {

  it('identical records are counted, never listed', () => {

    const doc = makeDocument({
      patients: [makePatient()],
      savedTreatments: [makeSavedTreatment()],
      customTemplates: [makeTemplate()],
      customProcedures: [makeProcedure()],
    })

    const diff = diffSnapshots(doc, structuredClone(doc))

    expect(isDiffEmpty(diff)).toBe(true)
    expect(diff.identicalCount).toBe(4)

  })

  it('puts one-sided and differing records in the right buckets', () => {

    const device = makeDocument({
      patients: [
        makePatient({ id: 'p-shared', patientNumber: 1, name: 'Ahmed S.' }),
        makePatient({ id: 'p-dev', patientNumber: 2, name: 'Sara K.' }),
      ],
    })

    const cloud = makeDocument({
      patients: [
        makePatient({ id: 'p-shared', patientNumber: 1, name: 'Ahmed Samy' }),
        makePatient({ id: 'p-cloud', patientNumber: 3, name: 'Lina M.' }),
      ],
    })

    const diff = diffSnapshots(device, cloud)

    expect(diff.deviceOnly.map(item => item.id)).toEqual(['p-dev'])
    expect(diff.cloudOnly.map(item => item.id)).toEqual(['p-cloud'])
    expect(diff.different.map(item => item.id)).toEqual(['p-shared'])
    expect(diff.deviceOnly[0].side).toBe('device')
    expect(diff.cloudOnly[0].side).toBe('cloud')

  })

  it('covers all four collections', () => {

    const device = makeDocument({
      patients: [makePatient({ id: 'p1' })],
      savedTreatments: [makeSavedTreatment({ id: 't1' })],
      customTemplates: [makeTemplate({ id: 'tpl1' })],
      customProcedures: [makeProcedure({ id: 'pr1' })],
    })

    const diff = diffSnapshots(device, makeDocument())

    expect(diff.deviceOnly.map(item => item.entity).sort()).toEqual(
      ['patient', 'procedure', 'template', 'treatment']
    )

  })

})

describe('diffSnapshots - what counts as different', () => {

  it('a record whose only difference is updatedAt is identical', () => {

    const device = makeDocument({
      patients: [makePatient({ updatedAt: '2026-05-01T00:00:00.000Z' })],
    })

    const cloud = makeDocument({ patients: [makePatient()] })

    const diff = diffSnapshots(device, cloud)

    expect(isDiffEmpty(diff)).toBe(true)
    expect(diff.identicalCount).toBe(1)

  })

  it('absent caseType equals Clinical; absent status equals active', () => {

    const device = makeDocument({
      patients: [makePatient({ caseType: 'Clinical' })],
      customProcedures: [makeProcedure({ status: 'active' })],
    })

    const cloud = makeDocument({
      patients: [makePatient()],
      customProcedures: [makeProcedure()],
    })

    expect(isDiffEmpty(diffSnapshots(device, cloud))).toBe(true)

  })

  it('Practice vs absent caseType is a real difference', () => {

    const diff = diffSnapshots(
      makeDocument({ patients: [makePatient({ caseType: 'Practice' })] }),
      makeDocument({ patients: [makePatient()] })
    )

    expect(diff.different).toHaveLength(1)
    expect(diff.different[0].changes).toEqual(['Case type: Practice vs Clinical'])

  })

  it('key order never matters; array order does', () => {

    const a = makeSavedTreatment({
      phases: [{ name: 'A', duration: 1 }, { name: 'B', duration: 2 }],
    })

    const reorderedKeys = {
      ...a,
      phases: [{ duration: 1, name: 'A' }, { duration: 2, name: 'B' }],
    }

    expect(
      isDiffEmpty(
        diffSnapshots(
          makeDocument({ savedTreatments: [a] }),
          makeDocument({ savedTreatments: [reorderedKeys] })
        )
      )
    ).toBe(true)

    const reorderedArray = {
      ...a,
      phases: [{ name: 'B', duration: 2 }, { name: 'A', duration: 1 }],
    }

    expect(
      diffSnapshots(
        makeDocument({ savedTreatments: [a] }),
        makeDocument({ savedTreatments: [reorderedArray] })
      ).different
    ).toHaveLength(1)

  })

  it('record order within a collection never matters', () => {

    const p1 = makePatient({ id: 'a', patientNumber: 1 })
    const p2 = makePatient({ id: 'b', patientNumber: 2 })

    expect(
      isDiffEmpty(
        diffSnapshots(
          makeDocument({ patients: [p1, p2] }),
          makeDocument({ patients: [p2, p1] })
        )
      )
    ).toBe(true)

  })

  it('undefined-valued keys equal absent keys', () => {

    const withUndefined = { ...makePatient(), caseType: undefined }

    expect(
      isDiffEmpty(
        diffSnapshots(
          makeDocument({ patients: [withUndefined] }),
          makeDocument({ patients: [makePatient()] })
        )
      )
    ).toBe(true)

  })

})

describe('diffSnapshots - field-level change lines', () => {

  it('patient: name and number', () => {

    const diff = diffSnapshots(
      makeDocument({ patients: [makePatient({ name: 'A', patientNumber: 4 })] }),
      makeDocument({ patients: [makePatient({ name: 'B', patientNumber: 5 })] })
    )

    expect(diff.different[0].changes).toEqual([
      'Name: "A" vs "B"',
      'Patient number: #4 vs #5',
    ])

  })

  it('treatment: total time and phases', () => {

    const diff = diffSnapshots(
      makeDocument({
        savedTreatments: [makeSavedTreatment({ totalActualDuration: 54 * 60 })],
      }),
      makeDocument({
        savedTreatments: [
          makeSavedTreatment({
            totalActualDuration: 61 * 60,
            phaseTimes: [999],
          }),
        ],
      })
    )

    expect(diff.different[0].changes).toEqual([
      'Total time: 54 min vs 61 min',
      'Phases or phase times differ',
    ])

  })

  it('procedure: status; template: phases', () => {

    const diff = diffSnapshots(
      makeDocument({
        customProcedures: [makeProcedure({ status: 'archived' })],
        customTemplates: [makeTemplate()],
      }),
      makeDocument({
        customProcedures: [makeProcedure()],
        customTemplates: [
          makeTemplate({
            phases: [
              { name: 'Phase 1', duration: 600 },
              { name: 'Phase 2', duration: 60 },
            ],
          }),
        ],
      })
    )

    const byEntity = Object.fromEntries(
      diff.different.map(item => [item.entity, item.changes])
    )

    expect(byEntity.procedure).toEqual(['Status: archived vs active'])
    expect(byEntity.template).toEqual(['Phases differ (1 vs 2)'])

  })

  it('never shows a different row with no explanation', () => {

    const diff = diffSnapshots(
      makeDocument({ customTemplates: [makeTemplate({ isCustom: true })] }),
      makeDocument({
        customTemplates: [{ ...makeTemplate(), isCustom: false }],
      })
    )

    expect(diff.different[0].changes).toEqual(['Other details differ'])

  })

  it('reports which side is newer, informationally', () => {

    const diff = diffSnapshots(
      makeDocument({
        patients: [makePatient({ name: 'A', updatedAt: '2026-06-01T00:00:00.000Z' })],
      }),
      makeDocument({
        patients: [makePatient({ name: 'B', updatedAt: '2026-05-01T00:00:00.000Z' })],
      })
    )

    expect(diff.different[0].newer).toBe('device')

  })

})

describe('plain-language summaries', () => {

  it('patient summary', () => {

    const diff = diffSnapshots(
      makeDocument({
        patients: [
          makePatient({
            id: 'x',
            patientNumber: 12,
            name: 'Ahmed Samy',
            createdAt: '2026-10-03T12:00:00.000Z',
          }),
        ],
      }),
      makeDocument()
    )

    expect(diff.deviceOnly[0].summary).toBe(
      '#12 Ahmed Samy - Clinical - added 3 Oct 2026'
    )

  })

  it('treatment summary shows patient number and name from either side', () => {

    const cloudPatient = makePatient({
      id: 'p-cloud',
      patientNumber: 12,
      name: 'Ahmed Samy',
    })

    const diff = diffSnapshots(
      makeDocument({
        savedTreatments: [
          makeSavedTreatment({
            id: 't1',
            patientId: 'p-cloud',
            patientName: 'old name on record',
            procedureName: 'Root canal',
            toothId: '36',
            date: '2026-10-03T12:00:00.000Z',
            totalActualDuration: 54 * 60,
          }),
        ],
      }),
      makeDocument({ patients: [cloudPatient] })
    )

    const summary = diff.deviceOnly[0].summary

    expect(summary).toContain('Root canal')
    expect(summary).toContain('36')
    expect(summary).toContain('3 Oct 2026')
    expect(summary).toContain('54 min total')
    expect(summary).toContain('patient #12 Ahmed Samy')

  })

  it('treatment summary falls back to the stored patient name when the patient is on neither side', () => {

    const diff = diffSnapshots(
      makeDocument({
        savedTreatments: [
          makeSavedTreatment({ patientId: 'gone', patientName: 'Stored Name' }),
        ],
      }),
      makeDocument()
    )

    expect(diff.deviceOnly[0].summary).toContain('patient Stored Name')

  })

  it('procedure and template summaries', () => {

    const diff = diffSnapshots(
      makeDocument({
        customProcedures: [makeProcedure({ name: 'Composite Class II' })],
        customTemplates: [makeTemplate({ name: 'RCT 3-visit' })],
      }),
      makeDocument()
    )

    const summaries = diff.deviceOnly.map(item => item.summary).sort()

    expect(summaries).toEqual([
      'Composite Class II (active)',
      'Custom template "RCT 3-visit" - 1 phase',
    ])

  })

})

describe('classifyAge - amendment 1 wording rules', () => {

  it('created-since only when creation time is KNOWN and later than the last sync', () => {

    expect(
      classifyAge('patient', makePatient({ createdAt: AFTER }), LAST_SYNC)
    ).toBe('created-since')

    expect(
      classifyAge(
        'treatment',
        makeSavedTreatment({ completedAt: AFTER }),
        LAST_SYNC
      )
    ).toBe('created-since')

  })

  it('a patient created before the last sync but edited since is at-or-before, not new', () => {

    expect(
      classifyAge(
        'patient',
        makePatient({ createdAt: BEFORE, updatedAt: AFTER }),
        LAST_SYNC
      )
    ).toBe('at-or-before')

  })

  it('templates/procedures (no creation time) can only be changed-since', () => {

    expect(
      classifyAge('template', makeTemplate({ updatedAt: AFTER }), LAST_SYNC)
    ).toBe('changed-since')

    expect(
      classifyAge('procedure', makeProcedure({ updatedAt: AFTER }), LAST_SYNC)
    ).toBe('changed-since')

  })

  it('a treatment without a usable completedAt falls back to updatedAt -> changed-since', () => {

    const treatment = makeSavedTreatment({ updatedAt: AFTER })
    delete treatment.completedAt

    expect(classifyAge('treatment', treatment, LAST_SYNC)).toBe('changed-since')

  })

  it('an unparseable creation time falls back to updatedAt', () => {

    expect(
      classifyAge(
        'patient',
        makePatient({ createdAt: 'garbage', updatedAt: AFTER }),
        LAST_SYNC
      )
    ).toBe('changed-since')

  })

  it('at or before the last sync (inclusive) -> at-or-before', () => {

    expect(
      classifyAge('patient', makePatient({ createdAt: LAST_SYNC }), LAST_SYNC)
    ).toBe('at-or-before')

    expect(
      classifyAge('template', makeTemplate({ updatedAt: BEFORE }), LAST_SYNC)
    ).toBe('at-or-before')

  })

  it('unknown when the last sync time is missing or invalid', () => {

    expect(classifyAge('patient', makePatient(), null)).toBe('unknown')
    expect(classifyAge('patient', makePatient(), undefined)).toBe('unknown')
    expect(classifyAge('patient', makePatient(), 'nope')).toBe('unknown')

  })

})

describe('hints on one-sided rows', () => {

  it('exact wording per age and side', () => {

    expect(describeAge('created-since', 'device')).toBe('Created since last sync')

    expect(describeAge('changed-since', 'cloud')).toBe(
      'Changed since last sync - may have been deleted on the other side'
    )

    expect(describeAge('at-or-before', 'device')).toContain(
      'probably DELETED from OneDrive'
    )

    expect(describeAge('at-or-before', 'cloud')).toContain(
      'probably DELETED on this device'
    )

    expect(describeAge('unknown', 'device')).toBeNull()

  })

  it('the diff attaches age and hint to each one-sided row', () => {

    const diff = diffSnapshots(
      makeDocument({
        patients: [
          makePatient({ id: 'new', createdAt: AFTER, updatedAt: AFTER }),
          makePatient({ id: 'old', createdAt: BEFORE, updatedAt: BEFORE }),
        ],
        customTemplates: [makeTemplate({ id: 'tpl', updatedAt: AFTER })],
      }),
      makeDocument({
        patients: [makePatient({ id: 'cloud-old', createdAt: BEFORE })],
      }),
      { lastSyncAt: LAST_SYNC }
    )

    const byId = Object.fromEntries(
      [...diff.deviceOnly, ...diff.cloudOnly].map(item => [item.id, item])
    )

    expect(byId.new.age).toBe('created-since')
    expect(byId.new.hint).toBe('Created since last sync')
    expect(byId.old.age).toBe('at-or-before')
    expect(byId.old.hint).toContain('probably DELETED from OneDrive')
    expect(byId.tpl.age).toBe('changed-since')
    expect(byId['cloud-old'].hint).toContain('probably DELETED on this device')

  })

  it('without a last-sync time, no row gets a hint', () => {

    const diff = diffSnapshots(
      makeDocument({ patients: [makePatient()] }),
      makeDocument()
    )

    expect(diff.deviceOnly[0].age).toBe('unknown')
    expect(diff.deviceOnly[0].hint).toBeNull()

  })

})

describe('findSameNameDifferentId', () => {

  it('flags a procedure with the same name but a different id on each side', () => {

    const diff = diffSnapshots(
      makeDocument({
        customProcedures: [makeProcedure({ id: 'a', name: 'Bleaching' })],
      }),
      makeDocument({
        customProcedures: [makeProcedure({ id: 'b', name: ' bleaching ' })],
      })
    )

    expect(findSameNameDifferentId(diff)).toEqual([
      { entity: 'procedure', name: 'Bleaching', deviceId: 'a', cloudId: 'b' },
    ])

  })

  it('returns nothing when names differ', () => {

    const diff = diffSnapshots(
      makeDocument({ customProcedures: [makeProcedure({ id: 'a', name: 'X' })] }),
      makeDocument({ customProcedures: [makeProcedure({ id: 'b', name: 'Y' })] })
    )

    expect(findSameNameDifferentId(diff)).toEqual([])

  })

})
