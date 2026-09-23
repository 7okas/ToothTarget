import { getAccessToken } from './auth'
import { validateCloudSyncDocument, type CloudSyncDocument } from './cloudSync'
import { migrateCloudSyncDocumentShape } from './cloudSyncSchemaMigration'

/*
  CLOUD STORAGE (Microsoft Graph OneDrive App Folder)

  Read/write helpers for ToothTarget's single cloud data file,
  toothtarget-data.json, inside the signed-in Microsoft account's
  OneDrive App Folder (Files.ReadWrite.AppFolder - already granted,
  no new scopes here). Same Graph endpoints and access-token pattern
  already proven working in graphTest.ts.

  This module is intentionally inert on its own: nothing in
  ToothTarget calls readCloudData()/writeCloudData() yet, and it
  never touches patient/treatment/template data or any existing
  localStorage key. It only exists so a later, separate step can wire
  actual backup/sync on top of it.

  ============================================================
  PHASE 5 ADDITION - SYNC DOCUMENT TRANSPORT (ETag-conditional)
  ============================================================

  readCloudSyncDocument()/writeCloudSyncDocument() below are a
  SEPARATE pair of functions for the Phase 1 CloudSyncDocument (v2
  schema) - deliberately NOT layered on top of readCloudData()/
  writeCloudData() above, and deliberately targeting a DIFFERENT file
  name (see CLOUD_SYNC_FILE_NAME below), for a concrete reason found
  during this phase's audit: toothtarget-data.json is already claimed
  by TWO existing, real features -
  createCloudBackup()/applyCloudRestore() (cloudBackup.ts's "Backup to
  Cloud"/"Load from Cloud", schemaVersion 1) and
  cloudStorageTest.ts's "Test Cloud Data File" connectivity check
  (an unconditional throwaway-payload overwrite). Pointing the new
  schemaVersion-2 sync document at that same file would mean three
  incompatible writers fighting over one file - eg. clicking "Test
  Cloud Data File" would silently destroy a real sync document, and a
  sync write would silently destroy a real backup. Both existing
  features are left completely untouched (see cloudBackup.ts/
  cloudStorageTest.ts/MicrosoftAccountSection.tsx, none of which are
  modified in this phase) and keep using toothtarget-data.json exactly
  as before; the sync document gets its own dedicated file instead, so
  there is exactly one writer per file rather than three sharing one.

  Nothing in ToothTarget calls readCloudSyncDocument()/
  writeCloudSyncDocument() yet either - no automatic sync, no merge
  orchestration, no retry-after-412, no UI. This phase is transport
  only: read the sync document + its Graph ETag, and conditionally
  write it back. Reuses the exact same getAccessToken() (auth.ts),
  GRAPH_APPROOT, and describeGraphError() already used above - no new
  MSAL instance, no new login flow, no new scopes.
*/

const GRAPH_APPROOT =
  'https://graph.microsoft.com/v1.0/me/drive/special/approot'

const CLOUD_DATA_FILE_NAME = 'toothtarget-data.json'

/*
  Reads a Graph error response body for a useful message (Graph
  returns { error: { code, message } } on failure) - never includes
  the Authorization header or the token itself.
*/
async function describeGraphError(response: Response): Promise<string> {

  try {

    const body = await response.json()
    const graphMessage = body?.error?.message || body?.error?.code

    if (graphMessage) {
      return `${response.status} ${response.statusText} - ${graphMessage}`
    }

  } catch {
    // Response body wasn't JSON - fall through to the generic message below.
  }

  return `${response.status} ${response.statusText}`

}

async function requireAccessToken(): Promise<string> {

  const accessToken = await getAccessToken()

  if (!accessToken) {
    throw new Error(
      'Not signed in to Microsoft (or the access token could not be obtained). Sign in and try again.'
    )
  }

  return accessToken

}

/*
  READ

  Downloads and parses toothtarget-data.json from the App Folder.
  Returns null (not an error) when the file simply doesn't exist yet
  - eg. before it has ever been written - since that is an expected,
  normal state, not a failure. Throws a plain-language Error for
  anything else (not signed in, network/Graph failure, or a file that
  exists but isn't valid JSON).
*/

export async function readCloudData<T = unknown>(): Promise<T | null> {

  const accessToken = await requireAccessToken()

  const response = await fetch(
    `${GRAPH_APPROOT}:/${CLOUD_DATA_FILE_NAME}:/content`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(
      `Could not read ${CLOUD_DATA_FILE_NAME} from the OneDrive App Folder (${await describeGraphError(response)}).`
    )
  }

  try {

    return (await response.json()) as T

  } catch {

    throw new Error(
      `${CLOUD_DATA_FILE_NAME} was downloaded but could not be parsed as JSON.`
    )

  }

}

