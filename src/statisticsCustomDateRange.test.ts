import { describe, expect, it } from 'vitest'

/*
  Custom date ranges are LOCAL calendar days. These tests pin the device
  time zone to Egypt (Africa/Cairo: UTC+2 in winter, UTC+3 in summer,
  with daylight saving restored in 2023 - clocks go forward at midnight
  on the last Friday of April and back at midnight on the last Thursday
  of October) so month-end and daylight-saving cases are exercised
  against the real rules instead of whatever zone the test machine uses.
  Set before any Date is created; statistics.ts creates none at import.
*/
// (This project has no Node type definitions, hence the cast.)
;(globalThis as unknown as { process: { env: Record<string, string> } })
  .process.env.TZ = 'Africa/Cairo'

import type { SavedTreatment } from './App'
import {
  applyStatisticsFilters,
  resolveCustomDateRange,
  resolveDateRangePreset,
  ALL_TREATMENTS_FILTER,
} from './statistics'

function treatmentAt(id: string, dateIso: string): SavedTreatment {
  return { id, date: dateIso } as unknown as SavedTreatment
}

function idsIn(
  fromDay: string,
  toDay: string,
  treatments: SavedTreatment[]
): string[] {
  const range = resolveCustomDateRange(fromDay, toDay)
  expect(range).not.toBeNull()
  return applyStatisticsFilters(treatments, {
    ...ALL_TREATMENTS_FILTER,
    dateRange: range,
  }).map(treatment => treatment.id)
}

describe('test setup', () => {

  it('is really running in Egypt time, with daylight saving', () => {
    // getTimezoneOffset() is minutes WEST of UTC: -120 = UTC+2, -180 = UTC+3.
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).toBe(-120)
    expect(new Date(2026, 6, 15, 12).getTimezoneOffset()).toBe(-180)
    // The 2026 transitions: Fri 24 Apr (forward) and Thu 29 Oct (back).
    expect(new Date(2026, 3, 23, 12).getTimezoneOffset()).toBe(-120)
    expect(new Date(2026, 3, 24, 12).getTimezoneOffset()).toBe(-180)
    expect(new Date(2026, 9, 29, 12).getTimezoneOffset()).toBe(-180)
    expect(new Date(2026, 9, 30, 12).getTimezoneOffset()).toBe(-120)
  })

})

describe('resolveCustomDateRange - whole local days', () => {

  it('one winter day runs from local midnight to the last millisecond of that local day', () => {
    // 15 March 2026 is UTC+2.
    expect(resolveCustomDateRange('2026-03-15', '2026-03-15')).toEqual({
      from: '2026-03-14T22:00:00.000Z',
      to: '2026-03-15T21:59:59.999Z',
    })
  })

  it('one summer day uses the summer offset (UTC+3)', () => {
    expect(resolveCustomDateRange('2026-07-10', '2026-07-10')).toEqual({
      from: '2026-07-09T21:00:00.000Z',
      to: '2026-07-10T20:59:59.999Z',
    })
  })

  it('a multi-day range includes both end days in full', () => {
    expect(resolveCustomDateRange('2026-03-10', '2026-03-12')).toEqual({
      from: '2026-03-09T22:00:00.000Z',
      to: '2026-03-12T21:59:59.999Z',
    })
  })

  it('returns null for missing or invalid input, so the caller treats it as "no range yet"', () => {
    for (const bad of ['', 'abc', '2026-13-01', '2026-02-30', '2026-00-10', '2026-3-5', '15/03/2026']) {
      expect(resolveCustomDateRange(bad, '2026-03-15')).toBeNull()
      expect(resolveCustomDateRange('2026-03-15', bad)).toBeNull()
    }
  })

  it('from after to is returned as given and matches nothing', () => {
    const range = resolveCustomDateRange('2026-03-20', '2026-03-10')
    expect(range).not.toBeNull()
    expect(
      idsIn('2026-03-20', '2026-03-10', [treatmentAt('x', '2026-03-15T10:00:00.000Z')])
    ).toEqual([])
  })

  it('plugs into the existing custom preset unchanged', () => {
    const range = resolveCustomDateRange('2026-03-10', '2026-03-12')
    expect(resolveDateRangePreset('custom', range)).toEqual(range)
  })

})

