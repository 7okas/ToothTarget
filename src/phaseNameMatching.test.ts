import { describe, expect, it } from 'vitest'
import {
  collapseRepeatedLetters,
  comparePhaseNames,
  editDistance,
  isSingleAdjacentSwap,
  normalisePhaseName,
} from './phaseNameMatching'

describe('normalisePhaseName', () => {

  it('trims, collapses spaces and lowercases', () => {
    expect(normalisePhaseName('  Access  ')).toBe('access')
    expect(normalisePhaseName('Working   Length')).toBe('working length')
    expect(normalisePhaseName('ACCESS')).toBe('access')
  })

  it('treats "&" as "and"', () => {
    expect(normalisePhaseName('Cleaning & Shaping')).toBe('cleaning and shaping')
    expect(normalisePhaseName('Cleaning&Shaping')).toBe('cleaning and shaping')
    expect(normalisePhaseName('Cleaning and Shaping')).toBe('cleaning and shaping')
  })

  it('turns punctuation into spaces', () => {
    expect(normalisePhaseName('Glide-Path')).toBe('glide path')
    expect(normalisePhaseName('Glide_Path.')).toBe('glide path')
    expect(normalisePhaseName("Pre-op (rinse)")).toBe('pre op rinse')
  })

  it('folds look-alike Unicode forms', () => {
    expect(normalisePhaseName('ＡＣＣＥＳＳ')).toBe('access')
  })

  it('an empty or punctuation-only name normalises to nothing', () => {
    expect(normalisePhaseName('')).toBe('')
    expect(normalisePhaseName(' - . ')).toBe('')
  })

})

describe('collapseRepeatedLetters / editDistance / isSingleAdjacentSwap', () => {

  it('collapses repeated letters but keeps digits and spaces', () => {
    expect(collapseRepeatedLetters('access')).toBe('aces')
    expect(collapseRepeatedLetters('acesss')).toBe('aces')
    expect(collapseRepeatedLetters('coat 11')).toBe('coat 11')
  })

  it('counts single-letter insert, delete and replace', () => {
    expect(editDistance('access', 'access')).toBe(0)
    expect(editDistance('obturaton', 'obturation')).toBe(1)
    expect(editDistance('shaping', 'shaped')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('abc', '')).toBe(3)
    expect(editDistance('acesss', 'access')).toBe(2)
  })

  it('recognises exactly one swapped neighbour pair', () => {
    expect(isSingleAdjacentSwap('lenght', 'length')).toBe(true)
    expect(isSingleAdjacentSwap('length', 'length')).toBe(false)
    expect(isSingleAdjacentSwap('abcd', 'acbd')).toBe(true)
    expect(isSingleAdjacentSwap('abcd', 'adcb')).toBe(false)
    expect(isSingleAdjacentSwap('abc', 'abcd')).toBe(false)
  })

})

describe('comparePhaseNames - identical', () => {

  it('the same name as written is never a problem', () => {
    expect(comparePhaseNames('Access', 'Access')).toEqual({ kind: 'identical' })
  })

  it('surrounding spaces do not count as a difference', () => {
    expect(comparePhaseNames('  Access ', 'Access')).toEqual({ kind: 'identical' })
  })

})

describe('comparePhaseNames - Tier 0 (case, spacing, punctuation, "&" vs "and")', () => {

  it.each([
    ['access', 'Access'],
    ['ACCESS', 'Access'],
    ['Working  Length', 'Working Length'],
    ['Glide-Path', 'Glide Path'],
    ['Glide Path.', 'Glide Path'],
    ['Cleaning and Shaping', 'Cleaning & Shaping'],
    ['cleaning&shaping', 'Cleaning & Shaping'],
  ])('"%s" vs "%s"', (typed, candidate) => {
    expect(comparePhaseNames(typed, candidate)).toEqual({ kind: 'match', tier: 0, distance: 0 })
  })

  it('applies at any length, even very short names', () => {
    expect(comparePhaseNames('etch', 'Etch')).toEqual({ kind: 'match', tier: 0, distance: 0 })
    expect(comparePhaseNames('a', 'A')).toEqual({ kind: 'match', tier: 0, distance: 0 })
  })

})

describe('comparePhaseNames - Tier 1 (repeated letters, swapped neighbours)', () => {

  it('catches the doubled-letter slip from the plan: "Acesss" vs "Access" (two edits apart)', () => {
    expect(comparePhaseNames('Acesss', 'Access')).toEqual({ kind: 'match', tier: 1, distance: 2 })
  })

  it.each([
    ['Irigation', 'Irrigation'],
    ['Shapping', 'Shaping'],
    ['Working Lenght', 'Working Length'],
    ['Obturaiton', 'Obturation'],
    ['Acess', 'Access'],
  ])('"%s" vs "%s"', (typed, candidate) => {
    const verdict = comparePhaseNames(typed, candidate)
    expect(verdict.kind).toBe('match')
    if (verdict.kind === 'match') {
      expect(verdict.tier).toBe(1)
    }
  })

  it('needs 5 or more letters in the typed name', () => {
    // "Seat"/"Seats" would be plural; use a swap: "Etch" vs "Ecth" is only 4 letters.
    expect(comparePhaseNames('Ecth', 'Etch')).toEqual({ kind: 'suppressed', guard: 'short', distance: 2 })
  })

})