/*
  WRITE

  Creates or overwrites toothtarget-data.json in the App Folder with
  the JSON-serialized form of whatever is passed in. Throws a
  plain-language Error on failure (not signed in, or the Graph
  request itself failing).
*/

export async function writeCloudData(data: unknown): Promise<void> {

  const accessToken = await requireAccessToken()

  const response = await fetch(
    `${GRAPH_APPROOT}:/${CLOUD_DATA_FILE_NAME}:/content`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    }
  )

  if (!response.ok) {
    throw new Error(
      `Could not write ${CLOUD_DATA_FILE_NAME} to the OneDrive App Folder (${await describeGraphError(response)}).`
    )
  }

}

/*
  ============================================================
  PHASE 5 - SYNC DOCUMENT TRANSPORT
  ============================================================

  See this file's header comment for why this targets its own,
  separate file rather than CLOUD_DATA_FILE_NAME above.
*/

const CLOUD_SYNC_FILE_NAME = 'toothtarget-sync.json'

/*
  Shared failure states between read and write - deliberately never
  collapsed into one generic "Cloud sync failed" message/status, so a
  future caller can tell "you're not signed in" apart from "Graph
  rejected this for a permissions reason" apart from "something else
  went wrong talking to Graph" (which also covers plain network
  failures - offline, DNS, etc. - since those arrive as a thrown
  error from fetch() itself rather than an HTTP status).
*/

export type CloudSyncTransportFailure =
  | { status: 'auth-failed' }
  | { status: 'permission-denied'; detail: string }
  | { status: 'graph-error'; detail: string }

export type CloudSyncReadResult =
  | { status: 'not-found' }
  | { status: 'found'; document: CloudSyncDocument; eTag: string }
  | { status: 'malformed-json'; detail: string }
  | { status: 'invalid-document'; detail: string }
  | CloudSyncTransportFailure

export type CloudSyncWriteResult =
  | { status: 'written'; eTag: string | null }
  | { status: 'precondition-failed' }
  | { status: 'invalid-document'; detail: string }
  | CloudSyncTransportFailure

function classifyGraphFailure(
  response: Response,
  detail: string
): CloudSyncTransportFailure {

  if (response.status === 401) {
    return { status: 'auth-failed' }
  }

  if (response.status === 403) {
    return { status: 'permission-denied', detail }
  }

  return { status: 'graph-error', detail }

}

function describeNetworkFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/*
  READ

  Two Graph requests, deliberately: a metadata GET (no :/content) to
  read the driveItem's real eTag off the response body, and a second
  GET .../content - the exact same call/pattern readCloudData() above
  already uses - to fetch the actual bytes. The eTag is NEVER derived
  from the content response, hashed, or invented locally; it is
  whatever Graph's driveItem.eTag property says, preserved verbatim
  (quotes and all) so it can be handed back unchanged as the If-Match
  value on a later write. (The file could in principle change in the
  instant between these two requests; that's not a correctness problem
  here, because the conditional WRITE below is what actually enforces
  concurrency safety, not this read - see writeCloudSyncDocument().)

  Every distinguishable outcome the future sync/merge layer needs is
  its own status, never collapsed into a generic error:
    - 'not-found': the file genuinely doesn't exist (404) - a normal,
      expected first-run state, never thrown as an error.
    - 'malformed-json': the file exists but isn't parseable JSON at
      all - this is very deliberately NOT reported as 'not-found'.
    - 'invalid-document': the file is valid JSON but
      validateCloudSyncDocument() rejects it (wrong schemaVersion/app,
      or any other structural problem) - also never 'not-found'.
    - 'found': a genuinely valid v2 document, plus its eTag.
*/

