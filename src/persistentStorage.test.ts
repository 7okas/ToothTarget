import { describe, expect, it, vi } from 'vitest'
import {
  BACKUP_NOTE,
  STORAGE_STATUS_TEXT,
  ensurePersistenceOnLaunch,
  readStorageStatus,
  requestPersistence,
} from './persistentStorage'

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

describe('readStorageStatus', () => {

  it('reports unknown when the browser has no storage API', async () => {
    expect(await readStorageStatus(undefined)).toBe('unknown')
    expect(await readStorageStatus({})).toBe('unknown')
  })

  it('reports protected when already persistent', async () => {
    expect(await readStorageStatus(fake({ persisted: true }))).toBe('protected')
  })

  it('reports not protected when not persistent', async () => {
    expect(await readStorageStatus(fake({ persisted: false }))).toBe('not-protected')
  })

  it('reports unknown (never throws) when persisted() fails', async () => {
    expect(await readStorageStatus(fake({ persisted: new Error('boom') }))).toBe('unknown')
  })

})

describe('requestPersistence', () => {

  it('reports protected when the browser grants it', async () => {
    const storage = fake({ persisted: false, persist: true })
    expect(await requestPersistence(storage)).toBe('protected')
    expect(storage.persist).toHaveBeenCalledTimes(1)
  })

  it('reports not protected when the browser refuses', async () => {
    expect(await requestPersistence(fake({ persisted: false, persist: false }))).toBe('not-protected')
  })

  it('does not throw when persist() fails, and falls back to the real status', async () => {
    expect(await requestPersistence(fake({ persisted: true, persist: new Error('x') }))).toBe('protected')
    expect(await requestPersistence(fake({ persisted: false, persist: new Error('x') }))).toBe('not-protected')
  })

  it('reports unknown when unsupported', async () => {
    expect(await requestPersistence(undefined)).toBe('unknown')
    expect(await requestPersistence({ persisted: async () => true })).toBe('protected')
  })

})

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

describe('wording', () => {

  it('uses the agreed plain-language texts and says nothing about an account', () => {
    expect(STORAGE_STATUS_TEXT.protected).toBe('Protected: this device is set to keep your data')
    expect(STORAGE_STATUS_TEXT['not-protected']).toBe('Not protected: your device may clear app data if storage runs low')
    expect(STORAGE_STATUS_TEXT.unknown).toBe('Unknown (not supported here)')
    expect(BACKUP_NOTE).not.toMatch(/account|@|email/i)
  })

})
