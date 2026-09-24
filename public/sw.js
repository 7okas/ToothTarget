/*
  Cache name is versioned per build (see vite.config.ts, which stamps in
  a real build timestamp during `npm run build`). This means every
  deploy gets a brand-new cache automatically - nobody has to remember
  to bump a version string by hand.
*/
const CACHE_VERSION = '__BUILD_VERSION__'
const CACHE_NAME = `toothtarget-${CACHE_VERSION}`

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('toothtarget-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

/*
  Only the page navigation itself (index.html) needs this - it's the one
  file Vite doesn't put a content hash in the name of, so it's the one
  file browsers can serve stale forever. The hashed JS/CSS/image files
  already change URL whenever their content changes, so the browser's
  normal HTTP cache handles those correctly without any help here.
*/
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const responseClone = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone))
        return response
      })
      .catch(() => caches.match(event.request)),
  )
})
