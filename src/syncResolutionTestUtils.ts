import type { Patient, SavedTreatment, ProcedureTemplate, Procedure } from './App'

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  type CloudSyncDocument,
} from './cloudSync'

/*
  Shared, fully-typed record factories for the Phase 6 resolution tests
  (syncDiff/syncResolve/syncResolutionSafetyCopy and later steps). Test
  support only - never imported by production code.
*/

export function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'patient-1',
    patientNumber: 1,
    name: 'Jane Doe',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function makeSavedTreatment(
  overrides: Partial<SavedTreatment> = {}
): SavedTreatment {
  return {
    id: 'treatment-1',
    patientName: 'Jane Doe',
    patientId: 'patient-1',
    toothId: '16',
    procedureName: 'RCT',
    procedureId: 'procedure-1',
    templateName: 'Custom Template',
    templateId: 'template-1',
    phases: [{ name: 'Access', duration: 480 }],
    date: '2026-01-01T12:00:00.000Z',
    completed: true,
    phaseTimes: [480],
    actualTimes: [500],
    phaseRecords: [],
    totalExpectedDuration: 480,
    totalActualDuration: 3240,
    totalOvertimeDuration: 20,
    events: [],
    tags: [],
    chairEnteredAt: null,
    chairLeftAt: null,
    currentPhaseIndex: 0,
    startedAt: '2026-01-01T11:00:00.000Z',
    completedAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:00:00.000Z',
    ...overrides,
  }
}

export function makeTemplate(
  overrides: Partial<ProcedureTemplate> = {}
): ProcedureTemplate {
  return {
    id: 'template-1',
    name: 'Custom Template',
    isCustom: true,
    phases: [{ name: 'Phase 1', duration: 600 }],
    specializationId: 'general',
    procedureKey: 'general',
    typeId: 'general',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: 'procedure-1',
    name: 'Custom Procedure',
    isCustom: true,
    templateId: 'template-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function makeDocument(
  overrides: Partial<CloudSyncDocument> = {}
): CloudSyncDocument {
  return {
    schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
    app: CLOUD_SYNC_APP,
    updatedAt: '2026-01-01T00:00:00.000Z',
    patients: [],
    savedTreatments: [],
    customTemplates: [],
    customProcedures: [],
    deletionTombstones: [],
    ...overrides,
  }
}
