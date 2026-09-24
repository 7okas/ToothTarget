import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  CLOUD_SYNC_APP,
  type CloudSyncDocument,
} from './cloudSync'

/*
  cloudStorage.ts imports getAccessToken from ./auth, which (via
  authConfig.ts) touches `window.location` and instantiates MSAL's
  PublicClientApplication at module load time - importing the real
  module here would crash immediately under Vitest's default 'node'
  environment. vi.mock hoists above imports and replaces the module
  entirely before cloudStorage.ts ever evaluates its own import of
  it, so the real auth.ts/authConfig.ts never load in this test file.
*/

vi.mock('./auth', () => ({
  getAccessToken: vi.fn(),
}))

import { getAccessToken } from './auth'
import {
  readCloudSyncDocument,
  writeCloudSyncDocument,
  __setAppFolderProvisionedForTests,
} from './cloudStorage'
import { readCloudCorruptionDiagnostics } from './cloudCorruptionDiagnostics'

const mockedGetAccessToken = vi.mocked(getAccessToken)

/*
  Minimal in-memory Storage - same pattern used throughout this
  project's own test suite (see cloudSyncEngine.test.ts's own comment).
  Needed here only for the new corruption-diagnostics-capture tests
  below - every other test in this file never touches localStorage at
  all, which is exactly why captureCloudCorruptionDiagnostics() is
  written to fail silently rather than throw when localStorage isn't
  usable (see this file's other tests, none of which stub it).
*/
class MemoryStorage implements Storage {

  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

}

function makeDocument(
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

function jsonResponse(
  status: number,
  body: unknown,
  headersInit?: HeadersInit
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headersInit },
  })
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status })
}