export async function readCloudSyncDocument(): Promise<CloudSyncReadResult> {

  /*
    allowInteraction: false - this is the automatic sync path (see
    auth.ts's getAccessToken() header comment); it must never pop open
    a Microsoft sign-in window on its own. A token that needs
    interactive refresh simply resolves to null here, reported below
    as 'auth-failed'.
  */
  const accessToken = await getAccessToken({ allowInteraction: false })

  if (!accessToken) {
    return { status: 'auth-failed' }
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` }

  let metadataResponse: Response

  try {

    metadataResponse = await fetch(
      `${GRAPH_APPROOT}:/${CLOUD_SYNC_FILE_NAME}`,
      { headers: authHeaders }
    )

  } catch (error) {
    return { status: 'graph-error', detail: describeNetworkFailure(error) }
  }

  if (metadataResponse.status === 404) {
    return { status: 'not-found' }
  }

  if (!metadataResponse.ok) {
    return classifyGraphFailure(
      metadataResponse,
      await describeGraphError(metadataResponse)
    )
  }

  let eTag: string

  try {

    const metadata = await metadataResponse.json()

    if (typeof metadata?.eTag !== 'string' || metadata.eTag === '') {
      return {
        status: 'graph-error',
        detail: 'The cloud file metadata did not include an eTag.',
      }
    }

    eTag = metadata.eTag

  } catch {

    return {
      status: 'graph-error',
      detail: `Could not read ${CLOUD_SYNC_FILE_NAME}'s metadata from the OneDrive App Folder.`,
    }

  }

  let contentResponse: Response

  try {

    contentResponse = await fetch(
      `${GRAPH_APPROOT}:/${CLOUD_SYNC_FILE_NAME}:/content`,
      { headers: authHeaders }
    )

  } catch (error) {
    return { status: 'graph-error', detail: describeNetworkFailure(error) }
  }

  /*
    Genuinely rare (the metadata GET just above succeeded), but not
    impossible if the file was deleted in the instant between the two
    requests - still an honest 'not-found', not an error.
  */
  if (contentResponse.status === 404) {
    return { status: 'not-found' }
  }

  if (!contentResponse.ok) {
    return classifyGraphFailure(
      contentResponse,
      await describeGraphError(contentResponse)
    )
  }

  let parsedContent: unknown

  try {

    parsedContent = await contentResponse.json()

  } catch {

    return {
      status: 'malformed-json',
      detail: `${CLOUD_SYNC_FILE_NAME} was downloaded but could not be parsed as JSON.`,
    }

  }

  /*
    SCHEMA MIGRATION (Phase 4.6 - cloud sync hardening)

    A document downloaded from OneDrive may have been written by an
    older version of this app, before a currently-required field
    existed (eg. Patient.createdAt, SavedTreatment.updatedAt) - that's
    an outdated document, not a corrupt one. migrateCloudSyncDocumentShape()
    backfills exactly those known, safely-derivable fields (see its own
    header comment for the full reasoning and the safety rules every
    step follows) BEFORE the strict validator below ever sees it, so a
    merely-outdated document is upgraded in memory and validated like
    any current one - genuine corruption (wrong types, fields with no
    honest fallback) still reaches validateCloudSyncDocument() untouched
    and is still rejected exactly as before.
  */
  const migratedContent = migrateCloudSyncDocumentShape(parsedContent)

  const validation = validateCloudSyncDocument(migratedContent)

  if (!validation.valid) {
    return { status: 'invalid-document', detail: validation.error }
  }

  return { status: 'found', document: validation.document, eTag }

}

/*
  WRITE (conditional)

  Uses createUploadSession, not the plain PUT :/content used by
  writeCloudData() above - per the current Microsoft Graph
  documentation (learn.microsoft.com/graph/api/driveitem-put-content,
  checked while implementing this phase), the small-file content PUT
  endpoint's request headers are only Authorization/Content-Type; it
  does not document or support If-Match at all. createUploadSession's
  own documented request headers DO include if-match/if-none-match
  (learn.microsoft.com/graph/api/driveitem-createuploadsession):
  "If this request header is included and the eTag ... provided
  doesn't match the current etag on the item, a 412 Precondition
  Failed error response is returned" - exactly the concurrency check
  this phase needs, so this is the only mechanism used here.

  Two cases, both using the SAME path-based createUploadSession
  endpoint (parent + filename, matching how every other Graph call in
  this file already addresses the App Folder by path):

  - expectedETag is a string (the caller previously read the file and
    knows its current eTag): conflictBehavior is 'replace' (this is
    expected to update an existing file) and the if-match header
    carries expectedETag verbatim. If the file changed since it was
    read, Graph returns 412 - reported as 'precondition-failed'; the
    write does not happen.

  - expectedETag === null (the caller previously determined the file
    does not exist): conflictBehavior is 'fail' (the documented
    default, set explicitly here for clarity) and no if-match header
    is sent, since there is no prior eTag to compare against. If
    another device created the file in the meantime, Graph reports
    that as a 409 nameAlreadyExists conflict - either immediately from
    createUploadSession, or "when the last byte range is uploaded" per
    Graph's own documented error-response behavior for this exact
    race. Both are treated as 'precondition-failed' here: conceptually
    the same "your assumption about the cloud state was stale" signal
    section 8 asks this phase to report rather than silently
    overwriting the other device's file. This is Graph's own
    documented safety net for the create-only race, not a
    GET-then-PUT check invented locally (which would have a race
    window of its own).

  The whole document is uploaded in a single PUT to the returned
  uploadUrl (this is a small JSON document, nowhere near the 60 MiB
  per-request limit), matching Graph's own "Completing a file
  (deferCommit is false)" example. No retry is attempted on 412/409 -
  that is explicitly Phase 6's job (re-read, merge, retry), not this
  transport layer's.
*/

