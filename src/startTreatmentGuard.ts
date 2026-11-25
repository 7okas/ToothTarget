/*
  START TREATMENT GUARD + TEMPLATE LIST REPAIR

  Pure helpers, kept out of App.tsx so they can be tested directly.

  Why the template repair exists: toothTargetTemplates holds the
  built-in templates AND the custom ones, but cloud sync / account
  switching rebuild that key as "built-ins already in storage + custom
  ones". On a device whose storage never held the built-ins, that
  produced an empty list, and the live refresh after a sync loaded it
  straight into React state - leaving resolveTemplate() with nothing to
  return. Built-ins are code, never account data, so they are always
  put back here whenever a persisted list is adopted.
*/

export const NO_PATIENT_MESSAGE = 'Enter a patient name before starting.'

export const NO_PROCEDURE_MESSAGE = 'Choose a procedure before starting.'

export const NO_TOOTH_MESSAGE = 'Tap a tooth on the chart before starting.'

export const NO_TEMPLATE_MESSAGE =
  'No procedure template found. Create one in Manage Procedure Templates.'

export function startTreatmentBlocker(input: {
  patientName: string
  hasProcedure: boolean
  toothId: string | null
  hasUsableTemplate: boolean
}): string | null {

  if (input.patientName.trim() === '') {
    return NO_PATIENT_MESSAGE
  }

  if (!input.hasProcedure) {
    return NO_PROCEDURE_MESSAGE
  }

  if (!input.toothId) {
    return NO_TOOTH_MESSAGE
  }

  if (!input.hasUsableTemplate) {
    return NO_TEMPLATE_MESSAGE
  }

  return null

}

/*
  Returns `persisted` with any built-in template it is missing put back
  at the front. Entries already present (matched by id) are kept as
  they are, so a user's edits and ordering are never overwritten.
*/
export function withBuiltinTemplates<T extends { id: string }>(
  persisted: T[],
  builtins: T[]
): T[] {

  const presentIds = new Set(persisted.map(template => template.id))

  const missing = builtins.filter(template => !presentIds.has(template.id))

  return missing.length === 0 ? persisted : [...missing, ...persisted]

}
