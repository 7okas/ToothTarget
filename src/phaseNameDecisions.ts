import { normalisePhaseName } from './phaseNameMatching'

/*
  "SAVE AS TYPED" MEMORY (Phase 9)

  When the dentist is warned about a phase name and taps "Save as typed",
  that is a deliberate decision about ONE pair: this typed name, for this
  suggestion. Remembering it here stops the same warning appearing again
  and again while the app stays open.

  IN MEMORY ONLY, for this session: a module-level set, same idea as the
  checked-treatments store. It is never written to localStorage,
  IndexedDB, the cloud or anywhere else, so it cannot sync, and closing
  or reloading the app forgets it (the warning would then appear once
  more, which is intended).

  A decision is remembered per PAIR, not per typed name: if the same
  typed name later resembles a different known name, that is a new
  question. The typed side is compared in normalised form, so "Acesss"
  and "acesss" are the same decision; the suggestion is compared as
  written (trimmed), so a decision about "Access" never silences
  "access".
*/

const keptAsTyped = new Set<string>()

function keyFor(typed: string, suggestion: string): string {
  return `${normalisePhaseName(typed)}\u0000${suggestion.trim()}`
}

export function rememberPhaseNameKeptAsTyped(
  typed: string,
  suggestion: string
): void {
  keptAsTyped.add(keyFor(typed, suggestion))
}

export function isPhaseNameKeptAsTyped(
  typed: string,
  suggestion: string
): boolean {
  return keptAsTyped.has(keyFor(typed, suggestion))
}

/* TEST-ONLY. */
export function __resetPhaseNameDecisionsForTests(): void {
  keptAsTyped.clear()
}
