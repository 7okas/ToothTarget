import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PhaseNameHint from './PhaseNameHint'
import AddPhaseForm from './AddPhaseForm'
import type { PhaseNameHint as PhaseNameHintResult } from './phaseNameCheck'

/*
  No DOM test harness in this project, so these render the real
  components to static HTML (the same approach as SyncResolutionScreen's
  test). They prove the wording and layout of the hint and the form's
  starting state; taps, blur and typing are covered through the pure
  modules they use (phaseNameHintFlow / phaseNameCheck / phaseNameHintWording).
*/

const suggest: PhaseNameHintResult = {
  kind: 'suggest',
  typed: 'Acesss',
  suggestion: 'Access',
  tier: 1,
  reason: 'spelling',
  usedTimes: 12,
  inTemplates: 1,
  inActiveTreatments: 0,
}

function html(hint: PhaseNameHintResult, keepDisabled = false): string {
  return renderToStaticMarkup(
    <PhaseNameHint
      hint={hint}
      onUseSuggestion={() => {}}
      onKeepAsTyped={() => {}}
      keepDisabled={keepDisabled}
    />
  )
}

describe('PhaseNameHint', () => {

  it('renders nothing when there is no hint', () => {
    expect(html({ kind: 'none' })).toBe('')
  })

  it('shows the question, the usage note and both buttons', () => {
    const markup = html(suggest)
    expect(markup).toContain('You typed &quot;Acesss&quot; - did you mean &quot;Access&quot;?')
    expect(markup).toContain('(used 12 times before)')
    expect(markup).toContain('Use &quot;Access&quot;')
    expect(markup).toContain('Save as typed')
  })

  it('says "from your templates" for a name used 0 times in saved treatments', () => {
    const markup = html({ ...suggest, usedTimes: 0, inTemplates: 2 })
    expect(markup).toContain('(from your templates)')
    expect(markup).not.toContain('used 0')
  })

  it('says "used 1 time before" for exactly one use', () => {
    expect(html({ ...suggest, usedTimes: 1 })).toContain('(used 1 time before)')
  })

  it('can disable "Save as typed" (eg. while the minutes are invalid), leaving the other button usable', () => {
    const markup = html(suggest, true)
    const keep = markup.split('<button').find(part => part.includes('Save as typed')) ?? ''
    const use = markup.split('<button').find(part => part.includes('Use &quot;')) ?? ''
    expect(keep).toContain('disabled')
    expect(use).not.toContain('disabled')
  })

  it('uses a status role so it is announced without taking focus', () => {
    expect(html(suggest)).toContain('role="status"')
  })

})

describe('AddPhaseForm - starting state', () => {

  function form(name: string, minutes: string): string {
    return renderToStaticMarkup(
      <AddPhaseForm
        savedTreatments={[]}
        templates={[]}
        activeTreatments={[]}
        name={name}
        onNameChange={() => {}}
        minutes={minutes}
        onMinutesChange={() => {}}
        onAdd={() => {}}
        onBack={() => {}}
      />
    )
  }

  function addButton(markup: string): string {
    return markup.split('<button').find(part => part.includes('Add Phase</button>')) ?? ''
  }

  it('shows the same fields as before and no hint to start with', () => {
    const markup = form('Access', '5')
    expect(markup).toContain('Add Phase')
    expect(markup).toContain('placeholder="Phase name..."')
    expect(markup).toContain('Duration (minutes)')
    expect(markup).toContain('Back')
    expect(markup).not.toContain('phase-name-hint')
  })

  it('keeps the existing rule: Add Phase is disabled for a blank name or minutes not above zero', () => {
    expect(addButton(form('', '5'))).toContain('disabled')
    expect(addButton(form('   ', '5'))).toContain('disabled')
    expect(addButton(form('Access', '0'))).toContain('disabled')
    expect(addButton(form('Access', ''))).toContain('disabled')
    expect(addButton(form('Access', '-3'))).toContain('disabled')
    expect(addButton(form('Access', '5'))).not.toContain('disabled')
  })

  it('never shows a hint on first render, even for a misspelled name (it waits for the field to lose focus)', () => {
    expect(form('Acesss', '5')).not.toContain('phase-name-hint')
  })

})
