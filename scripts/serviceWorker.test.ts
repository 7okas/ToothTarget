import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
  Loads the real public/sw.js into a sandbox with a fake `self`, fake
  CacheStorage and fake network, then drives its install / activate /
  message / fetch handlers directly.
*/

const SCOPE = 'https://example.test/ToothTarget/'
const ORIGIN = 'https://example.test'

const FILES = [
  'index.html',
  'assets/main-AAAA.js',
  'assets/main-AAAA.css',
  'version.json',
]

type Listener = (event: unknown) => void

type FakeRequest = { url: string; method: string; mode: string }

function load(options: { network?: Record<string, number>; buildId?: string } = {}) {

  const buildId = options.buildId ?? 'b1'

  const source = readFileSync('public/sw.js', 'utf-8')
    .replaceAll('__BUILD_ID__', buildId)
    .replaceAll('__PRECACHE_JSON__', JSON.stringify(FILES))

  const listeners: Record<string, Listener> = {}

  const stores = new Map<string, Map<string, string>>()

  /* url -> status; anything not listed is a network failure */
  const network = new Map<string, number>(
    Object.entries(options.network ?? {})
  )

  const networkCalls: string[] = []

  const matchOptionsSeen: Array<{ cacheName?: string; ignoreVary?: boolean } | undefined> = []

  async function fakeFetch(input: string | { url: string }) {

    const url = typeof input === 'string' ? input : input.url

    networkCalls.push(url)

    const status = network.get(url.split('?')[0])

    if (status === undefined) {
      throw new TypeError('network down')
    }

    return new Response(`net:${url}`, { status })

  }

  function makeCache(name: string) {

    return {
      async addAll(requests: Array<{ url: string }>) {

        const entries = new Map<string, string>()

        for (const request of requests) {

          const response = await fakeFetch(request)

          if (!response.ok) {
            throw new TypeError(`bad response for ${request.url}`)
          }

          entries.set(request.url, await response.text())

        }

        stores.set(name, entries)

      },
    }

  }

  const fakeCaches = {
    async open(name: string) {
      return makeCache(name)
    },
    async delete(name: string) {
      return stores.delete(name)
    },
    async keys() {
      return [...stores.keys()]
    },
    async match(
      request: string | { url: string },
      opts?: { cacheName?: string; ignoreVary?: boolean }
    ) {

      matchOptionsSeen.push(opts)

      const url = typeof request === 'string' ? request : request.url

      const names = opts?.cacheName ? [opts.cacheName] : [...stores.keys()]

      for (const name of names) {

        const hit = stores.get(name)?.get(url)

        if (hit !== undefined) {
          return new Response(`cache:${hit}`)
        }

      }

      return undefined

    },
  }

  const skipWaiting = vi.fn()
  const claim = vi.fn(async () => {})

  const fakeSelf = {
    registration: { scope: SCOPE },
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener
    },
    skipWaiting,
    clients: { claim },
  }

  runInNewContext(source, {
    self: fakeSelf,
    caches: fakeCaches,
    fetch: fakeFetch,
    Request: class {
      url: string
      constructor(url: string) {
        this.url = url
      }
    },
    URL,
    URLSearchParams,
    JSON,
    Promise,
  })

  async function run(type: string, extra: Record<string, unknown> = {}) {

    let pending: Promise<unknown> = Promise.resolve()

    listeners[type]({
      ...extra,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise
      },
    })

    await pending

  }

  async function fetchEvent(request: FakeRequest) {

    let answered: Promise<Response> | undefined

    listeners.fetch({
      request,
      respondWith: (promise: Promise<Response>) => {
        answered = promise
      },
    })

    return answered === undefined ? undefined : await answered

  }

  return { stores, networkCalls, matchOptionsSeen, skipWaiting, claim, run, fetchEvent, listeners, network }

}

function get(path: string, mode = 'cors'): FakeRequest {
  return { url: `${ORIGIN}${path}`, method: 'GET', mode }
}

const ALL_OK = Object.fromEntries(
  FILES.map(file => [`${SCOPE}${file}`, 200])
)

describe('install', () => {

  it('stores the whole build as ONE set named after the build id', async () => {

    const sw = load({ network: ALL_OK })

    await sw.run('install')

    expect([...sw.stores.keys()]).toEqual(['toothtarget-b1'])

    expect([...sw.stores.get('toothtarget-b1')!.keys()].sort()).toEqual(
      FILES.map(file => `${SCOPE}${file}`).sort()
    )

  })

  it('does not take over by itself (no skipWaiting on install)', async () => {

    const sw = load({ network: ALL_OK })

    await sw.run('install')

    expect(sw.skipWaiting).not.toHaveBeenCalled()

  })

  it('fails as a whole, leaving nothing behind, if one file is missing', async () => {

    const sw = load({
      network: { ...ALL_OK, [`${SCOPE}assets/main-AAAA.js`]: 404 },
    })

    await expect(sw.run('install')).rejects.toThrow()

    expect(sw.stores.size).toBe(0)

  })

})

describe('activate and messages', () => {

  it('deletes every older toothtarget-* set but leaves other caches alone', async () => {

    const sw = load({ network: ALL_OK })

    sw.stores.set('toothtarget-old', new Map())
    sw.stores.set('toothtarget-1700000000000', new Map())
    sw.stores.set('somebody-elses-cache', new Map())

    await sw.run('install')
    await sw.run('activate')

    expect([...sw.stores.keys()].sort()).toEqual([
      'somebody-elses-cache',
      'toothtarget-b1',
    ])

    expect(sw.claim).toHaveBeenCalled()

  })

  it('only activates a waiting version when the page asks (SKIP_WAITING)', async () => {

    const sw = load({ network: ALL_OK })

    sw.listeners.message({ data: { type: 'SOMETHING_ELSE' } })

    expect(sw.skipWaiting).not.toHaveBeenCalled()

    sw.listeners.message({ data: { type: 'SKIP_WAITING' } })

    expect(sw.skipWaiting).toHaveBeenCalledTimes(1)

  })

})

