import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import './App.css'
import logo from './assets/logo.png'
import BackButton from './BackButton'
import MicrosoftAccountSection from './MicrosoftAccountSection'
import TreatmentSummaryCard from './TreatmentSummaryCard'
import StatisticsScreen from './StatisticsScreen'
import ToothChart from './ToothChart'
import { formatTime, formatDate } from './format'
import { getToothById, getToothLabel, resolveLegacyToothId } from './teeth'
import { calculateInterruptionSeconds } from './treatmentEvents'
import { findExactDuplicateTemplate } from './templates'
import { calculateAppointmentDurationEstimate } from './statistics'
import {
  TEMPLATE_TAXONOMY,
  UNCLASSIFIED,
  classifyTemplate,
  findSpecialization,
  findProcedureOption,
  findTypeOption,
} from './templateTaxonomy'
import type { PatientNumberConflict } from './cloudMerge'
import {
  readPersistedPatientNumberConflicts,
  isValidPatientNumberConflict,
  reconcilePatientNumberConflicts,
  reconcileAndPersistPatientNumberConflicts,
  recordAndReconcilePatientNumberConflicts,
  resolvePatientNumberConflict,
  computeNextPatientNumber,
  detectPatientNumberConflict,
} from './patientNumberConflicts'
import { planPatientDeletionCascade } from './patientDeletionCascade'
import { applyPatientRenameToSavedTreatments } from './patientRenameCascade'
import {
  requestCloudSync,
  requestCloudSyncIfSignedIn,
  getPendingStaleReview,
  subscribePendingStaleReview,
  resumeSyncAfterStaleReview,
} from './cloudSyncScheduler'
import type { StaleReviewCandidate } from './staleRecordReview'
import { attachOnlineRetryListener } from './cloudSyncOnlineRetry'
import { reconcileSyncedAccount } from './cloudSyncEngine'
import { getActiveAccount } from './auth'

export type TemplatePhase = {
  name: string
  duration: number
}

/*
  PHASE TRACKING

  PhaseMeta is tracked alongside the existing phases/phaseTimes/
  actualTimes arrays on an ActiveTreatment (index-aligned, same
  pattern already used by those arrays). It only carries the extra
  bookkeeping the live timer doesn't already have a home for -
  timestamps, status, skip/pause info - so the existing countdown
  engine stays untouched.

  PhaseRecord is the frozen, fully self-contained record built once
  a treatment is saved - it's what future features (summaries,
  history, statistics) should read from, so they don't need to
  reassemble data out of several parallel arrays.
*/

export type PhaseStatus = 'pending' | 'active' | 'completed' | 'skipped'

type PhaseMeta = {
  id: string
  startedAt: string | null
  completedAt: string | null
  status: PhaseStatus
  skipped: boolean
  pausedWhileActive: boolean
}

export type PhaseRecord = {
  id: string
  name: string
  expectedDuration: number
  actualDuration: number
  startedAt: string | null
  completedAt: string | null
  status: PhaseStatus
  skipped: boolean
  pausedWhileActive: boolean
}

/*
  TREATMENT EVENTS

  A quick note ("Calcified canal") and a logged interruption
  ("Patient interruption - 3 min") are the same underlying concept -
  something that happened during a treatment, outside the normal
  procedure phase sequence - so they share one record shape. Only
  interruption-type events carry a duration; notes are purely
  informational (durationSeconds stays null). Interruption time is
  tracked here, entirely separately from phaseTimes/actualTimes, and
  is never inserted into the phase sequence or the procedure
  template - it belongs only to this one treatment.
*/

export type TreatmentEventType = 'note' | 'interruption'

export type TreatmentEvent = {
  id: string
  type: TreatmentEventType
  note: string
  timestamp: string
  durationSeconds: number | null
}

export type ProcedureTemplate = {
  id: string
  name: string
  isCustom: boolean
  phases: TemplatePhase[]
  /*
    Where this template lives in the Specialization -> Procedure ->
    Type hierarchy (see templateTaxonomy.ts). Every template has one,
    including legacy/custom ones migrated in via classifyTemplate().
  */
  specializationId: string
  procedureKey: string
  typeId: string
  /*
    Last time this template's content was intentionally saved as an
    edit (see saveTemplateDraft()) - never bumped just because the
    app loaded, the template was viewed/selected, or localStorage was
    rewritten without a content change. Required on every template
    (including built-ins, since ProcedureTemplate is one shared type)
    but only meaningful for custom ones: built-ins are never part of
    the cloud sync dataset (see cloudSync.ts), so their value is
    never read by anything. Existing templates saved before this
    field existed are backfilled once by migrateTemplateTimestamps().
  */
  updatedAt: string
}

export type Procedure = {
  id: string
  name: string
  isCustom: boolean
  templateId: string
  regionTemplateIds?: {
    anterior: string
    premolar: string
    molar: string
  }
  /*
    Phase 5.5 addition - added for the exact same reason
    ProcedureTemplate/Patient/SavedTreatment each gained one: a
    procedure record was "create-only/immutable" in every normal local
    workflow until editing (confirmEditProcedure()) and deleting
    (deleteProcedureFromRegistry()) a procedure became possible.
    Without a real timestamp, cloudMerge.ts's same-id merge would have
    no honest way to prefer an edit over a stale pre-edit copy still
    sitting in the cloud. Set at creation (addProcedure()), bumped on
    every edit; existing procedures missing it are backfilled once by
    migrateProcedureTimestamps() (falling back to "now", the same
    approximation migrateTemplateTimestamps() already uses for
    templates, since a Procedure carries no other field an honest
    historical value could be recovered from).
  */
  updatedAt: string
}

/*
  PATIENT IDENTITY (Patient ID Introduction, Stage 1 + patientNumber)

  Replaces the old toothTargetPatients shape (a bare string[] of
  names). id is a stable crypto.randomUUID(), generated once per
  patient by migratePatientIdentity() (for existing data) or wherever
  a new patient is first created - it's the internal identity used for
  patientId on treatments, never shown to the dentist.

  patientNumber is the separate, human-friendly, sequential number
  the dentist actually sees and searches by (see nextPatientNumber
  below) - it never replaces id and is never used as a treatment's
  patientId. Once assigned, a patientNumber is permanent: deleting a
  patient never frees their number for reuse.

  name stays the same trimmed, title-cased display string the app has
  always used.
*/

export type Patient = {
  id: string
  patientNumber: number
  name: string
  /*
    Phase 4.6 addition - set once, at the moment a patient is first
    created (allocatePatientUnderLock()), and never touched again by
    anything, including an edit (editPatientRecordUnderLock()) or a
    patient-number conflict resolution - unlike updatedAt below, which
    DOES change on every one of those. Existing patients that predate
    this field are backfilled once by migratePatientTimestamps(),
    falling back to their own (already-resolved) updatedAt - an
    honest approximation, not a recovered historical fact, since this
    app never recorded a real creation time before now.
  */
  createdAt: string
  /*
    Phase 8 addition - added for the exact same reason
    ProcedureTemplate gained one in Phase 2: a patient record is
    "immutable, create-only" in every normal local workflow, but
    patient-number conflict resolution (Phase 4/8) IS a legitimate,
    intentional mutation of an existing patient's own patientNumber -
    without a timestamp, cloudMerge.ts's same-UUID-different-content
    tie-break (deliberately content-based, not time-based, for a
    genuinely-immutable record) could just as easily pick the STALE
    pre-resolution value, silently undoing the dentist's own
    resolution on the very next sync. Required on every patient
    (matching cloudSync.ts's validator); existing patients missing it
    are backfilled once by migratePatientTimestamps() below, exactly
    like migrateTemplateTimestamps() already does for templates.

    Phase 4.6 note: also now updated on a direct name/number edit
    (editPatientRecordUnderLock()), the same "any intentional content
    change bumps updatedAt" principle this field has always followed.
  */
  updatedAt: string
}

/*
  DELETION TOMBSTONES (multi-device sync)

  Record of "this Patient/ProcedureTemplate/SavedTreatment/Procedure
  UUID was deleted here" - read by cloudMerge.ts's
  mergeCloudSyncDocuments() on every sync to suppress a deleted record
  from resurrecting via another device's still-live copy. id is the
  tombstone's own identity (crypto.randomUUID()), separate from
  entityId (the UUID of the thing that was deleted) - deliberately
  carries no patient name or other descriptive content, since a merge
  only ever needs to answer "was this UUID deleted?". 'procedure'
  (Phase 5.5) is recorded by deleteProcedureFromRegistry() below,
  mirroring exactly how 'procedureTemplate' is recorded by
  deleteTemplateFromRegistry().
*/

export type DeletionTombstone = {
  id: string
  entityType: 'patient' | 'procedureTemplate' | 'treatment' | 'procedure'
  entityId: string
  deletedAt: string
}

type ActiveTreatment = {
  /*
    Globally unique (crypto.randomUUID()) - see startTreatment() and
    migrateTreatmentIds() below. Was Date.now()-based before the
    treatment-ID migration; never used to correlate a treatment with
    a patient (that's patientId, a completely separate field) - this
    is purely the treatment's own identity, used to find/remove one
    specific record within its own array (resumeIncompleteTreatment,
    confirmDiscard) and as a React list key.
  */
  id: string
  patientName: string
  patientId: string
  /*
    Standardized FDI tooth identity (e.g. "16" for UR6) - see
    teeth.ts. Everything display-related (notation, arch, side,
    position, region) is derived from this via getToothById()
    rather than duplicated here, since tooth anatomy never changes.
  */
  toothId: string
  procedureName: string
  procedureId: string
  templateName: string
  templateId: string
  phases: TemplatePhase[]
  phaseTimes: number[]
  actualTimes: number[]
  phaseMeta: PhaseMeta[]
  /*
    Quick notes and logged interruptions for this treatment. Never
    read by the phase-timing engine and never written back to the
    procedure template - purely a log belonging to this treatment.
  */
  events: TreatmentEvent[]
  /*
    Optional classification (e.g. "Difficult", "Retreatment") -
    purely descriptive, never read by any timing/template logic.
  */
  tags: string[]
  /*
    CHAIR TIME (Phase 16)

    Distinct from the phase-timing engine above - these mark when
    the patient physically sat down and got up, which can start
    before and end after the clinical timer's own startedAt/
    completedAt. Both stay null until the dentist explicitly marks
    them; never inferred or defaulted, so "not recorded" is always
    honest rather than a fabricated guess.
  */
  chairEnteredAt: string | null
  chairLeftAt: string | null
  currentPhaseIndex: number
  lastUpdated: number
  isPaused: boolean
  /*
    ISO timestamp marking when the current unpaused run of
    currentPhaseIndex began. null whenever isPaused is true.
    settleActualTime() reconciles phaseTimes/actualTimes against
    this on every tick and on every phase/pause/save event, using
    real wall-clock elapsed time rather than counted ticks - so
    actual duration stays correct through background throttling,
    screen navigation, and app close/reopen.
  */
  runningSince: string | null
  startedAt: string
}

export type SavedTreatment = {
  /*
    Globally unique (crypto.randomUUID()) - inherited unchanged from
    the ActiveTreatment.id it was completed from (see
    completeTreatment()). See ActiveTreatment.id above for the full
    explanation.
  */
  id: string
  patientName: string
  patientId: string
  toothId: string
  procedureName: string
  procedureId: string
  templateName: string
  templateId: string
  phases: TemplatePhase[]
  date: string
  completed: boolean
  phaseTimes: number[]
  actualTimes: number[]
  phaseRecords: PhaseRecord[]
  totalExpectedDuration: number
  totalActualDuration: number
  totalOvertimeDuration: number
  events: TreatmentEvent[]
  tags: string[]
  chairEnteredAt: string | null
  chairLeftAt: string | null
  currentPhaseIndex: number
  startedAt: string
  completedAt?: string
  /*
    Phase 4.6 addition - added for the exact same reason Patient
    (Phase 8) and ProcedureTemplate (Phase 2) each gained one:
    completing a treatment was this type's only mutation until now,
    which is why cloudMerge.ts's own comment could previously call
    SavedTreatment "create-only/immutable" and use a purely content-
    based tiebreak for a same-id disagreement. Editing a completed
    treatment's phase data (see confirmEditTreatmentPhases()) IS a
    genuine, intentional content mutation, exactly like patient-number
    conflict resolution is for Patient - without a timestamp,
    cloudMerge.ts's same-id merge would have no honest way to prefer
    the edit over a stale pre-edit copy still sitting in the cloud.
    Set at completion time (same instant as completedAt) and bumped on
    every edit; existing treatments missing it are backfilled once by
    migrateSavedTreatmentTimestamps(), falling back to completedAt (or
    date, if even that's missing) - an approximation, not a recovered
    fact, same spirit as Patient.createdAt's own backfill.
  */
  updatedAt: string
}

type TemplateDraft = {
  id: string
  name: string
  phases: TemplatePhase[]
  specializationId: string
  procedureKey: string
  typeId: string
}

/*
  DEFAULT / BUILT-IN DATA

  DEFAULT_GENERAL_PHASES is the original fixed phase set ToothTarget
  shipped with. It now lives on as the "General Procedure" template,
  used as a safe fallback whenever a procedure has no more specific
  template.
*/

const DEFAULT_GENERAL_PHASES: TemplatePhase[] = [
  { name: 'Access', duration: 10 * 60 },
  { name: 'Cleaning & Shaping', duration: 30 * 60 },
  { name: 'Obturation', duration: 20 * 60 },
]

const DEFAULT_COMPOSITE_PHASES: TemplatePhase[] = [
  { name: 'Preparation', duration: 10 * 60 },
  { name: 'Restoration & Finishing', duration: 20 * 60 },
]

/*
  Built-in templates are static and never edited through the normal
  save path, so there's no real "last edited" moment to record - one
  fixed timestamp is stamped onto all of them purely to satisfy the
  shared ProcedureTemplate type. It's never read: built-ins are never
  part of the cloud sync dataset (customTemplates only, see
  cloudSync.ts) and are never included in a cloud backup either (see
  createCloudBackup()'s isCustom filter).
*/
const BUILTIN_TEMPLATE_UPDATED_AT = '2024-01-01T00:00:00.000Z'

const BUILTIN_TEMPLATES: ProcedureTemplate[] = (
  [
  {
    id: 'general',
    name: 'General Procedure',
    isCustom: false,
    phases: DEFAULT_GENERAL_PHASES.map(phase => ({ ...phase })),
    ...UNCLASSIFIED,
  },
  {
    id: 'rct-anterior',
    name: 'Anterior Root Canal',
    isCustom: false,
    phases: [
      { name: 'Access', duration: 8 * 60 },
      { name: 'Working Length', duration: 5 * 60 },
      { name: 'Glide Path', duration: 5 * 60 },
      { name: 'Shaping', duration: 10 * 60 },
      { name: 'Irrigation', duration: 5 * 60 },
      { name: 'Obturation', duration: 8 * 60 },
    ],
    specializationId: 'endodontics',
    procedureKey: 'rct',
    typeId: 'anterior',
  },
  {
    id: 'rct-premolar',
    name: 'Premolar Root Canal',
    isCustom: false,
    phases: [
      { name: 'Access', duration: 10 * 60 },
      { name: 'Working Length', duration: 8 * 60 },
      { name: 'Glide Path', duration: 5 * 60 },
      { name: 'Shaping', duration: 12 * 60 },
      { name: 'Irrigation', duration: 8 * 60 },
      { name: 'Obturation', duration: 10 * 60 },
    ],
    specializationId: 'endodontics',
    procedureKey: 'rct',
    typeId: 'premolar',
  },
  {
    id: 'rct-molar',
    name: 'Molar Root Canal',
    isCustom: false,
    phases: [
      { name: 'Access', duration: 10 * 60 },
      { name: 'Working Length', duration: 10 * 60 },
      { name: 'Glide Path', duration: 5 * 60 },
      { name: 'Shaping', duration: 15 * 60 },
      { name: 'Irrigation', duration: 10 * 60 },
      { name: 'Obturation', duration: 10 * 60 },
    ],
    specializationId: 'endodontics',
    procedureKey: 'rct',
    typeId: 'molar',
  },
  {
    id: 'cr-default',
    name: 'Composite Restoration',
    isCustom: false,
    phases: DEFAULT_COMPOSITE_PHASES.map(phase => ({ ...phase })),
    specializationId: 'restorative',
    procedureKey: 'composite',
    typeId: 'class-1',
  },
  {
    id: 'cr-class-2',
    name: 'Composite Restoration',
    isCustom: false,
    phases: DEFAULT_COMPOSITE_PHASES.map(phase => ({ ...phase })),
    specializationId: 'restorative',
    procedureKey: 'composite',
    typeId: 'class-2',
  },
  {
    id: 'cr-class-3',
    name: 'Composite Restoration',
    isCustom: false,
    phases: DEFAULT_COMPOSITE_PHASES.map(phase => ({ ...phase })),
    specializationId: 'restorative',
    procedureKey: 'composite',
    typeId: 'class-3',
  },
  {
    id: 'cr-class-4',
    name: 'Composite Restoration',
    isCustom: false,
    phases: DEFAULT_COMPOSITE_PHASES.map(phase => ({ ...phase })),
    specializationId: 'restorative',
    procedureKey: 'composite',
    typeId: 'class-4',
  },
  {
    id: 'cr-class-5',
    name: 'Composite Restoration',
    isCustom: false,
    phases: DEFAULT_COMPOSITE_PHASES.map(phase => ({ ...phase })),
    specializationId: 'restorative',
    procedureKey: 'composite',
    typeId: 'class-5',
  },
  {
    id: 'sp-default',
    name: 'Scaling & Polishing',
    isCustom: false,
    phases: [
      { name: 'Scaling & Polishing', duration: 30 * 60 },
    ],
    ...UNCLASSIFIED,
  },
  {
    id: 'ext-default',
    name: 'Extraction',
    isCustom: false,
    phases: [
      { name: 'Extraction', duration: 20 * 60 },
    ],
    ...UNCLASSIFIED,
  },
  {
    id: 'irprep-default',
    name: 'Indirect Restoration Prep',
    isCustom: false,
    phases: [
      { name: 'Preparation', duration: 30 * 60 },
      { name: 'Impression', duration: 10 * 60 },
    ],
    ...UNCLASSIFIED,
  },
  ] satisfies Omit<ProcedureTemplate, 'updatedAt'>[]
).map(template => ({ ...template, updatedAt: BUILTIN_TEMPLATE_UPDATED_AT }))

/*
  Built-in procedures are static and never edited/deleted through the
  normal edit/delete path (see confirmEditProcedure()/
  requestDeleteProcedure()'s own isCustom guards below), so there's no
  real "last edited" moment to record - one fixed timestamp is stamped
  onto all of them purely to satisfy the shared Procedure type, the
  exact same reasoning/pattern BUILTIN_TEMPLATE_UPDATED_AT already
  established for BUILTIN_TEMPLATES. It's never read: built-ins are
  never part of the cloud sync dataset (customProcedures only, see
  cloudSync.ts) and are never included in a cloud backup either (see
  createCloudBackup()'s isCustom filter).
*/
const BUILTIN_PROCEDURE_UPDATED_AT = '2024-01-01T00:00:00.000Z'

const BUILTIN_PROCEDURES: Procedure[] = (
  [
  {
    id: 'rct',
    name: 'RCT',
    isCustom: false,
    templateId: 'rct-molar',
    regionTemplateIds: {
      anterior: 'rct-anterior',
      premolar: 'rct-premolar',
      molar: 'rct-molar',
    },
  },
  { id: 'cr', name: 'CR', isCustom: false, templateId: 'cr-default' },
  { id: 'sp', name: 'S&P', isCustom: false, templateId: 'sp-default' },
  { id: 'ext', name: 'Ext', isCustom: false, templateId: 'ext-default' },
  { id: 'irprep', name: 'IRPrep', isCustom: false, templateId: 'irprep-default' },
  ] satisfies Omit<Procedure, 'updatedAt'>[]
).map(procedure => ({ ...procedure, updatedAt: BUILTIN_PROCEDURE_UPDATED_AT }))

/*
  One-tap presets for the Quick Notes and Interruption logs on the
  Timer screen - a custom text field alongside these covers anything
  not listed.
*/

const QUICK_NOTE_PRESETS = [
  'Calcified canal',
  'MB2 located',
  'Patient interruption',
  'Difficult access',
  'Additional irrigation',
  'File separation',
]

const INTERRUPTION_PRESETS = [
  'Patient interruption',
  'Equipment issue',
  'Additional interruption',
]

/*
  Optional treatment classification (Phase 12) - purely descriptive
  metadata for future statistics ("Average Molar RCT time - Routine
  vs Difficult"). Tags never affect timing, template resolution, or
  any calculation in this phase; they're just stored on the
  treatment record.
*/

const TREATMENT_TAG_PRESETS = [
  'Difficult',
  'Routine',
  'Retreatment',
  'Calcified',
  'Emergency',
  'Referral',
  'Complication',
]

/*
  DATA EXPORT & BACKUP (Phase 14)

  A backup is built directly from what's already sitting in
  localStorage, not from React state - that way it always reflects
  exactly what's persisted, and never accidentally includes
  transient in-memory UI state (search text, filter selections, open
  modals) that was never written to storage in the first place.
*/

const BACKUP_STORAGE_KEYS = [
  'toothTargetPatients',
  'toothTargetNextPatientNumber',
  'toothTargetSavedTreatments',
  'toothTargetIncompleteTreatments',
  'toothTargetActiveTreatment',
  'toothTargetTemplates',
  'toothTargetProcedures',
  'toothTargetDeletionTombstones',
] as const

function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string
) {

  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = filename

  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)

  URL.revokeObjectURL(url)

}

function csvEscape(value: string) {

  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }

  return value

}

/*
  CHAIR TIME (Phase 16)

  Chair time (patient seated -> patient left) is a separate
  measurement from the existing phase-timing engine's clinical time
  (sum of actualDuration) and logged interruption time - it
  supplements them for future practice-management statistics, never
  replaces or feeds back into them. null whenever either endpoint
  hasn't been marked, so "not recorded" is never confused with zero.
*/

function computeChairTimeSeconds(
  treatment: { chairEnteredAt: string | null; chairLeftAt: string | null }
): number | null {

  if (!treatment.chairEnteredAt || !treatment.chairLeftAt) {
    return null
  }

  return Math.max(
    0,
    Math.round(
      (Date.parse(treatment.chairLeftAt) -
        Date.parse(treatment.chairEnteredAt)) /
        1000
    )
  )

}

/*
  Root canal treatments pick their phase template based on which
  region of the mouth the tooth is in - read directly off the
  standardized FDI tooth (see teeth.ts), never inferred from text.
*/

function resolveTemplate(
  procedure: Procedure,
  toothId: string,
  templates: ProcedureTemplate[]
): ProcedureTemplate {

  const tooth = getToothById(toothId)

  const region =
    procedure.regionTemplateIds && tooth
      ? tooth.region
      : null

  const templateId =
    region && procedure.regionTemplateIds
      ? procedure.regionTemplateIds[region]
      : procedure.templateId

  return (
    templates.find(template => template.id === templateId) ??
    templates.find(template => template.id === 'general') ??
    templates[0]
  )

}

/*
  IDENTITY

  ToothTarget doesn't have a separate patient/procedure registry with
  its own IDs - patient identity is already the (case-insensitive)
  name everywhere in this app, and procedures/templates already have
  real IDs. slugify() derives a stable, deterministic ID from a name
  so treatment records can reference "who"/"what" without inventing a
  parallel identity system.
*/

function slugify(value: string): string {

  const slug =
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  return slug === '' ? 'unknown' : slug

}

/*
  PHASE META TRACKING

  These are small, pure helpers that update the phaseMeta array
  alongside whatever the timer is already doing to phaseTimes/
  actualTimes/currentPhaseIndex - they never drive the countdown
  themselves.
*/

function createPhaseMeta(count: number): PhaseMeta[] {

  return Array.from(
    { length: count },
    (_, index) => ({
      id: `phase-${index}`,
      startedAt: index === 0 ? new Date().toISOString() : null,
      completedAt: null,
      status: index === 0 ? 'active' : 'pending',
      skipped: false,
      pausedWhileActive: false,
    })
  )

}

function advancePhaseMeta(
  meta: PhaseMeta[],
  fromIndex: number,
  toIndex: number
): PhaseMeta[] {

  if (fromIndex === toIndex) {
    return meta
  }

  const now = new Date().toISOString()

  return meta.map((entry, index) => {

    if (index === fromIndex && entry.status === 'active') {
      return { ...entry, completedAt: now, status: 'completed' }
    }

    if (index === toIndex) {
      return {
        ...entry,
        startedAt: entry.startedAt ?? now,
        status: 'active',
      }
    }

    return entry

  })

}

function markPhasePaused(
  meta: PhaseMeta[],
  index: number
): PhaseMeta[] {

  return meta.map((entry, i) =>
    i === index
      ? { ...entry, pausedWhileActive: true }
      : entry
  )

}

function finalizePhaseMeta(
  meta: PhaseMeta[],
  currentIndex: number
): PhaseMeta[] {

  const now = new Date().toISOString()

  return meta.map((entry, index) => {

    if (index === currentIndex && entry.status === 'active') {
      return { ...entry, completedAt: now, status: 'completed' }
    }

    if (entry.status === 'pending' && entry.startedAt === null) {
      return { ...entry, status: 'skipped', skipped: true }
    }

    return entry

  })

}

function buildPhaseMetaFallback(
  phaseCount: number,
  currentPhaseIndex: number,
  allCompleted: boolean
): PhaseMeta[] {

  return Array.from(
    { length: phaseCount },
    (_, index) => ({
      id: `phase-${index}`,
      startedAt: null,
      completedAt: null,
      status:
        allCompleted || index < currentPhaseIndex
          ? 'completed'
          : index === currentPhaseIndex
            ? 'active'
            : 'pending',
      skipped: false,
      pausedWhileActive: false,
    })
  )

}

function buildPhaseRecords(
  phases: TemplatePhase[],
  actualTimes: number[],
  meta: PhaseMeta[]
): PhaseRecord[] {

  return phases.map((phase, index) => ({
    id: meta[index]?.id ?? `phase-${index}`,
    name: phase.name,
    expectedDuration: phase.duration,
    actualDuration: actualTimes[index] ?? 0,
    startedAt: meta[index]?.startedAt ?? null,
    completedAt: meta[index]?.completedAt ?? null,
    status: meta[index]?.status ?? 'pending',
    skipped: meta[index]?.skipped ?? false,
    pausedWhileActive: meta[index]?.pausedWhileActive ?? false,
  }))

}

/*
  ACTUAL TIME SETTLEMENT

  This is the single source of truth for "how much wall-clock time
  has actually elapsed on the current phase since it was last
  settled." It's called on every tick, and immediately before any
  event that changes phase/pause state or saves the treatment, so
  phaseTimes/actualTimes are always caught up to real elapsed time -
  not a count of ticks that fired. That's what keeps timing accurate
  through background-tab throttling, screen navigation away from the
  timer, and the app being closed and reopened (the load effect calls
  this once against the persisted runningSince timestamp).

  A treatment that is paused (or has no runningSince) is already
  settled - there's nothing running to catch up.
*/

function settleActualTime(
  treatment: ActiveTreatment,
  nowMs: number
): ActiveTreatment {

  if (
    treatment.isPaused ||
    treatment.runningSince === null
  ) {
    return treatment
  }

  const elapsedSeconds =
    Math.floor(
      (nowMs - Date.parse(treatment.runningSince)) / 1000
    )

  if (elapsedSeconds <= 0) {
    return treatment
  }

  const phaseTimes = [...treatment.phaseTimes]
  const actualTimes = [...treatment.actualTimes]

  phaseTimes[treatment.currentPhaseIndex] -= elapsedSeconds
  actualTimes[treatment.currentPhaseIndex] += elapsedSeconds

  return {
    ...treatment,
    phaseTimes,
    actualTimes,
    runningSince: new Date(nowMs).toISOString(),
  }

}

/*
  Validates and migrates a raw, loosely-typed localStorage record
  into a real ActiveTreatment - every fallback ToothTarget has ever
  needed for its live-treatment shape, in one place, shared by both
  the single "currently active" slot and each entry in the
  incomplete-treatments list (Phase 10), since a parked incomplete
  treatment needs exactly the same resumability guarantees as the
  active one. Returns null when the record isn't shaped closely
  enough to a treatment to trust at all.
*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateActiveTreatmentShape(
  parsed: any,
  nowMs: number
): ActiveTreatment | null {

  if (
    !parsed ||
    typeof parsed.patientName !== 'string' ||
    (typeof parsed.toothId !== 'string' &&
      typeof parsed.tooth !== 'string') ||
    !Array.isArray(parsed.phaseTimes) ||
    !Array.isArray(parsed.actualTimes)
  ) {
    return null
  }

  /*
    Treatments saved before the Visual Tooth Selection phase stored
    an arbitrary "tooth" text field instead of a standardized
    toothId - resolve it once, then drop the old field so it
    doesn't linger in storage.
  */

  if (
    typeof parsed.toothId !== 'string' ||
    parsed.toothId === ''
  ) {
    parsed.toothId = resolveLegacyToothId(parsed.tooth ?? '')
  }

  delete parsed.tooth

  /*
    Treatments saved before the Procedure Templates feature won't
    have phases/procedureName yet - fall back safely.
  */

  if (
    !Array.isArray(parsed.phases) ||
    parsed.phases.length === 0
  ) {
    parsed.phases =
      DEFAULT_GENERAL_PHASES.map(phase => ({ ...phase }))
  }

  if (typeof parsed.procedureName !== 'string') {
    parsed.procedureName = 'General'
  }

  /*
    Treatments saved before the Treatment Data Foundation phase
    won't have identity fields or phaseMeta yet - fall back safely.
  */

  if (
    typeof parsed.patientId !== 'string' ||
    parsed.patientId === ''
  ) {
    parsed.patientId = slugify(parsed.patientName)
  }

  if (
    typeof parsed.procedureId !== 'string' ||
    parsed.procedureId === ''
  ) {
    parsed.procedureId = slugify(parsed.procedureName)
  }

  if (
    typeof parsed.templateId !== 'string' ||
    parsed.templateId === ''
  ) {
    parsed.templateId = 'general'
  }

  if (
    typeof parsed.templateName !== 'string' ||
    parsed.templateName === ''
  ) {
    parsed.templateName = parsed.procedureName
  }

  if (
    !Array.isArray(parsed.phaseMeta) ||
    parsed.phaseMeta.length !== parsed.phases.length
  ) {
    parsed.phaseMeta =
      buildPhaseMetaFallback(
        parsed.phases.length,
        parsed.currentPhaseIndex,
        false
      )
  }

  /*
    Treatments saved before Treatment Notes & Events won't have an
    events log at all - an empty one is the honest fallback (we have
    no record of what happened).
  */

  if (!Array.isArray(parsed.events)) {
    parsed.events = []
  }

  /*
    Treatments saved before Treatment Tags won't have any - an
    empty list is the honest fallback.
  */

  if (!Array.isArray(parsed.tags)) {
    parsed.tags = []
  }

  /*
    Treatments saved before Chair Time won't have these at all - null
    means honestly "not recorded", never a fabricated guess.
  */

  if (typeof parsed.chairEnteredAt !== 'string') {
    parsed.chairEnteredAt = null
  }

  if (typeof parsed.chairLeftAt !== 'string') {
    parsed.chairLeftAt = null
  }

  /*
    Treatments saved before Accurate Expected vs Actual Timing won't
    have runningSince - derive it from the old lastUpdated field so
    the catch-up below still works for them.
  */

  if (
    typeof parsed.runningSince !== 'string' &&
    !parsed.isPaused
  ) {
    parsed.runningSince =
      new Date(parsed.lastUpdated).toISOString()
  }

  if (parsed.isPaused) {
    parsed.runningSince = null
  }

  /*
    Catch up the timer for the real wall-clock time that passed
    while the app was closed/backgrounded, rather than trusting any
    tick count.
  */

  const settled = settleActualTime(parsed, nowMs)

  settled.lastUpdated = nowMs

  return settled

}

