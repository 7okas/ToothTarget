import { describe, expect, it } from 'vitest'
import {
  reduceStartupGateState,
  markStartupGatePassed,
  computeStartupGateView,
  INITIAL_STARTUP_GATE_STATE,
  type StartupGateState,
} from './startupGate'

/*
  Pure-logic-only, same constraint as StartupSyncOverlay.test.ts /
  SyncStatusIndicator.test.ts previously used: this project has no
  React-rendering test harness, so StartupGateScreen.tsx itself (which
  imports auth.ts/cloudSyncScheduler.ts, and through them MSAL) is not
  imported here. Every scenario the task asks for - the not-signed-in
  prompt, auto-proceeding on a successful sync, a failing sync showing
  its classified reason with retry/continue always available, and both
  "continue without X" exits reaching the app - is fully determined by
  reduceStartupGateState()/computeStartupGateView() below; the
  component is a thin, untested-by-necessity rendering of exactly
  these decisions (see StartupGateScreen.tsx's own header comment).
*/

describe('reduceStartupGateState - tracks only the currently-gating sync attempt', () => {

  it('moves to syncing once a gating attempt becomes pending', () => {

    expect(
      reduceStartupGateState(INITIAL_STARTUP_GATE_STATE, 'pending')
    ).toEqual({ passed: false, phase: 'syncing' })

  })

  it('moves to syncing once a gating attempt becomes syncing directly', () => {

    expect(
      reduceStartupGateState(INITIAL_STARTUP_GATE_STATE, 'syncing')
    ).toEqual({ passed: false, phase: 'syncing' })

  })

  it('stays idle while status is idle/unavailable before any attempt has started', () => {

    expect(
      reduceStartupGateState(INITIAL_STARTUP_GATE_STATE, 'idle')
    ).toEqual(INITIAL_STARTUP_GATE_STATE)

    expect(
      reduceStartupGateState(INITIAL_STARTUP_GATE_STATE, 'unavailable')
    ).toEqual(INITIAL_STARTUP_GATE_STATE)

  })

  it('resolves a syncing attempt to success when status reaches idle', () => {

    const midAttempt: StartupGateState = { passed: false, phase: 'syncing' }

    expect(reduceStartupGateState(midAttempt, 'idle')).toEqual({
      passed: false,
      phase: 'success',
    })

  })

  it('resolves a syncing attempt to error when status reaches unavailable (any classified failure)', () => {

    const midAttempt: StartupGateState = { passed: false, phase: 'syncing' }

    expect(reduceStartupGateState(midAttempt, 'unavailable')).toEqual({
      passed: false,
      phase: 'error',
    })

  })

  it('a Retry after error re-arms syncing, the same as the original attempt', () => {

    const afterError: StartupGateState = { passed: false, phase: 'error' }

    expect(reduceStartupGateState(afterError, 'pending')).toEqual({
      passed: false,
      phase: 'syncing',
    })

  })

  it('never reacts to status changes once passed, regardless of phase', () => {

    const passedMidSuccess: StartupGateState = { passed: true, phase: 'success' }

    expect(reduceStartupGateState(passedMidSuccess, 'pending')).toBe(passedMidSuccess)
    expect(reduceStartupGateState(passedMidSuccess, 'unavailable')).toBe(passedMidSuccess)
    expect(reduceStartupGateState(passedMidSuccess, 'idle')).toBe(passedMidSuccess)

  })

})

describe('markStartupGatePassed - the shared "reach the app" action', () => {

  it('sets passed true from any phase', () => {

    expect(markStartupGatePassed({ passed: false, phase: 'idle' })).toEqual({
      passed: true,
      phase: 'idle',
    })

    expect(markStartupGatePassed({ passed: false, phase: 'error' })).toEqual({
      passed: true,
      phase: 'error',
    })

  })

  it('is idempotent (same reference back) once already passed', () => {

    const alreadyPassed: StartupGateState = { passed: true, phase: 'success' }

    expect(markStartupGatePassed(alreadyPassed)).toBe(alreadyPassed)

  })

})

describe('computeStartupGateView - what the gate shows', () => {

  it('shows the sign-in prompt whenever there is no active account, regardless of phase', () => {

    expect(
      computeStartupGateView(false, INITIAL_STARTUP_GATE_STATE, null)
    ).toEqual({ kind: 'sign-in-prompt' })

    expect(
      computeStartupGateView(false, { passed: false, phase: 'error' }, null)
    ).toEqual({ kind: 'sign-in-prompt' })

  })

  it('"continue without signing in" reaches the app: once passed, the view is "passed" even with no account', () => {

    expect(
      computeStartupGateView(false, { passed: true, phase: 'idle' }, null)
    ).toEqual({ kind: 'passed' })

  })

  it('shows syncing while signed in and a gating attempt is in flight (or not yet started)', () => {

    expect(
      computeStartupGateView(true, INITIAL_STARTUP_GATE_STATE, null)
    ).toEqual({ kind: 'syncing' })

    expect(
      computeStartupGateView(true, { passed: false, phase: 'syncing' }, null)
    ).toEqual({ kind: 'syncing' })

  })

  it('shows success once a signed-in sync completes cleanly (the auto-proceed trigger)', () => {

    expect(
      computeStartupGateView(true, { passed: false, phase: 'success' }, null)
    ).toEqual({ kind: 'success' })

  })

  it('"continue without syncing" reaches the app: once passed, the view is "passed" even after an error', () => {

    expect(
      computeStartupGateView(true, { passed: true, phase: 'error' }, null)
    ).toEqual({ kind: 'passed' })

  })

  it('shows the specific classified outcome on failure, not a generic error', () => {

    const outcome = { type: 'offline' as const }

    expect(
      computeStartupGateView(true, { passed: false, phase: 'error' }, outcome)
    ).toEqual({ kind: 'error', outcome })

    const authOutcome = { type: 'not-signed-in' as const }

    expect(
      computeStartupGateView(true, { passed: false, phase: 'error' }, authOutcome)
    ).toEqual({ kind: 'error', outcome: authOutcome })

  })

})
