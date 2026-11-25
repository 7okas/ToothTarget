/*
  ToothTarget service worker (hand-written, no plugin).

  HOW IT WORKS
  - Every production build is stamped (scripts/swBuild.ts, run from
    vite.config.ts) with BUILD_ID and PRECACHE, the list of every file in
    the build. They are cached together as ONE set named
    "toothtarget-<BUILD_ID>". If any file fails to download, the install
    fails and the previous version keeps running, so the app never mixes
    files from two builds.
  - Our own files are served cache-first from that one set, so the app
    opens offline. Anything not in the set is fetched from the network and
    is NOT stored.
  - A new version installs in the background and then WAITS. It only takes
    over when the page asks it to (the "Update available - reload"
    banner, user-initiated), so a page is never swapped while a treatment
    timer is running.

  NEVER INTERCEPTED (the request passes straight to the network, the
  worker does not answer it and does not store it):
  - non-GET requests
  - any other origin (Microsoft login, Graph/OneDrive, ...)
  - this file (sw.js)
  - the sign-in popup return page (src/redirect.html) and its script
  - any URL carrying sign-in parameters (code=, state=, error=, ...)

  KILL SWITCH: see README.md ("Service worker kill switch").
*/

const BUILD_ID = '__BUILD_ID__'
const PRECACHE = JSON.parse('__PRECACHE_JSON__')

const CACHE_PREFIX = 'toothtarget-'
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`

const SCOPE_URL = self.registration.scope
const SCOPE_PATH = new URL(SCOPE_URL).pathname

const INDEX_URL = new URL('index.html', SCOPE_URL).href

/*
  ignoreVary: a server that answers "Vary: Origin" (vite preview does)
  makes the browser's own script/style requests - which carry an Origin
  header the install-time requests did not - fail to match what was
  cached, and the offline app would load its page but none of its code.
  Everything in this set is our own file, so Vary is irrelevant here.
*/
const MATCH_OPTIONS = { cacheName: CACHE_NAME, ignoreVary: true }

const AUTH_PARAMS = [
  'code',
  'state',
  'error',
  'error_description',
  'error_uri',
  'id_token',
  'access_token',
  'session_state',
  'client_info',
  'iss',
]

function hasAuthParams(url) {

  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash

  return [url.search, hash].some(part => {

    const params = new URLSearchParams(part.replace(/^\?/, ''))

    return AUTH_PARAMS.some(name => params.has(name))

  })

}

function shouldBypass(request) {

  if (request.method !== 'GET') {
    return true
  }

  const url = new URL(request.url)

  if (url.origin !== self.location.origin) {
    return true
  }

  if (!url.pathname.startsWith(SCOPE_PATH)) {
    return true
  }

  const relative = url.pathname.slice(SCOPE_PATH.length)

  if (
    relative === 'sw.js' ||
    relative.startsWith('src/redirect') ||
    /^assets\/redirect-[^/]*\.js$/.test(relative)
  ) {
    return true
  }

  return hasAuthParams(url)

}

self.addEventListener('install', event => {

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache =>
        cache.addAll(
          PRECACHE.map(
            path => new Request(new URL(path, SCOPE_URL).href, { cache: 'reload' })
          )
        )
      )
      .catch(error => {

        /*
          A half-filled set must never be left behind under this name.
          Rethrowing makes the install fail, so the old version (if any)
          stays in charge.
        */
        return caches.delete(CACHE_NAME).then(() => {
          throw error
        })

      })
  )

})

self.addEventListener('activate', event => {

  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )

})

self.addEventListener('message', event => {

  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }

})

self.addEventListener('fetch', event => {

  const request = event.request

  if (shouldBypass(request)) {
    return
  }

  if (request.mode === 'navigate') {

    event.respondWith(
      caches
        .match(INDEX_URL, MATCH_OPTIONS)
        .then(cached => cached || fetch(request))
    )

    return

  }

  event.respondWith(
    caches
      .match(request, MATCH_OPTIONS)
      .then(cached => cached || fetch(request))
  )

})
