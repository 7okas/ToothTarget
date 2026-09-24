import { getAccessToken } from './auth'
import { validateCloudSyncDocument, type CloudSyncDocument } from './cloudSync'
import { migrateCloudSyncDocumentShape } from './cloudSyncSchemaMigration'
import {
  diagnoseCloudSyncDocumentFailure,
  diagnoseUnparsableCloudSyncContent,
  type CloudSyncCorruptionDiagnosis,
} from './cloudSyncCorruptionDiagnosis'
import { captureCloudCorruptionDiagnostics } from './cloudCorruptionDiagnostics'

/*
  CLOUD STORAGE (Microsoft Graph OneDrive App Folder)

  Read/write/list/delete helpers for everything ToothTarget stores in
  the signed-in Microsoft account's OneDrive App Folder
  (Files.ReadWrite.AppFolder - already granted, no new scopes here):

    - readCloudData()/writeCloudData() below - generic, named-file
      read/write (Phase 9: generalized from a single hardcoded
      filename to an explicit `fileName` parameter, once that fixed
      file's only two callers - the old "Backup to Cloud"/"Load from
      Cloud" buttons - were removed in Phase 8). Currently used by
      cloudBackupRotation.ts (the dated A/B/C snapshot files) and
      cloudBackup.ts's own restore-fallback lookup - each passes its
      own explicit file name, so multiple independent callers can
      each own their own file(s) without colliding.
    - listAppFolderFileNames()/deleteCloudFile() below (Phase 9, new)
      - list and delete, for the same reason: discovering which dated
        A/B/C snapshot files currently exist, and retiring the oldest
        one in a rotation slot.
    - toothtarget-sync.json (readCloudSyncDocument()/
      writeCloudSyncDocument() below) - the real-time, automatic,
      multi-device sync document, used only by cloudSyncEngine.ts's
      syncCloudNow(). Kept as its own dedicated pair of functions
      (never layered on readCloudData()/writeCloudData() above) so
      the one file every device's automatic sync depends on can never
      collide with any named snapshot file another feature happens to
      read/write/list/delete.

  ============================================================
  SYNC DOCUMENT TRANSPORT (ETag-conditional)
  ============================================================

  readCloudSyncDocument()/writeCloudSyncDocument() below are a
  SEPARATE pair of functions for the CloudSyncDocument (v2 schema,
  cloudSync.ts) - deliberately NOT layered on top of readCloudData()/
  writeCloudData() above, and deliberately targeting a DIFFERENT file
  name (see CLOUD_SYNC_FILE_NAME below), so the sync document and any
  named snapshot file can never collide over one shared file.

  Called automatically by cloudSyncEngine.ts's syncCloudNow() - on app
  load, on Microsoft sign-in, and after every synchronized-data change
  (see cloudSyncScheduler.ts) - with retry-after-412 handled by
  syncCloudNow() itself, one layer up. Reuses the exact same
  getAccessToken() (auth.ts), GRAPH_APPROOT, and describeGraphError()
  already used above - no new MSAL instance, no new login flow, no new
  scopes.
*/

const GRAPH_APPROOT =
  'https://graph.microsoft.com/v1.0/me/drive/special/approot'

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

  Downloads and parses the named file from the App Folder. Returns
  null (not an error) when the file simply doesn't exist yet - eg.
  before it has ever been written - since that is an expected, normal
  state, not a failure. Throws a plain-language Error for anything
  else (not signed in, network/Graph failure, or a file that exists
  but isn't valid JSON).
*/

export async function readCloudData<T = unknown>(
  fileName: string
): Promise<T | null> {

  const accessToken = await requireAccessToken()

  const response = await fetch(
    `${GRAPH_APPROOT}:/${fileName}:/content`,
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
      `Could not read ${fileName} from the OneDrive App Folder (${await describeGraphError(response)}).`
    )
  }

  try {

    return (await response.json()) as T

  } catch {

    throw new Error(
      `${fileName} was downloaded but could not be parsed as JSON.`
    )

  }

}

/*
  WRITE

  Creates or overwrites the named file in the App Folder with the
  JSON-serialized form of whatever is passed in. Throws a plain-
  language Error on failure (not signed in, or the Graph request
  itself failing).
*/

