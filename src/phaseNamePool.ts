/*
  KNOWN PHASE NAMES (Phase 9) - pure, no React, no storage

  Collects every phase name already in use, with how often, so the
  matching rules have something to compare a typed name against.

  SOURCES (all three, as decided):
    - SAVED treatments' phase records. "Used N times" is the number of
      saved treatments that contain the name, counted once per treatment,
      and phase records marked skipped are NOT counted (a skipped phase
      never happened - the same rule the phase statistics follow). This
      is the figure statistics actually see.
    - TEMPLATES (built-in and custom): names the dentist intends to use,
      which may not have been used yet.
    - ACTIVE and INCOMPLETE treatments: names typed minutes ago and not
      saved yet.

  Names are keyed EXACTLY as written once trimmed (case-sensitive), which
  is how statistics group them, so "Access" and "access" are two entries
  here - that is precisely what the matching then notices.

  The inputs are the smallest shapes needed, so the real SavedTreatment /
  ProcedureTemplate / ActiveTreatment objects fit without conversion.
*/

export type PoolSavedTreatment = {
  procedureId: string
  phaseRecords?: readonly { name: string; skipped?: boolean }[]
}

export type PoolTemplate = {
  phases: readonly { name: string }[]
}

export type PoolActiveTreatment = {
  phases: readonly { name: string }[]
}

export type PhaseNameStat = {
  /* Trimmed, as written. */
  name: string
  /* Saved treatments containing this name (skipped phases excluded). */
  savedTreatmentCount: number
  /* The same count split by procedure id. */
  savedByProcedure: Record<string, number>
  /* Templates (built-in or custom) containing this name. */
  templateCount: number
  /* Active or incomplete treatments containing this name. */
  activeCount: number
}

export type PhaseNamePool = PhaseNameStat[]

/* How many places the name appears in total; used to decide who is "established". */
export function phaseNameWeight(stat: PhaseNameStat): number {
  return stat.savedTreatmentCount + stat.templateCount + stat.activeCount
}

export function buildPhaseNamePool(sources: {
  savedTreatments: readonly PoolSavedTreatment[]
  templates: readonly PoolTemplate[]
  activeTreatments: readonly PoolActiveTreatment[]
}): PhaseNamePool {

  const stats = new Map<string, PhaseNameStat>()

  function statFor(name: string): PhaseNameStat {

    const existing = stats.get(name)

    if (existing) {
      return existing
    }

    const created: PhaseNameStat = {
      name,
      savedTreatmentCount: 0,
      savedByProcedure: {},
      templateCount: 0,
      activeCount: 0,
    }

    stats.set(name, created)

    return created

  }

  /* One treatment/template counts once per distinct name, however many times it repeats it. */
  function distinctNames(names: Iterable<string>): Set<string> {

    const result = new Set<string>()

    for (const raw of names) {

      const name = typeof raw === 'string' ? raw.trim() : ''

      if (name !== '') {
        result.add(name)
      }

    }

    return result

  }

  for (const treatment of sources.savedTreatments) {

    const names = distinctNames(
      (treatment.phaseRecords ?? [])
        .filter(record => !record.skipped)
        .map(record => record.name)
    )

    for (const name of names) {

      const stat = statFor(name)

      stat.savedTreatmentCount += 1

      stat.savedByProcedure[treatment.procedureId] =
        (stat.savedByProcedure[treatment.procedureId] ?? 0) + 1

    }

  }

  for (const template of sources.templates) {

    for (const name of distinctNames((template.phases ?? []).map(phase => phase.name))) {
      statFor(name).templateCount += 1
    }

  }

  for (const treatment of sources.activeTreatments) {

    for (const name of distinctNames((treatment.phases ?? []).map(phase => phase.name))) {
      statFor(name).activeCount += 1
    }

  }

  return Array.from(stats.values()).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )

}
