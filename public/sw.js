/* Only public menus and image URLs enter this cache; admin and non-GET traffic bypass it. */
const CACHE = 'jeti-menu-v1';
const MENU = /^\/[a-z0-9-]{3,40}$/;
const IMAGE = /^\/img\/c[1-9][0-9]*-[a-f0-9]{32}-[a-f0-9]{64}\.(webp|png)$/;
const menuPath = path => MENU.test(path) && path !== '/admin' && path !== '/img';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('jeti-menu-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

function keyFor(url) { return url.origin + url.pathname; }
async function notify(id, path) {
  const client = id && await self.clients.get(id);
  if (client) client.postMessage({ type: 'menu-updated', path });
}
async function refresh(url, cache, cached, clientId) {
  const menu = menuPath(url.pathname);
  const response = await fetch(keyFor(url), { credentials: 'omit', cache: menu ? 'no-cache' : 'default', priority: 'low' });
  if (response.ok && !response.redirected && (menu ? response.headers.get('X-Menu-Public') === '1' : /^image\/(webp|png)$/.test(response.headers.get('Content-Type') || ''))) {
    if (!menu || !cached || Number(response.headers.get('X-Menu-Version')) >= Number(cached.headers.get('X-Menu-Version'))) {
      await cache.put(keyFor(url), response.clone()).catch(() => cache.delete(keyFor(url)));
      if (menu && cached && response.headers.get('X-Menu-Version') !== cached.headers.get('X-Menu-Version')) await notify(clientId, url.pathname);
    }
  } else if (response.status === 404 || response.status === 410) {
    await cache.delete(keyFor(url));
    if (menu && cached) await notify(clientId, url.pathname);
  }
  return response;
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !(IMAGE.test(url.pathname) || (event.request.mode === 'navigate' && menuPath(url.pathname)))) return;
  const work = (async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(keyFor(url));
    const network = refresh(url, cache, cached, (event.resultingClientId || event.clientId)).catch(() => cached || Response.error());
    return { cached, network };
  })().catch(() => ({ cached: null, network: fetch(event.request) }));
  event.respondWith(work.then(({ cached, network }) => cached || network));
  event.waitUntil(work.then(({ network }) => network).then(() => {}));
});
// First visit is not yet controlled by this worker. Seed it after registration,
// then warm lazy images in the background so a second scan also works offline.
self.addEventListener('message', event => {
  if (event.data?.type !== 'cache-menu' || !event.source?.url) return;
  const url = new URL(event.source.url);
  const requested = new URL(event.data.url, self.location.origin);
  if (url.origin !== self.location.origin || requested.origin !== url.origin || requested.pathname !== url.pathname || !menuPath(url.pathname)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(keyFor(url));
    const response = await refresh(url, cache, cached, event.source.id);
    if ((response.status === 404 || response.status === 410) && event.data.version) await notify(event.source.id, url.pathname);
    if (!response.ok || response.headers.get('X-Menu-Public') !== '1') return;
    if (Number(response.headers.get('X-Menu-Version')) !== event.data.version) await notify(event.source.id, url.pathname);
    const html = await response.text();
    const paths = [...new Set([...html.matchAll(/src="(\/img\/[^"<>]+)"/g)].map(match => match[1]).filter(path => IMAGE.test(path)))];
    for (const path of paths) {
      const image = new URL(path, url.origin);
      if (!await cache.match(keyFor(image))) await refresh(image, cache, null, null);
    }
  })().catch(() => {}));
});
