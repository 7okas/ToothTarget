import { closeResolutionScreen, notifyResolutionResolved } from './syncResolutionStore'
import {
  applyResolution,
  markInSync,
  prepareResolution,
  type ResolutionSession,
} from './syncResolutionEngine'
import {
  decideAllFromCloud,
  decideAllFromDevice,
  decideCreatedSinceLastSync,
  decisionsKeepingPatientWithTreatments,
  decisionsOmittingTreatments,
  resolveSnapshots,
  suggestNumberFixes,
  type Choice,
  type Decisions,
  type NumberFixes,
  type ResolveResult,
} from './syncResolve'
import type { DiffEntity } from './syncDiff'
import {
  buildSummary,
  buildViewModel,
  describeApplyResult,
  describePrepareResult,
  type OutcomeMessage,
  type ResolutionViewModel,
  type SummaryViewModel,
} from './syncResolutionViewModel'
import { reportResolutionApplied, requestCloudPullIfSignedIn } from './cloudSyncScheduler'

/*
  RESOLUTION CONTROLLER (Phase 6, step 7-8)

  The framework-free state machine behind SyncResolutionScreen.tsx: it
  owns the session, the dentist's choices, the number fixes, the
  acknowledgement tick and the apply flow, and exposes plain actions.
  Kept out of the component so every rule on the screen - nothing is
  written until Apply, "Decide later" writes nothing, a changed cloud
  keeps what still applies - is unit-testable without a DOM (this
  project has no React-rendering test harness; see startupGate.ts for
  the same reasoning).

  Same get/subscribe module-store shape as cloudSyncScheduler.ts's
  stores, read in the component via useSyncExternalStore. Every state
  change replaces the state object, so React sees a new snapshot.

  PHASES
    idle        screen not in use
    loading     reading OneDrive + this device (read-only)
    message     nothing to decide - a plain-language message (offline,
                nothing to resolve, ...) with Retry/Close
    identical   both sides already match - offer "Mark as in sync"
    deciding    the row list
    summary     the final "here is exactly what will happen" screen
    applying    writing (screen is inert)
    done        finished (success or a follow-up message)

  WRITES: only apply() and markInSyncNow() ever cause a write, and only
  when called by a button press. open(), every choice, the shortcuts,
  goToSummary(), back() and decideLater() are read-only.
*/

export type ControllerPhase =
  | 'idle'
  | 'loading'
  | 'message'
  | 'identical'
  | 'deciding'
  | 'summary'
  | 'applying'
  | 'done'

export type ControllerState = {
  phase: ControllerPhase
  /* A banner (deciding/summary) or the main text (message/identical/done). */
  message: OutcomeMessage | null
  session: ResolutionSession | null
  decisions: Decisions
  /* Rows that changed while deciding and need a fresh choice. */
  changedKeys: string[]
  /* Who keeps each colliding patient number (patientNumber -> patientId). */
  keepers: Record<number, string>
  /* Manual overrides of the suggested new numbers (patientId -> number). */
  manualNumbers: NumberFixes
  acknowledged: boolean
  view: ResolutionViewModel | null
  /* The resolution with NO number fixes - what the collision UI lists. */
  base: ResolveResult | null
  /* The resolution with the effective fixes - what decides "can apply". */
  final: ResolveResult | null
  /* Every number fix actually in force (suggested + manual). */
  numberFixes: NumberFixes
  summary: SummaryViewModel | null
  /* Review summary is enabled only when this is true. */
  canReviewSummary: boolean
}

const INITIAL_STATE: ControllerState = {
  phase: 'idle',
  message: null,
  session: null,
  decisions: {},
  changedKeys: [],
  keepers: {},
  manualNumbers: {},
  acknowledged: false,
  view: null,
  base: null,
  final: null,
  numberFixes: {},
  summary: null,
  canReviewSummary: false,
}

let state: ControllerState = INITIAL_STATE

const listeners = new Set<() => void>()

export function getControllerState(): ControllerState {
  return state
}

export function subscribeController(listener: () => void): () => void {

  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }

}

function emit(next: ControllerState): void {

  state = next

  for (const listener of listeners) {
    listener()
  }

}

/* A monotonically increasing token so a slow, superseded open() can't overwrite a newer one. */
let openToken = 0

/* ---------- derived state ---------- */

function derive(
  session: ResolutionSession,
  decisions: Decisions,
  keepers: Record<number, string>,
  manualNumbers: NumberFixes
): Pick<
  ControllerState,
  'view' | 'base' | 'final' | 'numberFixes' | 'canReviewSummary'
