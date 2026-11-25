import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectPrecacheFiles,
  stampServiceWorker,
} from './swBuild.ts'

function makeDist(mainJs = 'console.log(1)') {

  const dist = mkdtempSync(join(tmpdir(), 'tt-dist-'))

  mkdirSync(join(dist, 'assets'))
  mkdirSync(join(dist, 'src'))

  writeFileSync(join(dist, 'index.html'), '<html></html>')
  writeFileSync(join(dist, 'manifest.webmanifest'), '{}')
  writeFileSync(join(dist, 'assets', 'main-AAAA.js'), mainJs)
  writeFileSync(join(dist, 'assets', 'redirect-BBBB.js'), 'redirect')
  writeFileSync(join(dist, 'src', 'redirect.html'), '<html></html>')
  writeFileSync(
    join(dist, 'sw.js'),
    "const BUILD_ID = '__BUILD_ID__'\nconst PRECACHE = JSON.parse('__PRECACHE_JSON__')\n"
  )

  return dist

}

describe('service worker build stamping', () => {

  it('never lists sw.js, the sign-in return page or its script', () => {

    expect(collectPrecacheFiles(makeDist())).toEqual([
      'assets/main-AAAA.js',
      'index.html',
      'manifest.webmanifest',
    ])

  })

  it('writes the id and the file list into sw.js, and version.json', () => {

    const dist = makeDist()

    const { buildId, files } = stampServiceWorker(dist, new Date('2026-11-25T10:00:00Z'))

    const sw = readFileSync(join(dist, 'sw.js'), 'utf-8')

    expect(sw).not.toContain('__BUILD_ID__')
    expect(sw).not.toContain('__PRECACHE_JSON__')
    expect(sw).toContain(buildId)
    expect(files).toContain('version.json')
    expect(files).not.toContain('sw.js')

    expect(JSON.parse(readFileSync(join(dist, 'version.json'), 'utf-8'))).toEqual({
      id: buildId,
      label: `2026-11-25 · ${buildId}`,
    })

  })

  it('can be run twice on the same folder without listing a file twice', () => {

    const dist = makeDist()

    stampServiceWorker(dist)

    /* a second run must start from an unstamped worker, as a real build does */
    writeFileSync(
      join(dist, 'sw.js'),
      "const BUILD_ID = '__BUILD_ID__'\nconst PRECACHE = JSON.parse('__PRECACHE_JSON__')\n"
    )

    const { files } = stampServiceWorker(dist)

    expect(new Set(files).size).toBe(files.length)
    expect(files.filter(file => file === 'version.json')).toHaveLength(1)

  })

  it('gives identical output the same id and changed output a new one', () => {

    const first = stampServiceWorker(makeDist('a')).buildId
    const same = stampServiceWorker(makeDist('a')).buildId
    const changed = stampServiceWorker(makeDist('b')).buildId

    expect(same).toBe(first)
    expect(changed).not.toBe(first)

  })

})
