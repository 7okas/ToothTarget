import { describe, expect, it } from 'vitest'

import type { CloudSyncResult } from './cloudSyncEngine'
import {
  classifySyncOutcome,
  describeSyncOutcome,
  SYNC_OUTCOME_COPY,
  SYNC_STATE_HEADING,
  SYNC_STATE_OF_OUTCOME,
  type SyncOutcomeType,
} from './syncOutcome'

/*
  Every one of these mirrors an ACTUAL CloudSyncResult shape
  cloudSyncEngine.ts/cloudStorage.ts can really produce (see those
  files' own status unions) - this is the test that proves Phase 6's
  central claim: no CloudSyncResult status collapses into a generic
  "Sync error" anymore, each gets its own distinct, correctly-flagged
  classification.
*/

describe('classifySyncOutcome - every CloudSyncResult status maps to its own distinct reason', () => {

  it('synced: "synced", does not need attention', () => {

    const result: CloudSyncResult = { status: 'synced' }

    expect(classifySyncOutcome(result)).toEqual({ type: 'synced' })
    expect(describeSyncOutcome(classifySyncOutcome(result)).needsAttention).toBe(false)

  })

  it('cloud-committed-locally-pending: "save-incomplete", does not need attention (self-heals on next sync)', () => {

    const result: CloudSyncResult = {
      status: 'cloud-committed-locally-pending',
      detail: 'quota exceeded',
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'save-incomplete' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(false)

  })

  it('cloud-invalid (corrupted or schema-mismatched remote document): "cloud-data-corrupted", needs attention', () => {

    const result: CloudSyncResult = {
      status: 'cloud-invalid',
      detail: 'not valid json',
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'cloud-data-corrupted' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(true)

  })

  it('cloud-invalid carries its diagnosis (if any) through to the outcome, for the corruption-recovery dialog to read', () => {

    const diagnosis = {
      kind: 'invalid-record' as const,
      recordType: 'patient' as const,
      recordDescription: 'Patient "Jane Doe" (id abc)',
      reason: 'is missing a name',
    }

    const result: CloudSyncResult = {
      status: 'cloud-invalid',
      detail: 'The cloud sync document contains invalid patient records.',
      diagnosis,
    }

    expect(classifySyncOutcome(result)).toEqual({
      type: 'cloud-data-corrupted',
      diagnosis,
    })

  })

  it('cloud-invalid with no diagnosis at all still classifies cleanly (diagnosis is optional)', () => {

    const result: CloudSyncResult = {
      status: 'cloud-invalid',
      detail: 'not valid json',
    }

    const outcome = classifySyncOutcome(result)

    expect(outcome.type).toBe('cloud-data-corrupted')
    expect(outcome.diagnosis).toBeUndefined()

  })

  it('validation-failed (this device\'s own local data): "local-data-invalid", needs attention', () => {

    const result: CloudSyncResult = {
      status: 'validation-failed',
      detail: 'malformed local patient record',
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'local-data-invalid' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(true)

  })

  it('auth-failed (expired/invalid sign-in): "not-signed-in", needs attention', () => {

    const result: CloudSyncResult = { status: 'auth-failed' }

    expect(classifySyncOutcome(result)).toEqual({ type: 'not-signed-in' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(true)

  })

  it('permission-denied (Graph 403): "sign-in-denied", needs attention', () => {

    const result: CloudSyncResult = {
      status: 'permission-denied',
      detail: 'accessDenied',
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'sign-in-denied' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(true)

  })

  it('network-unreachable (fetch itself threw - offline/DNS/etc): "offline", does not need attention', () => {

    const result: CloudSyncResult = {
      status: 'network-unreachable',
      detail: 'Failed to fetch',
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'offline' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(false)

  })

  it('graph-error (a response WAS received, but it was an error): "onedrive-unavailable", does not need attention', () => {

    const result: CloudSyncResult = {
      status: 'graph-error',
      detail: '503 Service Unavailable',
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'onedrive-unavailable' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(false)

  })

  it('diverged (Phase 5 - local and cloud both changed independently): "diverged", needs attention', () => {

    const result: CloudSyncResult = {
      status: 'diverged',
      detail: 'local has unsynced changes and the cloud moved independently',
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'diverged' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(true)

  })

  it('diverged copy invites the dentist to review, and no longer promises a future update', () => {

    const copy = describeSyncOutcome({ type: 'diverged' })

    expect(copy.label).toBe('Sync paused')
    expect(copy.detail).toContain('nothing was overwritten')
    expect(copy.detail).toContain('Tap to review the differences.')
    expect(copy.detail).not.toContain('next update')

  })

  it('network-unreachable and graph-error are classified DIFFERENTLY from each other (the Phase 6 split)', () => {

    const offline = classifySyncOutcome({
      status: 'network-unreachable',
      detail: 'x',
    })

    const graphDown = classifySyncOutcome({
      status: 'graph-error',
      detail: 'x',
    })

    expect(offline.type).not.toBe(graphDown.type)

  })

})

describe('SYNC_OUTCOME_COPY - every reason has real, distinct, non-technical wording', () => {

  const ALL_TYPES = Object.keys(SYNC_OUTCOME_COPY) as SyncOutcomeType[]

  it('has an entry for every SyncOutcomeType with a non-empty label', () => {

    for (const type of ALL_TYPES) {

      const copy = SYNC_OUTCOME_COPY[type]

      expect(copy.label.trim()).not.toBe('')
      expect(copy.detail.trim()).not.toBe('')
      expect(typeof copy.needsAttention).toBe('boolean')

    }

  })

  it('never shows technical jargon in any label or detail (no ETag, schema, HTTP codes, "Graph API")', () => {

    const forbiddenTerms = [
      'etag',
      'schema',
      '401',
      '403',
      '412',
      '409',
      '422',
      '500',
      'graph api',
      'json',
      'http',
    ]

    for (const type of ALL_TYPES) {

      const copy = SYNC_OUTCOME_COPY[type]
      const combined = `${copy.label} ${copy.detail}`.toLowerCase()

      for (const term of forbiddenTerms) {
        expect(combined).not.toContain(term)
      }

    }

  })

  it('every label is distinct - no two outcome types silently share the exact same badge text', () => {

    const labels = ALL_TYPES.map(type => SYNC_OUTCOME_COPY[type].label)

    expect(new Set(labels).size).toBe(labels.length)

  })

  it('needs-attention outcomes are exactly the ones a dentist must act on, auto-recoverable ones are exactly the rest', () => {

    const needsAttentionTypes = ALL_TYPES.filter(
      type => SYNC_OUTCOME_COPY[type].needsAttention
    ).sort()

    const autoRecoverableTypes = ALL_TYPES.filter(
      type => !SYNC_OUTCOME_COPY[type].needsAttention
    ).sort()

    expect(needsAttentionTypes).toEqual(
      [
        'cloud-data-corrupted',
        'diverged',
        'local-data-invalid',
        'not-signed-in',
        'sign-in-denied',
      ].sort()
    )

    expect(autoRecoverableTypes).toEqual(
      [
        'offline',
        'onedrive-unavailable',
        'save-incomplete',
        'synced',
      ].sort()
    )

  })

})

describe('describeSyncOutcome', () => {

  it('is a pure lookup - looking up the same reason twice returns equal copy', () => {

    const reason = { type: 'offline' as const }

    expect(describeSyncOutcome(reason)).toEqual(describeSyncOutcome(reason))

  })

})

describe('SYNC_STATE_OF_OUTCOME - every outcome belongs to exactly one of the four states', () => {

  it('maps each outcome type as planned', () => {
    expect(SYNC_STATE_OF_OUTCOME).toEqual({
      synced: 'synced',
      'save-incomplete': 'offline',
      offline: 'offline',
      'onedrive-unavailable': 'offline',
      diverged: 'conflict',
      'cloud-data-corrupted': 'needs-input',
      'local-data-invalid': 'needs-input',
      'not-signed-in': 'needs-input',
      'sign-in-denied': 'needs-input',
    })
  })

  it('agrees with the existing needsAttention flag: conflict/needs-input exactly when it is true', () => {
    for (const type of Object.keys(SYNC_STATE_OF_OUTCOME) as SyncOutcomeType[]) {
      const state = SYNC_STATE_OF_OUTCOME[type]
      expect(state === 'conflict' || state === 'needs-input').toBe(
        describeSyncOutcome({ type }).needsAttention
      )
    }
  })

  it('has the four headings', () => {
    expect(SYNC_STATE_HEADING).toEqual({
      synced: 'Synced',
      offline: 'Offline, will retry',
      conflict: 'Sync conflict',
      'needs-input': 'Needs your input',
    })
  })

})
