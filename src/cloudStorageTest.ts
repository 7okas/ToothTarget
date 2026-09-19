import { readCloudData, writeCloudData } from './cloudStorage'

/*
  TEMPORARY: CLOUD DATA FILE ROUND-TRIP TEST

  Verifies readCloudData()/writeCloudData() (cloudStorage.ts) work
  end-to-end against toothtarget-data.json, using a harmless throwaway
  object - never any real patient/treatment/template data. Isolated
  the same way graphTest.ts is: only imported by the one temporary
  button in MicrosoftAccountSection.tsx. Removing this file plus that
  button is the whole cleanup needed later.

  Note: this writes over toothtarget-data.json each time it runs -
  same as graphTest.ts already does with toothtarget-test.json - which
  is fine now (nothing real is stored there yet), but this file itself
  should be removed once real backup/sync data starts using that
  filename.
*/

type CloudDataTestPayload = {
  app: string
  cloudTest: boolean
  version: number
}

const TEST_PAYLOAD: CloudDataTestPayload = {
  app: 'ToothTarget',
  cloudTest: true,
  version: 1,
}

export type CloudDataFileTestResult =
  | { success: true; message: string }
  | { success: false; message: string }

export async function testCloudDataFile(): Promise<CloudDataFileTestResult> {

  try {

    await writeCloudData(TEST_PAYLOAD)

    const readBack = await readCloudData<CloudDataTestPayload>()

    if (
      !readBack ||
      readBack.app !== TEST_PAYLOAD.app ||
      readBack.cloudTest !== TEST_PAYLOAD.cloudTest ||
      readBack.version !== TEST_PAYLOAD.version
    ) {
      return {
        success: false,
        message:
          'Wrote toothtarget-data.json but the content read back did not match.',
      }
    }

    return {
      success: true,
      message: 'Cloud data file test successful.',
    }

  } catch (error) {

    console.error('Cloud data file test failed.', error)

    const detail = error instanceof Error ? error.message : String(error)

    return {
      success: false,
      message: `Cloud data file test failed: ${detail}`,
    }

  }

}
