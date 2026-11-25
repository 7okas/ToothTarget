import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/*
  BUILD STAMPING FOR THE SERVICE WORKER

  Run once after the production bundle is written (see vite.config.ts).
  It decides which files belong to "this build", gives the build an id
  derived from their contents, and writes that into dist/sw.js and
  dist/version.json. Same source => same id, so re-deploying identical
  code never makes the service worker look "changed".

  NOT precached (the service worker must never answer these from the
  cache - see public/sw.js): sw.js itself, the sign-in popup return page
  (src/redirect.html) and the script it loads (assets/redirect-*.js).
*/

const NEVER_PRECACHE = [
  /^sw\.js$/,
  /^version\.json$/,
  /^sw\.kill\.js$/,
  /^src\/redirect\.html$/,
  /^assets\/redirect-[^/]*\.js$/,
]

function walk(dir: string): string[] {

  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {

    const full = join(dir, entry.name)

    return entry.isDirectory() ? walk(full) : [full]

  })

}

export function collectPrecacheFiles(distDir: string): string[] {

  return walk(distDir)
    .map(file => relative(distDir, file).split(sep).join('/'))
    .filter(path => !NEVER_PRECACHE.some(pattern => pattern.test(path)))
    .sort()

}

export function computeBuildId(distDir: string, files: string[]): string {

  const hash = createHash('sha256')

  /*
    The worker's own (still unstamped) source counts too, so a change to
    sw.js alone also gets a new id and a fresh cache set.
  */
  hash.update(readFileSync(join(distDir, 'sw.js')))
  hash.update('\0')

  for (const file of files) {

    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(distDir, file)))
    hash.update('\0')

  }

  return hash.digest('hex').slice(0, 8)

}

export function stampServiceWorker(
  distDir: string,
  now: Date = new Date()
): { buildId: string; label: string; files: string[] } {

  /*
    version.json is itself precached (so the Settings screen shows the
    version of the build that is actually installed), but it can't be
    part of its own hash - it is added to the list after the id exists.
  */
  const hashedFiles = collectPrecacheFiles(distDir)

  const buildId = computeBuildId(distDir, hashedFiles)

  const label = `${now.toISOString().slice(0, 10)} · ${buildId}`

  writeFileSync(
    join(distDir, 'version.json'),
    JSON.stringify({ id: buildId, label })
  )

  const files = [...hashedFiles, 'version.json'].sort()

  const swPath = join(distDir, 'sw.js')

  writeFileSync(
    swPath,
    readFileSync(swPath, 'utf-8')
      .replaceAll('__BUILD_ID__', buildId)
      .replaceAll('__PRECACHE_JSON__', JSON.stringify(files))
  )

  return { buildId, label, files }

}
