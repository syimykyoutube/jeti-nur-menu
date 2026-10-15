import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import app from '../src/index';
import type { AppEnv } from '../src/types';
import type { User } from '../src/db/types';
import { createSession, hashPassword, SESSION_COOKIE } from '../src/lib/auth';
import { createCafe, createCategory, createItem, getCafe, getItem, updateItem } from '../src/db/queries';
import { cleanupImages, IMAGE_CACHE_CONTROL, MAX_IMAGE_BYTES } from '../src/lib/images';
import { createTestDatabase } from './helpers';

const origin = 'https://menu.test';
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const webp = Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'), c => c.charCodeAt(0));

describe('image upload with real local D1 and R2', () => {
  let runtime: Miniflare;
  let db: D1Database;
  let bucket: R2Bucket;
  let env: AppEnv['Bindings'];
  let passwordHash: string;
  beforeAll(async () => {
    ({ runtime, db, bucket } = await createTestDatabase());
    env = { DB: db, IMAGES: bucket };
    passwordHash = await hashPassword('Image-owner-test-123');
  }, 30_000);
  beforeEach(async () => {
    await db.prepare('DROP TRIGGER IF EXISTS fail_image_save').run();
    await db.prepare('DELETE FROM cafes').run();
    await db.prepare('DELETE FROM users').run();
    await db.prepare('DELETE FROM image_uploads').run();
    const objects = await bucket.list();
    if (objects.objects.length) await bucket.delete(objects.objects.map(object => object.key));
  });
  afterAll(async () => { await runtime?.dispose(); });

  async function fixture(slug = 'photo-cafe') {
    const cafe = await createCafe(db, { slug, name_ky: 'Кафе' });
    const owner = (await db.prepare("INSERT INTO users (login, password_hash, role, cafe_id) VALUES (?, ?, 'owner', ?) RETURNING *")
      .bind(slug, passwordHash, cafe.id).first<User>())!;
    const token = (await createSession(db, owner))!;
    const category = await createCategory(db, cafe.id, { name_ky: 'Тамактар' });
    const item = await createItem(db, cafe.id, { category_id: category.id, name_ky: 'Шорпо', variants: [{ price: 180 }] });
    return { cafe, category, item, token, base: `/admin/cafes/${cafe.id}` };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function headers(token?: string, requestOrigin: string | null = origin) {
    const result = new Headers({ Accept: 'application/json' });
    if (token) result.set('Cookie', `${SESSION_COOKIE}=${token}`);
    if (requestOrigin !== null) result.set('Origin', requestOrigin);
    return result;
  }
  function upload(f: Fixture, kind = 'item', bytes: Uint8Array = png, type = 'image/png', token: string | undefined = f.token, requestOrigin: string | null = origin) {
    const body = new FormData();
    body.set('cafe_id', String(f.cafe.id)); body.set('kind', kind);
    body.set('file', new File([Uint8Array.from(bytes)], 'untrusted-name.jpg', { type }));
    return app.request(origin + '/admin/upload', { method: 'POST', headers: headers(token, requestOrigin), body }, env);
  }
  async function uploaded(f: Fixture, kind = 'item') {
    const response = await upload(f, kind);
    expect(response.status).toBe(201);
    return await response.json() as { key: string; url: string; size: number };
  }
  function save(f: Fixture, key: string, extra: Record<string, string> = {}, path = `/items/${f.item.id}`) {
    const body = new URLSearchParams({ name_ky: 'Шорпо', category_id: String(f.category.id), variant_label: '', variant_price: '180', image_key: key, ...extra });
    return app.request(origin + f.base + path, { method: 'POST', headers: headers(f.token), body }, env);
  }
  function settings(f: Fixture, key: string, extra: Record<string, string> = {}) {
    return app.request(origin + f.base + '/settings', { method: 'POST', headers: headers(f.token), body: new URLSearchParams({ name_ky: 'Кафе', name_ru: '', default_lang: 'ky', logo_key: key, ...extra }) }, env);
  }
  async function state(key: string) { return db.prepare('SELECT state FROM image_uploads WHERE key = ?').bind(key).first<{ state: string }>(); }

  it('stores PNG/WebP with content hash, serves public immutable bytes and ETag, stages without changing the menu', async () => {
    const f = await fixture();
    const version = (await getCafe(db, f.cafe.id))!.menu_version;
    for (const [bytes, mime, ext] of [[png, 'image/png', 'png'], [webp, 'image/webp', 'webp']] as const) {
      const response = await upload(f, 'item', bytes, mime);
      expect(response.status).toBe(201);
      const image = await response.json() as { key: string; url: string; size: number };
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      expect(image.key).toMatch(new RegExp(`^c${f.cafe.id}-[0-9a-f]{32}-${digest}\\.${ext}$`));
      expect(image.size).toBe(bytes.length);
      const served = await app.request(origin + image.url, {}, env);
      expect(served.status).toBe(200);
      expect(served.headers.get('Cache-Control')).toBe(IMAGE_CACHE_CONTROL);
      expect(served.headers.get('Content-Type')).toBe(mime);
      expect(served.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
      const cached = await app.request(origin + image.url, { headers: { 'If-None-Match': served.headers.get('ETag')! } }, env);
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe('');
    }
    expect((await getCafe(db, f.cafe.id))!.menu_version).toBe(version);
    expect((await app.request(origin + '/img/unknown', {}, env)).headers.get('Cache-Control')).toBe('no-store');
  });

  it('accepts the 300 KB boundary and rejects oversized files and oversized request bodies', async () => {
    const f = await fixture();
    // Preserve PNG container endpoints; server checks headers, browser performs image decoding.
    const boundary = new Uint8Array(MAX_IMAGE_BYTES);
    boundary.set(png.slice(0, -12)); boundary.set(png.slice(-12), boundary.length - 12);
    expect((await upload(f, 'item', boundary)).status).toBe(201);
    expect((await upload(f, 'item', new Uint8Array(MAX_IMAGE_BYTES + 1))).status).toBe(413);
    const response = await upload(f, 'item', new Uint8Array(400 * 1024));
    expect(response.status).toBe(413);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it('rejects unsupported MIME, spoofed MIME, empty files, malformed multipart and invalid kinds', async () => {
    const f = await fixture();
    expect((await upload(f, 'item', png, 'image/jpeg')).status).toBe(415);
    expect((await upload(f, 'item', png, 'image/webp')).status).toBe(400);
    expect((await upload(f, 'item', new TextEncoder().encode('<svg/>'))).status).toBe(400);
    expect((await upload(f, 'item', new Uint8Array())).status).toBe(400);
    expect((await upload(f, 'avatar')).status).toBe(400);
    expect((await app.request(origin + '/admin/upload', { method: 'POST', headers: headers(f.token), body: '{}' }, env)).status).toBe(400);
    const malformedHeaders = headers(f.token); malformedHeaders.set('Content-Type', 'multipart/form-data; boundary=missing');
    expect((await app.request(origin + '/admin/upload', { method: 'POST', headers: malformedHeaders, body: 'wrong' }, env)).status).toBe(400);
    expect((await bucket.list()).objects).toHaveLength(0);
  });

  it('requires a fresh session, same origin and access to the requested café', async () => {
    const a = await fixture('cafe-one'); const b = await fixture('cafe-two');
    expect((await upload(b, 'item', png, 'image/png', a.token)).status).toBe(403);
    expect((await upload(a, 'item', png, 'image/png', '')).status).toBe(401);
    expect((await upload(a, 'item', png, 'image/png', a.token, null)).status).toBe(403);
    expect((await upload(a, 'item', png, 'image/png', a.token, 'https://evil.test')).status).toBe(403);
    await db.prepare('UPDATE cafes SET is_active = 0 WHERE id = ?').bind(a.cafe.id).run();
    expect((await upload(a)).status).toBe(401);
  });

  it('attaches an image when creating a dish, with its variants and one version increment', async () => {
    const f = await fixture(); const image = await uploaded(f);
    const before = (await getCafe(db, f.cafe.id))!.menu_version;
    expect((await save(f, image.key, {}, '/items')).status).toBe(303);
    const item = await db.prepare('SELECT id FROM items WHERE image_key = ?').bind(image.key).first();
    expect(item).not.toBeNull();
    expect(await state(image.key)).toEqual({ state: 'attached' });
    expect((await getCafe(db, f.cafe.id))!.menu_version).toBe(before + 1);
  });

  it('deletes a replaced dish image only after the new reference commits; removing also deletes it', async () => {
    const f = await fixture(); const old = await uploaded(f);
    expect((await save(f, old.key)).status).toBe(303);
    const next = await uploaded(f);
    expect((await save(f, next.key, { variant_price: '-1' })).status).toBe(400);
    expect(await bucket.head(old.key)).not.toBeNull();
    expect((await getItem(db, f.cafe.id, f.item.id))!.image_key).toBe(old.key);
    expect(await state(next.key)).toEqual({ state: 'staged' });
    const before = (await getCafe(db, f.cafe.id))!.menu_version;
    expect((await save(f, next.key)).status).toBe(303);
    expect(await bucket.head(old.key)).toBeNull();
    expect(await state(old.key)).toBeNull();
    expect(await bucket.head(next.key)).not.toBeNull();
    expect((await getCafe(db, f.cafe.id))!.menu_version).toBe(before + 1);
    expect((await save(f, '')).status).toBe(303);
    expect(await bucket.head(next.key)).toBeNull();
  });

  it('refuses another café’s key, wrong image kind, and reuse on a second dish', async () => {
    const a = await fixture('cafe-one'); const b = await fixture('cafe-two');
    const foreign = await uploaded(b); const logo = await uploaded(a, 'logo');
    expect((await save(a, foreign.key)).status).toBe(400);
    expect((await save(a, logo.key)).status).toBe(400);
    expect((await settings(a, foreign.key)).status).toBe(400);
    const image = await uploaded(a);
    expect((await save(a, image.key)).status).toBe(303);
    expect((await save(a, image.key, {}, '/items')).status).toBe(400);
    expect((await save(a, image.key)).status).toBe(303); // unchanged reference remains valid
    // Database guard also prevents races/direct duplicate claims, independently of HTTP validation.
    await expect(updateItem(db, b.cafe.id, b.item.id, { image_key: image.key })).rejects.toThrow();
    expect(await bucket.head(image.key)).not.toBeNull();
  }, 15_000);

  it('rolls back attachment and retirement together if menu-version update fails', async () => {
    const f = await fixture(); const old = await uploaded(f); await save(f, old.key);
    const next = await uploaded(f);
    await db.prepare(`CREATE TRIGGER fail_image_save BEFORE UPDATE OF menu_version ON cafes BEGIN SELECT RAISE(ABORT, 'test rollback'); END`).run();
    expect((await save(f, next.key)).status).toBe(500);
    expect((await getItem(db, f.cafe.id, f.item.id))!.image_key).toBe(old.key);
    expect(await state(old.key)).toEqual({ state: 'attached' });
    expect(await state(next.key)).toEqual({ state: 'staged' });
    expect(await bucket.head(old.key)).not.toBeNull();
  });

  it('saves café settings and logo, validates names/language and cleans replaced logos', async () => {
    const f = await fixture(); const old = await uploaded(f, 'logo');
    expect((await settings(f, old.key, { default_lang: 'en' })).status).toBe(400);
    expect((await settings(f, old.key, { name_ky: '' })).status).toBe(400);
    expect((await settings(f, old.key, { default_lang: 'ru', name_ky: 'Жаңы ат' })).status).toBe(303);
    expect((await getCafe(db, f.cafe.id))!.default_lang).toBe('ru');
    const next = await uploaded(f, 'logo');
    const before = (await getCafe(db, f.cafe.id))!.menu_version;
    expect((await settings(f, next.key)).status).toBe(303);
    expect(await bucket.head(old.key)).toBeNull();
    expect((await getCafe(db, f.cafe.id))!.logo_key).toBe(next.key);
    expect((await getCafe(db, f.cafe.id))!.menu_version).toBe(before + 1);
    expect((await settings(f, '')).status).toBe(303);
    expect(await bucket.head(next.key)).toBeNull();
  });

  it.each(['item', 'category'])('cleans images when deleting a %s', async (target) => {
    const f = await fixture(); const image = await uploaded(f); await save(f, image.key);
    const path = target === 'item' ? `/items/${f.item.id}/delete` : `/categories/${f.category.id}/delete`;
    expect((await save(f, '', { action: 'delete-items' }, path)).status).toBe(303);
    expect(await bucket.head(image.key)).toBeNull();
    expect(await state(image.key)).toBeNull();
  });

  it('keeps failed R2 deletions queued and retries them on a later successful request', async () => {
    const f = await fixture(); const image = await uploaded(f); await save(f, image.key);
    const realBucket = env.IMAGES;
    env.IMAGES = new Proxy(realBucket, { get(target, prop) { if (prop === 'delete') return async () => { throw new Error('R2 unavailable'); }; const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; } });
    try { expect((await save(f, '')).status).toBe(303); }
    finally { env.IMAGES = realBucket; }
    expect(await state(image.key)).toEqual({ state: 'retired' });
    expect(await bucket.head(image.key)).not.toBeNull();
    expect((await settings(f, '')).status).toBe(303);
    expect(await bucket.head(image.key)).toBeNull();
  });

  it('retires abandoned uploads after 24 hours without touching attached images', async () => {
    const f = await fixture(); const abandoned = await uploaded(f); const attached = await uploaded(f);
    await save(f, attached.key);
    await db.prepare("UPDATE image_uploads SET created_at = datetime('now', '-2 days')").run();
    await cleanupImages(env, f.cafe.id);
    expect(await bucket.head(abandoned.key)).toBeNull();
    expect(await bucket.head(attached.key)).not.toBeNull();
  });
});
