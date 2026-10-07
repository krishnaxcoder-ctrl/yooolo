// Offline support. After one visit online, the app and the models it used stay on the device, so
// indoor guidance, room recognition and the fall alert work without internet. Outdoor maps and
// routes (Google) and Chrome's speech recognition (Google's servers) still need a connection.

// Bump this to make every device fetch the models again, e.g. after re-exporting one under the same name.
const CACHE = 'yooolo-v1'
const scope = new URL(self.registration.scope)
const at = (path) => new URL(path, scope).pathname

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([at('./'), at('models/manifest.json')])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== scope.origin) return
  // Fingerprinted build files and the large models never change under one URL: serve them from the
  // cache. The page and the model list may change, so try the network first and fall back offline.
  const fixed =
    url.pathname.startsWith(at('assets/')) || url.pathname.startsWith(at('samples/')) || url.pathname.endsWith('.onnx')
  event.respondWith(fixed ? cacheFirst(request) : networkFirst(request))
})

async function cacheFirst(request) {
  const hit = await caches.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone())
  return response
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone())
    return response
  } catch (err) {
    const hit = (await caches.match(request, { ignoreSearch: true })) ?? (request.mode === 'navigate' ? await caches.match(at('./')) : undefined)
    if (hit) return hit
    throw err
  }
}
