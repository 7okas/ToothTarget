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
} from './cloudStorage'

const mockedGetAccessToken = vi.mocked(getAccessToken)

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
