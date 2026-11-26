/*
  PERSISTENT STORAGE

  Asks the browser to keep this site's data (localStorage included) even
  when the device runs low on space, once per launch (see main.tsx). This
  only ever calls navigator.storage.persisted() / persist() - it never
  reads or writes any ToothTarget data - and it never throws. There is no
  Settings screen for it: it is automatic.
*/

export type StorageLike = {
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
}

function defaultStorage(): StorageLike | undefined {

  return typeof navigator === 'undefined' ? undefined : navigator.storage

}

/*
  Once per launch, quietly. Already persistent => nothing to ask.
*/
export async function ensurePersistenceOnLaunch(
  storage: StorageLike | undefined = defaultStorage()
): Promise<void> {

  if (
    !storage ||
    typeof storage.persisted !== 'function' ||
    typeof storage.persist !== 'function'
  ) {
    return
  }

  try {

    if (!(await storage.persisted())) {
      await storage.persist()
    }

  } catch {
    // Unsupported or refused: nothing to show, nothing to do.
  }

}
