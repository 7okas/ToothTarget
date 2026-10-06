/*
  PHASE-NAME MATCHING (Phase 9) - pure, no React, no storage, no imports

  Decides whether two phase names are "near-identical spellings of the
  same name": the same words with a different case, spacing or
  punctuation, or a small typo. It deliberately does NOT try to catch
  synonyms ("Irrigation" vs "Irrigant activation").

  Statistics group phases by the name EXACTLY as stored (case-sensitive,
  untrimmed), so "access", "Access" and "Access " each get their own
  row today. These rules exist to stop NEW variants being typed by
  accident; they never change how statistics group or rewrite old data.

  This file only compares two names (one direction: `typed` against
  `candidate`). Choosing the single best suggestion from a whole pool of
  known names, with usage counts, lives in phaseNameCheck.ts.

  THE RULES
  ============================================================
  Step 0 - NORMALISE both names: Unicode-fold (NFKC), lowercase,
    "&" becomes "and", punctuation (. , ; : ' " ( ) - _ /) becomes a
    space, runs of spaces collapse, trim.

  Then, in this order:
   identical   the two names are the same as written (after trimming)
               -> never a warning, the name is already in use.
   TIER 0      the normalised names are equal but the written names are
               not (case, spacing, punctuation, "&" vs "and"). Warns at
               any length.
   guards      (a name that passes none of these is not warned about)
     digits      the digits in the two names differ ("Coat 1" / "Coat 2")
     plural-s    the names differ only by a trailing "s"
                 ("Rinse" / "Rinses", "Coat" / "Coats") - EXCEPT when the
                 longer name ends in a double "s", where that "s" is part
                 of the word, not a plural ("Access" / "Acces",
                 "Process" / "Proces"): those go on to the tiers below
     short       the typed name has 4 letters or fewer: only Tier 0 applies
   TIER 1      (typed name 5+ letters) equal once repeated letters are
               collapsed ("Acesss" / "Access" - both become "aces"), or
               exactly one swapped pair of neighbouring letters
               ("Lenght" / "Length").
   TIER 2      edit distance 1 when the typed name is 7+ letters; edit
               distance 2 when it is 12+ letters ("Obturaton" /
               "Obturation").
   Anything within edit distance 2 that none of the above accepts is
   reported as SUPPRESSED (with the guard that stopped it) so the audit
   can show whether the guards are in the right place.
*/

/* ---------------------------------------------------------------- */
/* Normalising                                                       */
/* ---------------------------------------------------------------- */

export function normalisePhaseName(raw: string): string {

  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,;:'"()\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

}

/* "access" and "acesss" both become "aces". Letters only; digits and spaces are kept. */
export function collapseRepeatedLetters(normalised: string): string {
  return normalised.replace(/([a-z])\1+/g, '$1')
}

function digitsOf(normalised: string): string {
  return normalised.replace(/\D/g, '')
}

/* ---------------------------------------------------------------- */
/* Edit distance                                                     */
/* ---------------------------------------------------------------- */

/* Plain Levenshtein distance (insert / delete / replace one letter = 1). */
export function editDistance(a: string, b: string): number {

  if (a === b) {
    return 0
  }

  if (a.length === 0) {
    return b.length
  }

  if (b.length === 0) {
    return a.length
  }

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i++) {

    const current = [i]

    for (let j = 1; j <= b.length; j++) {

      const cost = a[i - 1] === b[j - 1] ? 0 : 1

      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      )

    }

    previous = current

  }

  return previous[b.length]

}

/* Same length, differing only by two neighbouring letters swapped. */
export function isSingleAdjacentSwap(a: string, b: string): boolean {

  if (a.length !== b.length || a === b) {
    return false
  }

  let first = -1

  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) {
      first = index
      break
    }
  }

  return (
    first >= 0 &&
    first + 1 < a.length &&
    a[first] === b[first + 1] &&
    a[first + 1] === b[first] &&
    a.slice(first + 2) === b.slice(first + 2)
  )

}

/* ---------------------------------------------------------------- */
/* Comparing two names                                               */
/* ---------------------------------------------------------------- */

export type PhaseNameTier = 0 | 1 | 2

export type PhaseNameGuard = 'short' | 'digits' | 'plural-s' | 'length'

export type PhaseNameVerdict =
  | { kind: 'identical' }
  | { kind: 'match'; tier: PhaseNameTier; distance: number }
  | { kind: 'suppressed'; guard: PhaseNameGuard; distance: number }
  | { kind: 'different' }

export function comparePhaseNames(
  typed: string,
  candidate: string
): PhaseNameVerdict {

  const a = typed.trim()
  const b = candidate.trim()

  if (a === b) {
    return { kind: 'identical' }
  }

  const na = normalisePhaseName(a)
  const nb = normalisePhaseName(b)

  if (na === '' || nb === '') {
    return { kind: 'different' }
  }

  if (na === nb) {
    return { kind: 'match', tier: 0, distance: 0 }
  }

  const distance = editDistance(na, nb)

  const sameShapeTypo =
    collapseRepeatedLetters(na) === collapseRepeatedLetters(nb) ||
    isSingleAdjacentSwap(na, nb)

  const close = sameShapeTypo || distance <= 2

  if (!close) {
    return { kind: 'different' }
  }

  if (digitsOf(na) !== digitsOf(nb)) {
    return { kind: 'suppressed', guard: 'digits', distance }
  }

  /*
    Only a real plural is ignored. When the longer name ends in "ss"
    ("access", "process", "class") the missing letter is a slip, so the
    pair is not treated as a plural and falls through to the tiers.
  */
  const differsByTrailingS = na + 's' === nb || nb + 's' === na

  const longer = na.length > nb.length ? na : nb

  if (differsByTrailingS && !longer.endsWith('ss')) {
    return { kind: 'suppressed', guard: 'plural-s', distance }
  }

  const length = na.length

  if (length <= 4) {
    // Only reported when it really was close; "Seal"/"Bond" is just different.
    return sameShapeTypo || distance <= 1
      ? { kind: 'suppressed', guard: 'short', distance }
      : { kind: 'different' }
  }

  if (sameShapeTypo) {
    return { kind: 'match', tier: 1, distance }
  }

  if (distance === 1 && length >= 7) {
    return { kind: 'match', tier: 2, distance }
  }

  if (distance === 2 && length >= 12) {
    return { kind: 'match', tier: 2, distance }
  }

  return { kind: 'suppressed', guard: 'length', distance }

}
