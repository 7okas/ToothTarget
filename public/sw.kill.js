/*
  KILL SWITCH - NOT ACTIVE UNLESS COPIED OVER public/sw.js.

  If a bad service worker ever ships, replace the contents of public/sw.js
  with this file and deploy. On each device's next visit the browser fetches
  this version, which deletes every "toothtarget-*" cache, unregisters
  itself, and reloads the open pages once so they come straight from the
  network. It never touches localStorage (patients, treatments, sign-in).
  Restore the real sw.js in a later deploy. See README.md.
*/

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {

  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith('toothtarget-'))
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => clients.forEach(client => client.navigate(client.url)))
  )

})
