/*
  Shared time-formatting helpers. Pure functions with no component
  state, so they're used both inside App.tsx's own screens and by
  TreatmentSummaryCard (shared between the post-completion summary
  and the read-only historical treatment detail view).
*/

export function formatTime(
  seconds: number
) {

  /*
    Statistics averages produce fractional seconds (e.g. summing
    7 treatments and dividing by 7); round to the nearest whole
    second before formatting so the string only ever shows integers.
  */

  const absolute =
    Math.round(
      Math.abs(seconds)
    )

  const minutes =
    Math.floor(
      absolute / 60
    )

  const remainingSeconds =
    absolute % 60


  return `${String(
    minutes
  ).padStart(
    2,
    '0'
  )}:${String(
    remainingSeconds
  ).padStart(
    2,
    '0'
  )}`

}

/*
  Used for a phase's actual-vs-expected difference: "+2:32" for
  over, "-1:18" for under, plain "00:00" for exactly on target.
*/

export function formatSignedTime(
  seconds: number
) {

  const rounded = Math.round(seconds)

  if (rounded === 0) {
    return formatTime(0)
  }

  return `${rounded > 0 ? '+' : '-'}${formatTime(rounded)}`

}

export function formatDate(
  date: string
) {

  return new Date(
    date
  ).toLocaleDateString(
    undefined,
    {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }
  )

}
