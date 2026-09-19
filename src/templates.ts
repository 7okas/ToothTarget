import type { ProcedureTemplate, TemplatePhase } from './App'

/*
  Pure template-comparison helpers - no React, no component state.

  A template only counts as an exact duplicate when its name AND its
  full phase structure (same phases, same order, same durations)
  match another template. Two templates that merely share similar
  phases but have different names, different durations, or a
  different phase order are NOT duplicates - the dentist naming them
  differently is itself a signal they're meant to be distinct.
*/

function normalizePhases(
  phases: TemplatePhase[]
): { name: string; duration: number }[] {

  return phases.map(phase => ({
    name: phase.name.trim().toLowerCase(),
    duration: phase.duration,
  }))

}

export function templatesAreExactDuplicates(
  name: string,
  phases: TemplatePhase[],
  other: ProcedureTemplate
): boolean {

  if (
    name.trim().toLowerCase() !==
    other.name.trim().toLowerCase()
  ) {
    return false
  }

  const a = normalizePhases(phases)
  const b = normalizePhases(other.phases)

  if (a.length !== b.length) {
    return false
  }

  return a.every(
    (phase, index) =>
      phase.name === b[index].name &&
      phase.duration === b[index].duration
  )

}

/*
  excludeId lets a template be re-saved against itself (editing and
  saving your own template unchanged is not "a duplicate"), while
  still catching the case where an edit makes it collide with a
  *different* existing template.
*/

export function findExactDuplicateTemplate(
  name: string,
  phases: TemplatePhase[],
  templates: ProcedureTemplate[],
  excludeId?: string
): ProcedureTemplate | null {

  return (
    templates.find(
      template =>
        template.id !== excludeId &&
        templatesAreExactDuplicates(name, phases, template)
    ) ?? null
  )

}