/*
  CUSTOM TEMPLATE/PROCEDURE ID MIGRATION

  Custom ProcedureTemplate/Procedure ids used to be
  `template-${Date.now()}`/`custom-${Date.now()}` - not globally
  unique, for the same reason patient/treatment ids needed migrating.
  Built-in templates/procedures are never touched here - they're
  distinguished by isCustom (the same flag already used everywhere
  else in this file to tell them apart), never by guessing from the
  id's shape, and their real ids (eg. 'general', 'rct-anterior') never
  match the legacy pattern being migrated away from anyway.

  Because a Procedure's templateId/regionTemplateIds - and a
  treatment's own templateId/procedureId snapshot fields - store a
  template/procedure's id BY VALUE, migrating an id without also
  fixing up every place that stored the old value would leave those
  references dangling. This builds an old-id -> new-id map for every
  migrated template and every migrated procedure and returns both, so
  the load effect can apply the exact same mapping everywhere such a
  reference is stored, instead of re-deriving or guessing it more
  than once.
*/

const LEGACY_CUSTOM_TEMPLATE_ID_PATTERN = /^template-\d+$/
const LEGACY_CUSTOM_PROCEDURE_ID_PATTERN = /^custom-\d+$/

function isLegacyCustomTemplateId(
  template: { id: string; isCustom: boolean }
): boolean {

  return (
    template.isCustom === true &&
    LEGACY_CUSTOM_TEMPLATE_ID_PATTERN.test(template.id)
  )

}

function isLegacyCustomProcedureId(
  procedure: { id: string; isCustom: boolean }
): boolean {

  return (
    procedure.isCustom === true &&
    LEGACY_CUSTOM_PROCEDURE_ID_PATTERN.test(procedure.id)
  )

}

type TemplateProcedureIdMigrationResult = {
  templates: ProcedureTemplate[]
  procedures: Procedure[]
  templateIdMap: Map<string, string>
  procedureIdMap: Map<string, string>
  changed: boolean
}

function migrateTemplateAndProcedureIds(
  templates: ProcedureTemplate[],
  procedures: Procedure[]
): TemplateProcedureIdMigrationResult {

  let changed = false

  const templateIdMap = new Map<string, string>()

  const migratedTemplates = templates.map(template => {

    if (!isLegacyCustomTemplateId(template)) {
      return template
    }

    const newId = crypto.randomUUID()

    templateIdMap.set(template.id, newId)

    changed = true

    return { ...template, id: newId }

  })

  const procedureIdMap = new Map<string, string>()

  const migratedProcedures = procedures.map(procedure => {

    let next = procedure

    if (isLegacyCustomProcedureId(procedure)) {

      const newId = crypto.randomUUID()

      procedureIdMap.set(procedure.id, newId)

      changed = true

      next = { ...next, id: newId }

    }

    const mappedTemplateId = templateIdMap.get(next.templateId)

    if (mappedTemplateId) {
      next = { ...next, templateId: mappedTemplateId }
      changed = true
    }

    if (next.regionTemplateIds) {

      const region = next.regionTemplateIds

      const updatedRegion = {
        anterior: templateIdMap.get(region.anterior) ?? region.anterior,
        premolar: templateIdMap.get(region.premolar) ?? region.premolar,
        molar: templateIdMap.get(region.molar) ?? region.molar,
      }

      if (
        updatedRegion.anterior !== region.anterior ||
        updatedRegion.premolar !== region.premolar ||
        updatedRegion.molar !== region.molar
      ) {

        next = { ...next, regionTemplateIds: updatedRegion }

        changed = true

      }

    }

    return next

  })

  return {
    templates: migratedTemplates,
    procedures: migratedProcedures,
    templateIdMap,
    procedureIdMap,
    changed,
  }

}

/*
  Applies the same templateId/procedureId mapping produced above to a
  treatment's own templateId/procedureId snapshot fields only - never
  its own id, and never its copied phases (a treatment's actual phase
  content never changes here; only the two id fields that point back
  at a template/procedure record are ever rewritten).
*/

function migrateTreatmentTemplateProcedureRefs<
  T extends { templateId: string; procedureId: string }
>(
  treatment: T,
  templateIdMap: Map<string, string>,
  procedureIdMap: Map<string, string>
): { treatment: T; changed: boolean } {

  let changed = false

  let next = treatment

  const mappedTemplateId = templateIdMap.get(next.templateId)

  if (mappedTemplateId) {
    next = { ...next, templateId: mappedTemplateId }
    changed = true
  }

  const mappedProcedureId = procedureIdMap.get(next.procedureId)

  if (mappedProcedureId) {
    next = { ...next, procedureId: mappedProcedureId }
    changed = true
  }

  return { treatment: next, changed }

}

function migrateTreatmentTemplateProcedureRefsList<
  T extends { templateId: string; procedureId: string }
>(
  treatments: T[],
  templateIdMap: Map<string, string>,
  procedureIdMap: Map<string, string>
): { treatments: T[]; changed: boolean } {

  let changed = false

  const migrated = treatments.map(treatment => {

    const result =
      migrateTreatmentTemplateProcedureRefs(
        treatment,
        templateIdMap,
        procedureIdMap
      )

    if (result.changed) {
      changed = true
    }

    return result.treatment

  })

  return { treatments: migrated, changed }

}

/*
  TREATMENT ID MIGRATION

  ActiveTreatment.id/SavedTreatment.id used to be Date.now() - not
  globally unique, which matters now that cloud backup/restore can
  bring records from another device into this one. Unlike patient
  identity, a treatment's id has never been used to correlate it with
  anything else (patientId is a completely separate field for that) -
  it's purely self-referential, only ever compared against itself
  within its own array (resumeIncompleteTreatment, confirmDiscard) or
  used as a React key. That means this migration never needs to
  correlate records by name/date/procedure the way patient identity
  did: each treatment's id is simply and independently replaced with
  a fresh crypto.randomUUID() if it isn't already a string, with no
  cross-record logic at all.

  typeof treatment.id === 'string' looks redundant against the
  ActiveTreatment/SavedTreatment types (id is typed as string), but
  this runs against loosely-typed data straight from
  JSON.parse(localStorage...) that may still be a legacy numeric id
  at runtime - exactly the same "trust but verify persisted data"
  pattern already used throughout this file for patientId/
  patientNumber.
*/

function migrateTreatmentId<T extends { id: string }>(
  treatment: T
): { treatment: T; changed: boolean } {

  if (typeof treatment.id === 'string') {
    return { treatment, changed: false }
  }

  return {
    treatment: { ...treatment, id: crypto.randomUUID() },
    changed: true,
  }

}

function migrateTreatmentIdList<T extends { id: string }>(
  treatments: T[]
): { treatments: T[]; changed: boolean } {

  let changed = false

  const migrated = treatments.map(treatment => {

    const result = migrateTreatmentId(treatment)

    if (result.changed) {
      changed = true
    }

    return result.treatment

  })

  return { treatments: migrated, changed }

}

function migrateActiveTreatmentId<T extends { id: string }>(
  treatment: T | null
): { treatment: T | null; changed: boolean } {

  if (!treatment) {
    return { treatment: null, changed: false }
  }

  return migrateTreatmentId(treatment)

}

/*
  PATIENT ID MIGRATION (Stage 1 - data model only)

  toothTargetPatients has always been a plain string[] of names, and
  every treatment's patientId has always been slugify(patientName) -
  lossy (punctuation/accents collapse or vanish) and never actually
  guaranteed unique, even though nothing in the app has ever *relied*
  on it being unique (every real identity decision - search, dedup,
  deletion - has always matched on the name itself, case-
  insensitively). This is step one of moving toward a real Patient
  { id, name } record with a stable UUID: it only changes what's
  *stored*, not how the app currently decides who's who - see
  openPatient()/confirmDeletePatient() for the (unchanged) identity
  logic, which still matches by name exactly as before.

  Deliberately never reads the old slugified patientId - it was never
  guaranteed unique (eg. "O'Brien" and "OBrien" both slugify to
  "obrien"), so two different real patients whose old slugs happened
  to collide could otherwise get merged into one by mistake. Identity
  is always re-derived from patientName instead, using the exact same
  trimmed/case-insensitive rule already used everywhere else in this
  app - which also means any pre-existing slug collision between two
  different real names is naturally resolved correctly here, since
  the two different names were never actually confused by that rule.
*/

function normalizePatientName(name: string): string {
  return name.trim().toLowerCase()
}

type PatientDraft = {
  id: string
  name: string
  patientNumber?: number
  /*
    Carried through unchanged if the persisted entry already has one -
    left undefined otherwise, exactly like patientNumber above. This
    identity migration never invents a timestamp; a missing one is
    backfilled once, right after this runs, by
    migratePatientTimestamps() below (same two-step pattern
    migrateTemplateAndProcedureIds() -> migrateTemplateTimestamps()
    already established).
  */
  updatedAt?: string
  /*
    Same carry-through-or-undefined treatment as updatedAt above -
    backfilled once by migratePatientTimestamps() (Phase 4.6), which
    falls back to the patient's own updatedAt once THAT is resolved,
    never a fresh "now" (a true original creation time isn't
    recoverable for data that predates this field).
  */
  createdAt?: string
}

type PatientMigrationInput = {
  rawPatients: unknown
  savedTreatments: SavedTreatment[]
  incompleteTreatments: ActiveTreatment[]
  activeTreatment: ActiveTreatment | null
}

type PatientMigrationResult = {
  patients: Patient[]
  /*
    The updated running counter for the next NEW patient's number -
    always returned (and should always be persisted), independently
    of `changed` below, since it can move forward even when nothing
    else about the stored patients needed to change (eg. self-
    correcting a stale/never-before-written counter).
  */
  nextPatientNumber: number
  savedTreatments: SavedTreatment[]
  incompleteTreatments: ActiveTreatment[]
  activeTreatment: ActiveTreatment | null
  /*
    True whenever anything actually changed vs what's already
    persisted - eg. the old string[] format was found, a treatment
    referenced a patient name missing from the registry, or a patient
    was missing its patientNumber. When false, nothing is re-written
    to localStorage on this load (aside from nextPatientNumber, see
    above).
  */
  changed: boolean
}

/*
  Reads an already-stored patientNumber, if it's a valid positive
  integer - anything else (missing, from before this feature
  existed, or corrupted) is treated as "not yet assigned."
*/
function readStoredPatientNumber(value: unknown): number | undefined {

  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined

}

function isValidPatient(value: unknown): value is Patient {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Patient).id === 'string' &&
    typeof (value as Patient).name === 'string' &&
    typeof (value as Patient).patientNumber === 'number'
  )

}

function isValidTombstone(value: unknown): value is DeletionTombstone {

  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as DeletionTombstone).id === 'string' &&
    (value as DeletionTombstone).id.trim() !== '' &&
    ((value as DeletionTombstone).entityType === 'patient' ||
      (value as DeletionTombstone).entityType === 'procedureTemplate' ||
      (value as DeletionTombstone).entityType === 'treatment') &&
    typeof (value as DeletionTombstone).entityId === 'string' &&
    (value as DeletionTombstone).entityId.trim() !== '' &&
    typeof (value as DeletionTombstone).deletedAt === 'string'
  )

}

function migratePatientIdentity({
  rawPatients,
  savedTreatments,
  incompleteTreatments,
  activeTreatment,
}: PatientMigrationInput): PatientMigrationResult {

  let changed = false

  const rawList = Array.isArray(rawPatients) ? rawPatients : []

  const byNormalizedName = new Map<string, PatientDraft>()

  /*
    Seed from whatever is already stored. An already-migrated entry
    ({id, name}, optionally with patientNumber) keeps its existing id
    (and patientNumber, if it already has one) untouched - this,
    combined with never regenerating an id/number for a name already
    in this map, is what guarantees the same patient never gets a new
    UUID or a new patientNumber on a later load (idempotency). An
    old-format plain string gets exactly one new UUID (deduped by
    normalized name, in case the old array ever held case/whitespace-
    only duplicate entries) and no patientNumber yet - every patient
    still missing one gets assigned exactly one, below.
  */

  for (const entry of rawList) {

    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      (entry as { name: string }).name.trim() !== ''
    ) {

      const name = (entry as { name: string }).name
      const key = normalizePatientName(name)

      if (!byNormalizedName.has(key)) {

        const rawUpdatedAt = (entry as { updatedAt?: unknown }).updatedAt
        const rawCreatedAt = (entry as { createdAt?: unknown }).createdAt

        byNormalizedName.set(key, {
          id: (entry as { id: string }).id,
          name,
          patientNumber: readStoredPatientNumber(
            (entry as { patientNumber?: unknown }).patientNumber
          ),
          updatedAt:
            typeof rawUpdatedAt === 'string' && rawUpdatedAt.trim() !== ''
              ? rawUpdatedAt
              : undefined,
          createdAt:
            typeof rawCreatedAt === 'string' && rawCreatedAt.trim() !== ''
              ? rawCreatedAt
              : undefined,
        })

      }

      continue

    }

    if (typeof entry === 'string' && entry.trim() !== '') {

      const key = normalizePatientName(entry)

      if (!byNormalizedName.has(key)) {

        byNormalizedName.set(key, {
          id: crypto.randomUUID(),
          name: entry,
        })

        changed = true

      }

    }

  }

  /*
    Every treatment's patientName also gets a Patient entry, even if
    it was somehow missing from the registry above - this is what
    guarantees a treatment can never be orphaned by this migration.
  */

  const allTreatmentNames: unknown[] = [
    ...savedTreatments.map(treatment => treatment.patientName),
    ...incompleteTreatments.map(treatment => treatment.patientName),
    ...(activeTreatment ? [activeTreatment.patientName] : []),
  ]

  for (const name of allTreatmentNames) {

    if (typeof name !== 'string' || name.trim() === '') {
      continue
    }

    const key = normalizePatientName(name)

    if (!byNormalizedName.has(key)) {

      byNormalizedName.set(key, {
        id: crypto.randomUUID(),
        name,
      })

      changed = true

    }

  }

  const patientDrafts = Array.from(byNormalizedName.values())

  /*
    PATIENT NUMBER ASSIGNMENT

    A patientNumber is only ever handed out once and never decreases -
    not even when a patient is deleted - so a number is never reused.
    Assignment order (for patients that don't have one yet) follows
    patientDrafts' existing order, which is itself deterministic given
    the same stored data - so a re-run against unchanged data
    reassigns nothing and produces the same result.

    PHASE 4.6 - DYNAMIC NUMBERING: the starting point is now purely one
    past the highest patientNumber any existing patient already has -
    rawNextPatientNumber (toothTargetNextPatientNumber) is no longer
    consulted here at all. Now that a patient's number can be edited
    directly, that stored counter can drift arbitrarily far behind
    reality, and trusting it as a floor here could hand out a number
    that collides with one a dentist manually assigned. See
    allocatePatientUnderLock()'s own comment for the same reasoning
    applied to normal (non-migration) patient creation.
  */

  const highestAssignedPatientNumber =
    patientDrafts.reduce(
      (highest, patient) =>
        patient.patientNumber !== undefined &&
        patient.patientNumber > highest
          ? patient.patientNumber
          : highest,
      0
    )

  let nextPatientNumber = highestAssignedPatientNumber + 1

  const patients: Patient[] =
    patientDrafts.map(patient => {

      /*
        updatedAt/createdAt are intentionally left as
        `patient.updatedAt ?? ''`/`patient.createdAt ?? ''` here - never
        invented as "now" in this identity-migration pass. An empty
        string fails isValidUpdatedAtTimestamp(), so both are
        immediately corrected by migratePatientTimestamps(), which runs
        right after this function returns, in the same synchronous load
        effect, before any state is set or anything renders.
      */

      if (patient.patientNumber !== undefined) {

        return {
          id: patient.id,
          patientNumber: patient.patientNumber,
          name: patient.name,
          createdAt: patient.createdAt ?? '',
          updatedAt: patient.updatedAt ?? '',
        }

      }

      const assignedNumber = nextPatientNumber

      nextPatientNumber += 1

      changed = true

      return {
        id: patient.id,
        patientNumber: assignedNumber,
        name: patient.name,
        createdAt: patient.createdAt ?? '',
        updatedAt: patient.updatedAt ?? '',
      }

    })

  /*
    Reassign every treatment's patientId purely from its patientName
    via the lookup above - never from the old slugified patientId.
  */

  function migrateTreatmentPatientId<
    T extends { patientName: string; patientId: string }
  >(treatment: T): T {

    if (
      typeof treatment.patientName !== 'string' ||
      treatment.patientName.trim() === ''
    ) {
      return treatment
    }

    const newPatientId =
      byNormalizedName.get(
        normalizePatientName(treatment.patientName)
      )?.id

    if (newPatientId && newPatientId !== treatment.patientId) {
      changed = true
      return { ...treatment, patientId: newPatientId }
    }

    return treatment

  }

  const migratedSavedTreatments =
    savedTreatments.map(migrateTreatmentPatientId)

  const migratedIncompleteTreatments =
    incompleteTreatments.map(migrateTreatmentPatientId)

  const migratedActiveTreatment =
    activeTreatment
      ? migrateTreatmentPatientId(activeTreatment)
      : null

  return {
    patients,
    nextPatientNumber,
    savedTreatments: migratedSavedTreatments,
    incompleteTreatments: migratedIncompleteTreatments,
    activeTreatment: migratedActiveTreatment,
    changed,
  }

}

/*
  PATIENT updatedAt/createdAt MIGRATION (Phase 8 updatedAt, Phase 4.6
  createdAt - cloud sync hardening)

  Runs immediately after migratePatientIdentity() (which never invents
  a timestamp itself - see its own patients: Patient[] construction
  above), in the same synchronous load effect, before any patient
  state is set or rendered. Exactly mirrors migrateTemplateTimestamps()
  for updatedAt: a patient missing a valid updatedAt (including every
  one migratePatientIdentity() just built with the temporary ''
  placeholder) is stamped with the current migration time; a patient
  that already has one is returned completely unchanged, so re-running
  this on every load never overwrites a real prior value - in
  particular, never overwrites the fresh timestamp patientNumber-
  conflict resolution (patientNumberConflicts.ts) or
  allocatePatientUnderLock() already set.

  createdAt is handled differently, in the same pass: a patient
  missing a valid createdAt falls back to its own updatedAt (already
  resolved above, in this same map callback) - NEVER a fresh "now",
  since that would fabricate a false claim that the patient was just
  created. This is an honest approximation (the true original creation
  time isn't recoverable for data that predates this field), not a
  real historical fact - flagged explicitly in this phase's own report.
*/

function migratePatientTimestamps(
  patients: Patient[]
): { patients: Patient[]; changed: boolean } {

  let changed = false

  const migratedPatients = patients.map(patient => {

    const resolvedUpdatedAt =
      isValidUpdatedAtTimestamp(patient.updatedAt)
        ? patient.updatedAt
        : new Date().toISOString()

    const resolvedCreatedAt =
      isValidUpdatedAtTimestamp(patient.createdAt)
        ? patient.createdAt
        : resolvedUpdatedAt

    if (
      resolvedUpdatedAt === patient.updatedAt &&
      resolvedCreatedAt === patient.createdAt
    ) {
      return patient
    }

    changed = true

    return {
      ...patient,
      updatedAt: resolvedUpdatedAt,
      createdAt: resolvedCreatedAt,
    }

  })

  return { patients: migratedPatients, changed }

}

/*
  SAVED TREATMENT date MIGRATION (Phase 7 - statistics data-readiness
  audit)

  date is completeTreatment()'s own timestamp (see that function,
  where it's set unconditionally) and has been required on
  SavedTreatment since the type's very first version - unlike
  updatedAt/completedAt below, nothing ever intentionally left it
  unset. But nothing ever actually VERIFIED that either: the
  legacy-shape fallback pass above backfills toothId, procedureName,
  patientId, procedureId, templateId, templateName, phaseRecords,
  totals, events, tags, chairEnteredAt/chairLeftAt for old records
  missing them, but never included date - and cloudSync.ts's
  isValidSyncSavedTreatment() doesn't check it either, so a treatment
  that somehow reached this app with a missing/corrupted date would
  sync and load without complaint, then silently misbehave anywhere
  date is actually used (chronological sort, Statistics' date-range
  filters and trend chart, migrateSavedTreatmentTimestamps() below,
  which has always silently trusted date as an "always present"
  fallback for a missing updatedAt).

  No such record was found in this app's own data (every known write
  path sets date unconditionally), but this closes the gap
  defensively, the same way every other legacy field already does,
  and runs BEFORE the updatedAt/completedAt migration below so that
  migration's own "or date" fallback is never handed something
  equally invalid. Fallback order mirrors createdAt's own reasoning in
  migratePatientTimestamps(): prefer the closest honest historical
  approximation - completedAt (the same moment date would have
  recorded), then startedAt (still the right treatment, just an
  earlier instant within it) - and only reach for "now" (a fabricated
  date) if literally nothing else on the record is usable.
*/

function migrateSavedTreatmentDates(
  treatments: SavedTreatment[]
): { treatments: SavedTreatment[]; changed: boolean } {

  let changed = false

  const migratedTreatments = treatments.map(treatment => {

    if (isValidUpdatedAtTimestamp(treatment.date)) {
      return treatment
    }

    changed = true

    const fallbackDate =
      isValidUpdatedAtTimestamp(treatment.completedAt)
        ? treatment.completedAt
        : isValidUpdatedAtTimestamp(treatment.startedAt)
          ? treatment.startedAt
          : new Date().toISOString()

    return { ...treatment, date: fallbackDate }

  })

  return { treatments: migratedTreatments, changed }

}

/*
  SAVED TREATMENT updatedAt MIGRATION (Phase 4.6 - cloud sync
  hardening, same reasoning as migratePatientTimestamps() above)

  A saved treatment missing a valid updatedAt (every one that existed
  before this field did) is backfilled using its own completedAt if
  that's valid, or its date (guaranteed valid by
  migrateSavedTreatmentDates() above, which now runs immediately
  before this) as the last-resort fallback - never "now", which would
  falsely claim a old record was just edited. This runs as part of the
  same load-time migration pipeline as the patientName backfill, over
  whatever that pass already produced.
*/

function migrateSavedTreatmentTimestamps(
  treatments: SavedTreatment[]
): { treatments: SavedTreatment[]; changed: boolean } {

  let changed = false

  const migratedTreatments = treatments.map(treatment => {

    if (isValidUpdatedAtTimestamp(treatment.updatedAt)) {
      return treatment
    }

    changed = true

    const fallbackUpdatedAt =
      isValidUpdatedAtTimestamp(treatment.completedAt)
        ? treatment.completedAt
        : treatment.date

    return { ...treatment, updatedAt: fallbackUpdatedAt }

  })

  return { treatments: migratedTreatments, changed }

}

/*
  TREATMENT patientName MIGRATION (cloud sync hardening)

  Every other legacy field a saved/incomplete/active treatment can be
  missing already gets a defensive fallback where treatments are first
  loaded above (toothId, procedureName, patientId, procedureId,
  templateId, templateName) - patientName never did. A treatment
  stored before patientName was reliably written, or corrupted in any
  other way, can end up with a patientName that isn't a real string,
  which the cloud sync schema (cloudSync.ts's isValidSyncSavedTreatment)
  requires and correctly does not relax - that mismatch is exactly what
  surfaced as a real 'validation-failed' sync failure.

  Runs after patients are fully migrated (finalPatients, in the load
  effect below), so a treatment whose patientId still resolves to a
  real patient gets its real, current name back - never a guess. Only
  a treatment whose patientId resolves to nothing at all (deleted
  patient, or patientId itself never valid) falls back to a clearly-
  fake placeholder name; those are reported via `fallbackTreatmentIds`
  rather than silently accepted, since a fabricated name isn't real
  data and may warrant deleting that treatment instead.
*/

const UNKNOWN_PATIENT_NAME_FALLBACK = 'Unknown Patient'

function backfillTreatmentPatientName<
  T extends { id: string; patientId: string; patientName: unknown }
>(
  treatment: T,
  patientsById: Map<string, Patient>
): { treatment: T; changed: boolean; usedFallback: boolean } {

  if (
    typeof treatment.patientName === 'string' &&
    treatment.patientName.trim() !== ''
  ) {
    return { treatment, changed: false, usedFallback: false }
  }

  const matchedPatient = patientsById.get(treatment.patientId)

  if (matchedPatient) {
    return {
      treatment: { ...treatment, patientName: matchedPatient.name },
      changed: true,
      usedFallback: false,
    }
  }

  return {
    treatment: { ...treatment, patientName: UNKNOWN_PATIENT_NAME_FALLBACK },
    changed: true,
    usedFallback: true,
  }

}

function migrateTreatmentPatientNames<
  T extends { id: string; patientId: string; patientName: unknown }
>(
  treatments: T[],
  patients: Patient[]
): { treatments: T[]; changed: boolean; fallbackTreatmentIds: string[] } {

  const patientsById = new Map(patients.map(patient => [patient.id, patient]))

  let changed = false
  const fallbackTreatmentIds: string[] = []

  const migratedTreatments = treatments.map(treatment => {

    const result = backfillTreatmentPatientName(treatment, patientsById)

    if (result.changed) {
      changed = true
    }

    if (result.usedFallback) {
      fallbackTreatmentIds.push(treatment.id)
    }

    return result.treatment

  })

  return { treatments: migratedTreatments, changed, fallbackTreatmentIds }

}

/*
  SAVED TREATMENT patientName MIGRATION - ORPHAN REMOVAL VARIANT

  Saved treatments get stricter handling than incomplete/active ones
  above: a saved treatment is a permanent history record that's part of
  the cloud-synchronized dataset, so a fabricated "Unknown Patient"
  name is not an acceptable long-term state for it - unlike the
  fallback name, which only exists to keep a broken local-only record
  from crashing the app. If a saved treatment's patientId doesn't
  resolve to any currently-existing patient (the patient was deleted,
  or the id was never valid), the treatment is removed outright and
  tombstoned (entityType: 'treatment') so the deletion is honest,
  propagates through cloud sync, and the record can never silently
  reappear via a merge with another device's older copy of it.

  IMPORTANT: a saved treatment whose patientName is exactly
  UNKNOWN_PATIENT_NAME_FALLBACK is treated the SAME as one with no
  patientName at all, not as "already fine." An earlier build of this
  app's migration only renamed orphaned saved treatments to that
  placeholder instead of removing them - any treatment that already
  went through that older logic and got persisted with that literal
  string would otherwise look like a perfectly valid string here
  (non-empty, a real string) and be silently kept forever, never
  reaching the removal/tombstone path below. Checking for the sentinel
  value explicitly lets this migration self-heal that already-persisted
  state too, not just a genuinely-missing patientName. (The one
  theoretical false positive - a real patient actually named literally
  "Unknown Patient" - is accepted as a vanishingly unlikely tradeoff.)
*/

function migrateSavedTreatmentPatientNames(
  treatments: SavedTreatment[],
  patients: Patient[]
): {
  treatments: SavedTreatment[]
  changed: boolean
  orphanedTreatmentIds: string[]
} {

  const patientsById = new Map(patients.map(patient => [patient.id, patient]))

  let changed = false
  const orphanedTreatmentIds: string[] = []
  const survivingTreatments: SavedTreatment[] = []

  for (const treatment of treatments) {

    if (
      typeof treatment.patientName === 'string' &&
      treatment.patientName.trim() !== '' &&
      treatment.patientName !== UNKNOWN_PATIENT_NAME_FALLBACK
    ) {
      survivingTreatments.push(treatment)
      continue
    }

    changed = true

    const matchedPatient = patientsById.get(treatment.patientId)

    if (matchedPatient) {
      survivingTreatments.push({ ...treatment, patientName: matchedPatient.name })
      continue
    }

    orphanedTreatmentIds.push(treatment.id)

  }

  return { treatments: survivingTreatments, changed, orphanedTreatmentIds }

}

/*
  CROSS-TAB SAFE PATIENT CREATION

  ToothTarget has no server - two tabs of the same origin (eg. the
  same iPad open twice) share the exact same localStorage. Without
  protection, both tabs could read the same stale nextPatientNumber,
  both hand it to a different new patient, and whichever tab writes
  toothTargetPatients second would silently discard the first tab's
  new patient entirely. allocatePatient() is the one and only place a
  new patientNumber is ever handed out (see openPatient() below) -
  everything it needs (the current patient list, the current
  counter) is re-read from localStorage itself, never from React
  state, and the whole read-check-write sequence runs inside a Web
  Locks API request keyed by a fixed, same-origin lock name. The
  Locks API queues concurrent requests for the same name across every
  tab/window of this origin, so two tabs calling this at the same
  time are guaranteed to run one fully after the other - never
  interleaved - which is what actually prevents two tabs from ever
  computing the same "next" number. Falls back to running
  unprotected only if a browser genuinely lacks the Locks API.
*/

/*
  DELETION TOMBSTONES - PERSISTENCE

  Shared by patient deletion and custom-template deletion below.
  readPersistedTombstones() always re-reads localStorage directly
  (never React state) so it reflects whatever the most recent write -
  from this tab or another - actually persisted. appendTombstone()
  does the full "re-read current list, skip if an equivalent
  tombstone already exists, otherwise append and write back" sequence
  in one place, so both deletion paths call the exact same logic
  rather than each re-implementing their own idempotency check.
*/

const DELETION_TOMBSTONES_KEY = 'toothTargetDeletionTombstones'