export async function writeCloudSyncDocument(
  document: CloudSyncDocument,
  expectedETag: string | null
): Promise<CloudSyncWriteResult> {

  const validation = validateCloudSyncDocument(document)

  if (!validation.valid) {
    return { status: 'invalid-document', detail: validation.error }
  }

  /*
    Uploads exactly the validated document it was given - updatedAt
    (and every other field) is never touched, generated, or refreshed
    here. Owning document.updatedAt is the merge/orchestration layer's
    job, not transport's.
  */
  const serialized = JSON.stringify(validation.document)

  /*
    allowInteraction: false - same reasoning as readCloudSyncDocument()
    above: automatic sync must never pop open a Microsoft sign-in
    window on its own.
  */
  const accessToken = await getAccessToken({ allowInteraction: false })

  if (!accessToken) {
    return { status: 'auth-failed' }
  }

  const sessionHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  if (expectedETag !== null) {
    sessionHeaders['if-match'] = expectedETag
  }

  let sessionResponse: Response

  try {

    sessionResponse = await fetch(
      `${GRAPH_APPROOT}:/${CLOUD_SYNC_FILE_NAME}:/createUploadSession`,
      {
        method: 'POST',
        headers: sessionHeaders,
        body: JSON.stringify({
          item: {
            '@microsoft.graph.conflictBehavior':
              expectedETag === null ? 'fail' : 'replace',
          },
        }),
      }
    )

  } catch (error) {
    return { status: 'graph-error', detail: describeNetworkFailure(error) }
  }

  if (sessionResponse.status === 412 || sessionResponse.status === 409) {
    return { status: 'precondition-failed' }
  }

  if (!sessionResponse.ok) {
    return classifyGraphFailure(
      sessionResponse,
      await describeGraphError(sessionResponse)
    )
  }

  let uploadUrl: string

  try {

    const session = await sessionResponse.json()

    if (typeof session?.uploadUrl !== 'string' || session.uploadUrl === '') {
      return {
        status: 'graph-error',
        detail: 'Graph did not return an upload session URL.',
      }
    }

    uploadUrl = session.uploadUrl

  } catch {

    return {
      status: 'graph-error',
      detail: 'Could not read the upload session response.',
    }

  }

  /*
    Encoded as bytes (not measured by .length) so Content-Length/
    Content-Range are correct for a document containing multi-byte
    UTF-8 characters (eg. a patient/template name with accented
    letters). Authorization is deliberately NOT sent on this PUT -
    Graph's own documentation for this endpoint notes that including
    it can produce an unexpected 401, since the upload URL is already
    preauthenticated.
  */
  const contentBytes = new TextEncoder().encode(serialized)

  let uploadResponse: Response

  try {

    uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(contentBytes.byteLength),
        'Content-Range':
          contentBytes.byteLength > 0
            ? `bytes 0-${contentBytes.byteLength - 1}/${contentBytes.byteLength}`
            : 'bytes */0',
      },
      body: contentBytes,
    })

  } catch (error) {
    return { status: 'graph-error', detail: describeNetworkFailure(error) }
  }

  if (uploadResponse.status === 412 || uploadResponse.status === 409) {
    return { status: 'precondition-failed' }
  }

  if (!uploadResponse.ok) {
    return classifyGraphFailure(
      uploadResponse,
      await describeGraphError(uploadResponse)
    )
  }

  let newETag: string | null = null

  try {

    const uploadedItem = await uploadResponse.json()

    if (typeof uploadedItem?.eTag === 'string') {
      newETag = uploadedItem.eTag
    }

  } catch {
    /*
      The write already succeeded at this point (uploadResponse.ok) -
      an unparsable response body just means the new eTag isn't known
      to this caller yet, not that the write failed. A future read
      would pick up the real eTag.
    */
  }

  return { status: 'written', eTag: newETag }

}