export async function writeCloudData(
  fileName: string,
  data: unknown
): Promise<void> {

  const accessToken = await requireAccessToken()

  const response = await fetch(
    `${GRAPH_APPROOT}:/${fileName}:/content`,
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
      `Could not write ${fileName} to the OneDrive App Folder (${await describeGraphError(response)}).`
    )
  }

}

/*
  LIST (Phase 9 - dated backup rotation/discovery)

  Returns just the file names directly inside the App Folder (not
  subfolders' contents, not any other metadata) - enough for
  cloudBackupRotation.ts/cloudBackup.ts to find which dated
  toothtarget-backup-<slot>-<date>.json files currently exist without
  needing to guess a exact filename to fetch first (which would be
  impossible - the date in the name is exactly the thing being
  discovered here).
*/

export async function listAppFolderFileNames(): Promise<string[]> {

  const accessToken = await requireAccessToken()

  const response = await fetch(
    `${GRAPH_APPROOT}/children?$select=name`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  )

  if (!response.ok) {
    throw new Error(
      `Could not list the OneDrive App Folder (${await describeGraphError(response)}).`
    )
  }

  const body = await response.json()

  if (!Array.isArray(body?.value)) {
    throw new Error(
      'The OneDrive App Folder listing had an unexpected shape.'
    )
  }

  return body.value
    .map((item: unknown) =>
      typeof (item as { name?: unknown })?.name === 'string'
        ? (item as { name: string }).name
        : null
    )
    .filter((name: string | null): name is string => name !== null)

}

/*
  DELETE (Phase 9 - dated backup rotation)

  Removes the named file from the App Folder. Treats an already-
  missing file (404) as success rather than an error - deleting
  something that's already gone achieves the caller's actual goal
  ("this slot's old dated file should no longer exist") either way.
*/