function readPersistedTombstones(): DeletionTombstone[] {

  try {

    const raw = localStorage.getItem(DELETION_TOMBSTONES_KEY)

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed.filter(isValidTombstone) : []

  } catch {

    return []

  }

}

function hasTombstoneFor(
  tombstones: DeletionTombstone[],
  entityType: DeletionTombstone['entityType'],
  entityId: string
): boolean {

  return tombstones.some(
    tombstone =>
      tombstone.entityType === entityType &&
      tombstone.entityId === entityId
  )

}

function appendTombstone(
  entityType: DeletionTombstone['entityType'],
  entityId: string
): DeletionTombstone[] {

  const currentTombstones = readPersistedTombstones()

  if (hasTombstoneFor(currentTombstones, entityType, entityId)) {
    return currentTombstones
  }

  const newTombstone: DeletionTombstone = {
    id: crypto.randomUUID(),
    entityType,
    entityId,
    deletedAt: new Date().toISOString(),
  }

  const updatedTombstones = [...currentTombstones, newTombstone]

  localStorage.setItem(
    DELETION_TOMBSTONES_KEY,
    JSON.stringify(updatedTombstones)
  )

  return updatedTombstones

}

/*
  CUSTOM TEMPLATE updatedAt MIGRATION (cloud sync foundation, Phase 2)

  Existing templates saved before ProcedureTemplate.updatedAt existed
  won't have it yet. Nothing else in a template's record (id, name,
  phases) carries any timestamp a real historical edit time could be
  recovered from, so a missing/invalid updatedAt is stamped with the
  current migration time - an honest "first time this field existed"
  value, never a fabricated edit history. A template that already
  carries a valid, non-empty updatedAt string is returned completely
  untouched, so re-running this on every load never overwrites a real
  prior edit time - id, name, isCustom, phases and every other field
  are always copied through unchanged either way.
*/

/*
  Shared by both this template migration and migratePatientTimestamps()
  above (Phase 8) - a generic "is this a real, non-empty timestamp
  string" check, not specific to either entity.
*/
function isValidUpdatedAtTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function migrateTemplateTimestamps(
  templates: ProcedureTemplate[]
): { templates: ProcedureTemplate[]; changed: boolean } {

  let changed = false

  const migratedTemplates = templates.map(template => {

    if (isValidUpdatedAtTimestamp(template.updatedAt)) {
      return template
    }

    changed = true

    return { ...template, updatedAt: new Date().toISOString() }

  })

  return { templates: migratedTemplates, changed }

}

function readPersistedTemplates(): ProcedureTemplate[] {

  try {

    const raw = localStorage.getItem('toothTargetTemplates')

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed : []

  } catch {

    return []

  }

}

/*
  CUSTOM PROCEDURE updatedAt MIGRATION (Phase 5.5)

  Exactly mirrors migrateTemplateTimestamps() above, for the identical
  reason: existing procedures saved before Procedure.updatedAt existed
  won't have it yet, and nothing else in a procedure's record (id,
  name, isCustom, templateId, regionTemplateIds) carries any timestamp
  a real historical edit time could be recovered from, so a missing/
  invalid updatedAt is stamped with the current migration time - an
  honest "first time this field existed" value, never a fabricated
  edit history. A procedure that already carries a valid, non-empty
  updatedAt string is returned completely untouched, so re-running this
  on every load never overwrites a real prior edit time.
*/
function migrateProcedureTimestamps(
  procedures: Procedure[]
): { procedures: Procedure[]; changed: boolean } {

  let changed = false

  const migratedProcedures = procedures.map(procedure => {

    if (isValidUpdatedAtTimestamp(procedure.updatedAt)) {
      return procedure
    }

    changed = true

    return { ...procedure, updatedAt: new Date().toISOString() }

  })

  return { procedures: migratedProcedures, changed }

}

function readPersistedProcedures(): Procedure[] {

  try {

    const raw = localStorage.getItem('toothTargetProcedures')

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed : []

  } catch {

    return []

  }

}

const PATIENT_ALLOCATION_LOCK_NAME = 'toothtarget-patient-allocation'

type PatientAllocationResult = {
  patients: Patient[]
  patient: Patient
  nextPatientNumber: number
  /*
    True only when this call actually created a brand-new patient
    record (never for the find-existing-by-name case) - lets callers
    (see openPatient() below) request a cloud sync exactly when the
    synchronized patient registry actually changed, not on every
    "open a patient" call.
  */
  created: boolean
}

function readPersistedPatients(): Patient[] {

  try {

    const raw = localStorage.getItem('toothTargetPatients')

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed.filter(isValidPatient) : []

  } catch {

    return []

  }

}

function readPersistedNextPatientNumber(): number {

  try {

    const raw = localStorage.getItem('toothTargetNextPatientNumber')

    return raw
      ? readStoredPatientNumber(JSON.parse(raw)) ?? 1
      : 1

  } catch {

    return 1

  }

}

/*
  FRESH TREATMENT READS FOR PATIENT DELETION

  Deleting a patient also needs to remove that patient's treatments
  from toothTargetSavedTreatments/toothTargetIncompleteTreatments/
  toothTargetActiveTreatment. Re-reading each fresh from localStorage
  immediately before filtering+writing (rather than trusting this
  tab's own savedTreatments/incompleteTreatments/activeTreatment
  state, which could be stale) narrows the window where another tab's
  newer treatment write could otherwise be silently overwritten by
  this one. This is a lightweight trust-the-shape read (consistent
  with how this same data is already trusted once already migrated
  this session) - not the full legacy-shape migration the initial
  load effect performs, which only ever needs to run once per app
  open.
*/

function readPersistedSavedTreatments(): SavedTreatment[] {

  try {

    const raw = localStorage.getItem('toothTargetSavedTreatments')

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed : []

  } catch {

    return []

  }

}

function readPersistedIncompleteTreatments(): ActiveTreatment[] {

  try {

    const raw = localStorage.getItem('toothTargetIncompleteTreatments')

    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw)

    return Array.isArray(parsed) ? parsed : []

  } catch {

    return []

  }

}

function readPersistedActiveTreatment(): ActiveTreatment | null {

  try {

    const raw = localStorage.getItem('toothTargetActiveTreatment')

    return raw ? JSON.parse(raw) ?? null : null

  } catch {

    return null

  }

}

/*
  Finds-or-creates cleanName in the CURRENT persisted patient list
  (re-read fresh, not from React state) and, only when actually
  creating one, allocates the next safe number and persists both
  updated values before returning - so by the time this resolves, the
  allocation is already durably saved, not just decided.

  PHASE 4.6 - DYNAMIC NUMBERING: the new number is now computed purely
  as highestAssignedPatientNumber + 1, never Math.max()'d against the
  stored toothTargetNextPatientNumber counter. Now that a patient's
  number can be edited directly (see editPatientRecordUnderLock()
  below), that counter can drift arbitrarily far behind reality - eg.
  editing a patient up to #74 while the counter is still sitting at
  #10 - and trusting it as a floor would let a freshly-created patient
  collide with (or fall behind) numbers that already exist. The live
  patient list is the only value that can never be stale, so it's now
  the only thing this reads. See this phase's own report for why the
  stored counter is still written below rather than removed outright.
*/
function allocatePatientUnderLock(cleanName: string): PatientAllocationResult {

  const currentPatients = readPersistedPatients()

  const existingPatient =
    currentPatients.find(patient => patient.name === cleanName)

  if (existingPatient) {

    return {
      patients: currentPatients,
      patient: existingPatient,
      nextPatientNumber: readPersistedNextPatientNumber(),
      created: false,
    }

  }

  const safeNumber = computeNextPatientNumber(currentPatients)

  const createdAt = new Date().toISOString()

  const newPatient: Patient = {
    id: crypto.randomUUID(),
    patientNumber: safeNumber,
    name: cleanName,
    createdAt,
    updatedAt: createdAt,
  }

  const updatedPatients = [...currentPatients, newPatient]
  const updatedNextPatientNumber = safeNumber + 1

  localStorage.setItem(
    'toothTargetPatients',
    JSON.stringify(updatedPatients)
  )

  /*
    Kept as a best-effort, non-authoritative hint only - nothing reads
    this to decide a number anymore (see this function's own comment
    above), but it costs nothing to keep writing it, and removing the
    key entirely would also mean touching cloudSyncEngine.ts's
    per-account cache format (Phase 4), which already carries this
    same value for a different, still-legitimate reason (restoring a
    previously-seen account's own counter alongside the rest of its
    local state) - not worth disturbing for a value that's otherwise
    harmless to keep.
  */
  localStorage.setItem(
    'toothTargetNextPatientNumber',
    JSON.stringify(updatedNextPatientNumber)
  )

  return {
    patients: updatedPatients,
    patient: newPatient,
    nextPatientNumber: updatedNextPatientNumber,
    created: true,
  }

}

async function allocatePatient(
  cleanName: string
): Promise<PatientAllocationResult> {

  if (
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    navigator.locks
  ) {

    return navigator.locks.request(
      PATIENT_ALLOCATION_LOCK_NAME,
      () => allocatePatientUnderLock(cleanName)
    )

  }

  /*
    No Web Locks API available - proceed unprotected rather than
    blocking patient creation entirely. Still safe for the normal
    single-tab case; only the specific two-tabs-at-once race this
    feature targets goes unprotected here.
  */

  return allocatePatientUnderLock(cleanName)

}

/*
  CROSS-TAB SAFE PATIENT DELETION

  Removes one patient (identified by their stable UUID, never by
  name) from the CURRENT persisted registry - re-read fresh from
  localStorage here, not from React state, and done under the exact
  same lock allocatePatient() uses above, so a delete in one tab can
  never race a create (or another delete) in another tab and silently
  clobber it. Only ever filters the freshly-read list by id; it never
  touches toothTargetNextPatientNumber or any other patient's own
  fields, so numbers stay permanent and are never reused.

  Also records a deletion tombstone for the same patient UUID, inside
  the same lock and the same fresh-read - so the tombstone write can
  never race a concurrent delete/create either. appendTombstone()
  itself is idempotent (skips if a tombstone for this entityId
  already exists), so deleting an already-tombstoned patient again
  (eg. a stale second click, or two tabs both requesting the same
  delete) never creates a duplicate.
*/

type PatientDeletionResult = {
  patients: Patient[]
  tombstones: DeletionTombstone[]
  /*
    True only when this call actually removed a patient (and recorded
    its tombstone) - false for the "already gone" no-op case (eg.
    another tab deleted it first). Lets confirmDeletePatient() below
    request a cloud sync only when the synchronized state genuinely
    changed.
  */
  deleted: boolean
}

function removePatientFromCurrentList(
  patientId: string
): PatientDeletionResult {

  const currentPatients = readPersistedPatients()

  const patientExists =
    currentPatients.some(patient => patient.id === patientId)

  /*
    Already gone (eg. another tab already deleted this exact patient)
    - nothing left to remove or tombstone. Still returns the current
    tombstones so the caller can keep its own state in sync.
  */

  if (!patientExists) {

    return {
      patients: currentPatients,
      tombstones: readPersistedTombstones(),
      deleted: false,
    }

  }

  const updatedPatients =
    currentPatients.filter(patient => patient.id !== patientId)

  localStorage.setItem(
    'toothTargetPatients',
    JSON.stringify(updatedPatients)
  )

  const updatedTombstones = appendTombstone('patient', patientId)

  return {
    patients: updatedPatients,
    tombstones: updatedTombstones,
    deleted: true,
  }

}

async function deletePatientFromRegistry(
  patientId: string
): Promise<PatientDeletionResult> {

  if (
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    navigator.locks
  ) {

    return navigator.locks.request(
      PATIENT_ALLOCATION_LOCK_NAME,
      () => removePatientFromCurrentList(patientId)
    )

  }

  /*
    No Web Locks API available - proceed unprotected, same fallback
    allocatePatient() above uses.
  */

  return removePatientFromCurrentList(patientId)

}

/*
  CROSS-TAB SAFE PATIENT EDIT (Phase 4.6)

  Edits an existing patient's name and/or patientNumber in place -
  same fresh-read-under-lock pattern as allocation/deletion above, so
  an edit can never race a create/delete/another edit in a different
  tab. id and createdAt are never touched by this (createdAt is
  permanent from the moment a patient is created - see the Patient
  type's own comment); updatedAt IS refreshed, the same "any
  intentional content change bumps updatedAt" principle
  patientNumberConflicts.ts's own conflict resolution already follows.

  A collision with another patient's number is NOT blocked - the edit
  is allowed to proceed, and the collision is recorded as a genuine
  PatientNumberConflict via recordAndReconcilePatientNumberConflicts(),
  reusing the exact same detect-and-record pattern a cloud merge
  already uses for the same situation (two devices independently
  assigning the same number), rather than inventing separate
  edit-specific conflict handling. The dentist resolves it afterward
  through the existing conflict-browser UI, same as any other
  patient-number conflict.
*/

export type PatientEditResult =
  | {
      edited: true
      patients: Patient[]
      conflicts: PatientNumberConflict[]
      /*
        Only present when the name actually changed - see the
        renamedSavedTreatments comment inside
        editPatientRecordUnderLock() below. Absent (rather than an
        empty array) for a number-only edit or a genuine no-op, so the
        caller can tell "nothing to apply" apart from "renamed zero
        treatments because this patient happens to have none".
      */
      renamedSavedTreatments?: SavedTreatment[]
    }
  | { edited: false; reason: string; patients: Patient[] }

function editPatientRecordUnderLock(
  patientId: string,
  newName: string,
  newPatientNumber: number
): PatientEditResult {

  const currentPatients = readPersistedPatients()

  const existingPatient =
    currentPatients.find(patient => patient.id === patientId)

  if (!existingPatient) {

    return {
      edited: false,
      reason:
        'This patient no longer exists - it may have already been deleted.',
      patients: currentPatients,
    }

  }

  const cleanName = newName.trim()

  if (cleanName === '') {

    return {
      edited: false,
      reason: 'Patient name cannot be empty.',
      patients: currentPatients,
    }

  }

  if (!Number.isInteger(newPatientNumber) || newPatientNumber <= 0) {

    return {
      edited: false,
      reason: 'Patient number must be a positive whole number.',
      patients: currentPatients,
    }

  }

  if (
    existingPatient.name === cleanName &&
    existingPatient.patientNumber === newPatientNumber
  ) {

    return {
      edited: true,
      patients: currentPatients,
      conflicts: readPersistedPatientNumberConflicts(),
    }

  }

  const nowIso = new Date().toISOString()

  const updatedPatients =
    currentPatients.map(patient =>
      patient.id === patientId
        ? {
            ...patient,
            name: cleanName,
            patientNumber: newPatientNumber,
            updatedAt: nowIso,
          }
        : patient
    )

  localStorage.setItem(
    'toothTargetPatients',
    JSON.stringify(updatedPatients)
  )

  const detectedConflict =
    detectPatientNumberConflict(updatedPatients, newPatientNumber)

  const conflicts =
    recordAndReconcilePatientNumberConflicts(
      detectedConflict ? [detectedConflict] : [],
      updatedPatients
    )

  /*
    RENAME CASCADE (Phase 4.6, Part E)

    A patient's saved treatments each carry a denormalized snapshot of
    the patient's name (patientName), taken at treatment-save time
    rather than looked up live - so a name edit here has to walk this
    patient's own treatments and update that snapshot too, or history
    would keep showing the old name. Only runs when the NAME actually
    changed (a number-only edit leaves every treatment's patientName
    and updatedAt untouched) - see patientRenameCascade.ts's own
    header comment for why updatedAt is bumped on every treatment this
    touches.
  */

  const renamedSavedTreatments =
    existingPatient.name === cleanName
      ? undefined
      : applyPatientRenameToSavedTreatments(
          readPersistedSavedTreatments(),
          patientId,
          cleanName,
          nowIso
        )

  if (renamedSavedTreatments) {

    localStorage.setItem(
      'toothTargetSavedTreatments',
      JSON.stringify(renamedSavedTreatments)
    )

  }

  return {
    edited: true,
    patients: updatedPatients,
    conflicts,
    renamedSavedTreatments,
  }

}

async function editPatientRecord(
  patientId: string,
  newName: string,
  newPatientNumber: number
): Promise<PatientEditResult> {

  if (
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    navigator.locks
  ) {

    return navigator.locks.request(
      PATIENT_ALLOCATION_LOCK_NAME,
      () => editPatientRecordUnderLock(patientId, newName, newPatientNumber)
    )

  }

  /*
    No Web Locks API available - proceed unprotected, same fallback
    allocatePatient() above uses.
  */

  return editPatientRecordUnderLock(patientId, newName, newPatientNumber)

}

/*
  CROSS-TAB SAFE CUSTOM TEMPLATE DELETION

  Mirrors the patient-deletion approach immediately above, under its
  own lock name (a template deletion has nothing to do with patient
  allocation, so sharing that lock would just serialize two unrelated
  operations against each other for no benefit - a dedicated lock
  keeps each concern independent while still being fully protected
  against its own kind of concurrent write). Only ever removes a
  template that is BOTH found in the current persisted list AND
  isCustom === true - a built-in template (or a template that's
  somehow already gone) is left completely untouched, and no
  tombstone is created for it either, matching the existing UI (no
  delete button is ever shown for a built-in template).
*/

const TEMPLATE_DELETION_LOCK_NAME = 'toothtarget-template-deletion'

type TemplateDeletionResult = {
  templates: ProcedureTemplate[]
  tombstones: DeletionTombstone[]
  /*
    True only when a custom template was actually removed (and its
    tombstone recorded) - false for the "not found / not custom"
    no-op case. Lets confirmDeleteTemplate() below request a cloud
    sync only when the synchronized state genuinely changed.
  */
  deleted: boolean
}

function removeTemplateFromCurrentList(
  templateId: string
): TemplateDeletionResult {

  const currentTemplates = readPersistedTemplates()

  const templateToDelete =
    currentTemplates.find(template => template.id === templateId)

  if (!templateToDelete || templateToDelete.isCustom !== true) {

    return {
      templates: currentTemplates,
      tombstones: readPersistedTombstones(),
      deleted: false,
    }

  }

  const updatedTemplates =
    currentTemplates.filter(template => template.id !== templateId)

  localStorage.setItem(
    'toothTargetTemplates',
    JSON.stringify(updatedTemplates)
  )

  const updatedTombstones =
    appendTombstone('procedureTemplate', templateId)

  return {
    templates: updatedTemplates,
    tombstones: updatedTombstones,
    deleted: true,
  }

}

async function deleteTemplateFromRegistry(
  templateId: string
): Promise<TemplateDeletionResult> {

  if (
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    navigator.locks
  ) {

    return navigator.locks.request(
      TEMPLATE_DELETION_LOCK_NAME,
      () => removeTemplateFromCurrentList(templateId)
    )

  }

  return removeTemplateFromCurrentList(templateId)

}

/*
  CROSS-TAB SAFE CUSTOM PROCEDURE DELETION (Phase 5.5)

  Mirrors CROSS-TAB SAFE CUSTOM TEMPLATE DELETION immediately above,
  under its own lock name, for the identical reason a dedicated
  template-deletion lock exists rather than reusing the patient one.
  Only ever removes a procedure that is BOTH found in the current
  persisted list AND isCustom === true - a built-in procedure (or a
  procedure that's somehow already gone) is left completely untouched,
  and no tombstone is created for it either, matching the UI (no
  delete button is ever shown for a built-in procedure - see the
  procedureSelect screen below).

  CRITICAL: this only ever removes the Procedure record itself from
  toothTargetProcedures and records a tombstone for that UUID - it
  never reads, filters, or writes toothTargetSavedTreatments in any
  way. A past treatment's procedureName/procedureId is a snapshot taken
  once, at the moment the treatment was started (see startTreatment()
  below), never re-resolved against the live procedures list, so
  deleting a procedure can never change what an already-completed
  treatment shows - it only removes that procedure from the list
  offered when starting a NEW treatment (procedureSelect maps over
  `procedures`, which this function's caller updates via setProcedures()
  after a successful delete).
*/

const PROCEDURE_DELETION_LOCK_NAME = 'toothtarget-procedure-deletion'

type ProcedureDeletionResult = {
  procedures: Procedure[]
  tombstones: DeletionTombstone[]
  /*
    True only when a custom procedure was actually removed (and its
    tombstone recorded) - false for the "not found / not custom"
    no-op case. Lets confirmDeleteProcedure() below request a cloud
    sync only when the synchronized state genuinely changed.
  */
  deleted: boolean
}

function removeProcedureFromCurrentList(
  procedureId: string
): ProcedureDeletionResult {

  const currentProcedures = readPersistedProcedures()

  const procedureToDelete =
    currentProcedures.find(procedure => procedure.id === procedureId)

  if (!procedureToDelete || procedureToDelete.isCustom !== true) {

    return {
      procedures: currentProcedures,
      tombstones: readPersistedTombstones(),
      deleted: false,
    }

  }

  const updatedProcedures =
    currentProcedures.filter(procedure => procedure.id !== procedureId)

  localStorage.setItem(
    'toothTargetProcedures',
    JSON.stringify(updatedProcedures)
  )

  const updatedTombstones =
    appendTombstone('procedure', procedureId)

  return {
    procedures: updatedProcedures,
    tombstones: updatedTombstones,
    deleted: true,
  }

}

async function deleteProcedureFromRegistry(
  procedureId: string
): Promise<ProcedureDeletionResult> {

  if (
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    navigator.locks
  ) {

    return navigator.locks.request(
      PROCEDURE_DELETION_LOCK_NAME,
      () => removeProcedureFromCurrentList(procedureId)
    )

  }

  return removeProcedureFromCurrentList(procedureId)

}