beforeEach(() => {
  mockedGetAccessToken.mockReset()
  mockedGetAccessToken.mockResolvedValue('test-access-token')
  vi.stubGlobal('fetch', vi.fn())
  globalThis.localStorage = new MemoryStorage()
  /*
    Every test below exercises read/write behavior assuming the App
    Folder already exists (matching every test's existing mocked fetch
    sequence, written before app-folder provisioning existed) - only
    the dedicated 'app folder provisioning' tests further down opt out
    of this by setting it back to false first.
  */
  __setAppFolderProvisionedForTests(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readCloudSyncDocument', () => {

  it('maps a 404 on the metadata request to not-found', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock.mockResolvedValueOnce(textResponse(404, 'Not Found'))

    const result = await readCloudSyncDocument()

    expect(result).toEqual({ status: 'not-found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

  })

  it('preserves the returned eTag exactly, and returns the validated document', async () => {

    const document = makeDocument()
    const exactETag = '"0123ABCD,4"'

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { eTag: exactETag }))
      .mockResolvedValueOnce(jsonResponse(200, document))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('found')

    if (result.status !== 'found') {
      throw new Error('expected a found result')
    }

    expect(result.eTag).toBe(exactETag)
    expect(result.document).toEqual(document)

  })

  it('does not map malformed cloud JSON to not-found', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { eTag: '"abc"' }))
      .mockResolvedValueOnce(textResponse(200, '{ not valid json'))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('malformed-json')
    expect(result.status).not.toBe('not-found')

  })

  it('classifies malformed JSON as an "unreadable" diagnosis (no specific record identified) and captures diagnostics', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { eTag: '"abc"' }))
      .mockResolvedValueOnce(textResponse(200, '{ not valid json'))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('malformed-json')

    if (result.status !== 'malformed-json') {
      throw new Error('expected malformed-json')
    }

    expect(result.diagnosis?.kind).toBe('unreadable')

    const diagnostics = readCloudCorruptionDiagnostics()

    expect(diagnostics?.rawContent).toBe('{ not valid json')
    expect(diagnostics?.error).toBe(result.detail)
    expect(typeof diagnostics?.capturedAt).toBe('string')

  })

  it('does not map an unsupported schema version to not-found', async () => {

    const fetchMock = vi.mocked(fetch)

    const legacyLookingDocument = {
      schemaVersion: 1,
      app: 'ToothTarget',
      exportedAt: '2026-01-01T00:00:00.000Z',
      patients: [],
      savedTreatments: [],
      customTemplates: [],
      customProcedures: [],
    }

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { eTag: '"abc"' }))
      .mockResolvedValueOnce(jsonResponse(200, legacyLookingDocument))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('invalid-document')
    expect(result.status).not.toBe('not-found')

  })

  it('classifies a document-shape rejection (unsupported schema version) as "unreadable", and captures diagnostics with the raw content', async () => {

    const fetchMock = vi.mocked(fetch)

    const legacyLookingDocument = {
      schemaVersion: 1,
      app: 'ToothTarget',
      exportedAt: '2026-01-01T00:00:00.000Z',
      patients: [],
      savedTreatments: [],
      customTemplates: [],
      customProcedures: [],
    }

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { eTag: '"abc"' }))
      .mockResolvedValueOnce(jsonResponse(200, legacyLookingDocument))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('invalid-document')

    if (result.status !== 'invalid-document') {
      throw new Error('expected invalid-document')
    }

    expect(result.diagnosis?.kind).toBe('unreadable')

    const diagnostics = readCloudCorruptionDiagnostics()

    expect(diagnostics?.rawContent).toBe(JSON.stringify(legacyLookingDocument))
    expect(diagnostics?.error).toBe(result.detail)

  })

  it('classifies a single bad record (a patient missing its name) as "invalid-record", identifying that exact patient', async () => {

    const fetchMock = vi.mocked(fetch)

    const documentWithBadPatient = {
      schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
      app: CLOUD_SYNC_APP,
      updatedAt: '2026-01-01T00:00:00.000Z',
      patients: [
        {
          id: 'patient-broken',
          patientNumber: 4,
          name: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      savedTreatments: [],
      customTemplates: [],
      customProcedures: [],
      deletionTombstones: [],
    }

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { eTag: '"abc"' }))
      .mockResolvedValueOnce(jsonResponse(200, documentWithBadPatient))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('invalid-document')

    if (result.status !== 'invalid-document') {
      throw new Error('expected invalid-document')
    }

    expect(result.diagnosis?.kind).toBe('invalid-record')

    if (result.diagnosis?.kind === 'invalid-record') {
      expect(result.diagnosis.recordType).toBe('patient')
      expect(result.diagnosis.recordDescription).toContain('patient-broken')
    }

  })

  it('maps a 401 on the metadata request to auth-failed', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock.mockResolvedValueOnce(textResponse(401, 'Unauthorized'))

    const result = await readCloudSyncDocument()

    expect(result).toEqual({ status: 'auth-failed' })

  })

  it('maps a 403 on the metadata request to permission-denied', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: { code: 'accessDenied', message: 'nope' } })
    )

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('permission-denied')

  })

  it('returns auth-failed without calling fetch when there is no access token', async () => {

    mockedGetAccessToken.mockResolvedValue(null)

    const fetchMock = vi.mocked(fetch)

    const result = await readCloudSyncDocument()

    expect(result).toEqual({ status: 'auth-failed' })
    expect(fetchMock).not.toHaveBeenCalled()

  })

  /*
    Phase 6 - fetch() itself throwing (never reaching a Graph response
    at all) is now reported as its own distinct 'network-unreachable'
    status, separate from 'graph-error' (a response WAS received, just
    an unexpected one - see the metadata-parse-failure test below).
  */
  it('maps a thrown fetch error on the metadata request to network-unreachable, not graph-error', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('network-unreachable')
    expect(result.status).not.toBe('graph-error')

    if (result.status === 'network-unreachable') {
      expect(result.detail).toContain('Failed to fetch')
    }

  })

  it('maps a thrown fetch error on the content request to network-unreachable', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { eTag: '"abc"' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('network-unreachable')

  })

  it('still maps a genuine Graph-side response failure (a bad response body) to graph-error, not network-unreachable', async () => {

    const fetchMock = vi.mocked(fetch)

    // A response WAS received (200 OK), but its body has no eTag -
    // this is a Graph/OneDrive anomaly, not a network problem.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('graph-error')
    expect(result.status).not.toBe('network-unreachable')

  })

})

