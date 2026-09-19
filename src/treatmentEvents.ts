import type { TreatmentEvent } from './App'

/*
  Pure helpers over a treatment's events log - no React, no
  component state. Interruption time is always derived from the
  individual interruption-type events rather than stored as its own
  redundant running total, so it can never drift out of sync with
  the entries an assistant can see and edit.
*/

export function calculateInterruptionSeconds(
  events: TreatmentEvent[]
): number {

  return events
    .filter(event => event.type === 'interruption')
    .reduce(
      (total, event) => total + (event.durationSeconds ?? 0),
      0
    )

}

export function calculateTotalTreatmentSeconds(
  clinicalActualSeconds: number,
  events: TreatmentEvent[]
): number {

  return (
    clinicalActualSeconds +
    calculateInterruptionSeconds(events)
  )

}
