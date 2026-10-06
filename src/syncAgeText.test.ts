import { describe, expect, it } from 'vitest'
import { STALE_AFTER_MS, describeLastSync } from './syncAgeText'

const NOW = new Date('2026-10-06T12:00:00.000Z')

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString()
}

const synced = { synced: true, labelShown: false }
const notSynced = { synced: false, labelShown: false }

function long(ms: number, options = synced): string | undefined {
  return describeLastSync(ago(ms), NOW, options)?.long
}

function short(ms: number): string | undefined {
  return describeLastSync(ago(ms), NOW, synced)?.short
}

describe('describeLastSync - the long wording', () => {

  it('synced: "Synced 5 minutes ago"', () => {
    expect(long(5 * MIN)).toBe('Synced 5 minutes ago')
  })

  it('offline, needs input, conflict or syncing: "Last synced 3 hours ago"', () => {
    expect(long(3 * HOUR, notSynced)).toBe('Last synced 3 hours ago')
  })

  it('drops the prefix when the badge already shows "Synced" just before it', () => {
    expect(long(20 * SEC, { synced: true, labelShown: true })).toBe('just now')
    expect(long(5 * MIN, { synced: true, labelShown: true })).toBe('5 minutes ago')
  })

  it('keeps "Last synced" even when a label is shown, if it is not the synced state', () => {
    expect(long(3 * HOUR, { synced: false, labelShown: true })).toBe('Last synced 3 hours ago')
  })

})

describe('describeLastSync - the age words', () => {

  it('under a minute is "just now"', () => {
    expect(long(0)).toBe('Synced just now')
    expect(long(59 * SEC + 999)).toBe('Synced just now')
    expect(long(0, notSynced)).toBe('Last synced just now')
  })

  it('minutes, with 1 in the singular', () => {
    expect(long(60 * SEC)).toBe('Synced 1 minute ago')
    expect(long(2 * MIN)).toBe('Synced 2 minutes ago')
    expect(long(59 * MIN + 59 * SEC)).toBe('Synced 59 minutes ago')
  })

  it('hours, with 1 in the singular', () => {
    expect(long(60 * MIN)).toBe('Synced 1 hour ago')
    expect(long(3 * HOUR + 40 * MIN)).toBe('Synced 3 hours ago')
    expect(long(23 * HOUR + 59 * MIN)).toBe('Synced 23 hours ago')
  })

  it('days, with 1 in the singular, up to 13 days', () => {
    expect(long(24 * HOUR)).toBe('Synced 1 day ago')
    expect(long(3 * DAY)).toBe('Synced 3 days ago')
    expect(long(13 * DAY + 23 * HOUR)).toBe('Synced 13 days ago')
  })

  it('from 14 days on, whole weeks ("weeks ago")', () => {
    expect(long(14 * DAY)).toBe('Synced 2 weeks ago')
    expect(long(20 * DAY)).toBe('Synced 2 weeks ago')
    expect(long(21 * DAY)).toBe('Synced 3 weeks ago')
    expect(long(60 * DAY)).toBe('Synced 8 weeks ago')
  })

  it('a time slightly in the future (clock difference) reads "just now"', () => {
    const text = describeLastSync(new Date(NOW.getTime() + 5 * MIN).toISOString(), NOW, synced)
    expect(text?.long).toBe('Synced just now')
    expect(text?.stale).toBe(false)
  })

})

describe('describeLastSync - the short wording (narrow screens)', () => {

  it('is compact and has no prefix, whatever the state', () => {
    expect(short(0)).toBe('just now')
    expect(short(5 * MIN)).toBe('5m ago')
    expect(short(59 * MIN)).toBe('59m ago')
    expect(short(3 * HOUR)).toBe('3h ago')
    expect(short(2 * DAY)).toBe('2d ago')
    expect(short(13 * DAY)).toBe('13d ago')
    expect(short(21 * DAY)).toBe('3w ago')
    expect(describeLastSync(ago(3 * HOUR), NOW, notSynced)?.short).toBe('3h ago')
  })

  it('is never longer than the long form', () => {
    for (const ms of [0, 5 * MIN, 3 * HOUR, 3 * DAY, 21 * DAY]) {
      const text = describeLastSync(ago(ms), NOW, notSynced)!
      expect(text.short.length).toBeLessThanOrEqual(text.long.length)
    }
  })

})

describe('describeLastSync - the old-sync warning', () => {

  it('is stale only when older than 2 days', () => {
    expect(STALE_AFTER_MS).toBe(2 * DAY)
    expect(describeLastSync(ago(5 * MIN), NOW, synced)?.stale).toBe(false)
    expect(describeLastSync(ago(47 * HOUR), NOW, synced)?.stale).toBe(false)
    expect(describeLastSync(ago(2 * DAY), NOW, synced)?.stale).toBe(false)
    expect(describeLastSync(ago(2 * DAY + 1), NOW, synced)?.stale).toBe(true)
    expect(describeLastSync(ago(3 * DAY), NOW, notSynced)?.stale).toBe(true)
    expect(describeLastSync(ago(21 * DAY), NOW, notSynced)?.stale).toBe(true)
  })

})

describe('describeLastSync - nothing to show', () => {

  it('is null when the device has never synced', () => {
    expect(describeLastSync(null, NOW, synced)).toBeNull()
  })

  it('is null for an unreadable timestamp, never "NaN ago"', () => {
    expect(describeLastSync('', NOW, synced)).toBeNull()
    expect(describeLastSync('not a date', NOW, synced)).toBeNull()
  })

})
