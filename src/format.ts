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

/*
  "Synced X minutes/hours/days ago" for the sync status indicator -
  purely a display of an existing timestamp (see
  deviceSyncTracking.ts's getDeviceLastSyncAt()), never a computed
  sync fact of its own. `now` is a parameter (defaulting to the real
  clock) so this stays pure and testable the same way every other
  helper in this file is.
*/
export function formatRelativeTime(
  isoTimestamp: string,
  now: Date = new Date()
): string {

  const thenMs = Date.parse(isoTimestamp)

  if (Number.isNaN(thenMs)) {
    return ''
  }

  const diffSeconds =
    Math.max(0, Math.round((now.getTime() - thenMs) / 1000))

  if (diffSeconds < 60) {
    return 'Just now'
  }

  const diffMinutes = Math.floor(diffSeconds / 60)

  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)

  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
  }

  const diffDays = Math.floor(diffHours / 24)

  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`

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
