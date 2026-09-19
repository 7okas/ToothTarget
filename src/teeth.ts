/*
  STANDARDIZED TOOTH IDENTITY

  TOOTH_CHART is the single, permanent source of truth for tooth
  identity in ToothTarget - all 32 adult permanent teeth, numbered
  with FDI notation (ISO 3950). A tooth's anatomy never changes, so
  unlike procedures/templates (which are dentist-editable and need
  historical snapshots), everything about a tooth is safely derived
  from its toothId on demand - nothing here needs to be duplicated
  onto a treatment record.

  FDI quadrants: 1 = upper right, 2 = upper left, 3 = lower left,
  4 = lower right. Position within a quadrant runs 1 (central
  incisor, at the midline) to 8 (third molar/wisdom tooth), which is
  exactly the "UR6"-style numbering ToothTarget already used before
  this phase - so toothId "16" is what was previously typed as "UR6".
*/

export type ToothArch = 'upper' | 'lower'
export type ToothSide = 'left' | 'right'
export type ToothRegion = 'anterior' | 'premolar' | 'molar'

export type Tooth = {
  toothId: string
  notation: 'FDI'
  displayName: string
  arch: ToothArch
  side: ToothSide
  position: number
  region: ToothRegion
}

function regionForPosition(position: number): ToothRegion {

  if (position <= 3) {
    return 'anterior'
  }

  if (position <= 5) {
    return 'premolar'
  }

  return 'molar'

}

const QUADRANTS: {
  quadrant: number
  arch: ToothArch
  side: ToothSide
  prefix: string
}[] = [
  { quadrant: 1, arch: 'upper', side: 'right', prefix: 'UR' },
  { quadrant: 2, arch: 'upper', side: 'left', prefix: 'UL' },
  { quadrant: 3, arch: 'lower', side: 'left', prefix: 'LL' },
  { quadrant: 4, arch: 'lower', side: 'right', prefix: 'LR' },
]

export const TOOTH_CHART: Tooth[] =
  QUADRANTS.flatMap(({ quadrant, arch, side, prefix }) =>
    Array.from({ length: 8 }, (_, index) => {

      const position = index + 1

      return {
        toothId: `${quadrant}${position}`,
        notation: 'FDI' as const,
        displayName: `${prefix}${position}`,
        arch,
        side,
        position,
        region: regionForPosition(position),
      }

    })
  )

const TOOTH_BY_ID = new Map(
  TOOTH_CHART.map(tooth => [tooth.toothId, tooth])
)

export function getToothById(
  toothId: string
): Tooth | undefined {

  return TOOTH_BY_ID.get(toothId)

}

/*
  "UR6 (16)" for a real, recognized tooth. For legacy records whose
  toothId couldn't be confidently resolved during migration (see
  resolveLegacyToothId below), this just shows whatever text was
  preserved - never a fabricated real tooth.
*/

export function getToothLabel(
  toothId: string
): string {

  const tooth = getToothById(toothId)

  return tooth
    ? `${tooth.displayName} (${tooth.toothId})`
    : toothId

}

/*
  TOOTH GROUPS

  Broader filters ("all molars", "upper premolars") for the
  Statistics comparison system - each group is just an arch/region
  combination that resolves to a concrete list of toothIds via
  TOOTH_CHART, so the filtering engine itself only ever needs to
  match against toothIds, never re-derive anatomy from a label.
*/

export type ToothGroup = {
  id: string
  label: string
  arch: ToothArch | 'any'
  region: ToothRegion | 'any'
}

export const TOOTH_GROUPS: ToothGroup[] = [
  { id: 'all-anterior', label: 'All Anterior', arch: 'any', region: 'anterior' },
  { id: 'all-premolars', label: 'All Premolars', arch: 'any', region: 'premolar' },
  { id: 'all-molars', label: 'All Molars', arch: 'any', region: 'molar' },
  { id: 'upper', label: 'Upper Teeth', arch: 'upper', region: 'any' },
  { id: 'lower', label: 'Lower Teeth', arch: 'lower', region: 'any' },
  { id: 'upper-molars', label: 'Upper Molars', arch: 'upper', region: 'molar' },
  { id: 'lower-molars', label: 'Lower Molars', arch: 'lower', region: 'molar' },
  { id: 'upper-premolars', label: 'Upper Premolars', arch: 'upper', region: 'premolar' },
  { id: 'lower-premolars', label: 'Lower Premolars', arch: 'lower', region: 'premolar' },
]

export function getToothIdsForGroup(
  group: ToothGroup
): string[] {

  return TOOTH_CHART.filter(
    tooth =>
      (group.arch === 'any' || tooth.arch === group.arch) &&
      (group.region === 'any' || tooth.region === group.region)
  ).map(tooth => tooth.toothId)

}

/*
  MIGRATION: pre-Phase-5 records stored tooth as arbitrary free
  text (a 4-character input with a "UR5 / UL5 / LR6 / LL7" example,
  but never actually validated). This confidently resolves anything
  matching that established UR/UL/LR/LL + 1-8 pattern to its real
  FDI toothId. Anything else - or anything that overlapped with an
  old tooth-region guess that predates FDI ids - is preserved as its
  own trimmed, uppercased text rather than guessed into a specific
  real tooth. It will never collide with a genuine toothId (those
  are always exactly 2 digits), so it can't silently corrupt a real
  tooth's history, and getToothLabel()/getToothById() already treat
  anything unrecognized as "just display the text."
*/

export function resolveLegacyToothId(
  rawTooth: string
): string {

  const cleaned = rawTooth.trim().toUpperCase()

  const match = cleaned.match(/^(UR|UL|LR|LL)([1-8])$/)

  if (!match) {
    return cleaned === '' ? 'unknown' : cleaned
  }

  const quadrantByPrefix: Record<string, number> = {
    UR: 1,
    UL: 2,
    LL: 3,
    LR: 4,
  }

  const quadrant = quadrantByPrefix[match[1]]
  const position = match[2]

  return `${quadrant}${position}`

}
