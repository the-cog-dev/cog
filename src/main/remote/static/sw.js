// Service worker for The Cog Remote mobile console.
//
// Scope is determined by the URL the SW was registered from — since it's
// served at /r/<token>/sw.js, scope is /r/<token>/. That means each install
// is bound to one token; when the token rotates, the installed PWA shell
// becomes orphaned and the user reinstalls. This is acceptable because:
//   - the cookie-backed device id survives reinstall
//   - the cog desktop UI shows the current URL/QR
//   - tokens default to 8h, so reinstall cadence is daily-ish
//
// Caching strategy: app shell (HTML/JS/CSS/manifest/icon) is cache-first
// with a network-fallback. Everything else (state polls, agent output,
// inbox, schedule actions) goes straight to network — they're live data
// and must reflect the current server state. The hub is the source of
// truth; we never serve a cached /state.

const CACHE_VERSION = 'cog-remote-v1'
const APP_SHELL = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'icon.svg'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return // POST/etc — passthrough

  const url = new URL(req.url)
  // Heuristic for "this is live data, never cache": any path containing
  // /state, /inbox, /trollbox, /workshop, /agent/, /schedule/, /task,
  // /message, /files. The app shell is just the html/js/css/icon —
  // anything else under the token scope is a JSON or stream endpoint.
  const dataPathPattern = /\/(state|inbox|trollbox|workshop|schedule|task|message|agent|files|ws)(\/|$|\?)/
  if (dataPathPattern.test(url.pathname)) return

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit
      return fetch(req).then((res) => {
        // Only cache 200s under the app shell scope; never cache opaque or
        // error responses (would poison the cache).
        if (res.ok && res.type === 'basic') {
          const clone = res.clone()
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone)).catch(() => null)
        }
        return res
      }).catch(() => caches.match('index.html'))
    })
  )
})

// Allow the page to ask for an immediate update — useful when the user
// taps a "refresh shell" control or after the cog detects a server-side
// asset change. Page posts { type: 'skipWaiting' } to take effect.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skipWaiting') self.skipWaiting()
})
