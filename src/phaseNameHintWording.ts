import type { PhaseNameHint } from './phaseNameCheck'

/*
  WORDING OF THE PHASE-NAME HINT (Phase 9) - pure text rules

      You typed "Acesss" - did you mean "Access"?  (used 12 times before)
      [ Use "Access" ]   [ Save as typed ]

  Kept apart from the component so every wording case is tested without
  rendering anything.

  The bracketed note says where the suggested name comes from:
    - used in saved treatments: "used 12 times before" / "used 1 time before"
    - never used in a saved treatment but in a template: "from your templates"
    - only in a treatment or editor that is not saved yet: "already in use"
*/

export type SuggestHint = Extract<PhaseNameHint, { kind: 'suggest' }>

export const KEEP_AS_TYPED_LABEL = 'Save as typed'

export function hintQuestion(hint: SuggestHint): string {
  return `You typed "${hint.typed}" - did you mean "${hint.suggestion}"?`
}

export function suggestionButtonLabel(hint: SuggestHint): string {
  return `Use "${hint.suggestion}"`
}

export function usageNote(hint: SuggestHint): string {

  if (hint.usedTimes >= 2) {
    return `(used ${hint.usedTimes} times before)`
  }

  if (hint.usedTimes === 1) {
    return '(used 1 time before)'
  }

  return hint.inTemplates > 0 ? '(from your templates)' : '(already in use)'

}