> {

  const stamp = session.attemptStamp ?? new Date().toISOString()

  const base = resolveSnapshots(session.device, session.cloud, decisions, {
    nowIso: stamp,
    lastSyncAt: session.lastSyncAt,
  })

  const view = buildViewModel(session.diff, decisions)

  /*
    Suggested fixes only exist for real collisions: the keeper (default:
    the first patient listed) keeps the number, the others get the next
    free numbers. Manual numbers override a suggestion for that patient.
  */
  const suggested =
    base.collisions.length > 0
      ? suggestNumberFixes(base.candidatePatients, base.collisions, keepers)
      : {}

  const numberFixes: NumberFixes = { ...suggested }

  for (const [patientId, number] of Object.entries(manualNumbers)) {

    if (patientId in suggested) {
      numberFixes[patientId] = number
    }

  }

  const final = resolveSnapshots(session.device, session.cloud, decisions, {
    nowIso: stamp,
    lastSyncAt: session.lastSyncAt,
    numberFixes,
  })

  return {
    view,
    base,
    final,
    numberFixes,
    canReviewSummary: view.allDecided && final.canApply,
  }

}

function withDerived(
  partial: Partial<ControllerState> & { session: ResolutionSession }
): ControllerState {

  const merged: ControllerState = { ...state, ...partial }

  return {
    ...merged,
    ...derive(partial.session, merged.decisions, merged.keepers, merged.manualNumbers),
  }

}

/* ---------- actions ---------- */

export async function openController(): Promise<void> {

  const token = ++openToken

  emit({ ...INITIAL_STATE, phase: 'loading' })

  const prepared = await prepareResolution()

  if (token !== openToken) {
    return
  }

  if (prepared.status === 'ready') {

    emit(
      withDerived({
        ...INITIAL_STATE,
        phase: 'deciding',
        session: prepared.session,
      })
    )

    return

  }

  if (prepared.status === 'identical') {

    emit({
      ...INITIAL_STATE,
      phase: 'identical',
      session: prepared.session,
      message: describePrepareResult(prepared),
    })

    return

  }

  if (prepared.status === 'not-diverged' || prepared.status === 'no-cloud-document') {

    /*
      Nothing to decide any more: say so, and let the ordinary pull/push
      flow pick the situation up (it will find nothing to resolve).
    */
    requestCloudPullIfSignedIn(true)

  }

  emit({
    ...INITIAL_STATE,
    phase: 'message',
    message: describePrepareResult(prepared),
  })

}

function requireSession(): ResolutionSession | null {
  return state.session
}

function updateDeciding(
  patch: Partial<Pick<ControllerState, 'decisions' | 'keepers' | 'manualNumbers' | 'acknowledged' | 'changedKeys' | 'message'>>
): void {

  const session = requireSession()

  if (!session || (state.phase !== 'deciding' && state.phase !== 'summary')) {
    return
  }

  emit(withDerived({ ...patch, session }))

}

export function setChoice(key: string, choice: Choice): void {

  const changedKeys = state.changedKeys.filter(changed => changed !== key)

  updateDeciding({
    decisions: { ...state.decisions, [key]: choice },
    changedKeys,
  })

}

export function chooseAllFromDevice(): void {

  const session = requireSession()

  if (session) {
    updateDeciding({ decisions: decideAllFromDevice(session.diff), changedKeys: [], acknowledged: false })
  }

}

export function chooseAllFromCloud(): void {

  const session = requireSession()

  if (session) {
    updateDeciding({ decisions: decideAllFromCloud(session.diff), changedKeys: [], acknowledged: false })
  }

}

export function keepCreatedSinceLastSync(entity: DiffEntity | null): void {

  const session = requireSession()

  if (session) {
    updateDeciding({
      decisions: decideCreatedSinceLastSync(session.diff, entity, state.decisions),
    })
  }

}

export function chooseNumberKeeper(patientNumber: number, patientId: string): void {

  /* Picking a different keeper clears manual numbers for that collision. */
  const manualNumbers: NumberFixes = {}

  updateDeciding({
    keepers: { ...state.keepers, [patientNumber]: patientId },
    manualNumbers,
  })

}

export function setManualPatientNumber(patientId: string, number: number): void {
  updateDeciding({ manualNumbers: { ...state.manualNumbers, [patientId]: number } })
}

/* Fix for "a kept treatment's patient was left out": keep the patient. */
export function keepPatientForTreatments(patientId: string): void {

  const session = requireSession()

  if (session) {
    updateDeciding({
      decisions: decisionsKeepingPatientWithTreatments(session.diff, state.decisions, patientId),
    })
  }

}

