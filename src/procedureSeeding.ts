import type { Procedure } from './App'

/*
  BUILT-IN PROCEDURE SEEDING (Phase 2, Step 7 of the Sync &
  Statistics Redesign)

  Pulled out of App.tsx as its own small, pure, directly-testable
  module - the same "thin orchestration over a tested pure core"
  split this project already uses elsewhere (see
  cloudBackupRotation.ts/cloudBackup.ts's own header comments). App.tsx
  itself has top-level runtime dependencies (MSAL/window, pulled in
  transitively by rendering MicrosoftAccountSection) that make it
  impossible to unit-test directly in this project's Node test
  environment - every single import from App.tsx anywhere else in
  this codebase, including every other test file, is type-only
  (erased at compile time). Keeping this logic here, with only a
  type-only import of Procedure back, means it can be exercised
  directly with no mocking at all.

  ============================================================
  WHY THESE FOUR TAGS EXIST
  ============================================================

  cr-class-2/3/4/5 (defined among App.tsx's BUILTIN_TEMPLATES) have
  existed as ProcedureTemplate records since the template taxonomy was
  introduced, but were never reachable from anywhere in the app: the
  only Procedure that ever pointed at a composite template ('cr')
  always used cr-default (Class I) via its flat templateId, and
  App.tsx's resolveTemplate() has no other selector that could ever
  route to one of these by tooth/region the way RCT's
  regionTemplateIds does. This gives each of them its own standalone
  tag, so a dentist who wants separate Statistics history per
  composite class can pick one directly, instead of every composite
  filling bucketing into the single existing "Composite Restoration"
  (Class I) tag.

  Deliberately only Class II-V get a new tag here - Class I already
  has one (the existing 'cr' tag in App.tsx's BUILTIN_PROCEDURES,
  left completely untouched, still pointing at cr-default).

  ============================================================
  WHY THE IDS ARE FIXED, NOT crypto.randomUUID()
  ============================================================

  Two different devices must independently arrive at the EXACT SAME
  id for "Class II", or they would each mint their own, and the very
  history-splitting bug Phase 1 fixed (two unrelated ids for what a
  dentist considers one procedure) would reappear immediately for
  every composite class tag, on every fresh install or first-sync.

  ============================================================
  WHY seedMissingBuiltinProcedures() IS SAFE TO RUN ON EVERY LOAD
  ============================================================

  - A fresh install needs no migration at all: App.tsx's
    BUILTIN_PROCEDURES already includes these seeds directly, which
    is the starting value of both the `procedures` React state and
    the load effect's own shapedProcedures.
  - An EXISTING install's already-persisted procedure list predates
    these ids. seedMissingBuiltinProcedures() appends exactly the
    seeds whose id isn't already present - by id, not by name,
    matching every other "resolve by id" rule in this codebase - so
    calling it is always safe:
    - first run on an existing install: all four ids are missing, all
      four get appended once.
    - every run after that, on this device or any other that has
      already synced them in: all four ids are already present,
      nothing is appended, changed stays false, and no write happens.
    - if a dentist later renames or archives one of these tags, this
      function still finds its (now-different) record by id and
      leaves it completely alone - only an id that is TRULY ABSENT
      ever gets a fresh seed appended.
  - This function never reads or writes toothTargetSavedTreatments at
    all (its signature doesn't even accept a treatments argument) -
    an existing "Composite Restoration" (Class I) treatment's
    procedureId/procedureName snapshot is structurally untouchable by
    this migration, exactly like every other procedure
    edit/archive/migration in this codebase never rewrites past
    treatments.

  Uses the exact same BUILTIN_PROCEDURE_UPDATED_AT fixed timestamp as
  every other built-in, deliberately NOT "now" - this is what makes
  two different devices that each independently run this migration,
  on two different days, produce byte-for-byte identical records
  (same id, name, templateId, updatedAt), so a sync comparison sees no
  difference between them at all, rather than two devices disagreeing
  over whose migration timestamp is newer.
*/

export const BUILTIN_PROCEDURE_UPDATED_AT = '2024-01-01T00:00:00.000Z'

export const COMPOSITE_CLASS_PROCEDURE_SEEDS = [
  { id: 'cr-ii', name: 'Composite Restoration - Class II', isCustom: false, templateId: 'cr-class-2' },
  { id: 'cr-iii', name: 'Composite Restoration - Class III', isCustom: false, templateId: 'cr-class-3' },
  { id: 'cr-iv', name: 'Composite Restoration - Class IV', isCustom: false, templateId: 'cr-class-4' },
  { id: 'cr-v', name: 'Composite Restoration - Class V', isCustom: false, templateId: 'cr-class-5' },
] satisfies Omit<Procedure, 'updatedAt'>[]

export function seedMissingBuiltinProcedures(
  procedures: Procedure[]
): { procedures: Procedure[]; changed: boolean } {

  const missingSeeds =
    COMPOSITE_CLASS_PROCEDURE_SEEDS.filter(
      seed => !procedures.some(procedure => procedure.id === seed.id)
    )

  if (missingSeeds.length === 0) {
    return { procedures, changed: false }
  }

  return {
    procedures: [
      ...procedures,
      ...missingSeeds.map(seed => ({
        ...seed,
        updatedAt: BUILTIN_PROCEDURE_UPDATED_AT,
      })),
    ],
    changed: true,
  }

}