describe('writeCloudSyncDocument', () => {

  it('rejects an invalid document before making any Graph request', async () => {

    const fetchMock = vi.mocked(fetch)

    const result = await writeCloudSyncDocument(
      { not: 'a real document' } as unknown as CloudSyncDocument,
      null
    )

    expect(result.status).toBe('invalid-document')
    expect(fetchMock).not.toHaveBeenCalled()

  })

  it('accepts a valid v2 document and proceeds to the Graph write', async () => {

    const document = makeDocument()

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          uploadUrl: 'https://upload.example/session-1',
        })
      )
      .mockResolvedValueOnce(jsonResponse(201, { eTag: '"new-etag"' }))

    const result = await writeCloudSyncDocument(document, null)

    expect(result).toEqual({ status: 'written', eTag: '"new-etag"' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

  })

  it('uploads the document unmodified - updatedAt is never rewritten', async () => {

    const document = makeDocument({
      updatedAt: '2020-05-17T08:00:00.000Z',
    })

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { uploadUrl: 'https://upload.example/session-2' })
      )
      .mockResolvedValueOnce(jsonResponse(201, { eTag: '"e2"' }))

    await writeCloudSyncDocument(document, null)

    const uploadCall = fetchMock.mock.calls[1]
    const uploadedBody = uploadCall[1]?.body as Uint8Array

    const uploadedDocument = JSON.parse(
      new TextDecoder().decode(uploadedBody)
    )

    expect(uploadedDocument.updatedAt).toBe('2020-05-17T08:00:00.000Z')
    expect(uploadedDocument).toEqual(document)

  })

  it('sends the safe create-only behavior and no if-match when expectedETag is null', async () => {

    const document = makeDocument()

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { uploadUrl: 'https://upload.example/session-3' })
      )
      .mockResolvedValueOnce(jsonResponse(201, { eTag: '"e3"' }))

    await writeCloudSyncDocument(document, null)

    const sessionCall = fetchMock.mock.calls[0]
    const sessionHeaders = new Headers(sessionCall[1]?.headers)
    const sessionBody = JSON.parse(String(sessionCall[1]?.body))

    expect(sessionHeaders.has('if-match')).toBe(false)
    expect(sessionBody.item['@microsoft.graph.conflictBehavior']).toBe(
      'fail'
    )

  })

  it('passes expectedETag verbatim as the if-match header for a conditional update', async () => {

    const document = makeDocument()
    const expectedETag = '"existing-etag-value,1"'

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { uploadUrl: 'https://upload.example/session-4' })
      )
      .mockResolvedValueOnce(jsonResponse(200, { eTag: '"e4"' }))

    await writeCloudSyncDocument(document, expectedETag)

    const sessionCall = fetchMock.mock.calls[0]
    const sessionHeaders = new Headers(sessionCall[1]?.headers)
    const sessionBody = JSON.parse(String(sessionCall[1]?.body))

    expect(sessionHeaders.get('if-match')).toBe(expectedETag)
    expect(sessionBody.item['@microsoft.graph.conflictBehavior']).toBe(
      'replace'
    )

  })

  it('maps a 412 from createUploadSession to precondition-failed without uploading', async () => {

    const document = makeDocument()

    const fetchMock = vi.mocked(fetch)

    fetchMock.mockResolvedValueOnce(
      textResponse(412, 'Precondition Failed')
    )

    const result = await writeCloudSyncDocument(document, '"stale-etag"')

    expect(result).toEqual({ status: 'precondition-failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

  })

  it('maps a 409 (name already exists) on create to precondition-failed', async () => {

    const document = makeDocument()

    const fetchMock = vi.mocked(fetch)

    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: 'nameAlreadyExists', message: 'taken' },
      })
    )

    const result = await writeCloudSyncDocument(document, null)

    expect(result).toEqual({ status: 'precondition-failed' })

  })

  it('maps a 412 returned from the final upload PUT to precondition-failed', async () => {

    const document = makeDocument()

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { uploadUrl: 'https://upload.example/session-5' })
      )
      .mockResolvedValueOnce(textResponse(412, 'Precondition Failed'))

    const result = await writeCloudSyncDocument(document, '"some-etag"')

    expect(result).toEqual({ status: 'precondition-failed' })

  })

  it('returns auth-failed without calling fetch when there is no access token', async () => {

    mockedGetAccessToken.mockResolvedValue(null)

    const fetchMock = vi.mocked(fetch)

    const result = await writeCloudSyncDocument(makeDocument(), null)

    expect(result).toEqual({ status: 'auth-failed' })
    expect(fetchMock).not.toHaveBeenCalled()

  })

  it('maps a thrown fetch error on createUploadSession to network-unreachable, not graph-error', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const result = await writeCloudSyncDocument(makeDocument(), null)

    expect(result.status).toBe('network-unreachable')
    expect(result.status).not.toBe('graph-error')

  })

  it('maps a thrown fetch error on the final upload PUT to network-unreachable', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { uploadUrl: 'https://upload.example/session-6' })
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const result = await writeCloudSyncDocument(makeDocument(), null)

    expect(result.status).toBe('network-unreachable')

  })

  it('still maps a genuine Graph-side response failure (a bad session body) to graph-error, not network-unreachable', async () => {

    const fetchMock = vi.mocked(fetch)

    // A response WAS received (200 OK), but with no uploadUrl - a
    // Graph/OneDrive anomaly, not a network problem.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))

    const result = await writeCloudSyncDocument(makeDocument(), null)

    expect(result.status).toBe('graph-error')
    expect(result.status).not.toBe('network-unreachable')

  })

})

