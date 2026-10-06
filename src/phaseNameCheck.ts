import { comparePhaseNames } from './phaseNameMatching'
import { isPhaseNameKeptAsTyped } from './phaseNameDecisions'
import {
  phaseNameWeight,
  type PhaseNamePool,
  type PhaseNameStat,
} from './phaseNamePool'

/*
  EVALUATE A TYPED PHASE NAME (Phase 9) - pure apart from reading the
  in-memory "Save as typed" memory

  Puts the three earlier pieces together for one field: given what the
  dentist typed and the pool of known names, say whether to show a hint
  and, if so, which single name to suggest and how often it is used.
  A screen only has to call this and render the answer.

  WHEN THERE IS NO HINT
    - the field is blank
    - the typed name is already EXACTLY a known name (same characters
      after trimming) - an established name is never nagged, even if it
      resembles another one
    - nothing in the pool is a near-identical spelling (see
      phaseNameMatching.ts for the tiers and guards)
    - the only near matches are pairs the dentist already chose to keep
      as typed this session (phaseNameDecisions.ts)

  WHICH SUGGESTION WINS when several names qualify, in this order:
    1. the lowest tier (case/spacing before typos),
    2. the smallest edit distance,
    3. the name used in the SAME PROCEDURE as the one being edited
       (statistics group phases per procedure, so that spelling is the
       one that would merge), more uses first,
    4. the name used in more places overall,
    5. alphabetical, so the answer is always the same.
  Names from every procedure are compared; the procedure only breaks ties.

  `extraKnownNames` are names already typed in the same editor but not
  saved yet (eg. another row of the template being edited): they count
  as known, with a use count of zero.
*/

export type PhaseNameHint =
  | { kind: 'none' }
  | {
      kind: 'suggest'
      /* What was typed, trimmed. */
      typed: string
      /* The known name to offer, exactly as it is already written. */
      suggestion: string
      tier: 0 | 1 | 2
      /* 'case-or-spacing' = same name written differently; 'spelling' = a likely typo. */
      reason: 'case-or-spacing' | 'spelling'
      /* Saved treatments that contain the suggestion ("used 12 times before"). */
      usedTimes: number
      /* Templates / unsaved treatments that contain it (for "in a template" wording when usedTimes is 0). */
      inTemplates: number
      inActiveTreatments: number
    }

export type EvaluatePhaseNameOptions = {
  /* The procedure the name is being typed for, if known - only used to break ties. */
  currentProcedureId?: string
  /* Names typed elsewhere in the same editor, not saved yet. */
  extraKnownNames?: readonly string[]
  /* Defaults to the in-memory "Save as typed" memory. Injectable for tests. */
  isKeptAsTyped?: (typed: string, suggestion: string) => boolean
}

export function evaluatePhaseName(
  typedRaw: string,
  pool: PhaseNamePool,
  options: EvaluatePhaseNameOptions = {}
): PhaseNameHint {

  const typed = typedRaw.trim()

  if (typed === '') {
    return { kind: 'none' }
  }

  const isKept = options.isKeptAsTyped ?? isPhaseNameKeptAsTyped

  const known = new Map<string, PhaseNameStat>(
    pool.map(stat => [stat.name, stat])
  )

  for (const raw of options.extraKnownNames ?? []) {

    const name = raw.trim()

    if (name !== '' && !known.has(name)) {
      known.set(name, {
        name,
        savedTreatmentCount: 0,
        savedByProcedure: {},
        templateCount: 0,
        activeCount: 1,
      })
    }

  }

  if (known.has(typed)) {
    return { kind: 'none' }
  }

  /* A typed name that is not known yet has no uses, so it can never be "more established" than a known name. */
  const typedWeight = 0

  type Candidate = {
    stat: PhaseNameStat
    tier: 0 | 1 | 2
    distance: number
  }

  const candidates: Candidate[] = []

  for (const stat of known.values()) {

    const verdict = comparePhaseNames(typed, stat.name)

    if (verdict.kind !== 'match') {
      continue
    }

    if (phaseNameWeight(stat) <= typedWeight) {
      continue
    }

    if (isKept(typed, stat.name)) {
      continue
    }

    candidates.push({ stat, tier: verdict.tier, distance: verdict.distance })

  }

  if (candidates.length === 0) {
    return { kind: 'none' }
  }

  const procedureId = options.currentProcedureId

  function sameProcedureUses(stat: PhaseNameStat): number {
    return procedureId === undefined ? 0 : stat.savedByProcedure[procedureId] ?? 0
  }

  candidates.sort((a, b) =>
    a.tier - b.tier ||
    a.distance - b.distance ||
    sameProcedureUses(b.stat) - sameProcedureUses(a.stat) ||
    phaseNameWeight(b.stat) - phaseNameWeight(a.stat) ||
    (a.stat.name < b.stat.name ? -1 : a.stat.name > b.stat.name ? 1 : 0)
  )

  const best = candidates[0]

  return {
    kind: 'suggest',
    typed,
    suggestion: best.stat.name,
    tier: best.tier,
    reason: best.tier === 0 ? 'case-or-spacing' : 'spelling',
    usedTimes: best.stat.savedTreatmentCount,
    inTemplates: best.stat.templateCount,
    inActiveTreatments: best.stat.activeCount,
  }

}
