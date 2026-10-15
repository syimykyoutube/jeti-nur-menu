import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const script = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://menu.test';
const imagePath = '/img/c1-' + 'a'.repeat(32) + '-' + 'b'.repeat(64) + '.png';
const page = (version = 1, body = 'menu') => new Response(body, { headers: { 'Content-Type': 'text/html', 'X-Menu-Public': '1', 'X-Menu-Version': String(version) } });
function worker(network, unavailable = false) {
  const listeners = {}, stored = new Map(), messages = [], requests = [];
  const cache = {
    async match(key) { return stored.get(String(key))?.clone(); },
    async put(key, response) { stored.set(String(key), response.clone()); },
    async delete(key) { return stored.delete(String(key)); },
  };
  const self = { location: new URL(origin + '/sw.js'), skipWaiting() {}, clients: { async claim() {}, async get() { return { postMessage(data) { messages.push(data); } }; } }, addEventListener(type, callback) { listeners[type] = callback; } };
  runInNewContext(script, { self, URL, Response, Request, caches: { async open() { if (unavailable) throw Error('cache unavailable'); return cache; }, async keys() { return []; } }, fetch: async (...args) => { requests.push(args); return network(...args); } });
  function fetchEvent(path, options = {}) {
    const pending = []; let response;
    listeners.fetch({ request: { url: path.startsWith('http') ? path : origin + path, mode: 'navigate', method: 'GET', ...options }, clientId: 'client', respondWith(value) { response = value; }, waitUntil(value) { pending.push(value); } });
    return { response, done: () => Promise.all(pending) };
  }
  function message(data, source = { url: origin + '/sample-cafe', id: 'client' }) {
    const pending = []; listeners.message({ data, source, waitUntil(value) { pending.push(value); } }); return Promise.all(pending);
  }
  return { cache, stored, messages, requests, fetchEvent, message };
}

describe('public service worker', () => {
  it('never intercepts admin traffic, mutations, external URLs or unrelated assets', async () => {
    const w = worker(() => { throw Error('must bypass'); });
    for (const path of ['/admin','/admin/login','/admin/super','/admin.js','/sw.js','/favicon.ico','https://elsewhere.test/sample-cafe']) expect(w.fetchEvent(path).response).toBeUndefined();
    for (const method of ['POST','PUT','DELETE']) expect(w.fetchEvent('/sample-cafe',{method}).response).toBeUndefined();
    expect(w.requests).toHaveLength(0);
  });
  it('seeds the first visited menu and its lazy images for the second offline scan', async () => {
    const w = worker(async url => url.includes('/img/') ? new Response('image', {headers:{'Content-Type':'image/png'}}) : page(1, `<img src="${imagePath}"><img src="${imagePath}">`));
    await w.message({type:'cache-menu',url:origin+'/sample-cafe?lang=ru',version:1});
    expect(w.stored.size).toBe(2);
    expect(w.stored.has(origin+'/sample-cafe')).toBe(true);
    expect(w.stored.has(origin+imagePath)).toBe(true);
    expect(w.requests).toHaveLength(2);
  });
  it('rejects a forged cache message from admin or a different origin/page', async () => {
    const w = worker(() => { throw Error('must bypass'); });
    await w.message({type:'cache-menu',url:origin+'/sample-cafe'}, {url:origin+'/admin',id:'client'});
    await w.message({type:'cache-menu',url:'https://elsewhere.test/sample-cafe'});
    await w.message({type:'cache-menu',url:origin+'/other-cafe'});
    expect(w.requests).toHaveLength(0);
  });
  it('returns cached menus and images offline even when network requests fail', async () => {
    const w = worker(() => Promise.reject(Error('offline')));
    await w.cache.put(origin+'/sample-cafe',page());
    await w.cache.put(origin+imagePath,new Response('image'));
    for (const path of ['/sample-cafe',imagePath]) { const event = w.fetchEvent(path); expect((await event.response).status).toBe(200); await event.done(); }
  });
  it('returns stale HTML immediately and revalidates in the background, then notifies the page', async () => {
    let release; const gate = new Promise(resolve => {release=resolve;});
    const w = worker(async () => { await gate; return page(2,'new menu'); });
    await w.cache.put(origin+'/sample-cafe',page(1,'old menu'));
    const event=w.fetchEvent('/sample-cafe');
    expect(await (await event.response).text()).toBe('old menu');
    release(); await event.done();
    expect(await (await w.cache.match(origin+'/sample-cafe')).text()).toBe('new menu');
    expect(w.messages).toEqual([{type:'menu-updated',path:'/sample-cafe'}]);
  });
  it('does not downgrade a newer cached version when an older edge response arrives', async () => {
    const w=worker(async()=>page(1,'older edge copy'));
    await w.cache.put(origin+'/sample-cafe',page(2,'newest menu'));
    const event=w.fetchEvent('/sample-cafe');await event.response;await event.done();
    expect(await (await w.cache.match(origin+'/sample-cafe')).text()).toBe('newest menu');
    expect(w.messages).toHaveLength(0);
  });
  it('evicts paused/missing menus on 404 but keeps last-known content on temporary 500 errors', async () => {
    for (const status of [404,500]) {
      const w=worker(async()=>new Response('',{status}));
      await w.cache.put(origin+'/sample-cafe',page());
      const event=w.fetchEvent('/sample-cafe');await event.response;await event.done();
      expect(w.stored.has(origin+'/sample-cafe')).toBe(status===500);
    }
  });
  it('falls back to the network if Cache Storage is unavailable and never caches private HTML', async () => {
    const w=worker(async()=>page(),true);
    expect((await w.fetchEvent('/sample-cafe').response).status).toBe(200);
    const privateWorker=worker(async()=>new Response('private login',{headers:{'Content-Type':'text/html','Set-Cookie':'private=secret'}}));
    const event=privateWorker.fetchEvent('/sample-cafe');await event.response;await event.done();
    expect(privateWorker.stored.size).toBe(0);
  });
});
