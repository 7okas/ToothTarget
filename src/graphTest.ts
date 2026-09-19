import { getAccessToken } from './auth'

/*
  TEMPORARY: MICROSOFT GRAPH APP FOLDER CONNECTIVITY TEST

  This file exists only to verify that sign-in + the existing
  Files.ReadWrite.AppFolder permission actually work end-to-end
  against Microsoft Graph, before any real ToothTarget data (backup/
  sync) ever touches OneDrive. It is entirely isolated: nothing here
  is imported by anything except the one temporary button in
  MicrosoftAccountSection.tsx, it never reads or writes any
  patient/treatment/template/localStorage data, and removing this
  file plus that one button is the whole cleanup needed later.

  Every request re-fetches a token via the EXISTING getAccessToken()
  (auth.ts) - no new auth logic, no new scopes requested (the calls
  below only need Files.ReadWrite.AppFolder, already granted).
*/

const GRAPH_APPROOT = 'https://graph.microsoft.com/v1.0/me/drive/special/approot'
const TEST_FILE_NAME = 'toothtarget-test.json'
const TEST_FILE_CONTENT = {
  app: 'ToothTarget',
  test: true,
}

export type CloudStorageTestResult =
  | { success: true; message: string }
  | { success: false; message: string }

/*
  Reads a Graph error response body for a useful message (Graph
  returns { error: { code, message } } on failure) without ever
  including the Authorization header or the token itself.
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

export async function testCloudStorage(): Promise<CloudStorageTestResult> {

  const accessToken = await getAccessToken()

  if (!accessToken) {
    return {
      success: false,
      message:
        'Could not get a Microsoft access token. Make sure you are signed in and try again.',
    }
  }

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  }

  try {

    /*
      A. Obtain the App Folder.
    */

    const approotResponse = await fetch(GRAPH_APPROOT, {
      headers: authHeaders,
    })

    if (!approotResponse.ok) {
      return {
        success: false,
        message: `Could not access the OneDrive App Folder (${await describeGraphError(approotResponse)}).`,
      }
    }

    /*
      B. Create or overwrite the test file in the App Folder.
    */

    const writeResponse = await fetch(
      `${GRAPH_APPROOT}:/${TEST_FILE_NAME}:/content`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(TEST_FILE_CONTENT),
      }
    )

    if (!writeResponse.ok) {
      return {
        success: false,
        message: `Could not write ${TEST_FILE_NAME} to the App Folder (${await describeGraphError(writeResponse)}).`,
      }
    }

    /*
      C. Read the same file back.
    */

    const readResponse = await fetch(
      `${GRAPH_APPROOT}:/${TEST_FILE_NAME}:/content`,
      { headers: authHeaders }
    )

    if (!readResponse.ok) {
      return {
        success: false,
        message: `Wrote ${TEST_FILE_NAME} but could not read it back (${await describeGraphError(readResponse)}).`,
      }
    }

    /*
      D. Verify the returned content matches what was written.
    */

    const readBack = await readResponse.json()

    if (readBack?.app !== 'ToothTarget' || readBack?.test !== true) {
      return {
        success: false,
        message:
          'Read the test file back, but its content did not match what was written.',
      }
    }

    return {
      success: true,
      message: 'Cloud storage test successful.',
    }

  } catch (error) {

    console.error('Cloud storage test failed.', error)

    const detail = error instanceof Error ? error.message : String(error)

    return {
      success: false,
      message: `Cloud storage test failed: ${detail}`,
    }

  }

}
