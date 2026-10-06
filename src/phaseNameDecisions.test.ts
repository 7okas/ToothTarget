import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPhaseNameDecisionsForTests,
  isPhaseNameKeptAsTyped,
  rememberPhaseNameKeptAsTyped,
} from './phaseNameDecisions'

afterEach(() => {
  __resetPhaseNameDecisionsForTests()
  vi.unstubAllGlobals()
})

describe('"Save as typed" memory', () => {

  it('starts empty', () => {
    expect(isPhaseNameKeptAsTyped('Acesss', 'Access')).toBe(false)
  })

  it('remembers a typed-name / suggestion pair once it was kept as typed', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(isPhaseNameKeptAsTyped('Acesss', 'Access')).toBe(true)
  })

  it('remembers per PAIR: the same typed name against a different suggestion is a new question', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(isPhaseNameKeptAsTyped('Acesss', 'Assess')).toBe(false)
  })

  it('a different typed name against the same suggestion is a new question', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(isPhaseNameKeptAsTyped('Acess', 'Access')).toBe(false)
  })

  it('the typed side ignores case, spacing and punctuation differences', () => {
    rememberPhaseNameKeptAsTyped('  Acesss ', 'Access')
    expect(isPhaseNameKeptAsTyped('acesss', 'Access')).toBe(true)
    expect(isPhaseNameKeptAsTyped('ACESSS', 'Access')).toBe(true)
  })

  it('the suggestion side is compared as written (trimmed), so "Access" does not silence "access"', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(isPhaseNameKeptAsTyped('Acesss', ' Access ')).toBe(true)
    expect(isPhaseNameKeptAsTyped('Acesss', 'access')).toBe(false)
  })

  it('remembering twice is harmless', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(isPhaseNameKeptAsTyped('Acesss', 'Access')).toBe(true)
  })

  it('never reads or writes any browser storage', () => {
    const trap = {
      getItem: () => { throw new Error('storage was read') },
      setItem: () => { throw new Error('storage was written') },
      removeItem: () => { throw new Error('storage was written') },
      clear: () => { throw new Error('storage was written') },
      key: () => { throw new Error('storage was read') },
      length: 0,
    }
    vi.stubGlobal('localStorage', trap)
    vi.stubGlobal('sessionStorage', trap)

    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    expect(isPhaseNameKeptAsTyped('Acesss', 'Access')).toBe(true)
  })

  it('the test reset forgets everything (as closing the app would)', () => {
    rememberPhaseNameKeptAsTyped('Acesss', 'Access')
    __resetPhaseNameDecisionsForTests()
    expect(isPhaseNameKeptAsTyped('Acesss', 'Access')).toBe(false)
  })

})