describe('app folder provisioning', () => {

  /*
    Only these tests opt back out of the beforeEach's default
    "already provisioned" state, to exercise the provisioning call
    itself (see cloudStorage.ts's ensureAppFolderProvisioned()).
  */
  beforeEach(() => {
    __setAppFolderProvisionedForTests(false)
  })

  it('makes one extra plain GET on the App Folder itself before the first compound-path read, and proceeds normally', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {})) // provisioning GET
      .mockResolvedValueOnce(textResponse(404, 'Not Found')) // metadata GET

    const result = await readCloudSyncDocument()

    expect(result).toEqual({ status: 'not-found' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://graph.microsoft.com/v1.0/me/drive/special/approot'
    )

  })

  it('only provisions once - a second sync attempt does not repeat the plain GET', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {})) // provisioning GET
      .mockResolvedValueOnce(textResponse(404, 'Not Found')) // 1st metadata GET
      .mockResolvedValueOnce(textResponse(404, 'Not Found')) // 2nd metadata GET

    await readCloudSyncDocument()
    await readCloudSyncDocument()

    expect(fetchMock).toHaveBeenCalledTimes(3)

  })

  it('reports a graph-error from the provisioning GET itself as graph-error, before ever attempting the compound-path read', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock.mockResolvedValueOnce(textResponse(400, 'Bad Request'))

    const result = await readCloudSyncDocument()

    expect(result.status).toBe('graph-error')
    expect(fetchMock).toHaveBeenCalledTimes(1)

  })

  it('also provisions before the first compound-path write', async () => {

    const fetchMock = vi.mocked(fetch)

    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {})) // provisioning GET
      .mockResolvedValueOnce(
        jsonResponse(200, { uploadUrl: 'https://upload.example/session' })
      )
      .mockResolvedValueOnce(jsonResponse(201, { eTag: '"new-etag"' }))

    const result = await writeCloudSyncDocument(makeDocument(), null)

    expect(result).toEqual({ status: 'written', eTag: '"new-etag"' })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://graph.microsoft.com/v1.0/me/drive/special/approot'
    )

  })

})