describe('month-end boundaries (local days, not UTC days)', () => {

  // Cairo is UTC+2 in January, so local midnight = 22:00Z the evening before.
  const treatments = [
    treatmentAt('dec31-last-ms', '2025-12-31T21:59:59.999Z'), // 31 Dec 23:59:59.999 local
    treatmentAt('jan1-first-ms', '2025-12-31T22:00:00.000Z'), //  1 Jan 00:00:00.000 local
    treatmentAt('jan1-00-30', '2025-12-31T22:30:00.000Z'), //     1 Jan 00:30 local (still 31 Dec in UTC)
    treatmentAt('jan31-23-59', '2026-01-31T21:59:59.999Z'), //   31 Jan 23:59:59.999 local
    treatmentAt('feb1-first-ms', '2026-01-31T22:00:00.000Z'), //  1 Feb 00:00:00.000 local
  ]

  it('January includes its first and last local millisecond and nothing outside', () => {
    expect(idsIn('2026-01-01', '2026-01-31', treatments)).toEqual([
      'jan1-first-ms',
      'jan1-00-30',
      'jan31-23-59',
    ])
  })

  it('the day after January starts exactly one millisecond later', () => {
    expect(idsIn('2026-02-01', '2026-02-28', treatments)).toEqual(['feb1-first-ms'])
    expect(idsIn('2025-12-01', '2025-12-31', treatments)).toEqual(['dec31-last-ms'])
  })

  it('a treatment at 00:30 local on the 1st belongs to the 1st, not the 31st (the old UTC reading got this wrong)', () => {
    expect(idsIn('2026-01-01', '2026-01-01', treatments)).toEqual(['jan1-first-ms', 'jan1-00-30'])
    expect(idsIn('2025-12-31', '2025-12-31', treatments)).toEqual(['dec31-last-ms'])

    // The previous behaviour read the same picker values as UTC days.
    const oldFrom = new Date('2026-01-01').getTime()
    const oldTo = new Date('2026-01-31T23:59:59.999Z').getTime()
    const oldKept = treatments.filter(treatment => {
      const time = new Date(treatment.date).getTime()
      return time >= oldFrom && time <= oldTo
    }).map(treatment => treatment.id)
    expect(oldKept).not.toEqual(['jan1-first-ms', 'jan1-00-30', 'jan31-23-59'])
  })

  it('a leap February ends on the 29th and a non-leap one on the 28th', () => {
    // 2028 is a leap year (UTC+2 in winter).
    const leap = [
      treatmentAt('feb29-last', '2028-02-29T21:59:59.999Z'),
      treatmentAt('mar1-first', '2028-02-29T22:00:00.000Z'),
    ]
    expect(idsIn('2028-02-01', '2028-02-29', leap)).toEqual(['feb29-last'])

    const nonLeap = [
      treatmentAt('feb28-last', '2026-02-28T21:59:59.999Z'),
      treatmentAt('mar1-first', '2026-02-28T22:00:00.000Z'),
    ]
    expect(idsIn('2026-02-01', '2026-02-28', nonLeap)).toEqual(['feb28-last'])
    expect(resolveCustomDateRange('2026-02-29', '2026-03-01')).toBeNull()
  })

  it('a whole year, 1 Jan to 31 Dec, includes the first and last local instants of the year', () => {
    const year = [
      treatmentAt('before', '2025-12-31T21:59:59.999Z'),
      treatmentAt('first', '2025-12-31T22:00:00.000Z'),
      treatmentAt('last', '2026-12-31T21:59:59.999Z'),
      treatmentAt('after', '2026-12-31T22:00:00.000Z'),
    ]
    expect(idsIn('2026-01-01', '2026-12-31', year)).toEqual(['first', 'last'])
  })

  it('a month that straddles a daylight-saving change still includes its last local instant (April 2026)', () => {
    // 30 Apr 23:59:59.999 local is UTC+3, so 20:59:59.999Z; 1 May 00:00 local is 21:00Z.
    const april = [
      treatmentAt('apr30-last', '2026-04-30T20:59:59.999Z'),
      treatmentAt('may1-first', '2026-04-30T21:00:00.000Z'),
    ]
    expect(idsIn('2026-04-01', '2026-04-30', april)).toEqual(['apr30-last'])
  })

  it('October 2026, ended by the clock going back, still ends on its last local instant', () => {
    // 31 Oct 23:59:59.999 local is UTC+2 again = 21:59:59.999Z.
    const october = [
      treatmentAt('oct31-last', '2026-10-31T21:59:59.999Z'),
      treatmentAt('nov1-first', '2026-10-31T22:00:00.000Z'),
    ]
    expect(idsIn('2026-10-01', '2026-10-31', october)).toEqual(['oct31-last'])
  })

})