describe('comparePhaseNames - Tier 2 (edit distance)', () => {

  it('distance 1 is flagged from 7 letters up', () => {
    expect(comparePhaseNames('Obturaton', 'Obturation')).toEqual({ kind: 'match', tier: 2, distance: 1 })
    expect(comparePhaseNames('Impresion', 'Impression')).toEqual({ kind: 'match', tier: 1, distance: 1 })
    expect(comparePhaseNames('Irrigatio', 'Irrigation')).toEqual({ kind: 'match', tier: 2, distance: 1 })
  })

  it('distance 2 is flagged from 12 letters up', () => {
    expect(comparePhaseNames('Cleaning and Shapng', 'Cleaning and Shaping')).toEqual({
      kind: 'match',
      tier: 2,
      distance: 1,
    })
    expect(comparePhaseNames('Restoration Finishng', 'Restoration Finishing').kind).toBe('match')
    expect(comparePhaseNames('Indirect Restoratn', 'Indirect Restoration')).toEqual({
      kind: 'match',
      tier: 2,
      distance: 2,
    })
  })

})

describe('comparePhaseNames - guards (close but NOT flagged)', () => {

  it('a one-letter change on a 5-6 letter name is too short for Tier 2', () => {
    expect(comparePhaseNames('Rinse', 'Rise')).toEqual({ kind: 'suppressed', guard: 'length', distance: 1 })
    expect(comparePhaseNames('Shaped', 'Shaper')).toEqual({ kind: 'suppressed', guard: 'length', distance: 1 })
  })

  it('names of 4 letters or fewer only match at Tier 0', () => {
    expect(comparePhaseNames('Seal', 'Seat')).toEqual({ kind: 'suppressed', guard: 'short', distance: 1 })
    expect(comparePhaseNames('Bond', 'Bone')).toEqual({ kind: 'suppressed', guard: 'short', distance: 1 })
  })

  it('names that are just different words are not even reported', () => {
    expect(comparePhaseNames('Seal', 'Bond')).toEqual({ kind: 'different' })
    expect(comparePhaseNames('Access', 'Obturation')).toEqual({ kind: 'different' })
  })

  it('a trailing "s" is not a typo', () => {
    expect(comparePhaseNames('Rinses', 'Rinse')).toEqual({ kind: 'suppressed', guard: 'plural-s', distance: 1 })
    expect(comparePhaseNames('Rinse', 'Rinses')).toEqual({ kind: 'suppressed', guard: 'plural-s', distance: 1 })
    expect(comparePhaseNames('Irrigations', 'Irrigation')).toEqual({ kind: 'suppressed', guard: 'plural-s', distance: 1 })
  })

  it('names that differ in their numbers are never flagged', () => {
    expect(comparePhaseNames('Coat 1', 'Coat 2')).toEqual({ kind: 'suppressed', guard: 'digits', distance: 1 })
    expect(comparePhaseNames('Visit 2', 'Visit 3')).toEqual({ kind: 'suppressed', guard: 'digits', distance: 1 })
    expect(comparePhaseNames('Irrigation 1', 'Irrigation 12').kind).toBe('suppressed')
  })

  it('2 apart on a name under 12 letters is too loose', () => {
    expect(comparePhaseNames('Isolation', 'Insulation')).toEqual({ kind: 'suppressed', guard: 'length', distance: 2 })
    expect(comparePhaseNames('Preperatoon', 'Preparation')).toEqual({ kind: 'suppressed', guard: 'length', distance: 2 })
  })

  it('"Shaping" vs "Shaped" is three edits apart, so not even close', () => {
    expect(comparePhaseNames('Shaping', 'Shaped')).toEqual({ kind: 'different' })
  })

  it('synonyms are out of scope', () => {
    expect(comparePhaseNames('Irrigation', 'Irrigant activation')).toEqual({ kind: 'different' })
    expect(comparePhaseNames('Shaping', 'Cleaning & Shaping')).toEqual({ kind: 'different' })
  })

  it('an empty or punctuation-only name never matches anything', () => {
    expect(comparePhaseNames('', 'Access')).toEqual({ kind: 'different' })
    expect(comparePhaseNames(' - ', 'Access')).toEqual({ kind: 'different' })
  })

})

describe('comparePhaseNames - the examples from the plan', () => {

  const wouldTrigger: [string, string][] = [
    ['Acesss', 'Access'],
    ['access', 'Access'],
    ['Irigation', 'Irrigation'],
    ['Obturaton', 'Obturation'],
    ['Working Lenght', 'Working Length'],
    ['Glide-Path', 'Glide Path'],
    ['Cleaning and Shapping', 'Cleaning & Shaping'],
  ]

  const wouldNot: [string, string][] = [
    ['Rinse', 'Rinses'],
    ['Rinse', 'Rise'],
    ['Seal', 'Seat'],
    ['Coat 1', 'Coat 2'],
    ['Shaping', 'Shaped'],
    ['Isolation', 'Insulation'],
    ['Irrigation', 'Irrigant activation'],
    ['Access', 'Access'],
  ]

  it.each(wouldTrigger)('"%s" -> "%s" triggers', (typed, candidate) => {
    expect(comparePhaseNames(typed, candidate).kind).toBe('match')
  })

  it.each(wouldNot)('"%s" vs "%s" does not trigger', (typed, candidate) => {
    expect(comparePhaseNames(typed, candidate).kind).not.toBe('match')
  })

})
