import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Miniflare } from 'miniflare';
import app from '../src/index';
import type { AppEnv } from '../src/types';
import { randomToken } from '../src/lib/auth';
import { createCafe, createCategory, createItem, setItemAvailability } from '../src/db/queries';
import { createTestDatabase } from './helpers';

const origin = 'https://acceptance.test';
const adminPassword = 'Acceptance-super-123';
const ownerPassword = 'Acceptance-owner-123';

describe('Definition of Done workflows', () => {
  let runtime: Miniflare, db: D1Database, env: AppEnv['Bindings'];
  beforeAll(async () => {
    const test = await createTestDatabase();
    runtime = test.runtime; db = test.db;
    env = { DB: db, IMAGES: test.bucket, PASSWORD_VIEW_KEY: randomToken(), SETUP_LOGIN: 'acceptance-super', SETUP_PASSWORD: adminPassword };
  }, 30_000);
  beforeEach(async () => {
    await db.prepare('DELETE FROM cafes').run();
    await db.prepare('DELETE FROM users').run();
    await db.prepare('DELETE FROM auth_rate_limits').run();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await runtime?.dispose(); });

  function request(path: string, cookie?: string, body?: URLSearchParams | FormData) {
    const headers = new Headers({ Accept: 'application/json' });
    if (cookie) headers.set('Cookie', cookie);
    if (body) headers.set('Origin', origin);
    return app.request(origin + path, { method: body ? 'POST' : 'GET', headers, body }, env);
  }
  async function post(path: string, fields: Record<string, string>, cookie?: string) {
    return request(path, cookie, new URLSearchParams(fields));
  }
  async function signIn(login: string, password: string) {
    const response = await post('/admin/login', { login, password });
    expect(response.status).toBe(303);
    return response.headers.get('Set-Cookie')!.split(';')[0];
  }

  it('creates a café through the real routes, publishes a photo and two sizes, and revokes every device', async () => {
    expect((await post('/admin/setup', { login: 'acceptance-super', password: adminPassword })).status).toBe(303);
    const superCookie = await signIn('acceptance-super', adminPassword);
    expect((await post('/admin/super/cafes', {
      slug: 'acceptance-cafe', name_ky: 'Кабыл алуу кафеси', name_ru: 'Приёмочное кафе',
      login: 'acceptance-owner', password: ownerPassword,
    }, superCookie)).status).toBe(303);
    const deviceA = await signIn('acceptance-owner', ownerPassword);
    const deviceB = await signIn('acceptance-owner', ownerPassword);
    const base = (await request('/admin', deviceA)).headers.get('Location')!;
    const cafeId = base.split('/').at(-1)!;
    const category = await post(base + '/categories', { name_ky: 'Тамактар', name_ru: 'Блюда' }, deviceA);
    expect(category.status).toBe(303);
    const categoryId = category.headers.get('Location')!.match(/category-(\d+)/)![1];
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const upload = new FormData();
    upload.set('cafe_id', cafeId); upload.set('kind', 'item'); upload.set('file', new File([png], 'fixture.png', { type: 'image/png' }));
    const uploaded = await request('/admin/upload', deviceA, upload);
    expect(uploaded.status).toBe(201);
    const image = await uploaded.json() as { key: string; url: string };
    const form = new URLSearchParams({ name_ky: 'Шорпо', name_ru: 'Бульон', category_id: categoryId, image_key: image.key, is_available: '1', variants_form: '1' });
    for (const [label, price] of [['0,5', '180'], ['0,7', '230']]) { form.append('variant_label', label); form.append('variant_price', price); }
    const added = await request(base + '/items', deviceA, form);
    expect(added.status).toBe(303);
    const itemId = added.headers.get('Location')!.match(/item-(\d+)/)![1];
    const menu = await request('/acceptance-cafe');
    expect(menu.status).toBe(200);
    const html = await menu.text();
    for (const text of ['Шорпо', 'Бульон', '180 сом', '230 сом', image.key]) expect(html).toContain(text);
    expect((await request(image.url)).status).toBe(200);
    expect((await post(base + `/items/${itemId}/availability`, { is_available: '0' }, deviceA)).status).toBe(200);
    expect(await (await request('/acceptance-cafe')).text()).toContain(`class="dish unavailable" id="dish-${itemId}"`);
    const list = await (await request('/admin/super', superCookie)).text();
    for (const text of ['class="stat">1', 'acceptance-owner', '••••••', 'Бишкек убактысы']) expect(list).toContain(text);
    expect(list).not.toContain(ownerPassword);
    expect((await request(`/admin/super/cafes/${cafeId}/password`, deviceA)).status).toBe(403);
    expect(await (await request(`/admin/super/cafes/${cafeId}/password`, superCookie)).json()).toEqual({ password: ownerPassword });
    expect((await post(`/admin/super/cafes/${cafeId}/credentials`, { login: 'acceptance-updated', password: 'Acceptance-updated-123' }, superCookie)).status).toBe(303);
    for (const cookie of [deviceA, deviceB]) expect((await request(base, cookie)).status).toBe(401);
    expect((await post('/admin/login', { login: 'acceptance-owner', password: ownerPassword })).status).toBe(401);
    const fresh = await signIn('acceptance-updated', 'Acceptance-updated-123');
    expect((await post(`/admin/super/cafes/${cafeId}/status`, { is_active: '0' }, superCookie)).status).toBe(303);
    expect((await request(base, fresh)).status).toBe(401);
    expect((await post('/admin/login', { login: 'acceptance-updated', password: 'Acceptance-updated-123' })).status).toBe(401);
  }, 30_000);

  it('serves the old edge entry for 60 seconds, then reads and caches the new sold-out HTML', async () => {
    const cafe = await createCafe(db, { slug: 'cached-cafe', name_ky: 'Кэш кафеси' });
    const category = await createCategory(db, cafe.id, { name_ky: 'Тамактар' });
    const item = await createItem(db, cafe.id, { category_id: category.id, name_ky: 'Шорпо', variants: [{ price: 180 }] });
    let clock = 0;
    const entries = new Map<string, { response: Response; expires: number }>();
    const pending: Promise<unknown>[] = [];
    vi.stubGlobal('caches', { default: {
      async match(key: Request) {
        const entry = entries.get(key.url);
        return entry && entry.expires > clock ? entry.response.clone() : undefined;
      },
      async put(key: Request, response: Response) {
        expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
        entries.set(key.url, { response: response.clone(), expires: clock + 60_000 });
      },
    } });
    const context = { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}, props: {} };
    async function publicPage() {
      const response = await app.request(origin + '/cached-cafe', {}, env, context);
      await Promise.all(pending.splice(0));
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=86400');
      return response.text();
    }
    expect(await publicPage()).not.toContain('class="dish unavailable"');
    await setItemAvailability(db, cafe.id, item.id, 0);
    clock = 59_999;
    expect(await publicPage()).not.toContain('class="dish unavailable"');
    clock = 60_000;
    expect(await publicPage()).toContain('class="dish unavailable"');
    expect(entries.size).toBe(1);
  });
});