describe('Egypt daylight-saving transitions', () => {

  it('clock-forward day, Fri 24 Apr 2026: local midnight does not exist, the day starts at the first real instant and is 23 hours long', () => {
    // Clocks jump 00:00 -> 01:00 (UTC+2 -> UTC+3) at 22:00Z on 23 Apr.
    const range = resolveCustomDateRange('2026-04-24', '2026-04-24')
    expect(range).toEqual({
      from: '2026-04-23T22:00:00.000Z',
      to: '2026-04-24T20:59:59.999Z',
    })
    const hours = (new Date(range!.to).getTime() + 1 - new Date(range!.from).getTime()) / 3_600_000
    expect(hours).toBe(23)
  })

  it('clock-forward day: the day before ends exactly where this day starts - nothing lost, nothing double counted', () => {
    const before = resolveCustomDateRange('2026-04-23', '2026-04-23')!
    const day = resolveCustomDateRange('2026-04-24', '2026-04-24')!
    expect(new Date(before.to).getTime() + 1).toBe(new Date(day.from).getTime())
  })

  it('clock-back day, Thu 29 Oct 2026: the day is 25 hours long and includes the repeated 23:00-24:00 hour', () => {
    // Clocks go back 24:00 -> 23:00 (UTC+3 -> UTC+2): the hour from 21:00Z to 22:00Z
    // on 29 Oct is the SECOND 23:00-24:00 of that Thursday.
    const range = resolveCustomDateRange('2026-10-29', '2026-10-29')
    expect(range).toEqual({
      from: '2026-10-28T21:00:00.000Z',
      to: '2026-10-29T21:59:59.999Z',
    })
    const hours = (new Date(range!.to).getTime() + 1 - new Date(range!.from).getTime()) / 3_600_000
    expect(hours).toBe(25)

    const thursday = [
      treatmentAt('first-23-30', '2026-10-29T20:30:00.000Z'), // 23:30 local, first pass (UTC+3)
      treatmentAt('second-23-30', '2026-10-29T21:30:00.000Z'), // 23:30 local, second pass (UTC+2)
      treatmentAt('friday-00-10', '2026-10-29T22:10:00.000Z'), // 00:10 Friday local
    ]
    expect(idsIn('2026-10-29', '2026-10-29', thursday)).toEqual(['first-23-30', 'second-23-30'])
    expect(idsIn('2026-10-30', '2026-10-30', thursday)).toEqual(['friday-00-10'])
  })

  it('every instant across both transitions falls in exactly one single-day range', () => {

    function days(startDay: Date, count: number): string[] {
      return Array.from({ length: count }, (_, offset) => {
        const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + offset)
        const mm = String(day.getMonth() + 1).padStart(2, '0')
        const dd = String(day.getDate()).padStart(2, '0')
        return `${day.getFullYear()}-${mm}-${dd}`
      })
    }

    for (const startDay of [new Date(2026, 3, 20), new Date(2026, 9, 25), new Date(2026, 3, 22), new Date(2026, 9, 27)]) {

      const labels = days(startDay, 10)

      const ranges = labels.map(label => ({ label, range: resolveCustomDateRange(label, label)! }))

      // Probe every 30 minutes from the very start of the first day to the end of the last.
      const first = new Date(ranges[0].range.from).getTime()
      const last = new Date(ranges[ranges.length - 1].range.to).getTime()

      for (let time = first; time <= last; time += 30 * 60 * 1000) {
        const owners = ranges.filter(({ range }) =>
          time >= new Date(range.from).getTime() && time <= new Date(range.to).getTime()
        )
        expect(owners).toHaveLength(1)
      }

      // Consecutive days touch exactly (to + 1ms = next from).
      for (let index = 0; index < ranges.length - 1; index++) {
        expect(new Date(ranges[index].range.to).getTime() + 1).toBe(
          new Date(ranges[index + 1].range.from).getTime()
        )
      }

    }

  })

  it('a range spanning a whole transition week covers the same instants as its single days put together', () => {
    const week = resolveCustomDateRange('2026-10-25', '2026-10-31')!
    const firstDay = resolveCustomDateRange('2026-10-25', '2026-10-25')!
    const lastDay = resolveCustomDateRange('2026-10-31', '2026-10-31')!
    expect(week.from).toBe(firstDay.from)
    expect(week.to).toBe(lastDay.to)
  })

})
