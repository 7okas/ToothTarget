import { describe, expect, it } from 'vitest'

import type { CloudSyncResult } from './cloudSyncEngine'
import {
  classifySyncOutcome,
  describeSyncOutcome,
  SYNC_OUTCOME_COPY,
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

  it('synced (no contention): "synced", does not need attention', () => {

    const result: CloudSyncResult = {
      status: 'synced',
      patientNumberConflicts: [],
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'synced' })
    expect(describeSyncOutcome(classifySyncOutcome(result)).needsAttention).toBe(false)

  })

  it('synced with recoveredFromConflict: false: still plain "synced"', () => {

    const result: CloudSyncResult = {
      status: 'synced',
      patientNumberConflicts: [],
      recoveredFromConflict: false,
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'synced' })

  })

  it('synced with recoveredFromConflict: true: "synced-after-conflict", does not need attention', () => {

    const result: CloudSyncResult = {
      status: 'synced',
      patientNumberConflicts: [],
      recoveredFromConflict: true,
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'synced-after-conflict' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(false)

  })

  it('synced-with-conflicts: "patient-number-conflicts", DOES need attention, regardless of recoveredFromConflict', () => {

    const withoutContention: CloudSyncResult = {
      status: 'synced-with-conflicts',
      patientNumberConflicts: [{ patientNumber: 5, patientIds: ['a', 'b'] }],
    }

    const withContention: CloudSyncResult = {
      status: 'synced-with-conflicts',
      patientNumberConflicts: [{ patientNumber: 5, patientIds: ['a', 'b'] }],
      recoveredFromConflict: true,
    }

    expect(classifySyncOutcome(withoutContention)).toEqual({
      type: 'patient-number-conflicts',
    })
    expect(classifySyncOutcome(withContention)).toEqual({
      type: 'patient-number-conflicts',
    })
    expect(
      describeSyncOutcome(classifySyncOutcome(withoutContention)).needsAttention
    ).toBe(true)

  })

  it('stale-review-required: "review-needed", needs attention', () => {

    const result: CloudSyncResult = {
      status: 'stale-review-required',
      candidates: [],
    }

    expect(classifySyncOutcome(result)).toEqual({ type: 'review-needed' })
    expect(
      describeSyncOutcome(classifySyncOutcome(result)).needsAttention
    ).toBe(true)

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

  it('contention (retries exhausted): "sync-busy", does not need attention', () => {

    const result: CloudSyncResult = { status: 'contention', attempts: 3 }

    expect(classifySyncOutcome(result)).toEqual({ type: 'sync-busy' })
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
        'local-data-invalid',
        'not-signed-in',
        'patient-number-conflicts',
        'review-needed',
        'sign-in-denied',
      ].sort()
    )

    expect(autoRecoverableTypes).toEqual(
      [
        'offline',
        'onedrive-unavailable',
        'save-incomplete',
        'sync-busy',
        'synced',
        'synced-after-conflict',
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
