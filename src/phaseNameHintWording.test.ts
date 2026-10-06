import { describe, expect, it } from 'vitest'
import {
  KEEP_AS_TYPED_LABEL,
  hintQuestion,
  suggestionButtonLabel,
  usageNote,
  type SuggestHint,
} from './phaseNameHintWording'

function hint(overrides: Partial<SuggestHint> = {}): SuggestHint {
  return {
    kind: 'suggest',
    typed: 'Acesss',
    suggestion: 'Access',
    tier: 1,
    reason: 'spelling',
    usedTimes: 12,
    inTemplates: 1,
    inActiveTreatments: 0,
    ...overrides,
  }
}

describe('hintQuestion', () => {

  it('names what was typed and what is suggested', () => {
    expect(hintQuestion(hint())).toBe('You typed "Acesss" - did you mean "Access"?')
  })

  it('uses the names exactly as given', () => {
    expect(hintQuestion(hint({ typed: 'glide-path', suggestion: 'Glide Path' }))).toBe(
      'You typed "glide-path" - did you mean "Glide Path"?'
    )
  })

})

describe('suggestionButtonLabel / KEEP_AS_TYPED_LABEL', () => {

  it('the first button offers the suggested name', () => {
    expect(suggestionButtonLabel(hint())).toBe('Use "Access"')
  })

  it('the second button is always "Save as typed"', () => {
    expect(KEEP_AS_TYPED_LABEL).toBe('Save as typed')
  })

})

describe('usageNote - how often the suggested name was used', () => {

  it('many times', () => {
    expect(usageNote(hint({ usedTimes: 12 }))).toBe('(used 12 times before)')
    expect(usageNote(hint({ usedTimes: 2 }))).toBe('(used 2 times before)')
  })

  it('exactly once, in the singular', () => {
    expect(usageNote(hint({ usedTimes: 1 }))).toBe('(used 1 time before)')
  })

  it('never used in a saved treatment but in a template: "from your templates"', () => {
    expect(usageNote(hint({ usedTimes: 0, inTemplates: 1 }))).toBe('(from your templates)')
    expect(usageNote(hint({ usedTimes: 0, inTemplates: 3 }))).toBe('(from your templates)')
  })

  it('never saved and in no template (only in something not saved yet): "already in use", never "used 0 times"', () => {
    expect(usageNote(hint({ usedTimes: 0, inTemplates: 0, inActiveTreatments: 1 }))).toBe('(already in use)')
  })

  it('never says "used 0 times" in any case', () => {
    for (const inTemplates of [0, 1, 2]) {
      expect(usageNote(hint({ usedTimes: 0, inTemplates }))).not.toContain('0 times')
    }
  })

  it('saved use wins over the template note', () => {
    expect(usageNote(hint({ usedTimes: 5, inTemplates: 4 }))).toBe('(used 5 times before)')
  })

})