function App() {

  const [screen, setScreen] = useState<
    | 'home'
    | 'patient'
    | 'procedureSelect'
    | 'toothSelect'
    | 'timer'
    | 'manageTemplates'
    | 'templateEditor'
    | 'treatmentSummary'
    | 'treatmentDetail'
    | 'statistics'
    | 'treatmentSearch'
    | 'settings'
    | 'staleReview'
  >('home')

  const [patientSearch, setPatientSearch] = useState('')

  const [treatmentSearchQuery, setTreatmentSearchQuery] = useState('')

  const [selectedPatient, setSelectedPatient] = useState('')

  const [selectedToothId, setSelectedToothId] = useState<string | null>(null)

  /*
    CHAIR TIME (Phase 16)

    Captured before the treatment officially exists - the dentist
    can mark it the moment the patient sits down, ahead of Start
    Treatment - then handed off into the new ActiveTreatment once
    startTreatment() runs. Reset whenever a fresh New Treatment flow
    begins so it can never leak into an unrelated treatment.
  */

  const [pendingChairEnteredAt, setPendingChairEnteredAt] =
    useState<string | null>(null)

  const [activeTreatment, setActiveTreatment] =
    useState<ActiveTreatment | null>(null)

  /*
    TREATMENT LIFECYCLE (Phase 10)

    incompleteTreatments holds treatments the dentist parked via
    "Save as Incomplete" - same ActiveTreatment shape, just not the
    one currently ticking. showResumePrompt is the one-time-per-app-
    open "Active Treatment Found" dialog. discardTarget identifies
    what a pending discard confirmation would remove: the current
    active treatment, or one specific parked incomplete entry by id.
  */

  const [incompleteTreatments, setIncompleteTreatments] =
    useState<ActiveTreatment[]>([])

  const [showResumePrompt, setShowResumePrompt] =
    useState(false)

  const [showEndTreatmentModal, setShowEndTreatmentModal] =
    useState(false)

  const [discardTarget, setDiscardTarget] =
    useState<{ incompleteId: string } | 'active' | null>(null)

const [savedTreatments, setSavedTreatments] =
  useState<SavedTreatment[]>([])

const [savedPatients, setSavedPatients] =
  useState<Patient[]>([])

/*
  PATIENT-NUMBER CONFLICTS (Phase 4)

  Unlike tombstones/nextPatientNumber below, this DOES need React
  state: the whole point of this phase is to display an unresolved-
  conflict badge and let the dentist act on it, so a value that's
  only ever written and never rendered doesn't apply here. Always
  kept in sync with toothTargetPatientNumberConflicts via
  reconcileAndPersistPatientNumberConflicts() (load, and after this
  tab changes the registry) and the storage-event listener below (for
  changes made by another tab).
*/

const [patientNumberConflicts, setPatientNumberConflicts] =
  useState<PatientNumberConflict[]>([])

const [showConflictBrowser, setShowConflictBrowser] = useState(false)

const [conflictKeepChoice, setConflictKeepChoice] = useState<{
  patientNumber: number
  keepPatientId: string
} | null>(null)

const [conflictResolutionError, setConflictResolutionError] =
  useState<string | null>(null)

/*
  STALE-RECORD REVIEW (Phase 4.7)

  pendingStaleReview itself is owned by cloudSyncScheduler.ts (see that
  file's own pendingStaleReview store) - read here the same
  useSyncExternalStore pattern SyncStatusIndicator.tsx/
  StartupGateScreen.tsx already use for that module's status store, so
  this component always reflects the current candidate list, including
  one set from a sync that happened before this component even mounted.

  staleReviewDecidedIds is this tab's own in-session bookkeeping of
  which candidates the dentist has already decided (kept, or discarded
  - a discard also removes the patient from savedPatients entirely, so
  its own absence there would work too, but tracking ids explicitly
  here keeps "kept" and "discarded" visually indistinguishable from the
  review screen's own point of view: both simply leave the list).
  Deliberately NOT persisted anywhere - if the dentist leaves mid-review
  and the app reloads, the next sync attempt recomputes candidates fresh
  from current local/cloud state and the review starts over, which is
  simpler and safer than trying to resurrect a partial decision set
  across a reload (see cloudSyncEngine.ts's own comment on why "kept"
  decisions aren't persisted either).
*/

const pendingStaleReview = useSyncExternalStore(
  subscribePendingStaleReview,
  getPendingStaleReview
)

const [staleReviewDecidedIds, setStaleReviewDecidedIds] =
  useState<Set<string>>(new Set())

const [staleReviewDiscardTargetId, setStaleReviewDiscardTargetId] =
  useState<string | null>(null)

const [staleReviewActionError, setStaleReviewActionError] =
  useState<string | null>(null)

/*
  True only while the dentist is viewing a patient's full record FROM
  the review screen (requirement 5) - lets the Patient screen's own
  BackButton return to the review screen instead of Home, without
  touching backToHome() itself (used from many other places, all of
  which should keep going to Home exactly as before).
*/
const [staleReviewReturnActive, setStaleReviewReturnActive] =
  useState(false)

/*
  Like toothTargetNextPatientNumber below, deletion tombstones are
  deliberately NOT kept in React state either - nothing displays them
  yet (no cloud merge/UI consumes them in this task), so a state that
  only ever gets written and never read would be dead weight (the
  same reasoning that removed nextPatientNumber from state earlier).
  readPersistedTombstones()/appendTombstone() (above App()) are
  always called fresh at the moment they're actually needed - by
  confirmDeletePatient()/confirmDeleteTemplate(), and by the storage-
  event listener below, which still validates a cross-tab tombstone
  write but has no state to reconcile it into.
*/

/*
  toothTargetNextPatientNumber itself is deliberately NOT kept in
  React state - allocatePatient() (below App()) always re-reads it
  fresh from localStorage at the moment a new patient is actually
  created, under a cross-tab lock, rather than trusting a cached
  copy (see openPatient()). A React-state copy would only ever be
  read here for display, and nothing currently displays it.
*/

  const [procedures, setProcedures] =
    useState<Procedure[]>(BUILTIN_PROCEDURES)

  const [templates, setTemplates] =
    useState<ProcedureTemplate[]>(BUILTIN_TEMPLATES)

  const [selectedProcedure, setSelectedProcedure] =
    useState<Procedure | null>(null)

  const [showAddProcedure, setShowAddProcedure] =
    useState(false)

  const [newProcedureName, setNewProcedureName] =
    useState('')

  /*
    EDIT / DELETE PROCEDURE (Phase 5.5)

    Same shape as the template row's own edit/delete UI state -
    editProcedureId doubles as "is the edit modal open" (null means
    closed), deleteProcedureConfirmId likewise for the delete-confirm
    modal, both mirroring deleteTemplateConfirmId below.
  */

  const [editProcedureId, setEditProcedureId] =
    useState<string | null>(null)

  const [editProcedureName, setEditProcedureName] =
    useState('')

  const [editProcedureError, setEditProcedureError] =
    useState<string | null>(null)

  const [deleteProcedureConfirmId, setDeleteProcedureConfirmId] =
    useState<string | null>(null)

  const [showDeleteConfirm, setShowDeleteConfirm] =
    useState(false)

  const [deletePatientBlockedReason, setDeletePatientBlockedReason] =
    useState<string | null>(null)

  /*
    EDIT PATIENT (Phase 4.6)
  */

  const [showEditPatient, setShowEditPatient] =
    useState(false)

  const [editPatientName, setEditPatientName] =
    useState('')

  const [editPatientNumberInput, setEditPatientNumberInput] =
    useState('')

  const [editPatientError, setEditPatientError] =
    useState<string | null>(null)

  const [editPatientBusy, setEditPatientBusy] =
    useState(false)

  const [editingTemplateId, setEditingTemplateId] =
    useState<string | null>(null)

  const [templateDraft, setTemplateDraft] =
    useState<TemplateDraft | null>(null)

  const [duplicateTemplateWarning, setDuplicateTemplateWarning] =
    useState<ProcedureTemplate | null>(null)

  const [showRestoreDefaultConfirm, setShowRestoreDefaultConfirm] =
    useState(false)

  /*
    TEMPLATE BROWSER (Specialization -> Procedure -> Type -> Templates)

    Local drill-down position within the Manage Templates screen.
    All three null = the top-level specialization list. Reset
    whenever the screen is (re)entered from Home via
    openManageTemplates() so it never resumes mid-drill-down from a
    previous visit.
  */

  const [templateBrowseSpecializationId, setTemplateBrowseSpecializationId] =
    useState<string | null>(null)

  const [templateBrowseProcedureKey, setTemplateBrowseProcedureKey] =
    useState<string | null>(null)

  const [templateBrowseTypeId, setTemplateBrowseTypeId] =
    useState<string | null>(null)

  const [deleteTemplateConfirmId, setDeleteTemplateConfirmId] =
    useState<string | null>(null)

  const [lastCompletedTreatment, setLastCompletedTreatment] =
    useState<SavedTreatment | null>(null)

  const [selectedHistoryTreatment, setSelectedHistoryTreatment] =
    useState<SavedTreatment | null>(null)

  /*
    DELETE / EDIT SAVED TREATMENT (Phase 4.6)
  */

  const [showDeleteTreatmentConfirm, setShowDeleteTreatmentConfirm] =
    useState(false)

  const [showEditTreatmentPhases, setShowEditTreatmentPhases] =
    useState(false)

  const [editPhaseMinutes, setEditPhaseMinutes] =
    useState<string[]>([])

  const [customNoteText, setCustomNoteText] = useState('')

  const [customInterruptionText, setCustomInterruptionText] = useState('')

  /*
    TREATMENT OPTIONS MENU (Phase 11)

    The less-frequently-used timer actions (add/skip/restart phase,
    notes, interruptions, reset, end treatment) live behind this one
    menu instead of cluttering the primary timer view. optionsView
    switches which panel the menu modal shows; it's reset to 'menu'
    whenever the modal is opened/closed so it never reopens showing
    a stale sub-view.
  */

  const [showOptionsMenu, setShowOptionsMenu] =
    useState(false)

  const [optionsView, setOptionsView] =
    useState<
      | 'menu'
      | 'addPhase'
      | 'addNote'
      | 'addInterruption'
      | 'tags'
    >('menu')

  const [newPhaseName, setNewPhaseName] =
    useState('')

  const [newPhaseMinutes, setNewPhaseMinutes] =
    useState('5')

  /*
    DATA EXPORT & BACKUP (Phase 14)

    pendingImportData holds the parsed backup file waiting on the
    confirmation modal - nothing touches localStorage until the
    dentist explicitly confirms, so a wrong file pick can never
    silently overwrite real data.
  */

  const importFileInputRef = useRef<HTMLInputElement | null>(null)

  const [importError, setImportError] =
    useState<string | null>(null)

  const [pendingImportSummary, setPendingImportSummary] =
    useState<string | null>(null)

  const [pendingImportData, setPendingImportData] =
    useState<Record<string, unknown> | null>(null)

  /*
    LOAD SAVED DATA
  */

  useEffect(() => {

    /*
      PATIENT ID MIGRATION (Stage 1 - data model only)

      toothTargetSavedTreatments/toothTargetIncompleteTreatments/
      toothTargetActiveTreatment/toothTargetPatients are all shaped
      per-key exactly as before below (every existing legacy fallback
      untouched) - each result is captured into a local variable
      instead of being applied via setState immediately, so that once
      all four are available, migratePatientIdentity() can run a
      single cross-cutting pass over all of them together before
      anything is committed to React state or localStorage. See
      migratePatientIdentity() for why this has to see all of them at
      once rather than migrating toothTargetPatients in isolation.
    */

    let shapedSavedTreatments: SavedTreatment[] = []
    let rawPatients: unknown = undefined
    let rawNextPatientNumber: unknown = undefined
    let shapedActiveTreatment: ActiveTreatment | null = null
    let shapedIncompleteTreatments: ActiveTreatment[] = []
    let shapedProcedures: Procedure[] = BUILTIN_PROCEDURES
    let shapedTemplates: ProcedureTemplate[] = BUILTIN_TEMPLATES

    const saved =
      localStorage.getItem(
        'toothTargetSavedTreatments'
      )

    if (saved) {

      try {

        const parsed = JSON.parse(saved)

        if (Array.isArray(parsed)) {

          shapedSavedTreatments =
            parsed.map(treatment => {

              /*
                Treatments saved before the Procedure
                Templates / Treatment Data Foundation
                features won't have every field yet -
                fall back safely so old history keeps
                working and gets a reasonable, honest
                (not fabricated) record shape.
              */

              const phases: TemplatePhase[] =
                Array.isArray(treatment.phases) &&
                treatment.phases.length > 0
                  ? treatment.phases
                  : DEFAULT_GENERAL_PHASES.map(
                      phase => ({ ...phase })
                    )

              const actualTimes: number[] =
                Array.isArray(treatment.actualTimes) &&
                treatment.actualTimes.length === phases.length
                  ? treatment.actualTimes
                  : phases.map(() => 0)

              const procedureName =
                typeof treatment.procedureName === 'string'
                  ? treatment.procedureName
                  : 'General'

              /*
                Treatments saved before the Visual Tooth Selection
                phase stored an arbitrary "tooth" text field instead
                of a standardized toothId - resolve it once.
              */

              const toothId =
                typeof treatment.toothId === 'string' &&
                treatment.toothId !== ''
                  ? treatment.toothId
                  : resolveLegacyToothId(treatment.tooth ?? '')

              const phaseMetaFallback =
                buildPhaseMetaFallback(
                  phases.length,
                  phases.length - 1,
                  true
                )

              const phaseRecords =
                Array.isArray(treatment.phaseRecords) &&
                treatment.phaseRecords.length === phases.length
                  ? treatment.phaseRecords
                  : buildPhaseRecords(
                      phases,
                      actualTimes,
                      phaseMetaFallback
                    )

              const totalExpectedDuration =
                typeof treatment.totalExpectedDuration === 'number'
                  ? treatment.totalExpectedDuration
                  : phases.reduce(
                      (total, phase) => total + phase.duration,
                      0
                    )

              const totalActualDuration =
                typeof treatment.totalActualDuration === 'number'
                  ? treatment.totalActualDuration
                  : actualTimes.reduce(
                      (total, time) => total + time,
                      0
                    )

              const totalOvertimeDuration =
                typeof treatment.totalOvertimeDuration === 'number'
                  ? treatment.totalOvertimeDuration
                  : Math.max(
                      0,
                      totalActualDuration - totalExpectedDuration
                    )

              const { tooth: _legacyTooth, ...rest } = treatment

              return {

                ...rest,

                toothId,

                phases,

                actualTimes,

                procedureName,

                patientId:
                  typeof treatment.patientId === 'string' &&
                  treatment.patientId !== ''
                    ? treatment.patientId
                    : slugify(treatment.patientName ?? ''),

                procedureId:
                  typeof treatment.procedureId === 'string' &&
                  treatment.procedureId !== ''
                    ? treatment.procedureId
                    : slugify(procedureName),

                templateId:
                  typeof treatment.templateId === 'string' &&
                  treatment.templateId !== ''
                    ? treatment.templateId
                    : 'general',

                templateName:
                  typeof treatment.templateName === 'string' &&
                  treatment.templateName !== ''
                    ? treatment.templateName
                    : procedureName,

                phaseRecords,

                totalExpectedDuration,

                totalActualDuration,

                totalOvertimeDuration,

                events:
                  Array.isArray(treatment.events)
                    ? treatment.events
                    : [],

                tags:
                  Array.isArray(treatment.tags)
                    ? treatment.tags
                    : [],

                chairEnteredAt:
                  typeof treatment.chairEnteredAt === 'string'
                    ? treatment.chairEnteredAt
                    : null,

                chairLeftAt:
                  typeof treatment.chairLeftAt === 'string'
                    ? treatment.chairLeftAt
                    : null,

              }

            })

        }

      } catch {

        console.log(
          'Could not load saved treatments.'
        )

      }

    }

    const savedPatientNames =
      localStorage.getItem(
        'toothTargetPatients'
      )

    if (savedPatientNames) {

      try {

        const parsed =
          JSON.parse(
            savedPatientNames
          )

        if (Array.isArray(parsed)) {

          /*
            Captured raw (not yet filtered/shaped) - could be the old
            string[] format or the new Patient[] format.
            migratePatientIdentity() below detects which and handles
            both, generating IDs only for the old format.
          */

          rawPatients = parsed

        }

      } catch {

        console.log(
          'Could not load saved patients.'
        )

      }

    }

    const savedNextPatientNumber =
      localStorage.getItem(
        'toothTargetNextPatientNumber'
      )

    if (savedNextPatientNumber) {

      try {

        rawNextPatientNumber = JSON.parse(savedNextPatientNumber)

      } catch {

        console.log(
          'Could not load next patient number.'
        )

      }

    }

    const savedProcedures =
      localStorage.getItem(
        'toothTargetProcedures'
      )

    if (savedProcedures) {

      try {

        const parsed = JSON.parse(savedProcedures)

        if (Array.isArray(parsed) && parsed.length > 0) {
          shapedProcedures = parsed
        }

      } catch {

        console.log(
          'Could not load procedures.'
        )

      }

    }

    const savedTemplateList =
      localStorage.getItem(
        'toothTargetTemplates'
      )

    if (savedTemplateList) {

      try {

        const parsed = JSON.parse(savedTemplateList)

        if (Array.isArray(parsed) && parsed.length > 0) {
          shapedTemplates = parsed.map(classifyTemplate)
        }

      } catch {

        console.log(
          'Could not load templates.'
        )

      }

    }

    const active =
      localStorage.getItem(
        'toothTargetActiveTreatment'
      )

    if (active) {

      try {

        /*
          Parsed as loosely-typed JSON on purpose: this is untrusted
          localStorage data from potentially any prior version of
          ToothTarget - migrateActiveTreatmentShape() shape-checks
          and migrates every field before it's ever treated as a
          real ActiveTreatment.
        */

        const migrated =
          migrateActiveTreatmentShape(
            JSON.parse(active),
            Date.now()
          )

        if (migrated) {
          shapedActiveTreatment = migrated
        }

      } catch {

        console.log(
          'Could not load active treatment.'
        )

      }

    }

    /*
      INCOMPLETE TREATMENTS (Phase 10)

      Parked treatments the dentist saved without finishing - same
      shape as ActiveTreatment, migrated the same way, so resuming
      one later is exactly as reliable as the single "currently
      active" slot.
    */

    const incomplete =
      localStorage.getItem(
        'toothTargetIncompleteTreatments'
      )

    if (incomplete) {

      try {

        const parsed = JSON.parse(incomplete)

        if (Array.isArray(parsed)) {

          shapedIncompleteTreatments =
            parsed
              .map(item =>
                migrateActiveTreatmentShape(item, Date.now())
              )
              .filter(
                (item): item is ActiveTreatment => item !== null
              )

        }

      } catch {

        console.log(
          'Could not load incomplete treatments.'
        )

      }

    }

    /*
      CUSTOM TEMPLATE/PROCEDURE ID MIGRATION

      Runs before the treatment-id migration below (and everything
      else), so the old-id -> new-id maps it produces are ready
      before any treatment's templateId/procedureId reference ever
      needs fixing up. See migrateTemplateAndProcedureIds() above.
    */

    let templateProcedureIdMigrationChanged = false

    try {

      const templateProcedureResult =
        migrateTemplateAndProcedureIds(shapedTemplates, shapedProcedures)

      shapedTemplates = templateProcedureResult.templates
      shapedProcedures = templateProcedureResult.procedures

      const savedTreatmentsRefResult =
        migrateTreatmentTemplateProcedureRefsList(
          shapedSavedTreatments,
          templateProcedureResult.templateIdMap,
          templateProcedureResult.procedureIdMap
        )

      shapedSavedTreatments = savedTreatmentsRefResult.treatments

      const incompleteTreatmentsRefResult =
        migrateTreatmentTemplateProcedureRefsList(
          shapedIncompleteTreatments,
          templateProcedureResult.templateIdMap,
          templateProcedureResult.procedureIdMap
        )

      shapedIncompleteTreatments = incompleteTreatmentsRefResult.treatments

      const activeTreatmentRefResult =
        shapedActiveTreatment
          ? migrateTreatmentTemplateProcedureRefs(
              shapedActiveTreatment,
              templateProcedureResult.templateIdMap,
              templateProcedureResult.procedureIdMap
            )
          : null

      if (activeTreatmentRefResult) {
        shapedActiveTreatment = activeTreatmentRefResult.treatment
      }

      templateProcedureIdMigrationChanged =
        templateProcedureResult.changed ||
        savedTreatmentsRefResult.changed ||
        incompleteTreatmentsRefResult.changed ||
        (activeTreatmentRefResult?.changed ?? false)

    } catch {

      console.log(
        'Could not migrate template/procedure ids.'
      )

    }

    /*
      CUSTOM TEMPLATE updatedAt MIGRATION (cloud sync foundation,
      Phase 2)

      Runs right after the id migration above, still before anything
      is committed to state/localStorage, so every template already
      carries a valid updatedAt by the time the rest of the app - and
      any future sync code - ever reads shapedTemplates. Guarded on
      its own, same as the id migration above, so a bug here can never
      prevent the already-shaped templates from still reaching the
      app. See migrateTemplateTimestamps() above.
    */

    let templateTimestampMigrationChanged = false

    try {

      const templateTimestampResult =
        migrateTemplateTimestamps(shapedTemplates)

      shapedTemplates = templateTimestampResult.templates

      templateTimestampMigrationChanged = templateTimestampResult.changed

    } catch {

      console.log(
        'Could not migrate template timestamps.'
      )

    }

    /*
      CUSTOM PROCEDURE updatedAt MIGRATION (Phase 5.5)

      Same reasoning/placement as the template timestamp migration just
      above - runs before anything is committed to state/localStorage,
      guarded on its own so a bug here can never prevent the
      already-shaped procedures from still reaching the app. See
      migrateProcedureTimestamps() above.
    */

    let procedureTimestampMigrationChanged = false

    try {

      const procedureTimestampResult =
        migrateProcedureTimestamps(shapedProcedures)

      shapedProcedures = procedureTimestampResult.procedures

      procedureTimestampMigrationChanged = procedureTimestampResult.changed

    } catch {

      console.log(
        'Could not migrate procedure timestamps.'
      )

    }

    /*
      TREATMENT ID MIGRATION

      Runs before the patient-identity pass below (and before
      anything is committed to React state/localStorage) so every
      treatment already has a real UUID id by the time the rest of
      the app - and migratePatientIdentity()'s own patientId
      reassignment, which copies treatment.patientId, not
      treatment.id - ever sees it. See migrateTreatmentId() above for
      why this needs no cross-record correlation at all, unlike
      patient identity.
    */

    let treatmentIdMigrationChanged = false

    try {

      const savedTreatmentsIdResult =
        migrateTreatmentIdList(shapedSavedTreatments)

      shapedSavedTreatments = savedTreatmentsIdResult.treatments

      const incompleteTreatmentsIdResult =
        migrateTreatmentIdList(shapedIncompleteTreatments)

      shapedIncompleteTreatments = incompleteTreatmentsIdResult.treatments

      const activeTreatmentIdResult =
        migrateActiveTreatmentId(shapedActiveTreatment)

      shapedActiveTreatment = activeTreatmentIdResult.treatment

      treatmentIdMigrationChanged =
        savedTreatmentsIdResult.changed ||
        incompleteTreatmentsIdResult.changed ||
        activeTreatmentIdResult.changed

    } catch {

      console.log(
        'Could not migrate treatment ids.'
      )

    }

    /*
      Cross-cutting patient-identity pass over everything shaped
      above (now with treatment ids already migrated) - see
      migratePatientIdentity() for the full explanation. Guarded on
      its own so a bug here can never prevent the already-shaped
      treatments/templates/procedures loaded above from still
      reaching the app.
    */

    try {

      const migratedIdentity =
        migratePatientIdentity({
          rawPatients,
          savedTreatments: shapedSavedTreatments,
          incompleteTreatments: shapedIncompleteTreatments,
          activeTreatment: shapedActiveTreatment,
        })

      /*
        Runs immediately after identity migration, still inside this
        same guarded try block - see migratePatientTimestamps() above
        for why this is a separate pass rather than something identity
        migration does itself.
      */
      const patientTimestampResult =
        migratePatientTimestamps(migratedIdentity.patients)

      const finalPatients = patientTimestampResult.patients

      /*
        See migrateSavedTreatmentPatientNames()/migrateTreatmentPatientNames()
        above. Saved treatments use the stricter orphan-removal variant
        (they're part of the cloud-synchronized dataset - a fabricated
        name isn't acceptable long-term); incomplete/active treatments
        are local-only, so the fallback-name variant is enough to keep
        them from crashing the app.
      */

      const savedTreatmentNameResult =
        migrateSavedTreatmentPatientNames(
          migratedIdentity.savedTreatments,
          finalPatients
        )

      const incompleteTreatmentNameResult =
        migrateTreatmentPatientNames(
          migratedIdentity.incompleteTreatments,
          finalPatients
        )

      const activeTreatmentNameResult =
        migratedIdentity.activeTreatment
          ? backfillTreatmentPatientName(
              migratedIdentity.activeTreatment,
              new Map(finalPatients.map(patient => [patient.id, patient]))
            )
          : null

      const savedTreatmentDateResult =
        migrateSavedTreatmentDates(savedTreatmentNameResult.treatments)

      const savedTreatmentTimestampResult =
        migrateSavedTreatmentTimestamps(savedTreatmentDateResult.treatments)

      const finalSavedTreatments = savedTreatmentTimestampResult.treatments
      const finalIncompleteTreatments = incompleteTreatmentNameResult.treatments
      const finalActiveTreatment =
        activeTreatmentNameResult?.treatment ?? migratedIdentity.activeTreatment

      /*
        Each orphaned saved treatment is tombstoned (never just dropped
        silently) so its removal propagates through cloud sync instead
        of reappearing from another device's older copy on a future
        merge. appendTombstone() already reads/writes
        toothTargetDeletionTombstones directly - the same helper
        confirmDeletePatient()/confirmDeleteTemplate() use - so this
        needs no new persistence logic of its own.
      */

      for (const orphanedId of savedTreatmentNameResult.orphanedTreatmentIds) {
        appendTombstone('treatment', orphanedId)
      }

      if (savedTreatmentNameResult.orphanedTreatmentIds.length > 0) {

        console.log(
          `Removed ${savedTreatmentNameResult.orphanedTreatmentIds.length} saved treatment(s) with no matching patient (tombstoned): ${savedTreatmentNameResult.orphanedTreatmentIds.join(', ')}`
        )

        /*
          Every other tombstone-writing mutation in the app (patient
          deletion, template deletion) requests a sync immediately
          after committing its tombstone - this load-time cleanup
          should be no different, or the tombstone sits local-only
          until some unrelated mutation happens to trigger the next
          sync. Gated on orphanedTreatmentIds.length so a normal load
          with nothing to clean up never fires a sync on its own.
        */
        requestCloudSync()

      }

      const patientNameFallbackTreatmentIds = [
        ...incompleteTreatmentNameResult.fallbackTreatmentIds,
        ...(activeTreatmentNameResult?.usedFallback
          ? [migratedIdentity.activeTreatment!.id]
          : []),
      ]

      if (patientNameFallbackTreatmentIds.length > 0) {

        console.log(
          `Backfilled patientName with "${UNKNOWN_PATIENT_NAME_FALLBACK}" for ${patientNameFallbackTreatmentIds.length} treatment(s) whose patient no longer exists: ${patientNameFallbackTreatmentIds.join(', ')}`
        )

      }

      const patientNameMigrationChanged =
        savedTreatmentNameResult.changed ||
        incompleteTreatmentNameResult.changed ||
        (activeTreatmentNameResult?.changed ?? false) ||
        savedTreatmentDateResult.changed ||
        savedTreatmentTimestampResult.changed

      setSavedPatients(finalPatients)
      setSavedTreatments(finalSavedTreatments)
      setIncompleteTreatments(finalIncompleteTreatments)

      setPatientNumberConflicts(
        reconcileAndPersistPatientNumberConflicts(finalPatients)
      )

      if (finalActiveTreatment) {

        setActiveTreatment(finalActiveTreatment)

        /*
          Prompt once per app open (this effect only runs on mount)
          rather than every time the dentist navigates back to Home
          during the same session.
        */

        setShowResumePrompt(true)

      }

      /*
        Always kept in sync, independently of `changed` above - this
        counter can move forward (self-correcting a stale/never-
        before-written value) even when no patient actually needed a
        new number this run, and it must never be left stale, since a
        stale (too-low) counter could hand out a number that's
        already in use.
      */

      if (
        migratedIdentity.nextPatientNumber !==
        (readStoredPatientNumber(rawNextPatientNumber) ?? 1)
      ) {

        localStorage.setItem(
          'toothTargetNextPatientNumber',
          JSON.stringify(migratedIdentity.nextPatientNumber)
        )

      }

      if (
        migratedIdentity.changed ||
        patientTimestampResult.changed ||
        treatmentIdMigrationChanged ||
        templateProcedureIdMigrationChanged ||
        patientNameMigrationChanged
      ) {

        localStorage.setItem(
          'toothTargetPatients',
          JSON.stringify(finalPatients)
        )

        localStorage.setItem(
          'toothTargetSavedTreatments',
          JSON.stringify(finalSavedTreatments)
        )

        localStorage.setItem(
          'toothTargetIncompleteTreatments',
          JSON.stringify(finalIncompleteTreatments)
        )

        if (finalActiveTreatment) {

          localStorage.setItem(
            'toothTargetActiveTreatment',
            JSON.stringify(finalActiveTreatment)
          )

        }

      }

    } catch (error) {

      console.log(
        'Could not migrate patient identity.'
      )

      /*
        Logs the actual error (previously discarded by a bare `catch {}`)
        so a real failure here is diagnosable from the console instead of
        silently falling back with no trace at all.
      */
      console.error('Patient-identity migration failed - falling back to unmigrated data.', error)

      /*
        Fall back to whatever was already shaped above, unmigrated -
        still fully usable (patientId just stays whatever it already
        was), never a blank/broken app. If toothTargetPatients was
        already in the new Patient[] shape (the common case on any
        load after the first successful migration), keep it as-is
        rather than discarding it.
      */

      const fallbackPatients =
        Array.isArray(rawPatients)
          ? rawPatients.filter(isValidPatient)
          : []

      setSavedPatients(fallbackPatients)

      setPatientNumberConflicts(
        reconcileAndPersistPatientNumberConflicts(fallbackPatients)
      )

      setSavedTreatments(shapedSavedTreatments)
      setIncompleteTreatments(shapedIncompleteTreatments)

      if (shapedActiveTreatment) {
        setActiveTreatment(shapedActiveTreatment)
        setShowResumePrompt(true)
      }

    }

    /*
      Independent of whether the patient-identity pass above
      succeeded or fell back - shapedTemplates/shapedProcedures were
      already fully migrated before either try block ran.
    */

    setTemplates(shapedTemplates)
    setProcedures(shapedProcedures)

    if (
      templateProcedureIdMigrationChanged ||
      templateTimestampMigrationChanged ||
      procedureTimestampMigrationChanged
    ) {

      localStorage.setItem(
        'toothTargetTemplates',
        JSON.stringify(shapedTemplates)
      )

      localStorage.setItem(
        'toothTargetProcedures',
        JSON.stringify(shapedProcedures)
      )

    }

  }, [])


  /*
    AUTOMATIC SYNC ON APP LOAD (Phase 2)

    Fires once, on mount, but only ever requests a sync if a Microsoft
    account is already active - a dentist who has never signed in gets
    zero sync activity from this effect, not even an attempted-and-
    failed one (see requestCloudSyncIfSignedIn()'s own comment).

    Ordering: this must never run before the migration effect above
    has finished, since a sync validates local data against the
    CURRENT schema and migrations are what make old data valid (see
    cloudSyncEngine.ts's buildLocalCloudSyncDocument()). React runs
    same-phase effects in the order they're declared on initial mount,
    and the migration effect above is entirely synchronous (no awaits,
    no setTimeout), so by the time THIS effect's callback runs,
    migrations are already fully committed to localStorage - no extra
    flag or dependency is needed to enforce that ordering.

    getActiveAccount() is already authoritative here, not just a
    best-effort guess: main.tsx awaits initializeMsal() (which
    restores any cached account, or confirms one from a just-completed
    redirect sign-in) BEFORE React ever renders, so there is no
    "MSAL might still be initializing" window during this component's
    own mount. A later, in-session popup sign-in is a separate trigger
    (see MicrosoftAccountSection.tsx's handleSignIn()), not this one.

    ACCOUNT-SWITCH ISOLATION (Phase 4) - reconcileSyncedAccount() is
    called first, before ever requesting a sync, so a device that's
    signing in with a DIFFERENT Microsoft account than whatever this
    device's local data currently belongs to never gets a chance to
    merge that stale data into the new account's cloud document (see
    cloudSyncEngine.ts's own header comment on this function for the
    full reasoning). If it reports a switch just happened, local
    synced data has already been quarantined (see
    cloudSyncEngine.ts) - but this component's own React state above
    was already initialized from the OUTGOING account's data by the
    migration effect that ran just before this one, so it would still
    show that stale data on screen even though the underlying
    localStorage is already correct. Reloading - the same pattern
    cloudBackup.ts's own applyCloudRestore() already uses after any
    other bulk local-data replacement - guarantees this component
    remounts from the now-quarantined, correctly-empty state instead
    of leaving mismatched data on screen. The reload also means this
    effect runs again from scratch, where reconcileSyncedAccount()
    will see the account it just recorded and take the normal
    'same-account' path, requesting the new account's real sync.
  */
  useEffect(() => {

    const account = getActiveAccount()

    if (
      account &&
      reconcileSyncedAccount(account.homeAccountId) === 'switched-account'
    ) {
      window.location.reload()
      return
    }

    requestCloudSyncIfSignedIn(Boolean(account))

  }, [])


  /*
    RETRY SYNC WHEN CONNECTIVITY RETURNS (Phase 3)

    A sync that failed because the network dropped mid-request
    otherwise only retries whenever some unrelated mutation next calls
    requestCloudSync() - possibly a long wait, or never, in a session
    with no further changes. attachOnlineRetryListener() (see
    cloudSyncOnlineRetry.ts) listens for the browser's own 'online'
    event and asks for one more attempt when it fires, gated on
    sign-in status the same way every other automatic trigger is.

    No ordering dependency on the migration effect above - unlike the
    app-load trigger, this only ever fires later, in response to a
    real browser event, never synchronously during mount.
  */
  useEffect(() => attachOnlineRetryListener(), [])


  /*
    NAVIGATE TO THE STALE-RECORD REVIEW SCREEN (Phase 4.7)

    Only ever auto-navigates while `screen === 'home'` - never yanks the
    dentist away from an active treatment timer, an in-progress patient
    edit, or anything else mid-workflow. This still reliably surfaces
    the review the moment it's actually safe to: `screen` is in the
    dependency list precisely so that landing back on Home later (after
    finishing whatever the dentist was doing when the review first
    became pending) re-runs this check and navigates then, rather than
    only checking once at the instant pendingStaleReview first appears.
    A dentist who never returns to Home still sees the warning banner
    rendered on that screen (see the 'home' screen below) and can open
    the review manually at any time in the meantime.
  */
  useEffect(() => {

    if (
      pendingStaleReview &&
      pendingStaleReview.length > 0 &&
      screen === 'home'
    ) {
      setScreen('staleReview')
    }

  }, [pendingStaleReview, screen])


  /*
    SAVE ACTIVE TREATMENT AUTOMATICALLY
  */

  useEffect(() => {

    if (!activeTreatment) {
      return
    }

    localStorage.setItem(
      'toothTargetActiveTreatment',
      JSON.stringify(activeTreatment)
    )

  }, [activeTreatment])


  /*
    CROSS-TAB PATIENT/TEMPLATE SYNC

    The native "storage" event only fires in OTHER same-origin tabs/
    windows, never the one that made the change - exactly what's
    needed here: this tab's own writes (via allocatePatient()/
    deletePatientFromRegistry(), or deleteTemplateFromRegistry()
    below) already update its own state directly, so this only has to
    handle "some OTHER open tab changed toothTargetPatients/
    toothTargetTemplates/toothTargetDeletionTombstones" by adopting
    that new value. This is purely a display/state-freshness
    reconciliation - it never decides a patientNumber or performs a
    deletion itself, so it doesn't need (and isn't) either lock above.
  */

  useEffect(() => {

    function handlePatientStorageChange(event: StorageEvent) {

      if (event.key === 'toothTargetPatients') {

        try {

          const parsed =
            event.newValue ? JSON.parse(event.newValue) : []

          if (Array.isArray(parsed)) {

            const validPatients = parsed.filter(isValidPatient)

            setSavedPatients(validPatients)

            /*
              A patient change from another tab (eg. a delete, or a
              conflict resolution) can make one of THIS tab's own
              persisted conflicts stale - reconcile against the fresh
              patient list that just arrived, but only update this
              tab's own state, never re-persist (the writing tab
              already did that, exactly like this handler never
              re-persists toothTargetPatients/toothTargetTemplates
              either).
            */

            setPatientNumberConflicts(
              reconcilePatientNumberConflicts(
                readPersistedPatientNumberConflicts(),
                validPatients
              )
            )

          }

        } catch {

          console.log(
            'Could not sync patients from another tab.'
          )

        }

      }

      if (event.key === 'toothTargetPatientNumberConflicts') {

        try {

          const parsed =
            event.newValue ? JSON.parse(event.newValue) : []

          if (Array.isArray(parsed)) {

            setPatientNumberConflicts(
              reconcilePatientNumberConflicts(
                parsed.filter(isValidPatientNumberConflict),
                readPersistedPatients()
              )
            )

          }

        } catch {

          console.log(
            'Could not sync patient number conflicts from another tab.'
          )

        }

      }

      if (event.key === 'toothTargetTemplates') {

        try {

          const parsed =
            event.newValue ? JSON.parse(event.newValue) : []

          if (Array.isArray(parsed)) {
            setTemplates(parsed.map(classifyTemplate))
          }

        } catch {

          console.log(
            'Could not sync templates from another tab.'
          )

        }

      }

      if (event.key === 'toothTargetDeletionTombstones') {

        /*
          No React state mirrors tombstones (see the comment by
          savedPatients' declaration) - still validated here so a
          malformed cross-tab write is logged rather than silently
          ignored, even though there's nothing to reconcile it into
          yet. A future consumer would call readPersistedTombstones()
          fresh at the moment it's actually needed, exactly like
          toothTargetNextPatientNumber already does for its counter.
        */

        try {

          const parsed =
            event.newValue ? JSON.parse(event.newValue) : []

          if (!Array.isArray(parsed) || !parsed.every(isValidTombstone)) {

            console.log(
              'Received a malformed deletion tombstone list from another tab.'
            )

          }

        } catch {

          console.log(
            'Could not read deletion tombstones from another tab.'
          )

        }

      }

      /*
        No React state mirrors toothTargetNextPatientNumber (see the
        comment by savedPatients' declaration) - allocatePatient()
        always reads it fresh at the moment it's actually needed, so
        there is nothing to reconcile here for that key.
      */

    }

    window.addEventListener(
      'storage',
      handlePatientStorageChange
    )

    return () => {
      window.removeEventListener(
        'storage',
        handlePatientStorageChange
      )
    }

  }, [])


  /*
    CREATE PATIENT LIST

    We get patient names from both:
    - completed treatments
    - currently active treatment
  */

const patientNames = Array.from(
  new Set(
    [
      ...savedPatients.map(
        patient => patient.name
      ),

      ...savedTreatments.map(
        treatment =>
          treatment.patientName
      ),

      ...(activeTreatment
        ? [activeTreatment.patientName]
        : []),
    ].filter(
      patient =>
        typeof patient === 'string' &&
        patient.trim() !== ''
    )
  )
).sort(
  (a, b) =>
    a.localeCompare(b)
)

/*
  Pairs each name with its patientNumber (looked up from
  savedPatients, the registry every name above should already be
  part of - see migratePatientIdentity()/openPatient()) purely for
  display ("1 — Ahmed Mohamed") and search-by-number below. null only
  as a defensive fallback for a name that somehow isn't registered
  yet; openPatient() itself still only ever needs the plain name.
*/
/*
  Phase 8 - descending by patient number (highest first), regardless
  of patientNames' own alphabetical order above - a null patientNumber
  (defensive fallback only, see comment above) sorts last rather than
  breaking the numeric comparison.
*/
const patients = patientNames
  .map(name => ({
    name,
    patientNumber:
      savedPatients.find(patient => patient.name === name)
        ?.patientNumber ?? null,
  }))
  .sort(
    (a, b) =>
      (b.patientNumber ?? -Infinity) - (a.patientNumber ?? -Infinity)
  )

  /*
    PATIENT AUTOCOMPLETE

    IMPORTANT:
    We only show the dropdown when
    the user has actually typed something.

    Matches either the name or the patient number, so searching "1"
    finds patient 1 and searching "Ahmed" still works exactly as
    before.
  */

const filteredPatients =
  patients.filter(
    patient => {

      const cleanSearch =
        patientSearch.trim().toLowerCase()

      return (
        patient.name
          .toLowerCase()
          .includes(cleanSearch) ||
        (
          patient.patientNumber !== null &&
          String(patient.patientNumber).includes(cleanSearch)
        )
      )

    }
  )

/*
  PATIENT-NUMBER CONFLICT DISPLAY (Phase 4)

  Purely derived, read-only view over patientNumberConflicts +
  savedPatients for the conflict browser/confirmation UI below - never
  written back anywhere. A patient's UUID is never shown to the
  dentist except as a short last-resort suffix, and only for patients
  that share the exact same name within the SAME conflict - the one
  case name alone can't distinguish (section 13).
*/

type PatientConflictDisplayEntry = {
  patientNumber: number
  patients: {
    id: string
    name: string
    disambiguator: string | null
  }[]
}

const patientConflictDisplay: PatientConflictDisplayEntry[] =
  patientNumberConflicts.map(conflict => {

    const conflictPatients =
      conflict.patientIds
        .map(patientId =>
          savedPatients.find(patient => patient.id === patientId)
        )
        .filter((patient): patient is Patient => !!patient)

    const nameCounts = new Map<string, number>()

    for (const patient of conflictPatients) {
      const key = patient.name.toLowerCase()
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1)
    }

    return {
      patientNumber: conflict.patientNumber,
      patients: conflictPatients.map(patient => ({
        id: patient.id,
        name: patient.name,
        disambiguator:
          (nameCounts.get(patient.name.toLowerCase()) ?? 0) > 1
            ? `ID …${patient.id.slice(-6)}`
            : null,
      })),
    }

  })

