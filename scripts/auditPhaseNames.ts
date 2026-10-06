/*
  PHASE NAME AUDIT - command-line script (Phase 9)

  Reads a backup file exported from ToothTarget's Settings and prints a
  report of near-duplicate phase names: names written differently
  (case / spacing / punctuation / "&" vs "and"), pairs the matching rules
  would flag, and close pairs the guards suppress.

  HOW TO RUN (from the project folder, Node 22 or newer):
      node scripts/auditPhaseNames.ts "C:\\Users\\<you>\\Downloads\\toothtarget-backup-2026-10-06.json"

  SAFETY, enforced here and not just promised:
    - READ-ONLY. The only file operation is reading the one file you name;
      nothing is written, created, moved or deleted anywhere.
    - The backup must be OUTSIDE this project folder. A path inside it is
      refused before the file is even opened, so patient data in a backup
      can never end up inside the repository by accident.
    - Only phase NAMES and counts are read from the file and printed (see
      src/phaseNameAudit.ts): no patient names, ids, dates, notes, teeth or
      anything else. Names are cut to 60 characters in the report.
    - Errors never echo any of the file's content.
*/

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditPhaseNames,
  extractAuditInput,
  formatAuditReport,
} from '../src/phaseNameAudit.ts'

function fail(message: string, code: number): never {
  console.error(message)
  process.exit(code)
}

const argument = process.argv[2]

if (!argument || process.argv.length > 3) {
  fail(
    'Usage: node scripts/auditPhaseNames.ts <path to a backup file kept OUTSIDE the project folder>',
    1
  )
}

const projectRoot = realpathSync.native(
  resolve(dirname(fileURLToPath(import.meta.url)), '..')
)

let target: string

try {
  target = realpathSync.native(resolve(argument))
} catch {
  fail('Cannot find that file. Check the path (put it in quotes if it contains spaces).', 1)
}

const fromRoot = relative(projectRoot, target)

const insideProject =
  fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))

if (insideProject) {
  fail(
    'Refused: that file is inside the project folder. Keep the backup outside the project\n' +
      '(for example in your Downloads folder) so patient data can never be committed.\n' +
      'Nothing was read.',
    2
  )
}

let text: string

try {
  text = readFileSync(target, 'utf-8')
} catch {
  fail('Could not read that file.', 1)
}

let parsed: unknown

try {
  parsed = JSON.parse(text)
} catch {
  fail('That file is not valid JSON, so it cannot be a ToothTarget backup.', 1)
}

const input = extractAuditInput(parsed)

if (input === null) {
  fail(
    'That file does not look like a ToothTarget backup (no saved treatments or templates found).',
    1
  )
}

for (const line of formatAuditReport(auditPhaseNames(input))) {
  console.log(line)
}