describe('fetch: what is answered from the cache', () => {

  let sw: ReturnType<typeof load>

  beforeEach(async () => {

    sw = load({ network: ALL_OK })

    await sw.run('install')

    sw.networkCalls.length = 0

  })

  it('serves a precached file from the cache without touching the network', async () => {

    const response = await sw.fetchEvent(get('/ToothTarget/assets/main-AAAA.js'))

    expect(await response!.text()).toBe(`cache:net:${SCOPE}assets/main-AAAA.js`)

    expect(sw.networkCalls).toEqual([])

  })

  it('ignores Vary when matching (servers that answer "Vary: Origin")', async () => {

    await sw.fetchEvent(get('/ToothTarget/assets/main-AAAA.js'))
    await sw.fetchEvent(get('/ToothTarget/', 'navigate'))

    expect(sw.matchOptionsSeen).toHaveLength(2)

    for (const options of sw.matchOptionsSeen) {
      expect(options).toEqual({ cacheName: 'toothtarget-b1', ignoreVary: true })
    }

  })

  it('opens the app offline: a navigation gets the cached index.html', async () => {

    const response = await sw.fetchEvent(get('/ToothTarget/', 'navigate'))

    expect(await response!.text()).toBe(`cache:net:${SCOPE}index.html`)

    expect(sw.networkCalls).toEqual([])

  })

  it('fetches an unknown file from the network but never stores it', async () => {

    sw.network.set(`${SCOPE}assets/new-chunk.js`, 200)

    const response = await sw.fetchEvent(get('/ToothTarget/assets/new-chunk.js'))

    expect(await response!.text()).toBe(`net:${SCOPE}assets/new-chunk.js`)

    expect(sw.networkCalls).toEqual([`${SCOPE}assets/new-chunk.js`])

    expect(
      sw.stores.get('toothtarget-b1')!.has(`${SCOPE}assets/new-chunk.js`)
    ).toBe(false)

  })

  it('passes a missing old chunk through as the real network failure', async () => {

    await expect(
      sw.fetchEvent(get('/ToothTarget/assets/gone-OLD.js'))
    ).rejects.toThrow('network down')

  })

})

describe('fetch: what is NEVER answered or stored', () => {

  let sw: ReturnType<typeof load>

  beforeEach(async () => {

    sw = load({ network: ALL_OK })

    await sw.run('install')

    /* even if something with the same URL somehow sat in the cache */
    sw.stores.get('toothtarget-b1')!.set(
      `${SCOPE}src/redirect.html?code=abc&state=xyz`,
      'poisoned'
    )

    sw.networkCalls.length = 0

  })

  async function expectUntouched(request: FakeRequest) {

    const before = JSON.stringify(
      [...sw.stores.entries()].map(([name, map]) => [name, [...map.keys()]])
    )

    const answered = await sw.fetchEvent(request)

    expect(answered).toBeUndefined()

    expect(
      JSON.stringify(
        [...sw.stores.entries()].map(([name, map]) => [name, [...map.keys()]])
      )
    ).toBe(before)

  }

  it('the sign-in popup return URL (redirect.html with code= and state=)', async () => {

    await expectUntouched(
      get('/ToothTarget/src/redirect.html?code=abc&state=xyz', 'navigate')
    )

    await expectUntouched(get('/ToothTarget/src/redirect.html', 'navigate'))

  })

  it('the redirect page script', async () => {
    await expectUntouched(get('/ToothTarget/assets/redirect-DtFMivkY.js'))
  })

  it.each([
    '?code=abc',
    '?state=xyz',
    '?error=access_denied&error_description=nope',
    '?id_token=eyJ',
    '?access_token=eyJ',
    '?client_info=1',
    '?session_state=1',
    '#code=abc&state=xyz',
    '#id_token=eyJ',
  ])('any app URL carrying sign-in parameters (%s)', async suffix => {

    await expectUntouched(get(`/ToothTarget/${suffix}`, 'navigate'))

  })

  it('requests to other origins (Microsoft login, Graph/OneDrive)', async () => {

    for (const url of [
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?x=1',
      'https://graph.microsoft.com/v1.0/me/drive/special/approot',
      'https://example.test.evil.com/ToothTarget/index.html',
      'https://cdn.example.com/ToothTarget/assets/main-AAAA.js',
    ]) {
      await expectUntouched({ url, method: 'GET', mode: 'cors' })
    }

  })

  it('non-GET requests', async () => {

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expectUntouched({
        url: `${SCOPE}assets/main-AAAA.js`,
        method,
        mode: 'cors',
      })
    }

  })

  it('sw.js itself', async () => {
    await expectUntouched(get('/ToothTarget/sw.js'))
  })

  it('anything outside the app path', async () => {
    await expectUntouched(get('/OtherSite/index.html', 'navigate'))
  })

  it('never answers the poisoned redirect URL from the cache', async () => {

    const answered = await sw.fetchEvent(
      get('/ToothTarget/src/redirect.html?code=abc&state=xyz', 'navigate')
    )

    expect(answered).toBeUndefined()

  })

})