const activeConflictChoice =
  conflictKeepChoice
    ? {
        patientNumber: conflictKeepChoice.patientNumber,
        keepPatient:
          savedPatients.find(
            patient => patient.id === conflictKeepChoice.keepPatientId
          ) ?? null,
        otherPatients:
          (patientNumberConflicts
            .find(
              conflict =>
                conflict.patientNumber === conflictKeepChoice.patientNumber
            )
            ?.patientIds ?? [])
            .filter(id => id !== conflictKeepChoice.keepPatientId)
            .map(id => savedPatients.find(patient => patient.id === id))
            .filter((patient): patient is Patient => !!patient),
      }
    : null

async function openPatient(
  patientName: string
) {

  const cleanName =
    patientName
      .trim()
      .toLowerCase()
      .replace(
        /\b\w/g,
        letter => letter.toUpperCase()
      )

  if (cleanName === '') {
    return
  }

  /*
    Never trust the in-memory savedPatients/nextPatientNumber here -
    another tab could have created a patient (or even this exact
    name) a moment ago. allocatePatient() re-reads both values fresh
    from localStorage and does the whole find-or-create under a
    cross-tab lock, so what it returns is already the correct,
    durably-persisted result regardless of what this tab's own state
    currently holds.
  */

  const result = await allocatePatient(cleanName)

  setSavedPatients(result.patients)

  /*
    Only when a brand-new patient record was actually committed -
    never for the "found an existing patient by this name" case,
    which changed nothing in the synchronized registry.
  */
  if (result.created) {
    requestCloudSync()
  }

  setSelectedPatient(
    cleanName
  )

  setPatientSearch(
    cleanName
  )

  setScreen('patient')

}
  /*
    START NEW TREATMENT -> PROCEDURE SELECTION
  */

  function openProcedureSelect() {

    setSelectedProcedure(null)

    setShowAddProcedure(false)

    setNewProcedureName('')

    setPendingChairEnteredAt(null)

    setEditProcedureId(null)

    setEditProcedureError(null)

    setDeleteProcedureConfirmId(null)

    setScreen('procedureSelect')

  }

  function markPatientInChair() {
    setPendingChairEnteredAt(new Date().toISOString())
  }


  /*
    SELECT PROCEDURE -> TOOTH TYPE SELECTION
  */

  function selectProcedure(
    procedure: Procedure
  ) {

    setSelectedProcedure(procedure)

    setSelectedToothId(null)

    setShowAddProcedure(false)

    setNewProcedureName('')

    setScreen('toothSelect')

  }


  /*
    ADD NEW PROCEDURE
  */

  function addProcedure(
    rawName: string
  ) {

    const cleanName =
      rawName.trim()

    if (cleanName === '') {
      return
    }

    const newProcedure: Procedure = {

      id: crypto.randomUUID(),

      name: cleanName,

      isCustom: true,

      templateId: 'general',

      updatedAt: new Date().toISOString(),

    }

    const updatedProcedures = [
      ...procedures,
      newProcedure,
    ]

    setProcedures(
      updatedProcedures
    )

    localStorage.setItem(
      'toothTargetProcedures',
      JSON.stringify(
        updatedProcedures
      )
    )

    /*
      addProcedure() always creates a new isCustom: true record - every
      successful call here is a genuine synchronized-data change.
    */
    requestCloudSync()

    selectProcedure(newProcedure)

  }


  /*
    EDIT PROCEDURE (Phase 5.5)

    Opens pre-filled with the procedure's CURRENT name (called from the
    procedureSelect screen, which already has the record in scope).
    Unlike patient editing, this has no cross-tab counter to protect
    (procedures carry no number), so - exactly like saveTemplateDraft()
    already does for templates - it reads/writes the in-memory
    `procedures` state directly rather than re-reading fresh from
    localStorage under a lock; the only locked procedure operation is
    deletion (deleteProcedureFromRegistry() above), for the identical
    reason template deletion alone is locked (removing an entry from a
    shared list is the one operation genuinely at risk of a lost update
    between tabs - editing a single record's own field in place is
    not).
  */

  function requestEditProcedure(procedure: Procedure) {
    setEditProcedureId(procedure.id)
    setEditProcedureName(procedure.name)
    setEditProcedureError(null)
  }

  function cancelEditProcedure() {
    setEditProcedureId(null)
    setEditProcedureError(null)
  }

  function confirmEditProcedure() {

    if (!editProcedureId) {
      return
    }

    const cleanName = editProcedureName.trim()

    if (cleanName === '') {
      setEditProcedureError('Procedure name cannot be empty.')
      return
    }

    const existingProcedure =
      procedures.find(procedure => procedure.id === editProcedureId)

    if (!existingProcedure) {
      setEditProcedureId(null)
      setEditProcedureError(null)
      return
    }

    /*
      CRITICAL: this only ever updates the Procedure record itself -
      it never touches toothTargetSavedTreatments. A past treatment's
      procedureName is a snapshot taken once, at the moment the
      treatment was started, and is deliberately NEVER cascaded/
      rewritten by a later procedure rename - the same "historical
      record stays exactly as it was" choice template editing already
      makes (saveTemplateDraft() likewise never rewrites a past
      treatment's templateName). Only a patient rename cascades to past
      treatments (applyPatientRenameToSavedTreatments()), because a
      patient's name is their ongoing identity, not a record of what a
      long-past treatment was called at the time.
    */

    const updatedProcedure: Procedure = {
      ...existingProcedure,
      name: cleanName,
      updatedAt: new Date().toISOString(),
    }

    const updatedProcedures =
      procedures.map(procedure =>
        procedure.id === editProcedureId
          ? updatedProcedure
          : procedure
      )

    setProcedures(updatedProcedures)

    localStorage.setItem(
      'toothTargetProcedures',
      JSON.stringify(updatedProcedures)
    )

    requestCloudSync()

    setEditProcedureId(null)
    setEditProcedureError(null)

    /*
      Keep selectedProcedure in sync if the dentist is currently mid-
      selection with the exact record just renamed (eg. reached the
      editor from procedureSelect without yet moving on) - purely a
      display nicety, never required for correctness elsewhere.
    */
    if (selectedProcedure?.id === updatedProcedure.id) {
      setSelectedProcedure(updatedProcedure)
    }

  }


  /*
    DELETE PROCEDURE (Phase 5.5)

    Two-step, explicit-confirmation flow, matching the app's existing
    "confirm before delete" pattern (requestDeleteTemplate()/
    confirmDeleteTemplate(), requestDeletePatient()/confirmDeletePatient()).
    deleteProcedureFromRegistry() re-reads the registry fresh under the
    cross-tab deletion lock - see that function's own header comment
    for why this, unlike editing, needs to be locked and re-read fresh.
  */

  function requestDeleteProcedure(procedureId: string) {
    setDeleteProcedureConfirmId(procedureId)
  }

  function cancelDeleteProcedure() {
    setDeleteProcedureConfirmId(null)
  }

  async function confirmDeleteProcedure() {

    if (!deleteProcedureConfirmId) {
      return
    }

    const registryResult =
      await deleteProcedureFromRegistry(deleteProcedureConfirmId)

    setProcedures(registryResult.procedures)

    /*
      Only requested when a custom procedure was genuinely removed -
      skipped for the no-op "already gone / somehow not custom" case,
      exactly mirroring confirmDeleteTemplate()'s own guard.
    */
    if (registryResult.deleted) {
      requestCloudSync()
    }

    /*
      If the just-deleted procedure was the one currently selected
      (eg. reached via a stale reference from a previous render), clear
      it so a subsequent screen never tries to start a treatment
      against a procedure that no longer exists.
    */
    if (selectedProcedure?.id === deleteProcedureConfirmId) {
      setSelectedProcedure(null)
    }

    setDeleteProcedureConfirmId(null)

  }


  /*
    START TREATMENT
  */

  function startTreatment() {

    const cleanPatientName =
      selectedPatient.trim()


    if (
      cleanPatientName === '' ||
      !selectedToothId ||
      !selectedProcedure
    ) {

      return

    }


    const template =
      resolveTemplate(
        selectedProcedure,
        selectedToothId,
        templates
      )

    const treatmentPhases =
      template.phases.map(
        phase => ({ ...phase })
      )

    /*
      patientId is the patient's real, stable UUID - looked up by the
      exact name openPatient() already registered them under, never
      derived from the name itself (slugify() is lossy and was never
      actually unique). Falling back to a fresh UUID only guards
      against the practically-impossible case of reaching this screen
      for a name somehow missing from savedPatients - it's never
      persisted to the patient registry itself.
    */

    const matchedPatient =
      savedPatients.find(
        patient => patient.name === cleanPatientName
      )

    const newTreatment:
      ActiveTreatment = {

      id: crypto.randomUUID(),

      patientName:
        cleanPatientName,

      patientId:
        matchedPatient?.id ?? crypto.randomUUID(),

      toothId:
        selectedToothId,

      procedureName:
        selectedProcedure.name,

      procedureId:
        selectedProcedure.id,

      templateName:
        template.name,

      templateId:
        template.id,

      phases:
        treatmentPhases,

      phaseTimes:
        treatmentPhases.map(
          phase => phase.duration
        ),

      actualTimes:
        treatmentPhases.map(
          () => 0
        ),

      phaseMeta:
        createPhaseMeta(
          treatmentPhases.length
        ),

      events: [],

      tags: [],

      chairEnteredAt:
        pendingChairEnteredAt,

      chairLeftAt: null,

      currentPhaseIndex: 0,

      lastUpdated:
        Date.now(),

      isPaused: false,

      runningSince:
        new Date().toISOString(),

      startedAt:
        new Date().toISOString(),

    }


    setActiveTreatment(
      newTreatment
    )

    setPendingChairEnteredAt(null)

    setScreen('timer')

  }


  /*
    TIMER

    The phase NEVER changes automatically. This runs whenever a
    treatment is active and not paused, independent of which screen
    is currently showing - navigating away from the Timer screen is
    not the same as pressing Pause, so actual time keeps accruing
    (and gets settled from real elapsed wall-clock time, not a tick
    count, so background-tab throttling can't cause drift).
  */

  useEffect(() => {

    if (
      !activeTreatment ||
      activeTreatment.isPaused
    ) {

      return

    }


    const timer =
      setInterval(() => {

        setActiveTreatment(
          current => {

            if (!current) {
              return null
            }

            const settled =
              settleActualTime(
                current,
                Date.now()
              )

            return {

              ...settled,

              lastUpdated:
                Date.now(),

            }

          }
        )

      }, 1000)


    return () =>
      clearInterval(timer)

  }, [
    activeTreatment
  ])


  /*
    ADD MINUTE
  */

  function addMinute(
    index: number
  ) {

    if (!activeTreatment) {
      return
    }


    const newTimes =
      [...activeTreatment.phaseTimes]


    newTimes[index] += 60


    setActiveTreatment({

      ...activeTreatment,

      phaseTimes:
        newTimes,

      lastUpdated:
        Date.now(),

    })

  }


  /*
    REMOVE MINUTE
  */

  function removeMinute(
    index: number
  ) {

    if (!activeTreatment) {
      return
    }


    const newTimes =
      [...activeTreatment.phaseTimes]


    newTimes[index] -= 60


    setActiveTreatment({

      ...activeTreatment,

      phaseTimes:
        newTimes,

      lastUpdated:
        Date.now(),

    })

  }


  /*
    NEXT PHASE
  */

  function nextPhase() {

    if (!activeTreatment) {
      return
    }


    if (
      activeTreatment.currentPhaseIndex <
      activeTreatment.phases.length - 1
    ) {

      const settled =
        settleActualTime(
          activeTreatment,
          Date.now()
        )

      const nextIndex =
        settled.currentPhaseIndex + 1

      setActiveTreatment({

        ...settled,

        currentPhaseIndex:
          nextIndex,

        phaseMeta:
          advancePhaseMeta(
            settled.phaseMeta,
            settled.currentPhaseIndex,
            nextIndex
          ),

        lastUpdated:
          Date.now(),

      })

    }

  }


  /*
    PREVIOUS PHASE
  */

  function previousPhase() {

    if (!activeTreatment) {
      return
    }


    if (
      activeTreatment.currentPhaseIndex > 0
    ) {

      const settled =
        settleActualTime(
          activeTreatment,
          Date.now()
        )

      const previousIndex =
        settled.currentPhaseIndex - 1

      setActiveTreatment({

        ...settled,

        currentPhaseIndex:
          previousIndex,

        phaseMeta:
          advancePhaseMeta(
            settled.phaseMeta,
            settled.currentPhaseIndex,
            previousIndex
          ),

        lastUpdated:
          Date.now(),

      })

    }

  }


  /*
    CLICK PHASE
  */

  function selectPhase(
    index: number
  ) {

    if (!activeTreatment) {
      return
    }


    const settled =
      settleActualTime(
        activeTreatment,
        Date.now()
      )

    setActiveTreatment({

      ...settled,

      currentPhaseIndex:
        index,

      phaseMeta:
        advancePhaseMeta(
          settled.phaseMeta,
          settled.currentPhaseIndex,
          index
        ),

      lastUpdated:
        Date.now(),

    })

  }


  /*
    DYNAMIC TREATMENT PHASES

    These all edit only the current ActiveTreatment's own phases/
    phaseTimes/actualTimes/phaseMeta arrays - never the procedure
    template those phases were originally copied from - so a change
    made mid-treatment (an added phase, a skip, a restart) belongs
    only to this one treatment, exactly like the existing per-phase
    +/- minute adjustment already does.
  */

  function addPhaseToTreatment(
    rawName: string,
    minutes: number
  ) {

    if (!activeTreatment) {
      return
    }

    const cleanName = rawName.trim()

    if (
      cleanName === '' ||
      !Number.isFinite(minutes) ||
      minutes <= 0
    ) {
      return
    }

    const settled =
      settleActualTime(
        activeTreatment,
        Date.now()
      )

    const insertIndex =
      settled.currentPhaseIndex + 1

    const durationSeconds =
      Math.round(minutes * 60)

    const phases: TemplatePhase[] = [
      ...settled.phases.slice(0, insertIndex),
      { name: cleanName, duration: durationSeconds },
      ...settled.phases.slice(insertIndex),
    ]

    const phaseTimes: number[] = [
      ...settled.phaseTimes.slice(0, insertIndex),
      durationSeconds,
      ...settled.phaseTimes.slice(insertIndex),
    ]

    const actualTimes: number[] = [
      ...settled.actualTimes.slice(0, insertIndex),
      0,
      ...settled.actualTimes.slice(insertIndex),
    ]

    const phaseMeta: PhaseMeta[] = [
      ...settled.phaseMeta.slice(0, insertIndex),
      {
        id: `phase-custom-${Date.now()}`,
        startedAt: null,
        completedAt: null,
        status: 'pending',
        skipped: false,
        pausedWhileActive: false,
      },
      ...settled.phaseMeta.slice(insertIndex),
    ]

    setActiveTreatment({
      ...settled,
      phases,
      phaseTimes,
      actualTimes,
      phaseMeta,
      lastUpdated: Date.now(),
    })

    setNewPhaseName('')

    setNewPhaseMinutes('5')

  }

  /*
    SKIP PHASE

    Marks the current phase skipped (any time already accrued on it
    stays recorded - skipping isn't the same as it never having
    happened) and advances to the next phase, same as finishing it
    normally would.
  */

  function skipCurrentPhase() {

    if (!activeTreatment) {
      return
    }

    const settled =
      settleActualTime(
        activeTreatment,
        Date.now()
      )

    const skippedIndex =
      settled.currentPhaseIndex

    const nextIndex =
      Math.min(
        skippedIndex + 1,
        settled.phases.length - 1
      )

    const now = new Date().toISOString()

    const phaseMeta: PhaseMeta[] =
      settled.phaseMeta.map((entry, index) => {

        if (index === skippedIndex) {
          return {
            ...entry,
            status: 'skipped',
            skipped: true,
            completedAt: now,
          }
        }

        if (index === nextIndex && nextIndex !== skippedIndex) {
          return {
            ...entry,
            startedAt: entry.startedAt ?? now,
            status: 'active',
          }
        }

        return entry

      })

    setActiveTreatment({
      ...settled,
      currentPhaseIndex: nextIndex,
      phaseMeta,
      lastUpdated: Date.now(),
    })

    setShowOptionsMenu(false)

  }

  /*
    RESTART PHASE

    Resets the current phase's own timing/meta in place - it never
    inserts a second copy of the phase, so there's no risk of it
    quietly double-counting toward this treatment's totals.
  */

  function restartCurrentPhase() {

    if (!activeTreatment) {
      return
    }

    const index =
      activeTreatment.currentPhaseIndex

    const expectedDuration =
      activeTreatment.phases[index].duration

    const now = new Date().toISOString()

    const phaseTimes =
      [...activeTreatment.phaseTimes]

    const actualTimes =
      [...activeTreatment.actualTimes]

    phaseTimes[index] = expectedDuration

    actualTimes[index] = 0

    const phaseMeta: PhaseMeta[] =
      activeTreatment.phaseMeta.map((entry, i) =>
        i === index
          ? {
              ...entry,
              startedAt: now,
              completedAt: null,
              status: 'active',
              skipped: false,
              pausedWhileActive: false,
            }
          : entry
      )

    setActiveTreatment({
      ...activeTreatment,
      phaseTimes,
      actualTimes,
      phaseMeta,
      runningSince:
        activeTreatment.isPaused ? null : now,
      lastUpdated: Date.now(),
    })

    setShowOptionsMenu(false)

  }


  /*
    PAUSE / RESUME
  */

  function togglePause() {

    if (!activeTreatment) {
      return
    }

    const willBePaused =
      !activeTreatment.isPaused

    const now = Date.now()

    const settled =
      willBePaused
        ? settleActualTime(activeTreatment, now)
        : activeTreatment

    setActiveTreatment({

      ...settled,

      isPaused:
        willBePaused,

      runningSince:
        willBePaused
          ? null
          : new Date(now).toISOString(),

      phaseMeta:
        willBePaused
          ? markPhasePaused(
              settled.phaseMeta,
              settled.currentPhaseIndex
            )
          : settled.phaseMeta,

      lastUpdated:
        Date.now(),

    })

  }


  /*
    RESET
  */

  function resetTimer() {

    if (!activeTreatment) {
      return
    }


    setActiveTreatment({

      ...activeTreatment,

      phaseTimes:
        activeTreatment.phases.map(
          phase => phase.duration
        ),

      actualTimes:
        activeTreatment.phases.map(
          () => 0
        ),

      phaseMeta:
        createPhaseMeta(
          activeTreatment.phases.length
        ),

      events: [],

      currentPhaseIndex: 0,

      isPaused: false,

      runningSince:
        new Date().toISOString(),

      lastUpdated:
        Date.now(),

    })

  }


  /*
    TREATMENT TAGS

    Purely descriptive classification - toggling a tag never touches
    phaseTimes/actualTimes/phases or anything else timing-related.
  */

  function toggleTreatmentTag(
    tag: string
  ) {

    if (!activeTreatment) {
      return
    }

    const hasTag =
      activeTreatment.tags.includes(tag)

    setActiveTreatment({
      ...activeTreatment,
      tags:
        hasTag
          ? activeTreatment.tags.filter(item => item !== tag)
          : [...activeTreatment.tags, tag],
    })

  }

  /*
    CHAIR TIME - MARK PATIENT LEFT (Phase 16)

    Only offered once chairEnteredAt is actually set and chairLeftAt
    isn't yet - there's no "undo", same as every other timestamp
    this app logs, so a mis-tap just means Chair Time comes out a
    little short rather than the app inventing a correction.
  */

  function markPatientLeft() {

    if (
      !activeTreatment ||
      !activeTreatment.chairEnteredAt ||
      activeTreatment.chairLeftAt
    ) {
      return
    }

    setActiveTreatment({
      ...activeTreatment,
      chairLeftAt: new Date().toISOString(),
    })

  }


  /*
    QUICK NOTES

    Purely informational - logged with a timestamp, never affects
    phase timing or the template.
  */

  function addNoteEvent(
    rawText: string
  ) {

    if (!activeTreatment) {
      return
    }

    const cleanText = rawText.trim()

    if (cleanText === '') {
      return
    }

    const newEvent: TreatmentEvent = {
      id: `event-${Date.now()}`,
      type: 'note',
      note: cleanText,
      timestamp: new Date().toISOString(),
      durationSeconds: null,
    }

    setActiveTreatment({
      ...activeTreatment,
      events: [...activeTreatment.events, newEvent],
    })

    setCustomNoteText('')

  }


  /*
    INTERRUPTION / LOST TIME

    A dedicated log kept beside the normal phase sequence - never
    inserted into phaseTimes/actualTimes/phases. Each interruption
    starts at 0 and is built up (or trimmed) with its own +1/-1
    controls, so multiple interruptions stay separately identifiable
    and the assistant can adjust any one of them without touching
    the clinical phase timer.
  */

  function addInterruptionEvent(
    rawText: string
  ) {

    if (!activeTreatment) {
      return
    }

    const cleanText = rawText.trim()

    if (cleanText === '') {
      return
    }

    const newEvent: TreatmentEvent = {
      id: `event-${Date.now()}`,
      type: 'interruption',
      note: cleanText,
      timestamp: new Date().toISOString(),
      durationSeconds: 0,
    }

    setActiveTreatment({
      ...activeTreatment,
      events: [...activeTreatment.events, newEvent],
    })

    setCustomInterruptionText('')

  }

  function adjustInterruptionDuration(
    eventId: string,
    deltaSeconds: number
  ) {

    if (!activeTreatment) {
      return
    }

    setActiveTreatment({
      ...activeTreatment,
      events: activeTreatment.events.map(event =>
        event.id === eventId
          ? {
              ...event,
              durationSeconds: Math.max(
                0,
                (event.durationSeconds ?? 0) + deltaSeconds
              ),
            }
          : event
      ),
    })

  }


  /*
    SAVE / FINISH TREATMENT
  */

  function completeTreatment() {

    if (!activeTreatment) {
      return
    }


    const settled =
      settleActualTime(
        activeTreatment,
        Date.now()
      )

    const finalizedPhaseMeta =
      finalizePhaseMeta(
        settled.phaseMeta,
        settled.currentPhaseIndex
      )

    const phaseRecords =
      buildPhaseRecords(
        settled.phases,
        settled.actualTimes,
        finalizedPhaseMeta
      )

    /*
      Totals are built from the phase records (what actually
      happened in this treatment), not by re-summing the live
      template - a skipped phase contributes its expected time
      (it was still planned) but zero actual time.
    */

    const totalExpectedDuration =
      phaseRecords.reduce(
        (total, record) => total + record.expectedDuration,
        0
      )

    const totalActualDuration =
      phaseRecords.reduce(
        (total, record) => total + record.actualDuration,
        0
      )

    const totalOvertimeDuration =
      Math.max(
        0,
        totalActualDuration - totalExpectedDuration
      )


    const completed:
      SavedTreatment = {

      id:
        settled.id,

      patientName:
        settled.patientName,

      patientId:
        settled.patientId,

      toothId:
        settled.toothId,

      procedureName:
        settled.procedureName,

      procedureId:
        settled.procedureId,

      templateName:
        settled.templateName,

      templateId:
        settled.templateId,

      phases:
        settled.phases.map(
          phase => ({ ...phase })
        ),

      date:
        new Date().toISOString(),

      completed: true,

      phaseTimes:
        [...settled.phaseTimes],

      actualTimes:
        [...settled.actualTimes],

      phaseRecords,

      totalExpectedDuration,

      totalActualDuration,

      totalOvertimeDuration,

      events:
        [...settled.events],

      tags:
        [...settled.tags],

      chairEnteredAt:
        settled.chairEnteredAt,

      chairLeftAt:
        settled.chairLeftAt,

      currentPhaseIndex:
        settled.currentPhaseIndex,

      startedAt:
        settled.startedAt,

      completedAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString(),

    }


    const updatedTreatments = [
      ...savedTreatments,
      completed,
    ]


    setSavedTreatments(
      updatedTreatments
    )


    localStorage.setItem(
      'toothTargetSavedTreatments',
      JSON.stringify(
        updatedTreatments
      )
    )

    /*
      The most important automatic sync trigger: fired only once the
      completed treatment has actually been committed to
      toothTargetSavedTreatments above - never on a mere pause, or on
      the incomplete-treatment/active-treatment persistence used
      elsewhere, which are both local-only.
    */
    requestCloudSync()


    localStorage.removeItem(
      'toothTargetActiveTreatment'
    )


    setActiveTreatment(
      null
    )

    setLastCompletedTreatment(
      completed
    )

    setShowEndTreatmentModal(false)

    setScreen('treatmentSummary')

  }


  /*
    END TREATMENT: SAVE AS INCOMPLETE

    Preserves everything about the treatment exactly as it stands -
    completed phases, current phase, timing, interruptions, notes -
    by parking the whole ActiveTreatment object, unchanged, into the
    incomplete-treatments list instead of finalizing it into a
    SavedTreatment. It's paused on save so it doesn't keep silently
    accruing time while parked; resuming it later re-arms the clock
    only when the dentist explicitly presses Resume, same as any
    other paused treatment.
  */

  function saveTreatmentAsIncomplete() {

    if (!activeTreatment) {
      return
    }

    const settled =
      settleActualTime(
        activeTreatment,
        Date.now()
      )

    const parked: ActiveTreatment = {
      ...settled,
      isPaused: true,
      runningSince: null,
      lastUpdated: Date.now(),
    }

    const updatedIncomplete = [
      ...incompleteTreatments,
      parked,
    ]

    setIncompleteTreatments(updatedIncomplete)

    localStorage.setItem(
      'toothTargetIncompleteTreatments',
      JSON.stringify(updatedIncomplete)
    )

    localStorage.removeItem(
      'toothTargetActiveTreatment'
    )

    setActiveTreatment(null)

    setShowEndTreatmentModal(false)

    backToHome()

  }


  /*
    END TREATMENT: DISCARD

    requestDiscardActive/requestDiscardIncomplete only open the
    confirmation - nothing is removed until confirmDiscard() runs,
    so a treatment can never be discarded by a single accidental tap.
  */

  function requestDiscardActive() {
    setShowEndTreatmentModal(false)
    setShowResumePrompt(false)
    setDiscardTarget('active')
  }

  function requestDiscardIncomplete(
    incompleteId: string
  ) {
    setDiscardTarget({ incompleteId })
  }

  function cancelDiscard() {
    setDiscardTarget(null)
  }

  function confirmDiscard() {

    if (discardTarget === 'active') {

      localStorage.removeItem(
        'toothTargetActiveTreatment'
      )

      setActiveTreatment(null)

      setDiscardTarget(null)

      setShowResumePrompt(false)

      backToHome()

      return

    }

    if (discardTarget) {

      const updatedIncomplete =
        incompleteTreatments.filter(
          treatment => treatment.id !== discardTarget.incompleteId
        )

      setIncompleteTreatments(updatedIncomplete)

      localStorage.setItem(
        'toothTargetIncompleteTreatments',
        JSON.stringify(updatedIncomplete)
      )

    }

    setDiscardTarget(null)

  }


  /*
    RESUME AN INCOMPLETE TREATMENT

    Only allowed when nothing is currently active - ToothTarget's
    timer only ever tracks one running treatment at a time, so the
    dentist needs to finish, save-as-incomplete, or discard whatever
    is currently active before picking this one back up.
  */

  function resumeIncompleteTreatment(
    incompleteId: string
  ) {

    if (activeTreatment) {
      return
    }

    const treatment =
      incompleteTreatments.find(
        item => item.id === incompleteId
      )

    if (!treatment) {
      return
    }

    const updatedIncomplete =
      incompleteTreatments.filter(
        item => item.id !== incompleteId
      )

    setIncompleteTreatments(updatedIncomplete)

    localStorage.setItem(
      'toothTargetIncompleteTreatments',
      JSON.stringify(updatedIncomplete)
    )

    setActiveTreatment(treatment)

    setScreen('timer')

  }


  /*
    ACTIVE TREATMENT FOUND PROMPT
  */

  function resumeFromPrompt() {
    setShowResumePrompt(false)
    setScreen('timer')
  }


  /*
    BACK TO HOME
  */

  function backToHome() {

    setPatientSearch('')

    setTreatmentSearchQuery('')

    setSelectedProcedure(null)

    setImportError(null)

    setPendingImportSummary(null)

    setPendingImportData(null)

    setScreen('home')

  }


  /*
    DATA EXPORT & BACKUP (Phase 14)
  */

  function exportBackup() {

    const data: Record<string, unknown> = {}

    for (const key of BACKUP_STORAGE_KEYS) {

      const raw = localStorage.getItem(key)

      if (raw === null) {
        continue
      }

      try {
        data[key] = JSON.parse(raw)
      } catch {
        console.log(`Could not include ${key} in the backup.`)
      }

    }

    const backup = {
      app: 'ToothTarget',
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      data,
    }

    const filenameDate = new Date().toISOString().slice(0, 10)

    downloadTextFile(
      `toothtarget-backup-${filenameDate}.json`,
      JSON.stringify(backup, null, 2),
      'application/json'
    )

  }

  function exportCsv() {

    const header = [
      'Date',
      'Patient',
      'Tooth',
      'Procedure',
      'Template',
      'Expected',
      'Actual',
      'Overtime',
      'Chair Time',
      'Interruptions',
      'Phases (name: actual/expected)',
    ]

    const rows = savedTreatments.map(treatment => {

      const phasesSummary =
        treatment.phaseRecords
          .map(
            phase =>
              `${phase.name}: ${formatTime(phase.actualDuration)}/${formatTime(phase.expectedDuration)}`
          )
          .join(' | ')

      const chairTimeSeconds = computeChairTimeSeconds(treatment)

      return [
        treatment.date,
        treatment.patientName,
        getToothLabel(treatment.toothId),
        treatment.procedureName,
        treatment.templateName,
        formatTime(treatment.totalExpectedDuration),
        formatTime(treatment.totalActualDuration),
        formatTime(treatment.totalOvertimeDuration),
        chairTimeSeconds === null ? 'Not recorded' : formatTime(chairTimeSeconds),
        formatTime(calculateInterruptionSeconds(treatment.events)),
        phasesSummary,
      ]

    })

    const csv =
      [header, ...rows]
        .map(row => row.map(csvEscape).join(','))
        .join('\n')

    const filenameDate = new Date().toISOString().slice(0, 10)

    downloadTextFile(
      `toothtarget-treatments-${filenameDate}.csv`,
      csv,
      'text/csv'
    )

  }

  function triggerImportFilePicker() {
    importFileInputRef.current?.click()
  }

  async function handleImportFileSelected(
    event: ChangeEvent<HTMLInputElement>
  ) {

    const file = event.target.files?.[0]

    /*
      Reset immediately so picking the same filename again later
      still fires a change event.
    */
    event.target.value = ''

    if (!file) {
      return
    }

    setImportError(null)

    try {

      const text = await file.text()
      const parsed = JSON.parse(text)

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.data !== 'object' ||
        parsed.data === null
      ) {
        setImportError(
          'That file is not a valid ToothTarget backup.'
        )
        return
      }

      const data = parsed.data as Record<string, unknown>

      const recognizedKeys =
        BACKUP_STORAGE_KEYS.filter(key => key in data)

      if (recognizedKeys.length === 0) {
        setImportError(
          'That file is not a valid ToothTarget backup.'
        )
        return
      }

      const patientCount =
        Array.isArray(data.toothTargetPatients)
          ? data.toothTargetPatients.length
          : 0

      const savedCount =
        Array.isArray(data.toothTargetSavedTreatments)
          ? data.toothTargetSavedTreatments.length
          : 0

      const incompleteCount =
        Array.isArray(data.toothTargetIncompleteTreatments)
          ? data.toothTargetIncompleteTreatments.length
          : 0

      const templateCount =
        Array.isArray(data.toothTargetTemplates)
          ? data.toothTargetTemplates.length
          : 0

      const procedureCount =
        Array.isArray(data.toothTargetProcedures)
          ? data.toothTargetProcedures.length
          : 0

      const hasActive =
        data.toothTargetActiveTreatment !== undefined &&
        data.toothTargetActiveTreatment !== null

      const summaryParts = [
        `${patientCount} patient${patientCount === 1 ? '' : 's'}`,
        `${savedCount} completed treatment${savedCount === 1 ? '' : 's'}`,
        `${incompleteCount} incomplete treatment${incompleteCount === 1 ? '' : 's'}`,
        `${templateCount} template${templateCount === 1 ? '' : 's'}`,
        `${procedureCount} procedure${procedureCount === 1 ? '' : 's'}`,
      ]

      if (hasActive) {
        summaryParts.push('1 in-progress treatment')
      }

      setPendingImportSummary(summaryParts.join(', '))
      setPendingImportData(data)

    } catch {

      setImportError(
        'That file could not be read as a backup - it may be damaged or not a ToothTarget export.'
      )

    }

  }

  function cancelImport() {
    setPendingImportSummary(null)
    setPendingImportData(null)
  }

  function confirmImport() {

    if (!pendingImportData) {
      return
    }

    for (const key of BACKUP_STORAGE_KEYS) {

      if (key in pendingImportData) {
        localStorage.setItem(
          key,
          JSON.stringify(pendingImportData[key])
        )
      }

    }

    /*
      The LOAD SAVED DATA effect only runs on mount, so a full
      reload is the simplest way to re-hydrate every piece of state
      from the newly-imported localStorage consistently - it reuses
      all the same shape validation/migration the app already trusts
      for normal startup, instead of duplicating it here.
    */
    window.location.reload()

  }



  /*
    EDIT PATIENT (Phase 4.6)

    Opens pre-filled with the patient's CURRENT name/number (called
    from the Patient screen, which already has the resolved record in
    scope) - editPatientRecord() itself re-reads the registry fresh
    under the same cross-tab lock allocation/deletion use, so what
    actually gets edited is never this tab's possibly-stale copy.
  */

  function requestEditPatient(patient: Patient) {
    setEditPatientName(patient.name)
    setEditPatientNumberInput(String(patient.patientNumber))
    setEditPatientError(null)
    setShowEditPatient(true)
  }

  function cancelEditPatient() {
    setShowEditPatient(false)
    setEditPatientError(null)
  }

  async function confirmEditPatient(patientId: string) {

    const parsedNumber = Number(editPatientNumberInput)

    setEditPatientBusy(true)

    const result =
      await editPatientRecord(patientId, editPatientName, parsedNumber)

    setEditPatientBusy(false)

    if (!result.edited) {
      setEditPatientError(result.reason)
      return
    }

    setSavedPatients(result.patients)

    setPatientNumberConflicts(result.conflicts)

    /*
      selectedPatient (this screen's own "which patient" identifier)
      is a NAME, not a UUID - if the name just changed, it has to be
      updated too, or this screen would immediately fail to resolve
      selectedPatientRecord against the now-renamed registry entry on
      the very next render.
    */
    const updatedRecord =
      result.patients.find(patient => patient.id === patientId)

    if (updatedRecord) {
      setSelectedPatient(updatedRecord.name)
    }

    /*
      Rename cascade (Phase 4.6, Part E) - editPatientRecordUnderLock()
      already wrote the renamed treatments to localStorage when the
      name changed; this just mirrors that same array into React state
      so the History screen reflects it immediately, without a reload.
      Committed to localStorage above, synchronously, before
      requestCloudSync() below - no separate sync call needed.
    */
    if (result.renamedSavedTreatments) {
      setSavedTreatments(result.renamedSavedTreatments)
    }

    requestCloudSync()

    setShowEditPatient(false)

    setEditPatientError(null)

  }


  /*
    DELETE PATIENT
  */

  function requestDeletePatient() {
    setDeletePatientBlockedReason(null)
    setShowDeleteConfirm(true)
  }

  function cancelDeletePatient() {
    setShowDeleteConfirm(false)
    setDeletePatientBlockedReason(null)
  }

  /*
    SHARED PATIENT-DELETION CORE (Phase 4.7 extraction)

    Everything confirmDeletePatient() below used to do inline, minus the
    three UI-only concerns that differ by caller (closing whichever
    confirm modal is open, clearing selectedHistoryTreatment, and which
    screen to land on afterward) - factored out so
    confirmDiscardStaleReviewPatient() (the review screen's "Discard"
    action) can reuse the EXACT same cascade-plan/tombstone/sync logic
    a normal patient deletion already uses, per this phase's own
    requirement that discarding "behave like a normal deletion", not a
    second, parallel implementation of it. Takes an explicit id/name
    pair rather than reading `selectedPatient` itself, since the review
    screen's caller already knows exactly which candidate it's acting
    on and has no dependency on which patient (if any) is currently
    open on the Patient screen.
  */

  async function deletePatientRecordAndCascade(
    patientIdToDelete: string | undefined,
    nameToDelete: string
  ): Promise<
    | { blocked: true; reason: string }
    | { blocked: false; deleted: boolean }
  > {

    const lowercasedNameToDelete = nameToDelete.toLowerCase()

    const patientToDelete =
      patientIdToDelete
        ? savedPatients.find(patient => patient.id === patientIdToDelete)
        : savedPatients.find(
            patient => patient.name.toLowerCase() === lowercasedNameToDelete
          )

    /*
      CASCADE PLAN (Phase 4.5)

      planPatientDeletionCascade() (patientDeletionCascade.ts) is the
      single source of truth for what a patient deletion does to their
      treatments, including the active-treatment block - see that
      file's own header comment for the full reasoning. Collections
      are read fresh from localStorage here, not this tab's own
      possibly-stale savedTreatments/incompleteTreatments/
      activeTreatment state, same reasoning as every other collection
      re-read in this file.
    */

    const cascadePlan = planPatientDeletionCascade({
      patientToDelete:
        patientToDelete
          ? { id: patientToDelete.id, name: patientToDelete.name }
          : undefined,
      nameToDelete: lowercasedNameToDelete,
      savedTreatments: readPersistedSavedTreatments(),
      incompleteTreatments: readPersistedIncompleteTreatments(),
      activeTreatment: readPersistedActiveTreatment(),
    })

    if (cascadePlan.blocked) {
      return { blocked: true, reason: cascadePlan.reason }
    }

    /*
      PATIENT REGISTRY

      Deletion is identified by the patient's stable UUID, never by
      name, and the actual removal runs under the exact same
      cross-tab lock allocatePatient() uses (toothtarget-patient-
      allocation), against the registry as it exists AT THAT MOMENT -
      re-read fresh from localStorage inside deletePatientFromRegistry(),
      never the in-memory savedPatients array below, which could be
      stale if another tab changed the registry since this tab last
      loaded it. This only removes the one matching entry - it never
      touches toothTargetNextPatientNumber or any other patient's own
      id/patientNumber/name, so numbers stay permanent and are never
      reused. A deletion tombstone for the same UUID is recorded as
      part of the same locked operation - see removePatientFromCurrentList().
    */

    const registryResult =
      patientToDelete
        ? await deletePatientFromRegistry(patientToDelete.id)
        : null

    const patientsAfterDelete = registryResult?.patients ?? savedPatients

    setSavedPatients(patientsAfterDelete)

    /*
      Deleting a patient can resolve (or leave stale) an unrelated
      patient-number conflict record - eg. deleting one of two
      patients that shared a number leaves only one holder, so that
      conflict is no longer genuine. Reconciling here keeps the
      conflict badge/list honest immediately, in the same tab that
      just changed the registry, rather than waiting for a reload.
    */

    setPatientNumberConflicts(
      reconcileAndPersistPatientNumberConflicts(patientsAfterDelete)
    )

    /*
      TREATMENT / HISTORY CLEANUP (Phase 4.5 - now tombstones saved
      treatments too, applying the plan computed above)
    */

    setSavedTreatments(cascadePlan.survivingSavedTreatments)

    localStorage.setItem(
      'toothTargetSavedTreatments',
      JSON.stringify(cascadePlan.survivingSavedTreatments)
    )

    /*
      Each removed saved treatment is tombstoned (never just dropped
      silently) so its removal propagates through cloud sync instead
      of reappearing from another device's older copy on a future
      merge - the exact same pattern the orphaned-treatment cleanup
      migration already uses (see this file's own load-time migration
      effect and appendTombstone()'s own comment). Without this, a
      synced device would simply re-merge the "deleted" treatment back
      in on its next sync, since a plain removal here has nothing to
      tell the merge engine it was intentional.
    */

    for (const removedId of cascadePlan.removedSavedTreatmentIds) {
      appendTombstone('treatment', removedId)
    }

    setIncompleteTreatments(cascadePlan.survivingIncompleteTreatments)

    localStorage.setItem(
      'toothTargetIncompleteTreatments',
      JSON.stringify(cascadePlan.survivingIncompleteTreatments)
    )

    /*
      One coalesced sync request for the whole deletion transaction
      (patient registry + saved-treatment cleanup + tombstones), fired
      only once everything above has already committed successfully -
      never between the individual steps. Skipped entirely when
      registryResult.deleted is false (eg. another tab already deleted
      this exact patient), since nothing synchronized actually changed
      from this tab's perspective.
    */
    if (registryResult?.deleted) {
      requestCloudSync()
    }

    return { blocked: false, deleted: registryResult?.deleted ?? false }

  }

  async function confirmDeletePatient() {

    const result =
      await deletePatientRecordAndCascade(undefined, selectedPatient)

    if (result.blocked) {

      setDeletePatientBlockedReason(result.reason)

      return

    }

    setDeletePatientBlockedReason(null)

    setShowDeleteConfirm(false)

    setSelectedHistoryTreatment(null)

    backToHome()

  }

  /*
    STALE-RECORD REVIEW SCREEN (Phase 4.7)

    See this file's own pendingStaleReview/staleReviewDecidedIds state
    comments above for the overall design. "View Full Record" reuses
    the existing Patient screen wholesale (requirement 5 - complete
    treatment history, not a second, cut-down summary view) rather than
    building a separate read-only viewer; the only new behavior needed
    is remembering to come back HERE instead of Home afterward.
  */

  function viewStaleReviewPatientRecord(candidate: StaleReviewCandidate) {

    setSelectedPatient(candidate.name)

    setPatientSearch(candidate.name)

    setStaleReviewReturnActive(true)

    setScreen('patient')

  }

  function returnFromStaleReviewPatientView() {

    setStaleReviewReturnActive(false)

    setScreen('staleReview')

  }

  /*
    "Keep" writes nothing at all - the patient simply stays exactly as
    it already is, a completely normal local patient, and reaches the
    cloud the ordinary way on the resumed sync finishStaleReview()
    triggers. Only this tab's own in-session decision bookkeeping is
    updated, so the review list stops asking about it again.
  */
  function keepStaleReviewPatient(patientId: string) {

    setStaleReviewActionError(null)

    setStaleReviewDecidedIds(previous => {
      const next = new Set(previous)
      next.add(patientId)
      return next
    })

  }

  function requestDiscardStaleReviewPatient(patientId: string) {
    setStaleReviewActionError(null)
    setStaleReviewDiscardTargetId(patientId)
  }

  function cancelDiscardStaleReviewPatient() {
    setStaleReviewDiscardTargetId(null)
  }

  /*
    Reuses deletePatientRecordAndCascade() - the exact same cascade
    plan, tombstone, and requestCloudSync() a normal patient deletion
    already uses (requirement 6: discarding must behave like a real
    deletion, not a silent removal). The active-treatment block can, in
    principle, still fire here (a candidate patient could have picked up
    a fresh active treatment on this device since the review began) -
    surfaced as an inline error on the review screen rather than losing
    the dentist's "discard" decision silently.
  */
  async function confirmDiscardStaleReviewPatient() {

    const candidate =
      (pendingStaleReview ?? []).find(
        item => item.patientId === staleReviewDiscardTargetId
      )

    setStaleReviewDiscardTargetId(null)

    if (!candidate) {
      return
    }

    const result =
      await deletePatientRecordAndCascade(candidate.patientId, candidate.name)

    if (result.blocked) {
      setStaleReviewActionError(result.reason)
      return
    }

    setStaleReviewActionError(null)

    setStaleReviewDecidedIds(previous => {
      const next = new Set(previous)
      next.add(candidate.patientId)
      return next
    })

  }

  /*
    Called once every candidate has been kept or discarded. Resets this
    tab's own decision bookkeeping (nothing left to remember - the next
    stale episode, if one ever happens again, starts from a clean
    slate) and hands off to resumeSyncAfterStaleReview()
    (cloudSyncScheduler.ts), which clears the pending review and
    requests exactly one more sync attempt that skips the gate this
    review just satisfied.
  */
  function finishStaleReview() {

    setStaleReviewDecidedIds(new Set())

    setStaleReviewActionError(null)

    resumeSyncAfterStaleReview()

    setScreen('home')

  }

  /*
    PATIENT-NUMBER CONFLICT RESOLUTION (Phase 4)

    Two-step, explicit-confirmation flow, matching section 12's
    required copy: picking a patient in the browser only stages the
    choice (conflictKeepChoice) - nothing is written until the
    dentist explicitly confirms in the second modal. Cancelling either
    modal discards the staged choice without touching localStorage.
  */

  function openConflictBrowser() {
    setShowConflictBrowser(true)
  }

  function closeConflictBrowser() {
    setShowConflictBrowser(false)
    setConflictKeepChoice(null)
    setConflictResolutionError(null)
  }

  function chooseConflictKeeper(
    patientNumber: number,
    keepPatientId: string
  ) {
    setConflictKeepChoice({ patientNumber, keepPatientId })
    setConflictResolutionError(null)
  }

  function cancelConflictChoice() {
    setConflictKeepChoice(null)
  }

  async function confirmConflictResolution() {

    if (!conflictKeepChoice) {
      return
    }

    const result =
      await resolvePatientNumberConflict(
        conflictKeepChoice.patientNumber,
        conflictKeepChoice.keepPatientId
      )

    setSavedPatients(result.patients)

    setPatientNumberConflicts(result.conflicts)

    /*
      Phase 8 addition: a resolved conflict changes patientNumber on
      the renumbered patient(s) - part of the synchronized Patient
      record - so the corrected registry needs to reach the cloud, or
      another device could still see (and re-report) the same
      collision. Gated on result.resolved so a stale/no-op resolution
      attempt (eg. already resolved by another tab) never fires a
      pointless sync.
    */
    if (result.resolved) {
      requestCloudSync()
    }

    setConflictKeepChoice(null)

    setConflictResolutionError(
      result.resolved ? null : result.reason
    )

  }


  /*
    TREATMENT HISTORY DETAIL

    Phase 4.6: previously read-only (TreatmentSummaryCard renders no
    inputs) - now also offers deleting this one treatment outright, or
    editing its phase timings, without touching its patient or any
    other treatment. Both close back to the Patient screen, same as
    the read-only "back" flow already did.
  */

  function openTreatmentDetail(
    treatment: SavedTreatment
  ) {

    setSelectedHistoryTreatment(treatment)

    setScreen('treatmentDetail')

  }

  function closeTreatmentDetail() {

    setSelectedHistoryTreatment(null)

    setScreen('patient')

  }

  /*
    DELETE ONE SAVED TREATMENT (Phase 4.6)

    Distinct from deleting a whole patient (which cascades to every
    one of their treatments, Phase 4.5) - this removes exactly the one
    treatment currently open here, tombstoning it the same way any
    other treatment removal already does (orphan cleanup, patient-
    deletion cascade), so the deletion propagates through sync instead
    of reappearing from another device's older copy.
  */

  function requestDeleteTreatment() {
    setShowDeleteTreatmentConfirm(true)
  }

  function cancelDeleteTreatment() {
    setShowDeleteTreatmentConfirm(false)
  }

  function confirmDeleteTreatment() {

    if (!selectedHistoryTreatment) {
      return
    }

    const treatmentId = selectedHistoryTreatment.id

    const currentSavedTreatments = readPersistedSavedTreatments()

    const updatedTreatments =
      currentSavedTreatments.filter(
        treatment => treatment.id !== treatmentId
      )

    setSavedTreatments(updatedTreatments)

    localStorage.setItem(
      'toothTargetSavedTreatments',
      JSON.stringify(updatedTreatments)
    )

    appendTombstone('treatment', treatmentId)

    requestCloudSync()

    setShowDeleteTreatmentConfirm(false)

    closeTreatmentDetail()

  }

  /*
    EDIT PHASE TIMINGS OF A SAVED TREATMENT (Phase 4.6)

    Edits actualDuration on each of this treatment's phaseRecords - the
    figures TreatmentSummaryCard/statistics.ts actually read for a
    completed treatment (phaseTimes/actualTimes are only ever consulted
    for an ACTIVE/incomplete treatment's live timer - see
    ActiveTreatment's own fields - so they are deliberately left
    untouched here rather than kept in sync with data nothing displays
    for a completed one). Minutes, not seconds, to match this app's
    existing "minimal typing" duration inputs elsewhere (eg. template
    phase editing) - entered as whole minutes and converted to seconds
    on save.
  */

  function requestEditTreatmentPhases() {

    if (!selectedHistoryTreatment) {
      return
    }

    setEditPhaseMinutes(
      selectedHistoryTreatment.phaseRecords.map(
        record => String(Math.round(record.actualDuration / 60))
      )
    )

    setShowEditTreatmentPhases(true)

  }

  function cancelEditTreatmentPhases() {
    setShowEditTreatmentPhases(false)
  }

  function updateEditPhaseMinutes(index: number, value: string) {

    setEditPhaseMinutes(current =>
      current.map((minutes, i) => (i === index ? value : minutes))
    )

  }

  function confirmEditTreatmentPhases() {

    if (!selectedHistoryTreatment) {
      return
    }

    const treatmentId = selectedHistoryTreatment.id

    const updatedPhaseRecords =
      selectedHistoryTreatment.phaseRecords.map((record, index) => {

        const parsedMinutes = Number(editPhaseMinutes[index])

        const actualDuration =
          Number.isFinite(parsedMinutes) && parsedMinutes >= 0
            ? Math.round(parsedMinutes * 60)
            : record.actualDuration

        return { ...record, actualDuration }

      })

    const totalActualDuration =
      updatedPhaseRecords.reduce(
        (total, record) => total + record.actualDuration,
        0
      )

    const totalOvertimeDuration =
      Math.max(
        0,
        totalActualDuration - selectedHistoryTreatment.totalExpectedDuration
      )

    const updatedTreatment: SavedTreatment = {
      ...selectedHistoryTreatment,
      phaseRecords: updatedPhaseRecords,
      totalActualDuration,
      totalOvertimeDuration,
      updatedAt: new Date().toISOString(),
    }

    const currentSavedTreatments = readPersistedSavedTreatments()

    const updatedTreatments =
      currentSavedTreatments.map(treatment =>
        treatment.id === treatmentId ? updatedTreatment : treatment
      )

    setSavedTreatments(updatedTreatments)

    localStorage.setItem(
      'toothTargetSavedTreatments',
      JSON.stringify(updatedTreatments)
    )

    setSelectedHistoryTreatment(updatedTreatment)

    requestCloudSync()

    setShowEditTreatmentPhases(false)

  }


  /*
    MANAGE TEMPLATES
  */

  function openManageTemplates() {

    setTemplateBrowseSpecializationId(null)

    setTemplateBrowseProcedureKey(null)

    setTemplateBrowseTypeId(null)

    setDeleteTemplateConfirmId(null)

    setScreen('manageTemplates')

  }

  /*
    TEMPLATE BROWSER NAVIGATION

    Each select* function advances one level of the Specialization ->
    Procedure -> Type drill-down; backTemplateBrowseStep() unwinds it
    one level at a time, only falling back to leaving the screen
    entirely once already at the top.
  */

  function selectTemplateBrowseSpecialization(specializationId: string) {
    setTemplateBrowseSpecializationId(specializationId)
  }

  function selectTemplateBrowseProcedure(procedureKey: string) {
    setTemplateBrowseProcedureKey(procedureKey)
  }

  function selectTemplateBrowseType(typeId: string) {
    setTemplateBrowseTypeId(typeId)
  }

  function backTemplateBrowseStep() {

    if (templateBrowseTypeId !== null) {
      setTemplateBrowseTypeId(null)
      return
    }

    if (templateBrowseProcedureKey !== null) {
      setTemplateBrowseProcedureKey(null)
      return
    }

    if (templateBrowseSpecializationId !== null) {
      setTemplateBrowseSpecializationId(null)
      return
    }

    backToHome()

  }

  function openTemplateEditor(
    templateId: string
  ) {

    const template =
      templates.find(
        item => item.id === templateId
      )

    if (!template) {
      return
    }

    setEditingTemplateId(template.id)

    setTemplateDraft({
      id: template.id,
      name: template.name,
      phases: template.phases.map(
        phase => ({ ...phase })
      ),
      specializationId: template.specializationId,
      procedureKey: template.procedureKey,
      typeId: template.typeId,
    })

    setDuplicateTemplateWarning(null)

    setShowRestoreDefaultConfirm(false)

    setScreen('templateEditor')

  }

  /*
    Always opened from within a specific Type bucket in the browser,
    so the new template is filed there directly rather than needing
    a separate classification step in the editor itself.
  */

  function openNewTemplateDraft(
    specializationId: string,
    procedureKey: string,
    typeId: string
  ) {

    setEditingTemplateId(null)

    setTemplateDraft({
      id: crypto.randomUUID(),
      name: '',
      phases: [],
      specializationId,
      procedureKey,
      typeId,
    })

    setDuplicateTemplateWarning(null)

    setShowRestoreDefaultConfirm(false)

    setScreen('templateEditor')

  }

  /*
    DUPLICATE AN EXISTING TEMPLATE

    Opens the editor pre-filled with a copy of another template, as
    a starting point - not yet saved, and not itself a duplicate
    until/unless the dentist saves it without changing the name
    (saveTemplateDraft() would then catch that). The copy stays in
    the same Specialization/Procedure/Type bucket as the original.
  */

  function duplicateTemplate(
    templateId: string
  ) {

    const template =
      templates.find(
        item => item.id === templateId
      )

    if (!template) {
      return
    }

    setEditingTemplateId(null)

    setTemplateDraft({
      id: crypto.randomUUID(),
      name: `${template.name} (Copy)`,
      phases: template.phases.map(
        phase => ({ ...phase })
      ),
      specializationId: template.specializationId,
      procedureKey: template.procedureKey,
      typeId: template.typeId,
    })

    setDuplicateTemplateWarning(null)

    setShowRestoreDefaultConfirm(false)

    setScreen('templateEditor')

  }

  /*
    DELETE A CUSTOM TEMPLATE

    Built-in templates can't be deleted this way (only reset via
    Restore Default in the editor) - removing one would silently
    break resolveTemplate() for any procedure/region still pointing
    at it. Custom templates are safe to remove outright: nothing else
    in the taxonomy depends on their id existing.
  */

  function requestDeleteTemplate(templateId: string) {
    setDeleteTemplateConfirmId(templateId)
  }

  function cancelDeleteTemplate() {
    setDeleteTemplateConfirmId(null)
  }

  /*
    Cross-tab safe, mirroring confirmDeletePatient(): the actual
    removal runs under the toothtarget-template-deletion lock, against
    the persisted template list re-read fresh at that moment (never
    this tab's own possibly-stale templates state) - see
    deleteTemplateFromRegistry()/removeTemplateFromCurrentList() above
    App(). Only ever deletes a template that's still isCustom === true
    in that fresh read; a built-in, or a template already removed by
    another tab, is left untouched and no tombstone is created for it.
  */
  async function confirmDeleteTemplate() {

    if (!deleteTemplateConfirmId) {
      return
    }

    const registryResult =
      await deleteTemplateFromRegistry(deleteTemplateConfirmId)

    setTemplates(registryResult.templates)

    /*
      One sync request for the completed deletion (template removal +
      its tombstone, both already committed inside
      deleteTemplateFromRegistry()) - skipped when nothing was
      actually deleted (eg. already removed by another tab).
    */
    if (registryResult.deleted) {
      requestCloudSync()
    }

    setDeleteTemplateConfirmId(null)

  }

  /*
    REORDER TEMPLATES WITHIN A BUCKET

    Templates from every bucket share one flat array, so "up"/"down"
    swaps this template with its nearest same-bucket neighbor in that
    array rather than a literal adjacent index - otherwise moving a
    template could reorder it past templates from a different
    Specialization/Procedure/Type entirely.
  */

  function moveTemplate(templateId: string, direction: -1 | 1) {

    const template =
      templates.find(item => item.id === templateId)

    if (!template) {
      return
    }

    const bucketIds =
      templates
        .filter(
          item =>
            item.specializationId === template.specializationId &&
            item.procedureKey === template.procedureKey &&
            item.typeId === template.typeId
        )
        .map(item => item.id)

    const positionInBucket = bucketIds.indexOf(templateId)

    const targetPositionInBucket = positionInBucket + direction

    if (
      targetPositionInBucket < 0 ||
      targetPositionInBucket >= bucketIds.length
    ) {
      return
    }

    const otherId = bucketIds[targetPositionInBucket]

    const indexA = templates.findIndex(item => item.id === templateId)
    const indexB = templates.findIndex(item => item.id === otherId)

    const updatedTemplates = [...templates]

    updatedTemplates[indexA] = templates[indexB]
    updatedTemplates[indexB] = templates[indexA]

    setTemplates(updatedTemplates)

    localStorage.setItem(
      'toothTargetTemplates',
      JSON.stringify(updatedTemplates)
    )

  }

  function closeTemplateEditor() {

    setTemplateDraft(null)

    setEditingTemplateId(null)

    setDuplicateTemplateWarning(null)

    setShowRestoreDefaultConfirm(false)

    setScreen('manageTemplates')

  }

  function updateDraftName(
    name: string
  ) {

    if (!templateDraft) {
      return
    }

    setTemplateDraft({
      ...templateDraft,
      name,
    })

  }

  function addDraftPhase() {

    if (!templateDraft) {
      return
    }

    setTemplateDraft({
      ...templateDraft,
      phases: [
        ...templateDraft.phases,
        { name: '', duration: 10 * 60 },
      ],
    })

  }

  function updateDraftPhaseName(
    index: number,
    name: string
  ) {

    if (!templateDraft) {
      return
    }

    const phases =
      [...templateDraft.phases]

    phases[index] = {
      ...phases[index],
      name,
    }

    setTemplateDraft({
      ...templateDraft,
      phases,
    })

  }

  function updateDraftPhaseDuration(
    index: number,
    minutes: number
  ) {

    if (!templateDraft) {
      return
    }

    const phases =
      [...templateDraft.phases]

    phases[index] = {
      ...phases[index],
      duration: Math.max(
        0,
        Math.round(minutes * 60)
      ),
    }

    setTemplateDraft({
      ...templateDraft,
      phases,
    })

  }

  function removeDraftPhase(
    index: number
  ) {

    if (!templateDraft) {
      return
    }

    setTemplateDraft({
      ...templateDraft,
      phases:
        templateDraft.phases.filter(
          (_, i) => i !== index
        ),
    })

  }

  function moveDraftPhase(
    index: number,
    direction: -1 | 1
  ) {

    if (!templateDraft) {
      return
    }

    const target = index + direction

    if (
      target < 0 ||
      target >= templateDraft.phases.length
    ) {
      return
    }

    const phases =
      [...templateDraft.phases]

    const [moved] =
      phases.splice(index, 1)

    phases.splice(target, 0, moved)

    setTemplateDraft({
      ...templateDraft,
      phases,
    })

  }

  function saveTemplateDraft() {

    if (!templateDraft) {
      return
    }

    const cleanName =
      templateDraft.name.trim()

    if (
      cleanName === '' ||
      templateDraft.phases.length === 0
    ) {
      return
    }

    const cleanedPhases =
      templateDraft.phases.map(phase => ({
        name: phase.name.trim() || 'Phase',
        duration: phase.duration,
      }))

    /*
      Duplicate-checking is scoped to the draft's own bucket - the
      same name/phases in two different Specialization/Procedure/Type
      buckets (eg. two unrelated "Standard" templates) are not the
      same template.
    */

    const bucketTemplates =
      templates.filter(
        item =>
          item.specializationId === templateDraft.specializationId &&
          item.procedureKey === templateDraft.procedureKey &&
          item.typeId === templateDraft.typeId
      )

    const duplicate =
      findExactDuplicateTemplate(
        cleanName,
        cleanedPhases,
        bucketTemplates,
        templateDraft.id
      )

    if (duplicate) {

      setDuplicateTemplateWarning(duplicate)

      return

    }

    const existingTemplate =
      editingTemplateId
        ? templates.find(
            item => item.id === editingTemplateId
          )
        : null

    const savedTemplate:
      ProcedureTemplate = {

      id: templateDraft.id,

      name: cleanName,

      phases: cleanedPhases,

      isCustom:
        existingTemplate
          ? existingTemplate.isCustom
          : true,

      specializationId: templateDraft.specializationId,

      procedureKey: templateDraft.procedureKey,

      typeId: templateDraft.typeId,

      /*
        This function only ever runs from the explicit Save button in
        the template editor - never on load, view, selection, or any
        other re-render - so every call here is a genuine, dentist-
        initiated content save. A brand-new template (existingTemplate
        is null) and a duplicated template (its draft carries no prior
        updatedAt to preserve) both fall into this same "just saved"
        case, so one fresh timestamp on every save correctly covers
        creation, editing, and duplication alike.
      */
      updatedAt: new Date().toISOString(),

    }

    const alreadyExists =
      templates.some(
        item => item.id === savedTemplate.id
      )

    const updatedTemplates =
      alreadyExists
        ? templates.map(item =>
            item.id === savedTemplate.id
              ? savedTemplate
              : item
          )
        : [...templates, savedTemplate]

    setTemplates(updatedTemplates)

    localStorage.setItem(
      'toothTargetTemplates',
      JSON.stringify(updatedTemplates)
    )

    /*
      Only custom templates are part of the synchronized dataset -
      editing/overriding a built-in (isCustom stays false) never
      touches customTemplates in the cloud document, so syncing then
      would accomplish nothing. savedTemplate.updatedAt was already
      set above by the existing Phase 2 logic; this trigger does not
      touch it.
    */
    if (savedTemplate.isCustom) {
      requestCloudSync()
    }

    setTemplateDraft(null)

    setEditingTemplateId(null)

    setScreen('manageTemplates')

  }

  /*
    DUPLICATE WARNING

    "Use Existing Template" takes the dentist to the template that
    already matches, instead of creating another copy of it.
  */

  function cancelDuplicateWarning() {
    setDuplicateTemplateWarning(null)
  }

  function useExistingTemplate() {

    if (!duplicateTemplateWarning) {
      return
    }

    openTemplateEditor(duplicateTemplateWarning.id)

  }

  /*
    RESTORE BUILT-IN DEFAULT

    Resets the draft back to the template's original seeded
    configuration - the dentist still has to press Save Template to
    actually commit it, same as any other edit.
  */

  function requestRestoreDefault() {
    setShowRestoreDefaultConfirm(true)
  }

  function cancelRestoreDefault() {
    setShowRestoreDefaultConfirm(false)
  }

  function restoreTemplateToDefault() {

    if (!templateDraft) {
      return
    }

    const original =
      BUILTIN_TEMPLATES.find(
        template => template.id === templateDraft.id
      )

    if (!original) {
      return
    }

    setTemplateDraft({
      id: original.id,
      name: original.name,
      phases: original.phases.map(
        phase => ({ ...phase })
      ),
      specializationId: original.specializationId,
      procedureKey: original.procedureKey,
      typeId: original.typeId,
    })

    setShowRestoreDefaultConfirm(false)

  }


  /*
    =========================================
    HOME
    =========================================
  */

  if (screen === 'home') {

    return (

      <div className="app">

        <div className="header">

          <img
            src={logo}
            alt="ToothTarget"
            className="home-logo"
          />

          <p>
            Dental procedure timing
          </p>

        </div>


        {patientNumberConflicts.length > 0 && (

          <div className="patient-conflict-banner-container">

            <button
              type="button"
              className="patient-conflict-banner"
              onClick={openConflictBrowser}
            >
              ⚠ Patient number conflicts ({patientNumberConflicts.length})
            </button>

          </div>

        )}


        {pendingStaleReview && pendingStaleReview.length > 0 && (

          <div className="patient-conflict-banner-container">

            <button
              type="button"
              className="patient-conflict-banner"
              onClick={() => setScreen('staleReview')}
            >
              ⚠ Review needed before syncing can continue (
              {
                pendingStaleReview.filter(
                  candidate => !staleReviewDecidedIds.has(candidate.patientId)
                ).length
              }
              )
            </button>

          </div>

        )}


        <div className="home-nav-grid">

          <button
            type="button"
            onClick={() => setScreen('treatmentSearch')}
          >
            <span className="home-nav-icon" aria-hidden="true">🔍</span>
            Search Treatments
          </button>

          <button
            type="button"
            onClick={() => setScreen('statistics')}
          >
            <span className="home-nav-icon" aria-hidden="true">📊</span>
            Statistics
          </button>

          <button
            type="button"
            onClick={openManageTemplates}
          >
            <span className="home-nav-icon" aria-hidden="true">🗂️</span>
            Manage Procedure Templates
          </button>

          <button
            type="button"
            onClick={() => setScreen('settings')}
          >
            <span className="home-nav-icon" aria-hidden="true">⚙️</span>
            Settings
          </button>

        </div>


        <div className="patient-search-container">

          <input
            className="patient-search"
            type="text"
            placeholder="Enter patient name..."
            value={patientSearch}
            onChange={
              event =>
                setPatientSearch(
                  event.target.value
                )
            }
          />


<div className="patient-list">

  {filteredPatients.map(
    patient => (

      <button
        key={patient.name}
        type="button"
        className="patient-list-item"
        onClick={() =>
          openPatient(patient.name)
        }
      >
        <span className="patient-list-item-number">
          {patient.patientNumber !== null ? patient.patientNumber : ''}
        </span>
        <span className="patient-list-item-name">
          {patient.name}
        </span>
      </button>

    )
  )}

  {patientSearch.trim() !== '' &&
    !patients.some(
      patient =>
        patient.name.toLowerCase() ===
        patientSearch.trim().toLowerCase()
    ) && (

      <button
        type="button"
        className="patient-list-item create-patient"
        onClick={() =>
          openPatient(
            patientSearch.trim()
          )
        }
      >
        + Create Patient "{patientSearch.trim()}"
      </button>

    )}

        </div> {/* patient-list */}

      </div> {/* patient-search-container */}

        {activeTreatment && (

          <div className="active-treatment-card">

            <div>

              <strong>
                Active treatment
              </strong>

              <p>
                {activeTreatment.patientName}
                {' — '}
                {getToothLabel(activeTreatment.toothId)}
              </p>

            </div>

            <button
              type="button"
              onClick={() =>
                setScreen('timer')
              }
            >
              Resume
            </button>

          </div>

        )}


        {showResumePrompt && activeTreatment && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Active Treatment Found
              </h2>

              <p className="duplicate-template-name">
                {getToothLabel(activeTreatment.toothId)}
                {' — '}
                {activeTreatment.procedureName}
              </p>

              <p>
                Current phase:{' '}
                {activeTreatment.phases[activeTreatment.currentPhaseIndex]
                  ?.name}
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={resumeFromPrompt}
                >
                  Resume Treatment
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={requestDiscardActive}
                >
                  Discard
                </button>

              </div>

            </div>

          </div>

        )}


        {discardTarget === 'active' && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Discard this treatment?
              </h2>

              <p>
                All timing information from this treatment will be
                lost.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelDiscard}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmDiscard}
                >
                  Discard
                </button>

              </div>

            </div>

          </div>

        )}


        {showConflictBrowser && !activeConflictChoice && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Patient number conflicts
              </h2>

              {conflictResolutionError && (

                <p className="conflict-resolution-error">
                  {conflictResolutionError}
                </p>

              )}

              {patientConflictDisplay.length === 0 ? (

                <p>
                  All patient number conflicts have been resolved.
                </p>

              ) : (

                patientConflictDisplay.map(conflict => (

                  <div
                    key={conflict.patientNumber}
                    className="patient-conflict-group"
                  >

                    <p className="patient-conflict-heading">
                      Patient number #{conflict.patientNumber} is
                      currently assigned to:
                    </p>

                    <div className="patient-conflict-choices">

                      {conflict.patients.map(patient => (

                        <button
                          key={patient.id}
                          type="button"
                          className="patient-conflict-choice"
                          onClick={() =>
                            chooseConflictKeeper(
                              conflict.patientNumber,
                              patient.id
                            )
                          }
                        >
                          #{conflict.patientNumber} — {patient.name}
                          {patient.disambiguator &&
                            ` (${patient.disambiguator})`}
                        </button>

                      ))}

                    </div>

                    <p className="patient-conflict-hint">
                      Choose which patient should retain #{conflict.patientNumber}.
                    </p>

                  </div>

                ))

              )}

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={closeConflictBrowser}
                >
                  Close
                </button>

              </div>

            </div>

          </div>

        )}


        {activeConflictChoice && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Confirm patient number #{activeConflictChoice.patientNumber}
              </h2>

              <p>
                {activeConflictChoice.keepPatient?.name ?? 'This patient'}
                {' '}keeps #{activeConflictChoice.patientNumber}.
              </p>

              <p>
                {activeConflictChoice.otherPatients.length > 0
                  ? activeConflictChoice.otherPatients
                      .map(patient => patient.name)
                      .join(', ')
                  : 'The other patient'}
                {' '}will be assigned a new patient number.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelConflictChoice}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={confirmConflictResolution}
                >
                  Confirm
                </button>

              </div>

            </div>

          </div>

        )}

      </div>

    )

  }

  /*
    =========================================
    PATIENT PAGE
    =========================================
  */

  if (screen === 'patient') {

    /*
      Resolves the selected patient (a name, via the app's existing
      selectedPatient mechanism - unchanged) to its actual Patient
      record in the current registry, purely so the treatment filters
      below can identify history by UUID instead of name alone. If
      the name no longer matches any registered patient (eg. it was
      deleted), this stays undefined and every filter below safely
      falls back to its existing name-based behavior below - never
      guessing or inventing a replacement patient record.
    */

    const selectedPatientRecord =
      savedPatients.find(
        patient =>
          patient.name.toLowerCase() ===
          selectedPatient.toLowerCase()
      )

    /*
      Matches a treatment to the currently-open patient by UUID
      whenever the treatment has a valid one - this is what prevents
      two different patients who happen to share a name from having
      their histories merged on this screen. Only falls back to the
      historical case-insensitive name rule for a treatment that
      still lacks a valid patientId (data that predates this app's
      own UUID migration), so old history is never lost.
    */

    function belongsToSelectedPatient(
      treatment: { patientId: string; patientName: string }
    ): boolean {

      if (
        selectedPatientRecord &&
        typeof treatment.patientId === 'string' &&
        treatment.patientId !== ''
      ) {
        return treatment.patientId === selectedPatientRecord.id
      }

      return (
        typeof treatment.patientName === 'string' &&
        treatment.patientName.toLowerCase() ===
          selectedPatient.toLowerCase()
      )

    }

const patientTreatments =
  savedTreatments
    .filter(belongsToSelectedPatient)
    .sort(
      (a, b) =>
        new Date(b.date).getTime() -
        new Date(a.date).getTime()
    )

    const patientActiveTreatment =
      activeTreatment &&
      belongsToSelectedPatient(activeTreatment)
        ? activeTreatment
        : null

    const patientIncompleteTreatments =
      incompleteTreatments.filter(belongsToSelectedPatient)

    /*
      TOOTH HISTORY

      Group the same chronological patientTreatments list by tooth,
      keeping each tooth's treatments newest-first (patientTreatments
      is already sorted that way, and groups are built by walking it
      in order). Only teeth with more than one treatment are shown -
      that's the actual point of this section (spotting repeat work
      on the same tooth), single-visit teeth already read fine in the
      Treatment History list above.
    */

    const toothHistoryMap =
      new Map<string, SavedTreatment[]>()

    patientTreatments.forEach(treatment => {

      const existing =
        toothHistoryMap.get(treatment.toothId) ?? []

      existing.push(treatment)

      toothHistoryMap.set(treatment.toothId, existing)

    })

    const toothHistory =
      Array.from(toothHistoryMap.entries())
        .filter(([, treatments]) => treatments.length > 1)
        .sort(
          ([toothIdA], [toothIdB]) =>
            getToothLabel(toothIdA).localeCompare(
              getToothLabel(toothIdB)
            )
        )


    return (

      <div className="app">

        <div className="top-header">

          <BackButton
            onClick={
              staleReviewReturnActive
                ? returnFromStaleReviewPatientView
                : backToHome
            }
          />

          <div className="title-block">
            <h1>
              {selectedPatient}
            </h1>
          </div>

          <div className="top-header-spacer" />

        </div>


<div className="patient-page">

  <div className="patient-actions">

    <button
      type="button"
      className="start-treatment-button"
      onClick={
        openProcedureSelect
      }
    >
      + Start New Treatment
    </button>

  </div>

  <h2>
    Treatment History
  </h2>

          {patientActiveTreatment && (

            <div className="treatment-card active-treatment">

              <div>

                <strong>
                  Active Treatment
                </strong>

                <p>
                  {patientActiveTreatment.procedureName}
                  {' — '}
                  Tooth:{' '}
                  {getToothLabel(patientActiveTreatment.toothId)}
                </p>

                <small>
                  Started:{' '}
                  {formatDate(
                    patientActiveTreatment.startedAt
                  )}
                </small>

              </div>


              <button
                type="button"
                onClick={() =>
                  setScreen('timer')
                }
              >
                Resume
              </button>

            </div>

          )}


          {patientIncompleteTreatments.map(treatment => (

            <div
              className="treatment-card incomplete-treatment"
              key={treatment.id}
            >

              <div>

                <strong>
                  Incomplete Treatment
                </strong>

                <p>
                  {treatment.procedureName}
                  {' — '}
                  Tooth:{' '}
                  {getToothLabel(treatment.toothId)}
                </p>

                <small>
                  Current phase:{' '}
                  {treatment.phases[treatment.currentPhaseIndex]?.name}
                </small>

              </div>

              <div className="incomplete-treatment-actions">

                <button
                  type="button"
                  disabled={!!activeTreatment}
                  title={
                    activeTreatment
                      ? 'Finish or park your current active treatment first'
                      : undefined
                  }
                  onClick={() =>
                    resumeIncompleteTreatment(treatment.id)
                  }
                >
                  Resume
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={() =>
                    requestDiscardIncomplete(treatment.id)
                  }
                >
                  Discard
                </button>

              </div>

            </div>

          ))}


          {patientTreatments.length === 0 &&
            !patientActiveTreatment &&
            patientIncompleteTreatments.length === 0 && (

              <p className="empty-message">
                No treatments recorded yet.
              </p>

            )}


          {patientTreatments.map(
            treatment => (

              <div
                className="treatment-card treatment-card-clickable"
                key={treatment.id}
                onClick={() =>
                  openTreatmentDetail(treatment)
                }
              >

                <div>

                  <strong>
                    {getToothLabel(treatment.toothId)}
                    {' — '}
                    {treatment.procedureName}
                  </strong>

                  <p>
                    {formatDate(
                      treatment.date
                    )}
                    {' — '}
                    {formatTime(
                      treatment.totalActualDuration
                    )}
                  </p>

                  {treatment.tags.length > 0 && (

                    <div className="summary-tags treatment-card-tags">
                      {treatment.tags.map(tag => (
                        <span className="summary-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>

                  )}

                </div>


                <div>

                  {treatment.completed && (

                    <span className="completed-label">
                      Completed
                    </span>

                  )}

                </div>

              </div>

            )
          )}

          {toothHistory.length > 0 && (

            <div className="tooth-history-section">

              <h2>
                Tooth History
              </h2>

              {toothHistory.map(([toothId, treatments]) => (

                <div
                  className="tooth-history-group"
                  key={toothId}
                >

                  <h3>
                    {getToothLabel(toothId)}
                  </h3>

                  {treatments.map(treatment => (

                    <button
                      type="button"
                      className="tooth-history-item"
                      key={treatment.id}
                      onClick={() =>
                        openTreatmentDetail(treatment)
                      }
                    >
                      {formatDate(treatment.date)}
                      {' — '}
                      {treatment.procedureName}
                      {' — '}
                      {formatTime(treatment.totalActualDuration)}
                    </button>

                  ))}

                </div>

              ))}

            </div>

          )}

        </div>


        {selectedPatientRecord && (

          <div className="delete-patient-section">

            <button
              type="button"
              onClick={() => requestEditPatient(selectedPatientRecord)}
            >
              Edit Patient
            </button>

          </div>

        )}


        <div className="delete-patient-section">

          <button
            type="button"
            className="delete-patient-button"
            onClick={requestDeletePatient}
          >
            Delete Patient
          </button>

        </div>


        {showEditPatient && selectedPatientRecord && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Edit Patient
              </h2>

              <div className="add-procedure-form">

                <input
                  type="text"
                  value={editPatientName}
                  onChange={
                    event => setEditPatientName(event.target.value)
                  }
                  placeholder="Patient name"
                  autoFocus
                />

              </div>

              <div
                className="add-phase-duration-row"
              >

                <label>
                  Patient number
                </label>

                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={editPatientNumberInput}
                  onChange={
                    event => setEditPatientNumberInput(event.target.value)
                  }
                />

              </div>

              {editPatientError && (
                <p className="conflict-resolution-error">
                  {editPatientError}
                </p>
              )}

              <p className="template-meta">
                Changing this patient's number to one another patient
                already has is allowed, but will be flagged as a
                patient number conflict for you to resolve afterward
                (Settings).
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelEditPatient}
                  disabled={editPatientBusy}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={
                    () => confirmEditPatient(selectedPatientRecord.id)
                  }
                  disabled={editPatientBusy}
                >
                  {editPatientBusy ? 'Saving…' : 'Save'}
                </button>

              </div>

            </div>

          </div>

        )}


        {showDeleteConfirm && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Delete "{selectedPatient}" patient?
              </h2>

              <p>
                This also deletes all of this patient's saved and
                incomplete treatments. This action cannot be undone.
              </p>

              {deletePatientBlockedReason && (
                <p className="conflict-resolution-error">
                  {deletePatientBlockedReason}
                </p>
              )}

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelDeletePatient}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmDeletePatient}
                >
                  Delete
                </button>

              </div>

            </div>

          </div>

        )}


        {discardTarget !== null && discardTarget !== 'active' && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Discard this treatment?
              </h2>

              <p>
                All timing information from this treatment will be
                lost.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelDiscard}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmDiscard}
                >
                  Discard
                </button>

              </div>

            </div>

          </div>

        )}

      </div>

    )

  }


  /*
    =========================================
    PROCEDURE SELECTION
    =========================================
  */

  if (screen === 'procedureSelect') {

    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={() => setScreen('patient')} />

          <div className="title-block">
            <h1>
              Select Procedure
            </h1>
            <p>
              {selectedPatient}
            </p>
          </div>

          <div className="top-header-spacer" />

        </div>


        <div className="procedure-page">

          <div className="template-list">

            {procedures.map(
              procedure => (

                <div className="template-row" key={procedure.id}>

                  <button
                    type="button"
                    className="template-row-main"
                    onClick={() =>
                      selectProcedure(procedure)
                    }
                  >
                    <span className="template-row-title">
                      <span className="template-row-name">
                        {procedure.name}
                      </span>
                      {!procedure.isCustom && (
                        <span className="template-badge">
                          Built-in
                        </span>
                      )}
                    </span>
                  </button>

                  {procedure.isCustom && (

                    <div className="template-row-actions">

                      <button
                        type="button"
                        className="small-button"
                        title="Edit this procedure"
                        onClick={() =>
                          requestEditProcedure(procedure)
                        }
                      >
                        ✎
                      </button>

                      <button
                        type="button"
                        className="small-button"
                        title="Delete this procedure"
                        onClick={() =>
                          requestDeleteProcedure(procedure.id)
                        }
                      >
                        ×
                      </button>

                    </div>

                  )}

                </div>

              )
            )}

          </div>

          <div className="patient-list">

            {!showAddProcedure && (

              <button
                type="button"
                className="patient-list-item create-patient"
                onClick={() =>
                  setShowAddProcedure(true)
                }
              >
                + Add New Procedure
              </button>

            )}

          </div>

          {showAddProcedure && (

            <div className="add-procedure-form">

              <input
                type="text"
                placeholder="Procedure name..."
                value={newProcedureName}
                onChange={
                  event =>
                    setNewProcedureName(
                      event.target.value
                    )
                }
                autoFocus
              />

              <button
                type="button"
                onClick={() =>
                  addProcedure(newProcedureName)
                }
                disabled={
                  !newProcedureName.trim()
                }
              >
                Save
              </button>

            </div>

          )}

        </div>


        {editProcedureId && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Edit Procedure
              </h2>

              {editProcedureError && (
                <p className="settings-error-message">
                  {editProcedureError}
                </p>
              )}

              <input
                type="text"
                placeholder="Procedure name..."
                value={editProcedureName}
                onChange={
                  event =>
                    setEditProcedureName(event.target.value)
                }
                autoFocus
              />

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelEditProcedure}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={confirmEditProcedure}
                >
                  Save
                </button>

              </div>

            </div>

          </div>

        )}


        {deleteProcedureConfirmId && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Delete this procedure?
              </h2>

              <p>
                This removes only this procedure from the list offered
                when starting new treatments. Past treatments that
                already used it are not affected and keep displaying
                exactly as before. This action cannot be undone.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelDeleteProcedure}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmDeleteProcedure}
                >
                  Delete
                </button>

              </div>

            </div>

          </div>

        )}

      </div>

    )

  }


  /*
    =========================================
    TOOTH TYPE SELECTION
    =========================================
  */

  if (screen === 'toothSelect' && selectedProcedure) {

    /*
      Purely informational (Phase 17) - never touches the template
      this treatment is about to use, and never changes anything on
      its own. Null (hidden) until there's enough real history for a
      "typical" figure to mean something.
    */
    const durationEstimate =
      selectedToothId
        ? calculateAppointmentDurationEstimate(
            savedTreatments,
            selectedToothId,
            selectedProcedure.id
          )
        : null

    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={() => setScreen('procedureSelect')} />

          <div className="title-block">
            <h1>
              New Treatment
            </h1>
            <p>
              {selectedPatient}
            </p>
            <p>
              Procedure: {selectedProcedure.name}
            </p>
          </div>

          <div className="top-header-spacer" />

        </div>


        <ToothChart
          selectedToothId={selectedToothId}
          onSelect={setSelectedToothId}
        />


        <div className="tooth-selection-footer">

          <p className="tooth-selection-label">
            {selectedToothId
              ? <>Selected tooth: <strong>{getToothLabel(selectedToothId)}</strong></>
              : 'Tap a tooth on the chart above'}
          </p>

          {durationEstimate && (

            <div className="duration-estimate-card">

              <p className="duration-estimate-label">
                Historical {selectedProcedure.name} time on{' '}
                {getToothLabel(selectedToothId!)} (n={durationEstimate.sampleSize})
              </p>

              <p className="duration-estimate-value">
                Typical: {formatTime(durationEstimate.typicalDuration)}
                {' · '}
                Range: {formatTime(durationEstimate.minDuration)}
                {'–'}
                {formatTime(durationEstimate.maxDuration)}
              </p>

            </div>

          )}

          <button
            type="button"
            className="chair-time-button"
            onClick={markPatientInChair}
          >
            {pendingChairEnteredAt
              ? '✓ Patient In Chair'
              : 'Mark Patient In Chair (optional)'}
          </button>

          <button
            type="button"
            className="start-treatment-button"
            onClick={
              startTreatment
            }
            disabled={
              !selectedToothId
            }
          >
            Start Treatment
          </button>

        </div>

      </div>

    )

  }


  /*
    =========================================
    TIMER
    =========================================
  */

  if (
    screen === 'timer' &&
    activeTreatment
  ) {

    const currentPhase =
      activeTreatment.phases[
        activeTreatment.currentPhaseIndex
      ]


    const currentPhaseTime =
      activeTreatment.phaseTimes[
        activeTreatment.currentPhaseIndex
      ]


    const isOvertime =
      currentPhaseTime < 0


    const totalSecondsRemaining =
      activeTreatment.phaseTimes
        .slice(
          activeTreatment.currentPhaseIndex
        )
        .reduce(
          (
            total,
            time
          ) =>
            total +
            Math.max(
              time,
              0
            ),
          0
        )


    const radius = 120

    const circumference =
      2 *
      Math.PI *
      radius


    let strokeDashoffset =
      circumference


    if (!isOvertime) {

      const progress =
        Math.max(
          Math.min(
            currentPhaseTime /
              currentPhase.duration,
            1
          ),
          0
        )


      strokeDashoffset =
        circumference *
        (1 - progress)

    } else {

      const overtimeSeconds =
        Math.abs(
          currentPhaseTime
        )


      const overtimeProgress =
        Math.min(
          overtimeSeconds /
            currentPhase.duration,
          1
        )


      strokeDashoffset =
        circumference *
        (1 - overtimeProgress)

    }


    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={backToHome} />

          <div className="title-block">

            <h1>
              {getToothById(activeTreatment.toothId)?.displayName ??
                activeTreatment.toothId}
            </h1>

            <p className="procedure-label">
              {activeTreatment.procedureName}
            </p>

            <p className="patient-label">
              {activeTreatment.patientName}
            </p>

            <p>
              {formatTime(
                totalSecondsRemaining
              )}{' '}
              remaining
            </p>

          </div>

          <div className="top-header-spacer" />

        </div>


        <div className="main-timer">

          <button
            type="button"
            className="phase-arrow"
            onClick={
              previousPhase
            }
            disabled={
              activeTreatment.currentPhaseIndex ===
              0
            }
          >
            ‹
          </button>


          <div
            className={`timer-circle ${
              isOvertime
                ? 'timer-overtime'
                : 'timer-normal'
            }`}
          >

            <svg
              className={`progress-ring ${
                isOvertime
                  ? 'overtime-ring'
                  : 'normal-ring'
              }`}
              width="280"
              height="280"
              viewBox="0 0 280 280"
            >

              <circle
                className="progress-background"
                cx="140"
                cy="140"
                r={radius}
              />


              <circle
                className="progress-ring-circle"
                cx="140"
                cy="140"
                r={radius}
                style={{
                  strokeDasharray:
                    circumference,

                  strokeDashoffset:
                    strokeDashoffset,
                }}
              />

            </svg>


            <div className="circle-content">

              <div className="circle-phase-name">
                {currentPhase.name}
              </div>


              <div className="circle-phase-time">

                {isOvertime && '+'}

                {formatTime(
                  currentPhaseTime
                )}

              </div>


              <div className="circle-label">

                {isOvertime
                  ? 'overtime'
                  : 'remaining'}

              </div>

            </div>

          </div>


          <button
            type="button"
            className="phase-arrow"
            onClick={
              nextPhase
            }
            disabled={
              activeTreatment.currentPhaseIndex ===
              activeTreatment.phases.length - 1
            }
          >
            ›
          </button>

        </div>


        <div className="timer-controls">

          <button
            type="button"
            onClick={
              togglePause
            }
          >
            {activeTreatment.isPaused
              ? 'Resume'
              : 'Pause'}
          </button>


          <button
            type="button"
            onClick={() => {
              setOptionsView('menu')
              setShowOptionsMenu(true)
            }}
          >
            Options
            {activeTreatment.events.length > 0 &&
              ` (${activeTreatment.events.length})`}
          </button>

        </div>


        {showOptionsMenu && (

          <div className="modal-overlay">

            <div className="modal-card options-menu-card">

              {optionsView === 'menu' && (

                <>

                  <h2>
                    Treatment Options
                  </h2>

                  <div className="options-menu-list">

                    <button
                      type="button"
                      onClick={() => setOptionsView('addPhase')}
                    >
                      + Add Phase
                    </button>

                    <button
                      type="button"
                      onClick={skipCurrentPhase}
                    >
                      Skip Phase
                    </button>

                    <button
                      type="button"
                      onClick={restartCurrentPhase}
                    >
                      Restart Phase
                    </button>

                    <button
                      type="button"
                      onClick={() => setOptionsView('tags')}
                    >
                      Tags
                      {activeTreatment.tags.length > 0 &&
                        ` (${activeTreatment.tags.join(', ')})`}
                    </button>

                    {activeTreatment.chairEnteredAt &&
                      !activeTreatment.chairLeftAt && (

                        <button
                          type="button"
                          onClick={markPatientLeft}
                        >
                          Mark Patient Left
                        </button>

                      )}

                    <button
                      type="button"
                      onClick={() => setOptionsView('addNote')}
                    >
                      + Add Note
                    </button>

                    <button
                      type="button"
                      onClick={() => setOptionsView('addInterruption')}
                    >
                      + Add Interruption
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        resetTimer()
                        setShowOptionsMenu(false)
                      }}
                    >
                      Reset Treatment
                    </button>

                    <button
                      type="button"
                      className="button-danger"
                      onClick={() => {
                        setShowOptionsMenu(false)
                        setShowEndTreatmentModal(true)
                      }}
                    >
                      End Treatment
                    </button>

                    <button
                      type="button"
                      className="modal-cancel-button"
                      onClick={() => setShowOptionsMenu(false)}
                    >
                      Close
                    </button>

                  </div>

                </>

              )}

              {optionsView === 'addPhase' && (

                <>

                  <h2>
                    Add Phase
                  </h2>

                  <p>
                    This phase is added to this treatment only - the
                    procedure template is not changed.
                  </p>

                  <input
                    type="text"
                    className="template-name-input"
                    placeholder="Phase name..."
                    value={newPhaseName}
                    onChange={event =>
                      setNewPhaseName(event.target.value)
                    }
                    autoFocus
                  />

                  <div className="add-phase-duration-row">

                    <label>
                      Duration (minutes)
                    </label>

                    <input
                      type="number"
                      min={1}
                      value={newPhaseMinutes}
                      onChange={event =>
                        setNewPhaseMinutes(event.target.value)
                      }
                    />

                  </div>

                  <div className="modal-actions modal-actions-stacked">

                    <button
                      type="button"
                      onClick={() => {
                        addPhaseToTreatment(
                          newPhaseName,
                          Number(newPhaseMinutes)
                        )
                        setShowOptionsMenu(false)
                      }}
                      disabled={
                        !newPhaseName.trim() ||
                        !(Number(newPhaseMinutes) > 0)
                      }
                    >
                      Add Phase
                    </button>

                    <button
                      type="button"
                      className="modal-cancel-button"
                      onClick={() => setOptionsView('menu')}
                    >
                      Back
                    </button>

                  </div>

                </>

              )}

              {optionsView === 'tags' && (

                <>

                  <h2>
                    Tags
                  </h2>

                  <p>
                    Optional classification for this treatment - does
                    not affect timing.
                  </p>

                  <div className="quick-chip-row">

                    {TREATMENT_TAG_PRESETS.map(tag => (

                      <button
                        type="button"
                        key={tag}
                        className={`quick-chip ${
                          activeTreatment.tags.includes(tag)
                            ? 'quick-chip-selected'
                            : ''
                        }`}
                        onClick={() => toggleTreatmentTag(tag)}
                      >
                        {tag}
                      </button>

                    ))}

                  </div>

                  <button
                    type="button"
                    className="modal-cancel-button options-menu-back-button"
                    onClick={() => setOptionsView('menu')}
                  >
                    Back
                  </button>

                </>

              )}

              {optionsView === 'addNote' && (

                <>

                  <h2>
                    Quick Notes
                  </h2>

                  <div className="quick-chip-row">

                    {QUICK_NOTE_PRESETS.map(preset => (

                      <button
                        type="button"
                        key={preset}
                        className="quick-chip"
                        onClick={() => addNoteEvent(preset)}
                      >
                        {preset}
                      </button>

                    ))}

                  </div>

                  <div className="quick-add-inline-form">

                    <input
                      type="text"
                      placeholder="Custom note..."
                      value={customNoteText}
                      onChange={event =>
                        setCustomNoteText(event.target.value)
                      }
                    />

                    <button
                      type="button"
                      onClick={() => addNoteEvent(customNoteText)}
                      disabled={!customNoteText.trim()}
                    >
                      Add
                    </button>

                  </div>

                  {activeTreatment.events.some(
                    event => event.type === 'note'
                  ) && (

                    <div className="notes-log">

                      {[...activeTreatment.events]
                        .filter(event => event.type === 'note')
                        .reverse()
                        .map(event => (

                          <div className="note-item" key={event.id}>

                            <span>
                              {event.note}
                            </span>

                            <small>
                              {new Date(
                                event.timestamp
                              ).toLocaleTimeString(
                                [],
                                { hour: '2-digit', minute: '2-digit' }
                              )}
                            </small>

                          </div>

                        ))}

                    </div>

                  )}

                  <button
                    type="button"
                    className="modal-cancel-button options-menu-back-button"
                    onClick={() => setOptionsView('menu')}
                  >
                    Back
                  </button>

                </>

              )}

              {optionsView === 'addInterruption' && (

                <>

                  <div className="interruption-header">

                    <h2>
                      Interruption / Lost Time
                    </h2>

                    <span className="interruption-total">
                      +{formatTime(
                        calculateInterruptionSeconds(
                          activeTreatment.events
                        )
                      )}
                    </span>

                  </div>

                  <p className="interruption-hint">
                    Kept separate from the normal procedure phases -
                    use this for time lost to interruptions, not
                    clinical work.
                  </p>

                  {activeTreatment.events.some(
                    event => event.type === 'interruption'
                  ) && (

                    <div className="interruption-list">

                      {activeTreatment.events
                        .filter(event => event.type === 'interruption')
                        .map(event => (

                          <div className="interruption-card" key={event.id}>

                            <span className="interruption-note">
                              {event.note}
                            </span>

                            <div className="interruption-actions">

                              <span className="interruption-duration">
                                {formatTime(event.durationSeconds ?? 0)}
                              </span>

                              <button
                                type="button"
                                className="small-button"
                                onClick={() =>
                                  adjustInterruptionDuration(event.id, -60)
                                }
                              >
                                −
                              </button>

                              <button
                                type="button"
                                className="small-button"
                                onClick={() =>
                                  adjustInterruptionDuration(event.id, 60)
                                }
                              >
                                +
                              </button>

                            </div>

                          </div>

                        ))}

                    </div>

                  )}

                  <div className="quick-chip-row">

                    {INTERRUPTION_PRESETS.map(preset => (

                      <button
                        type="button"
                        key={preset}
                        className="quick-chip"
                        onClick={() => addInterruptionEvent(preset)}
                      >
                        + {preset}
                      </button>

                    ))}

                  </div>

                  <div className="quick-add-inline-form">

                    <input
                      type="text"
                      placeholder="Custom interruption..."
                      value={customInterruptionText}
                      onChange={event =>
                        setCustomInterruptionText(event.target.value)
                      }
                    />

                    <button
                      type="button"
                      onClick={() =>
                        addInterruptionEvent(customInterruptionText)
                      }
                      disabled={!customInterruptionText.trim()}
                    >
                      Add
                    </button>

                  </div>

                  <button
                    type="button"
                    className="modal-cancel-button options-menu-back-button"
                    onClick={() => setOptionsView('menu')}
                  >
                    Back
                  </button>

                </>

              )}

            </div>

          </div>

        )}


        {showEndTreatmentModal && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                End Treatment
              </h2>

              <p>
                How would you like to end this treatment?
              </p>

              <div className="modal-actions modal-actions-stacked">

                <button
                  type="button"
                  onClick={completeTreatment}
                >
                  Complete Treatment
                </button>

                <button
                  type="button"
                  onClick={saveTreatmentAsIncomplete}
                >
                  Save as Incomplete
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={requestDiscardActive}
                >
                  Discard Treatment
                </button>

                <button
                  type="button"
                  className="modal-cancel-button"
                  onClick={() =>
                    setShowEndTreatmentModal(false)
                  }
                >
                  Cancel
                </button>

              </div>

            </div>

          </div>

        )}


        {discardTarget === 'active' && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Discard this treatment?
              </h2>

              <p>
                All timing information from this treatment will be
                lost.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelDiscard}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmDiscard}
                >
                  Discard
                </button>

              </div>

            </div>

          </div>

        )}


        <div className="phase-list">

          <h2>
            Procedure Phases
          </h2>


          {activeTreatment.phases.map(
            (
              phase,
              index
            ) => {

              const time =
                activeTreatment
                  .phaseTimes[index]


              const actual =
                activeTreatment
                  .actualTimes[index]


              let actualClass =
                'phase-actual-equal'


              if (
                actual <
                phase.duration
              ) {

                actualClass =
                  'phase-actual-good'

              } else if (
                actual >
                phase.duration
              ) {

                actualClass =
                  'phase-actual-overtime'

              }


              return (

                <div
                  key={index}
                  className={`phase-card ${
                    index ===
                    activeTreatment.currentPhaseIndex
                      ? 'active-phase'
                      : ''
                  }`}
                  onClick={() =>
                    selectPhase(
                      index
                    )
                  }
                >

                  <div className="phase-name">

                    <span>
                      {phase.name}
                    </span>


                    <small>
                      Default:{' '}
                      {phase.duration / 60}{' '}
                      min
                    </small>


                    <small
                      className={
                        actualClass
                      }
                    >
                      Actual:{' '}
                      {formatTime(
                        actual
                      )}
                    </small>

                  </div>


                  <div
                    className="phase-actions"
                    onClick={
                      event =>
                        event.stopPropagation()
                    }
                  >

                    <span
                      className={`phase-time ${
                        time < 0
                          ? 'phase-time-overtime'
                          : ''
                      }`}
                    >

                      {time < 0 &&
                        '+'}

                      {formatTime(
                        time
                      )}

                    </span>


                    <button
                      type="button"
                      className="small-button"
                      onClick={() =>
                        removeMinute(
                          index
                        )
                      }
                    >
                      −
                    </button>


                    <button
                      type="button"
                      className="small-button"
                      onClick={() =>
                        addMinute(
                          index
                        )
                      }
                    >
                      +
                    </button>

                  </div>

                </div>

              )

            }
          )}

        </div>

      </div>

    )

  }


  /*
    =========================================
    MANAGE TEMPLATES
    =========================================
  */

  if (screen === 'manageTemplates') {

    /*
      Specialization -> Procedure -> Type drill-down. Each level is
      only resolved once its parent is selected, so eg. browseType
      stays null until both a specialization and a procedure are
      chosen - that's what drives which of the four panels below
      renders.
    */

    const browseSpecialization =
      templateBrowseSpecializationId
        ? findSpecialization(templateBrowseSpecializationId)
        : null

    const browseProcedure =
      browseSpecialization && templateBrowseProcedureKey
        ? findProcedureOption(
            browseSpecialization.id,
            templateBrowseProcedureKey
          )
        : null

    const browseType =
      browseSpecialization && browseProcedure && templateBrowseTypeId
        ? findTypeOption(
            browseSpecialization.id,
            browseProcedure.key,
            templateBrowseTypeId
          )
        : null

    const headerTitle =
      browseType
        ? browseType.name
        : browseProcedure
          ? browseProcedure.name
          : browseSpecialization
            ? browseSpecialization.name
            : 'Procedure Templates'

    const headerSubtitle =
      browseType && browseSpecialization && browseProcedure
        ? `${browseSpecialization.name} · ${browseProcedure.name}`
        : browseProcedure && browseSpecialization
          ? `${browseSpecialization.name} · Select Type`
          : browseSpecialization
            ? 'Select Procedure'
            : 'Select Specialization'

    const bucketTemplates =
      browseSpecialization && browseProcedure && browseType
        ? templates.filter(
            template =>
              template.specializationId === browseSpecialization.id &&
              template.procedureKey === browseProcedure.key &&
              template.typeId === browseType.id
          )
        : []

    const templateToDelete =
      deleteTemplateConfirmId
        ? templates.find(
            template => template.id === deleteTemplateConfirmId
          ) ?? null
        : null

    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={backTemplateBrowseStep} />

          <div className="title-block">
            <h1>
              {headerTitle}
            </h1>
            <p className="template-breadcrumb">
              {headerSubtitle}
            </p>
          </div>

          <div className="top-header-spacer" />

        </div>


        <div className="procedure-page">

          {!browseSpecialization && (

            <div className="patient-list">

              {TEMPLATE_TAXONOMY.map(specialization => (

                <button
                  key={specialization.id}
                  type="button"
                  className="patient-list-item"
                  onClick={() =>
                    selectTemplateBrowseSpecialization(specialization.id)
                  }
                >
                  {specialization.name}
                </button>

              ))}

            </div>

          )}

          {browseSpecialization && !browseProcedure && (

            <div className="patient-list">

              {browseSpecialization.procedures.map(procedure => (

                <button
                  key={procedure.key}
                  type="button"
                  className="patient-list-item"
                  onClick={() =>
                    selectTemplateBrowseProcedure(procedure.key)
                  }
                >
                  {procedure.name}
                </button>

              ))}

            </div>

          )}

          {browseSpecialization && browseProcedure && !browseType && (

            <div className="patient-list">

              {browseProcedure.types.map(type => (

                <button
                  key={type.id}
                  type="button"
                  className="patient-list-item"
                  onClick={() =>
                    selectTemplateBrowseType(type.id)
                  }
                >
                  {type.name}
                </button>

              ))}

            </div>

          )}

          {browseSpecialization && browseProcedure && browseType && (

            <>

              <div className="template-list">

                {bucketTemplates.length === 0 && (
                  <p className="template-meta template-list-empty">
                    No templates yet in this category.
                  </p>
                )}

                {bucketTemplates.map((template, index) => {

                  const totalMinutes =
                    Math.round(
                      template.phases.reduce(
                        (total, phase) =>
                          total + phase.duration,
                        0
                      ) / 60
                    )

                  return (

                    <div className="template-row" key={template.id}>

                      <button
                        type="button"
                        className="template-row-main"
                        onClick={() =>
                          openTemplateEditor(template.id)
                        }
                      >
                        <span className="template-row-title">
                          <span className="template-row-name">
                            {template.name}
                          </span>
                          {!template.isCustom && (
                            <span className="template-badge">
                              Built-in
                            </span>
                          )}
                        </span>
                        <small className="template-meta">
                          {template.phases.length} phase
                          {template.phases.length === 1 ? '' : 's'}
                          {' · '}
                          {totalMinutes} min
                        </small>
                      </button>

                      <div className="template-row-actions">

                        <button
                          type="button"
                          className="small-button"
                          title="Move up"
                          onClick={() => moveTemplate(template.id, -1)}
                          disabled={index === 0}
                        >
                          ↑
                        </button>

                        <button
                          type="button"
                          className="small-button"
                          title="Move down"
                          onClick={() => moveTemplate(template.id, 1)}
                          disabled={index === bucketTemplates.length - 1}
                        >
                          ↓
                        </button>

                        <button
                          type="button"
                          className="small-button"
                          title="Duplicate this template"
                          onClick={() =>
                            duplicateTemplate(template.id)
                          }
                        >
                          ⧉
                        </button>

                        {template.isCustom && (
                          <button
                            type="button"
                            className="small-button"
                            title="Delete this template"
                            onClick={() =>
                              requestDeleteTemplate(template.id)
                            }
                          >
                            ×
                          </button>
                        )}

                      </div>

                    </div>

                  )

                })}

              </div>


              <div className="manage-templates-actions">

                <button
                  type="button"
                  className="start-treatment-button"
                  onClick={() =>
                    openNewTemplateDraft(
                      browseSpecialization.id,
                      browseProcedure.key,
                      browseType.id
                    )
                  }
                >
                  + New Template
                </button>

              </div>

            </>

          )}

        </div>


        {templateToDelete && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Delete template?
              </h2>

              <p>
                This permanently removes "{templateToDelete.name}".
                This can't be undone.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelDeleteTemplate}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmDeleteTemplate}
                >
                  Delete
                </button>

              </div>

            </div>

          </div>

        )}

      </div>

    )

  }


  /*
    =========================================
    TEMPLATE EDITOR
    =========================================
  */

  if (screen === 'templateEditor' && templateDraft) {

    const totalMinutes =
      Math.round(
        templateDraft.phases.reduce(
          (total, phase) =>
            total + phase.duration,
          0
        ) / 60
      )

    const isEditingBuiltIn =
      editingTemplateId !== null &&
      BUILTIN_TEMPLATES.some(
        template => template.id === editingTemplateId
      )

    const draftSpecialization =
      findSpecialization(templateDraft.specializationId)

    const draftProcedure =
      findProcedureOption(
        templateDraft.specializationId,
        templateDraft.procedureKey
      )

    const draftType =
      findTypeOption(
        templateDraft.specializationId,
        templateDraft.procedureKey,
        templateDraft.typeId
      )

    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={closeTemplateEditor} />

          <div className="title-block">
            <h1>
              {editingTemplateId
                ? 'Edit Template'
                : 'New Template'}
            </h1>
            {draftSpecialization && draftProcedure && draftType && (
              <p className="template-breadcrumb">
                {draftSpecialization.name} · {draftProcedure.name} · {draftType.name}
              </p>
            )}
            {isEditingBuiltIn && (
              <span className="template-badge">
                Built-in
              </span>
            )}
          </div>

          <div className="top-header-spacer" />

        </div>


        <div className="template-editor-card">

          <input
            className="template-name-input"
            type="text"
            placeholder="Template name..."
            value={templateDraft.name}
            onChange={
              event =>
                updateDraftName(event.target.value)
            }
          />

          {templateDraft.phases.map((phase, index) => (

            <div className="template-phase-row" key={index}>

              <input
                type="text"
                placeholder="Phase name"
                value={phase.name}
                onChange={
                  event =>
                    updateDraftPhaseName(
                      index,
                      event.target.value
                    )
                }
              />

              <input
                type="number"
                min={0}
                value={Math.round(phase.duration / 60)}
                onChange={
                  event =>
                    updateDraftPhaseDuration(
                      index,
                      Number(event.target.value)
                    )
                }
              />

              <button
                type="button"
                className="small-button"
                onClick={() => moveDraftPhase(index, -1)}
                disabled={index === 0}
              >
                ↑
              </button>

              <button
                type="button"
                className="small-button"
                onClick={() => moveDraftPhase(index, 1)}
                disabled={
                  index === templateDraft.phases.length - 1
                }
              >
                ↓
              </button>

              <button
                type="button"
                className="small-button"
                onClick={() => removeDraftPhase(index)}
              >
                ×
              </button>

            </div>

          ))}

          <button
            type="button"
            onClick={addDraftPhase}
          >
            + Add Phase
          </button>

          <p className="template-total">
            Total: {totalMinutes} min
          </p>

          <button
            type="button"
            className="start-treatment-button"
            onClick={saveTemplateDraft}
            disabled={
              !templateDraft.name.trim() ||
              templateDraft.phases.length === 0
            }
          >
            Save Template
          </button>

          {isEditingBuiltIn && (

            <button
              type="button"
              className="restore-default-button"
              onClick={requestRestoreDefault}
            >
              Restore Default
            </button>

          )}

        </div>


        {showRestoreDefaultConfirm && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Restore default template?
              </h2>

              <p>
                This resets "{templateDraft.name}" back to its
                original built-in phases and timings. Your current
                changes here will be lost once you save.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelRestoreDefault}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={restoreTemplateToDefault}
                >
                  Restore Default
                </button>

              </div>

            </div>

          </div>

        )}


        {duplicateTemplateWarning && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Template already exists
              </h2>

              <p>
                An identical template already exists:
              </p>

              <p className="duplicate-template-name">
                {duplicateTemplateWarning.name}
              </p>

              <p>
                This template has the same name and phase
                structure/timings. Would you like to use the
                existing template instead?
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={useExistingTemplate}
                >
                  Use Existing Template
                </button>

                <button
                  type="button"
                  onClick={cancelDuplicateWarning}
                >
                  Cancel
                </button>

              </div>

            </div>

          </div>

        )}

      </div>

    )

  }


  /*
    =========================================
    TREATMENT SUMMARY
    =========================================
  */

  if (
    screen === 'treatmentSummary' &&
    lastCompletedTreatment
  ) {

    return (

      <div className="app">

        <div className="header">

          <h1>
            Treatment Complete
          </h1>

          <p>
            {getToothLabel(lastCompletedTreatment.toothId)}
            {' — '}
            {lastCompletedTreatment.procedureName}
            {' — '}
            {lastCompletedTreatment.patientName}
          </p>

        </div>


        <TreatmentSummaryCard
          totalExpectedDuration={
            lastCompletedTreatment.totalExpectedDuration
          }
          totalActualDuration={
            lastCompletedTreatment.totalActualDuration
          }
          totalOvertimeDuration={
            lastCompletedTreatment.totalOvertimeDuration
          }
          phaseRecords={
            lastCompletedTreatment.phaseRecords
          }
          interruptionDuration={
            calculateInterruptionSeconds(
              lastCompletedTreatment.events
            )
          }
          chairTimeDuration={
            computeChairTimeSeconds(lastCompletedTreatment)
          }
          tags={
            lastCompletedTreatment.tags
          }
          footer={

            <button
              type="button"
              className="start-treatment-button"
              onClick={() => {
                setLastCompletedTreatment(null)
                backToHome()
              }}
            >
              Done
            </button>

          }
        />

      </div>

    )

  }


  /*
    =========================================
    TREATMENT DETAIL (history, plus edit/delete - Phase 4.6)
    =========================================
  */

  if (
    screen === 'treatmentDetail' &&
    selectedHistoryTreatment
  ) {

    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={closeTreatmentDetail} />

          <div className="title-block">

            <h1>
              {getToothLabel(selectedHistoryTreatment.toothId)}
            </h1>

            <p className="procedure-label">
              {selectedHistoryTreatment.procedureName}
            </p>

            <p className="patient-label">
              {selectedHistoryTreatment.patientName}
            </p>

            <p>
              Template: {selectedHistoryTreatment.templateName}
            </p>

            <p>
              {formatDate(selectedHistoryTreatment.date)}
            </p>

          </div>

          <div className="top-header-spacer" />

        </div>


        <TreatmentSummaryCard
          totalExpectedDuration={
            selectedHistoryTreatment.totalExpectedDuration
          }
          totalActualDuration={
            selectedHistoryTreatment.totalActualDuration
          }
          totalOvertimeDuration={
            selectedHistoryTreatment.totalOvertimeDuration
          }
          phaseRecords={
            selectedHistoryTreatment.phaseRecords
          }
          interruptionDuration={
            calculateInterruptionSeconds(
              selectedHistoryTreatment.events
            )
          }
          chairTimeDuration={
            computeChairTimeSeconds(selectedHistoryTreatment)
          }
          tags={
            selectedHistoryTreatment.tags
          }
        />

        <div className="delete-patient-section">

          <button
            type="button"
            onClick={requestEditTreatmentPhases}
          >
            Edit Phase Timings
          </button>

          <button
            type="button"
            className="delete-patient-button"
            onClick={requestDeleteTreatment}
          >
            Delete Treatment
          </button>

        </div>


        {showEditTreatmentPhases && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Edit Phase Timings
              </h2>

              <p className="template-meta">
                Actual minutes spent on each phase. Totals recalculate
                automatically when you save.
              </p>

              {selectedHistoryTreatment.phaseRecords.map((record, index) => (

                <div className="template-phase-row" key={record.id}>

                  <span>
                    {record.name}
                  </span>

                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={editPhaseMinutes[index] ?? '0'}
                    onChange={
                      event =>
                        updateEditPhaseMinutes(index, event.target.value)
                    }
                  />

                </div>

              ))}

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelEditTreatmentPhases}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={confirmEditTreatmentPhases}
                >
                  Save
                </button>

              </div>

            </div>

          </div>

        )}


        {showDeleteTreatmentConfirm && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Delete this treatment?
              </h2>

              <p>
                This removes only this one treatment record. The
                patient and their other treatments are not affected.
                This action cannot be undone.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelDeleteTreatment}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmDeleteTreatment}
                >
                  Delete
                </button>

              </div>

            </div>

          </div>

        )}

      </div>

    )

  }


  /*
    =========================================
    STATISTICS
    =========================================
  */

  if (screen === 'statistics') {

    return (

      <StatisticsScreen
        treatments={savedTreatments}
        procedures={procedures}
        templates={templates}
        onBack={() => setScreen('home')}
      />

    )

  }


  /*
    =========================================
    TREATMENT SEARCH

    Global search across every completed treatment, for every
    patient - not the per-patient Treatment History list on the
    Patient Page, which is already scoped to one patient. Matches
    are computed directly from savedTreatments (the same array
    Patient History and Statistics both read), so a search result is
    never a separate copy of the data.
    =========================================
  */

  if (screen === 'treatmentSearch') {

    const cleanQuery =
      treatmentSearchQuery.trim().toLowerCase()

    const searchResults =
      cleanQuery === ''
        ? []
        : savedTreatments
            .filter(treatment =>
              treatment.patientName.toLowerCase().includes(cleanQuery) ||
              getToothLabel(treatment.toothId)
                .toLowerCase()
                .includes(cleanQuery) ||
              treatment.procedureName.toLowerCase().includes(cleanQuery) ||
              treatment.templateName.toLowerCase().includes(cleanQuery)
            )
            .sort(
              (a, b) =>
                new Date(b.date).getTime() - new Date(a.date).getTime()
            )

    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={backToHome} />

          <div className="title-block">
            <h1>
              Search Treatments
            </h1>
          </div>

          <div className="top-header-spacer" />

        </div>


        <div className="procedure-page">

          <input
            className="patient-search"
            type="text"
            placeholder="Search by patient, tooth, procedure, or template..."
            value={treatmentSearchQuery}
            onChange={event =>
              setTreatmentSearchQuery(event.target.value)
            }
            autoFocus
          />

          {cleanQuery === '' && (
            <p className="empty-message">
              Start typing to search across every patient's treatment
              history.
            </p>
          )}

          {cleanQuery !== '' && searchResults.length === 0 && (
            <p className="empty-message">
              No treatments match "{treatmentSearchQuery.trim()}".
            </p>
          )}

          {searchResults.map(treatment => (

            <div
              className="treatment-card treatment-card-clickable"
              key={treatment.id}
              onClick={() => {
                setSelectedPatient(treatment.patientName)
                openTreatmentDetail(treatment)
              }}
            >

              <div>

                <strong>
                  {getToothLabel(treatment.toothId)}
                  {' — '}
                  {treatment.procedureName}
                </strong>

                <p>
                  {treatment.patientName}
                  {' — '}
                  {formatDate(treatment.date)}
                  {' — '}
                  {formatTime(treatment.totalActualDuration)}
                </p>

              </div>

            </div>

          ))}

        </div>

      </div>

    )

  }


  if (screen === 'staleReview') {

    const candidates = pendingStaleReview ?? []

    const remainingCandidates = candidates.filter(
      candidate => !staleReviewDecidedIds.has(candidate.patientId)
    )

    const staleReviewDiscardTarget =
      staleReviewDiscardTargetId
        ? candidates.find(
            candidate => candidate.patientId === staleReviewDiscardTargetId
          ) ?? null
        : null

    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={backToHome} />

          <div className="title-block">
            <h1>
              Review Before Syncing
            </h1>
          </div>

          <div className="top-header-spacer" />

        </div>


        <div className="procedure-page">

          <p>
            This device hasn't synced to the cloud in over a month.
            The patients below were added on this device but have
            never reached the cloud, and none are marked for deletion.
            Review each one - keep it to sync it normally, or discard
            it if it shouldn't be kept - before syncing continues.
          </p>

          {staleReviewActionError && (
            <p className="conflict-resolution-error">
              {staleReviewActionError}
            </p>
          )}

          {remainingCandidates.length === 0 ? (

            <>

              <p className="empty-message">
                All patients reviewed.
              </p>

              <button
                type="button"
                onClick={finishStaleReview}
              >
                Continue Syncing
              </button>

            </>

          ) : (

            remainingCandidates.map(candidate => (

              <div
                className="treatment-card incomplete-treatment"
                key={candidate.patientId}
              >

                <div>

                  <strong>
                    #{candidate.patientNumber} — {candidate.name}
                  </strong>

                  <p>
                    {candidate.completedTreatmentCount} completed
                    treatment{candidate.completedTreatmentCount === 1 ? '' : 's'}
                  </p>

                  <small>
                    Last edited {formatDate(candidate.lastEditedAt)}
                  </small>

                </div>

                <div className="incomplete-treatment-actions">

                  <button
                    type="button"
                    onClick={() => viewStaleReviewPatientRecord(candidate)}
                  >
                    View Full Record
                  </button>

                  <button
                    type="button"
                    onClick={() => keepStaleReviewPatient(candidate.patientId)}
                  >
                    Keep
                  </button>

                  <button
                    type="button"
                    className="button-danger"
                    onClick={
                      () => requestDiscardStaleReviewPatient(candidate.patientId)
                    }
                  >
                    Discard
                  </button>

                </div>

              </div>

            ))

          )}

        </div>


        {staleReviewDiscardTarget && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Discard {staleReviewDiscardTarget.name}?
              </h2>

              <p>
                This removes the patient and their treatment history
                from this device, the same as deleting them normally.
                This action cannot be undone.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  onClick={cancelDiscardStaleReviewPatient}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmDiscardStaleReviewPatient}
                >
                  Discard
                </button>

              </div>

            </div>

          </div>

        )}

      </div>

    )

  }


  if (screen === 'settings') {

    return (

      <div className="app">

        <div className="top-header">

          <BackButton onClick={backToHome} />

          <div className="title-block">
            <h1>
              Settings
            </h1>
          </div>

          <div className="top-header-spacer" />

        </div>


        <div className="procedure-page">

          <MicrosoftAccountSection />

          <h2 className="settings-section-title">
            Data Export &amp; Backup
          </h2>

          <p className="settings-section-description">
            Export a full backup of your patients, treatments,
            templates, and procedures, or export completed
            treatments as a spreadsheet. Backups are saved to a file
            on this device only - nothing is ever sent over the
            network.
          </p>

          <div className="options-menu-list settings-actions">

            <button
              type="button"
              onClick={exportBackup}
            >
              Export Backup (JSON)
            </button>

            <button
              type="button"
              onClick={exportCsv}
              disabled={savedTreatments.length === 0}
            >
              Export Completed Treatments (CSV)
            </button>

            <button
              type="button"
              onClick={triggerImportFilePicker}
            >
              Import Backup
            </button>

          </div>

          <input
            ref={importFileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden-file-input"
            onChange={handleImportFileSelected}
          />

          {importError && (
            <p className="settings-error-message">
              {importError}
            </p>
          )}

        </div>


        {pendingImportSummary && (

          <div className="modal-overlay">

            <div className="modal-card">

              <h2>
                Import this backup?
              </h2>

              <p>
                This backup contains: {pendingImportSummary}.
              </p>

              <p>
                Importing will replace your current data for
                anything included in this backup. This cannot be
                undone.
              </p>

              <div className="modal-actions">

                <button
                  type="button"
                  className="modal-cancel-button"
                  onClick={cancelImport}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="button-danger"
                  onClick={confirmImport}
                >
                  Import &amp; Replace
                </button>

              </div>

            </div>

          </div>

        )}


      </div>

    )

  }


  /*
    SAFETY FALLBACK

    Prevents a blank/black screen if
    something unexpected happens.
  */

  return (

    <div className="app">

      <div className="header">

        <h1>
          ToothTarget
        </h1>

        <p>
          Something went wrong.
        </p>

        <button
          type="button"
          onClick={() =>
            setScreen('home')
          }
        >
          Return to Home
        </button>

      </div>

    </div>

  )

}

export default App
