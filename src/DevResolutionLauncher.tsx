import { openResolutionScreen, openSafetyCopiesScreen } from './syncResolutionStore'

/*
  TEMPORARY, DEV-ONLY (Phase 6, commit 1 of Chunk C)

  Two small buttons that open the resolution screen and the safety-copies
  screen so they can be tried before they are wired into the startup gate,
  the sync badge and Settings. Mounted in main.tsx ONLY when
  import.meta.env.DEV is true - it is never part of a production build.
  Removed again by the wiring commit that follows.
*/
export default function DevResolutionLauncher() {

  return (
    <div className="dev-launcher">
      <button type="button" onClick={openResolutionScreen}>
        DEV: Resolve differences
      </button>
      <button type="button" onClick={openSafetyCopiesScreen}>
        DEV: Safety copies
      </button>
    </div>
  )

}
