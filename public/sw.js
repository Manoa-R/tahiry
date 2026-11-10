// Service worker : réseau d'abord (avec délai court), cache sinon.
// L'API de synchronisation n'est jamais mise en cache.
const CACHE = 'tahiry-shell-v3';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/sync.js', 'js/domain.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];
const NETWORK_WAIT = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function respond(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  });
  const cachedFallback = async () => (await cache.match(request, { ignoreSearch: true }))
    ?? (request.mode === 'navigate' ? cache.match('index.html') : undefined);

  const timeout = new Promise((ok) => { setTimeout(ok, NETWORK_WAIT, null); });
  const fast = await Promise.race([network.catch(() => null), timeout]);
  if (fast) return fast;
  // Réseau lent ou absent : on sert le cache, sinon on attend quand même le réseau.
  return (await cachedFallback()) ?? network;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(respond(e.request));
});
