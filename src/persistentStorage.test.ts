import { describe, expect, it, vi } from 'vitest'
import { ensurePersistenceOnLaunch } from './persistentStorage'

function fake(options: { persisted?: boolean | Error; persist?: boolean | Error } = {}) {

  const persisted = vi.fn(async () => {
    if (options.persisted instanceof Error) throw options.persisted
    return options.persisted ?? false
  })

  const persist = vi.fn(async () => {
    if (options.persist instanceof Error) throw options.persist
    return options.persist ?? false
  })

  return { persisted, persist }

}

describe('ensurePersistenceOnLaunch', () => {

  it('asks once when not yet persistent', async () => {
    const storage = fake({ persisted: false, persist: true })
    await ensurePersistenceOnLaunch(storage)
    expect(storage.persist).toHaveBeenCalledTimes(1)
  })

  it('does not ask when already persistent', async () => {
    const storage = fake({ persisted: true })
    await ensurePersistenceOnLaunch(storage)
    expect(storage.persist).not.toHaveBeenCalled()
  })

  it('stays quiet when refused', async () => {
    await expect(ensurePersistenceOnLaunch(fake({ persisted: false, persist: false }))).resolves.toBeUndefined()
  })

  it('stays quiet when unsupported or failing', async () => {
    await expect(ensurePersistenceOnLaunch(undefined)).resolves.toBeUndefined()
    await expect(ensurePersistenceOnLaunch({})).resolves.toBeUndefined()
    await expect(ensurePersistenceOnLaunch(fake({ persisted: new Error('x') }))).resolves.toBeUndefined()
    await expect(ensurePersistenceOnLaunch(fake({ persisted: false, persist: new Error('x') }))).resolves.toBeUndefined()
  })

})
