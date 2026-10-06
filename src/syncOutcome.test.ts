import { describe, expect, it } from 'vitest'

import type { CloudSyncResult } from './cloudSyncEngine'
import {
  classifySyncOutcome,
  describeSyncOutcome,
  SYNC_STATE_HEADING,
  type SyncOutcomeAction,
  type SyncState,
} from './syncOutcome'

/*
  The full mapping from every CloudSyncResult the engine can produce to
  one of the four sync states, with the one detail line the dentist
  sees. No result may fall through to a generic "Sync error".
*/

type Row = {
  result: CloudSyncResult
  state: SyncState
  detail: string
  action: SyncOutcomeAction
}

const ROWS: Row[] = [
  {
    result: { status: 'synced' },
    state: 'synced',
    detail: 'Synced',
    action: 'none',
  },
  {
    result: { status: 'cloud-committed-locally-pending', detail: 'quota exceeded' },
    state: 'offline',
    detail:
      "Synced to the cloud, but couldn't finish saving on this device — will retry automatically",
    action: 'retry',
  },
  {
    result: { status: 'cloud-invalid', detail: 'bad file' },
    state: 'needs-input',
    detail: 'Cloud data looks corrupted — this needs attention',
    action: 'none',
  },
  {
    result: { status: 'validation-failed', detail: 'bad local data' },
    state: 'needs-input',
    detail: "Something's wrong with this device's data — this needs attention",
    action: 'none',
  },
  {
    result: { status: 'diverged', detail: 'both changed' },
    state: 'conflict',
    detail:
      'This device and OneDrive both have changes; nothing was overwritten. ' +
      'Tap to review the differences.',
    action: 'none',
  },
  {
    result: { status: 'auth-failed' },
    state: 'needs-input',
    detail: 'Your Microsoft sign-in has expired — please sign in again',
    action: 'sign-in',
  },
  {
    result: { status: 'permission-denied', detail: '403' },
    state: 'needs-input',
    detail: 'OneDrive access was denied — please sign in again',
    action: 'sign-in',
  },
  {
    result: { status: 'network-unreachable', detail: 'Failed to fetch' },
    state: 'offline',
    detail: "No internet connection — will sync once you're back online",
    action: 'retry',
  },
  {
    result: { status: 'graph-error', detail: '503' },
    state: 'offline',
    detail: "Couldn't reach OneDrive — will try again automatically",
    action: 'retry',
  },
]

describe('classifySyncOutcome - every CloudSyncResult maps to one of the four states', () => {

  it.each(ROWS.map(row => [row.result.status, row] as const))(
    '%s',
    (_status, row) => {

      const outcome = classifySyncOutcome(row.result)

      expect(outcome.state).toBe(row.state)
      expect(outcome.detail).toBe(row.detail)

    }
  )

  it.each(ROWS.map(row => [row.result.status, row] as const))(
    '%s carries the right action',
    (_status, row) => {
      expect(classifySyncOutcome(row.result).action).toBe(row.action)
    }
  )

  it('the actions are exactly: retry for offline-type results, sign-in for sign-in problems, none for the rest', () => {
    const byAction = (action: SyncOutcomeAction) =>
      ROWS.filter(row => row.action === action).map(row => row.result.status).sort()
    expect(byAction('retry')).toEqual(['cloud-committed-locally-pending', 'graph-error', 'network-unreachable'])
    expect(byAction('sign-in')).toEqual(['auth-failed', 'permission-denied'])
    expect(byAction('none')).toEqual(['cloud-invalid', 'diverged', 'synced', 'validation-failed'])
  })

  it('covers every status the engine can produce', () => {

    // A compile-time guard lives in classifySyncOutcome's exhaustive
    // switch; this keeps the table above in step with it.
    expect(new Set(ROWS.map(row => row.result.status)).size).toBe(ROWS.length)
    expect(ROWS).toHaveLength(9)

  })

  it('attaches the corruption diagnosis to cloud-invalid only', () => {

    const diagnosis = { kind: 'unreadable', reason: 'could not be parsed' } as const

    expect(
      classifySyncOutcome({ status: 'cloud-invalid', detail: 'x', diagnosis }).diagnosis
    ).toEqual(diagnosis)

    for (const row of ROWS.filter(row => row.result.status !== 'cloud-invalid')) {
      expect(classifySyncOutcome(row.result).diagnosis).toBeUndefined()
    }

  })

  it('supplies a generic diagnosis when cloud-invalid arrives without one', () => {

    expect(
      classifySyncOutcome({ status: 'cloud-invalid', detail: 'x' }).diagnosis
    ).toEqual({ kind: 'unreadable', reason: 'The cloud file failed validation.' })

  })

  it('the detail is plain language - no jargon, HTTP codes or raw error text', () => {

    for (const row of ROWS) {
      const { detail } = classifySyncOutcome(row.result)
      expect(detail).not.toMatch(/\b(etag|schema|graph|http|4\d\d|5\d\d)\b/i)
      expect(detail).not.toContain(String((row.result as { detail?: string }).detail))
    }

  })

})

describe('describeSyncOutcome - heading and needsAttention come from the state', () => {

  it('uses the four state headings', () => {

    expect(SYNC_STATE_HEADING).toEqual({
      synced: 'Synced',
      offline: 'Offline, will retry',
      conflict: 'Sync conflict',
      'needs-input': 'Needs your input',
    })

    for (const row of ROWS) {
      expect(describeSyncOutcome(classifySyncOutcome(row.result)).label).toBe(
        SYNC_STATE_HEADING[row.state]
      )
    }

  })

  it('needs attention exactly for conflict and needs-input', () => {

    for (const row of ROWS) {
      expect(describeSyncOutcome(classifySyncOutcome(row.result)).needsAttention).toBe(
        row.state === 'conflict' || row.state === 'needs-input'
      )
    }

  })

  it('keeps the specific reason as the detail line', () => {

    for (const row of ROWS) {
      expect(describeSyncOutcome(classifySyncOutcome(row.result)).detail).toBe(row.detail)
    }

  })

})
