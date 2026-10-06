/*
  "SYNCED 5 MINUTES AGO" TEXT FOR THE SYNC BADGE - pure, no React

  Turns the device's last-successful-sync timestamp (see
  deviceSyncTracking.ts's getDeviceLastSyncAt()) into the words shown
  next to the badge, in a long and a short form, plus whether the sync
  is old enough to warn about. Purely a display of an existing timestamp;
  it never decides anything about syncing.

  LONG FORM (wide screens)
    synced:                 "Synced 5 minutes ago"
    anything else:          "Last synced 3 hours ago"   (offline, needs
                            input, conflict, syncing)
    when the badge already shows the word "Synced" just before it (the
    short-lived "Synced" label after a sync) the prefix is dropped, so it
    reads "Synced  just now" rather than "Synced  Synced just now".
  SHORT FORM (narrow screens, so it does not crowd the page title)
    "5m ago", "3h ago", "2d ago", "3w ago", "just now" - no prefix; the
    badge's icon and label already say whether it is up to date.

  AGE WORDS
    under a minute -> "just now"; then minutes, hours, days (up to 13
    days), and from 14 days on whole weeks ("2 weeks ago").

  STALE: older than 2 days, so the badge can show a warning colour.
*/

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export const STALE_AFTER_MS = 2 * DAY_MS

export type LastSyncAgeText = {
  long: string
  short: string
  stale: boolean
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}

export function describeLastSync(
  isoTimestamp: string | null,
  now: Date,
  options: {
    /* The badge is currently in the up-to-date state. */
    synced: boolean
    /* The badge is also showing a state label such as "Synced" right before this text. */
    labelShown: boolean
  }
): LastSyncAgeText | null {

  if (isoTimestamp === null) {
    return null
  }

  const thenMs = Date.parse(isoTimestamp)

  if (Number.isNaN(thenMs)) {
    return null
  }

  // A timestamp slightly in the future (clock differences) counts as "just now".
  const ageMs = Math.max(0, now.getTime() - thenMs)

  let phrase: string
  let short: string

  if (ageMs < MINUTE_MS) {
    phrase = 'just now'
    short = 'just now'
  } else if (ageMs < HOUR_MS) {
    const minutes = Math.floor(ageMs / MINUTE_MS)
    phrase = plural(minutes, 'minute')
    short = `${minutes}m ago`
  } else if (ageMs < DAY_MS) {
    const hours = Math.floor(ageMs / HOUR_MS)
    phrase = plural(hours, 'hour')
    short = `${hours}h ago`
  } else if (ageMs < 14 * DAY_MS) {
    const days = Math.floor(ageMs / DAY_MS)
    phrase = plural(days, 'day')
    short = `${days}d ago`
  } else {
    const weeks = Math.floor(ageMs / (7 * DAY_MS))
    phrase = plural(weeks, 'week')
    short = `${weeks}w ago`
  }

  const prefix =
    options.synced
      ? options.labelShown ? '' : 'Synced '
      : 'Last synced '

  return {
    long: `${prefix}${phrase}`,
    short,
    stale: ageMs > STALE_AFTER_MS,
  }

}
