import type { SavedTreatment } from './App'
import { clearChecked, pruneToExisting, type CheckedIds } from './treatmentSelection'

/*
  IN-MEMORY HOME FOR THE CHECKED TREATMENTS (Statistics, Phase 8)

  A plain module-level store (same get/subscribe shape as the other
  stores in this app, readable with useSyncExternalStore). It lives for
  as long as the app stays open, so the checks survive leaving the
  Statistics screen and coming back - the screen component is destroyed
  and rebuilt, this is not. It is DELIBERATELY never written to
  localStorage, IndexedDB, the cloud or anywhere else: closing or
  reloading the app clears it, and it can never sync.

  getCheckedTreatmentIds() returns the same set object until something
  actually changes, which is what useSyncExternalStore needs.
*/

let checked: CheckedIds = new Set<string>()

const listeners = new Set<() => void>()

export function getCheckedTreatmentIds(): CheckedIds {
  return checked
}

export function subscribeCheckedTreatments(listener: () => void): () => void {

  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }

}

export function setCheckedTreatmentIds(next: CheckedIds): void {

  if (next === checked) {
    return
  }

  checked = next

  for (const listener of listeners) {
    listener()
  }

}

/* The "Clear" button. */
export function clearCheckedTreatments(): void {
  setCheckedTreatmentIds(clearChecked(checked))
}

/*
  Drops ids of treatments that no longer exist, silently. Safe to call
  on every render of the screen: it changes nothing (and notifies
  nobody) when every checked id still has its treatment.
*/
export function pruneCheckedTreatments(
  treatments: readonly Pick<SavedTreatment, 'id'>[]
): void {
  setCheckedTreatmentIds(pruneToExisting(checked, treatments))
}

/* TEST-ONLY. */
export function __resetCheckedTreatmentsForTests(): void {
  checked = new Set<string>()
  listeners.clear()
}