/* ...or leave those treatments out too. */
export function leaveOutTreatments(treatmentIds: string[]): void {

  const session = requireSession()

  if (session) {
    updateDeciding({
      decisions: decisionsOmittingTreatments(state.decisions, session.diff, treatmentIds),
    })
  }

}

export function setAcknowledged(value: boolean): void {
  updateDeciding({ acknowledged: value })
}

export function goToSummary(): void {

  const session = requireSession()

  if (!session || state.phase !== 'deciding' || !state.canReviewSummary || !state.final) {
    return
  }

  emit(
    withDerived({
      session,
      phase: 'summary',
      message: null,
      acknowledged: false,
      summary: buildSummary(state.final),
    })
  )

}

export function backToDeciding(): void {

  const session = requireSession()

  if (!session || state.phase !== 'summary') {
    return
  }

  emit(withDerived({ session, phase: 'deciding', message: null, summary: null }))

}

/*
  The one button that lets the dentist walk away. Writes NOTHING: it
  only closes the screen and forgets the in-memory choices. The
  'diverged' state stays exactly as it was.
*/
export function decideLater(): void {

  openToken += 1

  emit(INITIAL_STATE)

  closeResolutionScreen()

}

/* After a finished/message screen: close it and reset. */
export function closeFinished(): void {
  decideLater()
}

export async function applyNow(): Promise<void> {

  const session = requireSession()

  if (!session || state.phase !== 'summary' || !state.final) {
    return
  }

  const requiresAck = state.final.resurrected.length > 0

  if (requiresAck && !state.acknowledged) {
    emit({
      ...state,
      message: describeApplyResult({ status: 'needs-acknowledgement', result: state.final }),
    })
    return
  }

  emit({ ...state, phase: 'applying', message: null })

  const result = await applyResolution(session, state.decisions, {
    numberFixes: state.numberFixes,
    acknowledgedResurrection: state.acknowledged,
  })

  const outcome = describeApplyResult(result)

  switch (result.status) {

    case 'applied':

      reportResolutionApplied()
      notifyResolutionResolved()

      emit({ ...INITIAL_STATE, phase: 'done', message: outcome })

      return

    case 'changed-while-deciding':

      emit(
        withDerived({
          session: result.session,
          phase: 'deciding',
          decisions: result.decisions,
          changedKeys: result.reset,
          message: outcome,
          summary: null,
          acknowledged: false,
        })
      )

      return

    case 'cloud-written-local-changed':

      /*
        OneDrive now holds the resolved data and this device kept the
        newer edit. Let the ordinary flow notice the small remaining
        difference (it will land in 'diverged' again).
      */
      requestCloudPullIfSignedIn(true)

      emit({ ...INITIAL_STATE, phase: 'done', message: outcome })

      return

    case 'cloud-committed-locally-pending':

      emit({ ...INITIAL_STATE, phase: 'done', message: outcome })

      return

    case 'blocked':
    case 'needs-acknowledgement':
    case 'failed':
    case 'safety-copy-failed':
    case 'marker-failed':

      /* Nothing was applied: back to the summary with the reason, ready to retry. */
      emit({ ...state, phase: 'summary', message: outcome })

      return

  }

}

export async function markInSyncNow(): Promise<void> {

  const session = requireSession()

  if (!session || state.phase !== 'identical') {
    return
  }

  emit({ ...state, phase: 'applying' })

  const result = await markInSync(session)

  if (result.status === 'in-sync') {

    reportResolutionApplied()
    notifyResolutionResolved()

    emit({
      ...INITIAL_STATE,
      phase: 'done',
      message: {
        tone: 'success',
        title: 'This device is now marked as in sync',
        message: 'Both sides already matched, so nothing was changed.',
        retryable: false,
        needsRefresh: false,
      },
    })

    return

  }

  if (result.status === 'changed-while-deciding') {

    emit(
      withDerived({
        session: result.session,
        phase: result.session.diff.deviceOnly.length +
          result.session.diff.cloudOnly.length +
          result.session.diff.different.length === 0
          ? 'identical'
          : 'deciding',
        decisions: {},
        message: describeApplyResult({
          status: 'changed-while-deciding',
          session: result.session,
          decisions: {},
          reset: [],
        }),
      })
    )

    return

  }

  emit({
    ...state,
    phase: 'identical',
    message: describeApplyResult({
      status: 'failed',
      result: result.result,
      retryable: true,
    }),
  })

}

/* TEST-ONLY */
export function __resetControllerForTests(): void {
  openToken += 1
  state = INITIAL_STATE
  listeners.clear()
}