export async function deleteCloudFile(fileName: string): Promise<void> {

  const accessToken = await requireAccessToken()

  const response = await fetch(
    `${GRAPH_APPROOT}:/${fileName}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  )

  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Could not delete ${fileName} from the OneDrive App Folder (${await describeGraphError(response)}).`
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
  rejected this for a permissions reason" apart from "the network
  itself is unreachable" apart from "Graph responded, but with an
  error" (Phase 6 - previously the last two were both reported as
  'graph-error', since both arrive from inside a fetch() try/catch;
  they're now split by WHERE the failure happened: 'network-unreachable'
  is a thrown exception from fetch() itself - offline, DNS failure, etc.
  - never a response Graph actually sent, whereas 'graph-error' is
  reserved for cases where a response WAS received (an unexpected
  non-2xx status, or a 2xx response whose body wasn't shaped as
  expected) - see classifyGraphFailure()/describeNetworkFailure() below
  for exactly where each is produced. This distinction is what lets
  cloudSyncScheduler.ts's sync-outcome classification (syncOutcome.ts)
  tell the dentist "no internet connection" apart from "couldn't reach
  OneDrive" instead of one generic message for both.
*/

export type CloudSyncTransportFailure =
  | { status: 'auth-failed' }
  | { status: 'permission-denied'; detail: string }
  | { status: 'network-unreachable'; detail: string }
  | { status: 'graph-error'; detail: string }

export type CloudSyncReadResult =
  | { status: 'not-found' }
  | { status: 'found'; document: CloudSyncDocument; eTag: string }
  | {
      status: 'malformed-json'
      detail: string
      /*
        Optional (not required) so every existing mocked
        CloudSyncReadResult literal across this project's own test
        suite - constructed before this diagnosis feature existed -
        keeps compiling unchanged. The real readCloudSyncDocument()
        below always sets it; only a hand-built test mock can leave
        it out.
      */
      diagnosis?: CloudSyncCorruptionDiagnosis
    }
  | {
      status: 'invalid-document'
      detail: string
      diagnosis?: CloudSyncCorruptionDiagnosis
    }
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
  APP FOLDER PROVISIONING

  Microsoft's own docs (learn.microsoft.com/graph/onedrive-sharepoint-
  appfolder) document exactly one call as guaranteed to create the App
  Folder the first time it's used: a plain GET on GRAPH_APPROOT itself,
  with no child path appended. Every read/write below instead addresses
  a FILE inside that folder in one request, via the compound
  "approot:/{fileName}" colon-path form - undocumented behavior when
  the folder doesn't exist yet, and observed in practice to come back
  as a generic 400 invalidRequest rather than a clean 404 on a device/
  account that has never used this app's OneDrive folder before.

  Making the documented plain-GET form once per page load, before the
  first compound-path call, sidesteps that edge case. Cached in module
  state so this costs exactly one extra Graph round trip per session,
  never per sync attempt.
*/
let appFolderProvisioned = false

async function ensureAppFolderProvisioned(
  authHeaders: Record<string, string>
): Promise<CloudSyncTransportFailure | null> {

  if (appFolderProvisioned) {
    return null
  }

  let response: Response

  try {
    response = await fetch(GRAPH_APPROOT, { headers: authHeaders })
  } catch (error) {
    return { status: 'network-unreachable', detail: describeNetworkFailure(error) }
  }

  if (!response.ok) {
    return classifyGraphFailure(response, await describeGraphError(response))
  }

  appFolderProvisioned = true
  return null

}

/*
  TEST-ONLY - overrides this module's internal provisioning state
  between test cases (defaulted to true by every other test in this
  file's beforeEach, matching a real page session that only ever
  provisions once - only the dedicated provisioning tests set this
  back to false first). Never called from production code.
*/

export function __setAppFolderProvisionedForTests(provisioned: boolean): void {
  appFolderProvisioned = provisioned
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

  const provisionFailure = await ensureAppFolderProvisioned(authHeaders)

  if (provisionFailure) {
    return provisionFailure
  }

  let metadataResponse: Response

  try {

    metadataResponse = await fetch(
      `${GRAPH_APPROOT}:/${CLOUD_SYNC_FILE_NAME}`,
      { headers: authHeaders }
    )

  } catch (error) {
    return { status: 'network-unreachable', detail: describeNetworkFailure(error) }
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
    return { status: 'network-unreachable', detail: describeNetworkFailure(error) }
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

  /*
    Read as text FIRST, then JSON.parse() it separately (rather than
    the single-step Response.json() used elsewhere in this file) - a
    Response body can only be consumed once, so this is what lets the
    exact raw bytes downloaded from OneDrive still be captured below
    (captureCloudCorruptionDiagnostics()) even when they turn out not
    to be valid JSON at all, not just when they parse but fail
    validateCloudSyncDocument().
  */
  let rawContent: string

  try {

    rawContent = await contentResponse.text()

  } catch (error) {
    return { status: 'network-unreachable', detail: describeNetworkFailure(error) }
  }

  let parsedContent: unknown

  try {

    parsedContent = JSON.parse(rawContent)

  } catch {

    const detail = `${CLOUD_SYNC_FILE_NAME} was downloaded but could not be parsed as JSON.`

    captureCloudCorruptionDiagnostics({
      rawContent,
      error: detail,
      capturedAt: new Date().toISOString(),
    })

    return {
      status: 'malformed-json',
      detail,
      diagnosis: diagnoseUnparsableCloudSyncContent(),
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

    captureCloudCorruptionDiagnostics({
      rawContent,
      error: validation.error,
      capturedAt: new Date().toISOString(),
    })

    return {
      status: 'invalid-document',
      detail: validation.error,
      /*
        Diagnosed against the MIGRATED content, not the raw parsed
        content - migrateCloudSyncDocumentShape() already backfilled
        any known-missing field from an older schema version above,
        so this reflects the actual reason validateCloudSyncDocument()
        just rejected it, not a stale pre-migration shape.
      */
      diagnosis: diagnoseCloudSyncDocumentFailure(migratedContent),
    }

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

  const provisionFailure = await ensureAppFolderProvisioned({
    Authorization: `Bearer ${accessToken}`,
  })

  if (provisionFailure) {
    return provisionFailure
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
    return { status: 'network-unreachable', detail: describeNetworkFailure(error) }
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
    return { status: 'network-unreachable', detail: describeNetworkFailure(error) }
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
