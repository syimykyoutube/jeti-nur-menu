import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import app from '../src/index';
import type { AppEnv } from '../src/types';
import type { User } from '../src/db/types';
import { createSession, hashPassword, logout, SESSION_COOKIE } from '../src/lib/auth';
import {
  createCafe, createCategory, createItem, getCafe, getCategory, getItem, listCategories,
  listItems, listVariants, updateItemWithVariants, moveCategory,
} from '../src/db/queries';
import { publishMenu } from '../src/lib/publish';
import { t } from '../src/lib/i18n';
import { createTestDatabase } from './helpers';

const origin = 'https://menu.test';
type Form = Record<string, string | string[]>;

describe('owner menu', () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: AppEnv['Bindings'];
  let passwordHash: string;

  beforeAll(async () => {
    ({ runtime, db } = await createTestDatabase());
    env = { DB: db, IMAGES: {} as R2Bucket };
    passwordHash = await hashPassword('Owner-menu-test-123');
  }, 30_000);
  beforeEach(async () => {
    await db.prepare('DROP TRIGGER IF EXISTS fail_menu_version').run();
    await db.prepare('DELETE FROM cafes').run();
    await db.prepare('DELETE FROM users').run();
  });
  afterAll(async () => { await runtime?.dispose(); });

  async function fixture(slug = 'owner-cafe') {
    const cafe = await createCafe(db, { slug, name_ky: 'Жети Нур', name_ru: 'Семь лучей' });
    const owner = (await db.prepare("INSERT INTO users (login, password_hash, role, cafe_id) VALUES (?, ?, 'owner', ?) RETURNING *")
      .bind(`owner-${slug}`, passwordHash, cafe.id).first<User>())!;
    const token = (await createSession(db, owner))!;
    const category = await createCategory(db, cafe.id, { name_ky: 'Шорполор', name_ru: 'Супы' });
    const item = await createItem(db, cafe.id, { category_id: category.id, name_ky: 'Шорпо', ingredients_ky: 'Эт', variants: [{ label: '0,5', price: 180 }, { label: '0,7', price: 230 }] });
    return { cafeId: cafe.id, owner, token, category, item, base: `/admin/cafes/${cafe.id}` };
  }

  function request(path: string, token?: string, form?: Form, json = false, requestOrigin: string | null = origin) {
    const headers = new Headers();
    if (token) headers.set('Cookie', `${SESSION_COOKIE}=${token}`);
    if (json) headers.set('Accept', 'application/json');
    const body = form ? new URLSearchParams() : undefined;
    if (form) {
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      if (requestOrigin !== null) headers.set('Origin', requestOrigin);
      for (const [key, value] of Object.entries(form)) for (const entry of Array.isArray(value) ? value : [value]) body!.append(key, entry);
    }
    return app.request(origin + path, { method: form ? 'POST' : 'GET', headers, body }, env);
  }
  async function version(cafeId: number) { return (await getCafe(db, cafeId))!.menu_version; }
  function fullItemForm(categoryId: number): Form {
    return { name_ky: 'Көк чай', name_ru: 'Зелёный чай', category_id: String(categoryId), ingredients_ky: 'Чай, суу', ingredients_ru: 'Чай, вода', is_available: '1', variant_label: ['0,5', '0,7'], variant_price: ['180', '230'] };
  }

  it('renders grouped items, prices and accessible quick switches; editor has all fields and translated controls', async () => {
    const { base, token, item, category } = await fixture();
    const dashboard = await request(base, token);
    expect(dashboard.status).toBe(200);
    const html = await dashboard.text();
    expect(html).toContain(`id="category-${category.id}"`);
    expect(html).toContain(`id="item-${item.id}"`);
    expect(html).toContain('0,5 — 180 сом');
    expect(html).toContain('role="switch" aria-checked="false"');
    expect(html).toContain(`href="${base}/items/${item.id}/edit"`);
    expect(html).toContain(t('ky', 'up'));
    const editor = await request(`${base}/items/${item.id}/edit`, token);
    const form = await editor.text();
    for (const field of ['name_ky', 'name_ru', 'category_id', 'ingredients_ky', 'ingredients_ru', 'variant_label', 'variant_price']) expect(form).toContain(`name="${field}"`);
    expect(form).toContain(t('ky', 'addVariant'));
    expect(form).toContain('value="180"');
    expect(form).toContain('data-variant-template');
  });

  it('sets availability with JSON without redirect, advances the version once, and safely accepts retries', async () => {
    const { base, token, cafeId, item } = await fixture();
    const before = await version(cafeId);
    const response = await request(`${base}/items/${item.id}/availability`, token, { is_available: '0' }, true);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({ is_available: 0, menu_version: before + 1 });
    expect((await getItem(db, cafeId, item.id))?.is_available).toBe(0);
    expect((await request(`${base}/items/${item.id}/availability`, token, { is_available: '0' }, true)).status).toBe(200);
    expect(await version(cafeId)).toBe(before + 1);
    expect((await request(`${base}/items/${item.id}/availability`, token, { is_available: '1' }, true)).status).toBe(200);
    expect(await version(cafeId)).toBe(before + 2);
  });

  it('rejects invalid, expired and cross-origin quick updates without advancing the version', async () => {
    const { base, token, cafeId, item } = await fixture();
    const before = await version(cafeId);
    expect((await request(`${base}/items/${item.id}/availability`, token, { is_available: '2' }, true)).status).toBe(400);
    expect((await request(`${base}/items/${item.id}/availability`, token, { is_available: ['0', '1'] }, true)).status).toBe(400);
    expect((await request(`${base}/items/999999/availability`, token, { is_available: '0' }, true)).status).toBe(404);
    const csrf = await request(`${base}/items/${item.id}/availability`, token, { is_available: '0' }, true, 'https://evil.test');
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toEqual({ error: t('ky', 'invalidOrigin') });
    await logout(db, token);
    const expired = await request(`${base}/items/${item.id}/availability`, token, { is_available: '0' }, true);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: t('ky', 'sessionExpired') });
    expect(await version(cafeId)).toBe(before);
  });

  it('creates an item with ingredients and several sizes in one save, and edits them together', async () => {
    const { base, token, cafeId, category } = await fixture();
    const before = await version(cafeId);
    expect((await request(`${base}/items`, token, fullItemForm(category.id))).status).toBe(303);
    const created = (await listItems(db, cafeId)).find((item) => item.name_ky === 'Көк чай')!;
    expect(created).toMatchObject({ name_ru: 'Зелёный чай', ingredients_ky: 'Чай, суу', ingredients_ru: 'Чай, вода' });
    expect((await listVariants(db, cafeId, created.id)).map((row) => row.price)).toEqual([180, 230]);
    expect(await version(cafeId)).toBe(before + 1);
    const other = await createCategory(db, cafeId, { name_ky: 'Суусундуктар' });
    const priorEdit = await version(cafeId);
    expect((await request(`${base}/items/${created.id}`, token, { ...fullItemForm(other.id), name_ky: 'Жаңы чай', variant_label: ['Чыны'], variant_price: ['90'], is_available: '0' })).status).toBe(303);
    expect(await getItem(db, cafeId, created.id)).toMatchObject({ category_id: other.id, name_ky: 'Жаңы чай', is_available: 0 });
    expect((await listVariants(db, cafeId, created.id)).map((row) => [row.label, row.price])).toEqual([['Чыны', 90]]);
    expect(await version(cafeId)).toBe(priorEdit + 1);
  });

  it.each(['-1', '1.5', 'NaN', 'Infinity', '9007199254740992', ''])('validates bad prices on the server and preserves entered fields: %s', async (price) => {
    const { base, token, cafeId, category } = await fixture();
    const before = await version(cafeId);
    const response = await request(`${base}/items`, token, { ...fullItemForm(category.id), name_ky: '<img src=x>', variant_price: ['180', price] });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(t('ky', 'invalidPrice'));
    expect(html).toContain('value="&lt;img src=x&gt;"');
    expect(html).not.toContain('<img src=x>');
    expect(await listItems(db, cafeId)).toHaveLength(1);
    expect(await version(cafeId)).toBe(before);
  });

  it('validates missing variants, mismatched rows, names, ingredients, label lengths and availability', async () => {
    const { base, token, cafeId, category, item } = await fixture();
    const before = await version(cafeId);
    const valid = fullItemForm(category.id);
    for (const bad of [
      { ...valid, variant_price: [], variant_label: [] },
      { ...valid, variant_price: ['180'] },
      { ...valid, name_ky: '  ' }, { ...valid, name_ky: 'a'.repeat(121) },
      { ...valid, ingredients_ky: 'a'.repeat(2001) },
      { ...valid, variant_label: ['a'.repeat(41), 'b'] },
      { ...valid, is_available: 'fake' },
      { ...valid, variant_price: Array(51).fill('1'), variant_label: Array(51).fill('') },
    ]) expect((await request(`${base}/items`, token, bad)).status).toBe(400);
    expect((await request(`${base}/items/${item.id}`, token, { ...valid, variants_form: '1', variant_label: [], variant_price: [] })).status).toBe(400);
    expect(await version(cafeId)).toBe(before);
    expect(await listItems(db, cafeId)).toHaveLength(1);
  });

  it('supports a blank label and zero price, and keeps at least one variant on delete', async () => {
    const { base, token, cafeId, item } = await fixture();
    const before = await version(cafeId);
    const first = item.variants[0].id;
    expect((await request(`${base}/items/${item.id}/variants/${first}`, token, { label: '', price: '0' })).status).toBe(303);
    expect(await version(cafeId)).toBe(before + 1);
    expect((await request(`${base}/items/${item.id}/variants/${item.variants[1].id}/delete`, token, {})).status).toBe(303);
    const priorLast = await version(cafeId);
    expect((await request(`${base}/items/${item.id}/variants/${first}/delete`, token, {})).status).toBe(400);
    expect(await version(cafeId)).toBe(priorLast);
    expect(await listVariants(db, cafeId, item.id)).toHaveLength(1);
  });

  it('appends categories and moves them up/down even when existing sort_order values tie', async () => {
    const { base, token, cafeId, category } = await fixture();
    const second = await createCategory(db, cafeId, { name_ky: 'Экинчи', sort_order: 0 });
    const third = await createCategory(db, cafeId, { name_ky: 'Үчүнчү', sort_order: 0 });
    const before = await version(cafeId);
    expect((await request(`${base}/categories/${second.id}/move`, token, { direction: 'up' })).status).toBe(303);
    expect((await listCategories(db, cafeId)).map((row) => row.id)).toEqual([second.id, category.id, third.id]);
    expect(await version(cafeId)).toBe(before + 1);
    expect((await listCategories(db, cafeId)).map((row) => row.sort_order)).toEqual([0, 1, 2]);
    expect(await moveCategory(db, cafeId, second.id, 'up')).toBe(false);
    expect(await version(cafeId)).toBe(before + 1);
    expect((await request(`${base}/categories/${second.id}/move`, token, { direction: 'down' })).status).toBe(303);
    expect((await listCategories(db, cafeId)).map((row) => row.id)).toEqual([category.id, second.id, third.id]);
    expect((await request(`${base}/categories`, token, { name_ky: 'Акыркы' })).status).toBe(303);
    expect((await listCategories(db, cafeId)).at(-1)?.name_ky).toBe('Акыркы');
  });

  it('requires an explicit category deletion decision and validates the destination', async () => {
    const { base, token, cafeId, category, item } = await fixture();
    const destination = await createCategory(db, cafeId, { name_ky: 'Жаңы' });
    const before = await version(cafeId);
    expect((await request(`${base}/categories/${category.id}/delete`, token, {})).status).toBe(400);
    expect((await request(`${base}/categories/${category.id}/delete`, token, { action: 'move-items' })).status).toBe(400);
    expect((await request(`${base}/categories/${category.id}/delete`, token, { action: 'move-items', target_category_id: String(category.id) })).status).toBe(400);
    expect(await version(cafeId)).toBe(before);
    expect((await request(`${base}/categories/${category.id}/delete`, token, { action: 'move-items', target_category_id: String(destination.id) })).status).toBe(303);
    expect(await getCategory(db, cafeId, category.id)).toBeNull();
    expect(await getItem(db, cafeId, item.id)).toMatchObject({ category_id: destination.id });
    expect(await listVariants(db, cafeId, item.id)).toHaveLength(2);
    expect(await version(cafeId)).toBe(before + 1);
    expect((await request(`${base}/categories/${destination.id}/delete`, token, { action: 'delete-items' })).status).toBe(303);
    expect(await listItems(db, cafeId)).toHaveLength(0);
    expect(await version(cafeId)).toBe(before + 2);
  });

  it('scopes every mutation and editor to the owner cafe, with no changes or version bumps on rejection', async () => {
    const a = await fixture('cafe-one');
    const b = await fixture('cafe-two');
    const beforeA = await version(a.cafeId), beforeB = await version(b.cafeId);
    expect((await request(`${b.base}/items/${b.item.id}/edit`, a.token)).status).toBe(403);
    expect((await request(`${a.base}/items/${b.item.id}/edit`, a.token)).status).toBe(404);
    expect((await request(`${a.base}/items/${b.item.id}/availability`, a.token, { is_available: '0' }, true)).status).toBe(404);
    expect((await request(`${a.base}/items/${b.item.id}/delete`, a.token, {})).status).toBe(404);
    expect((await request(`${a.base}/categories/${b.category.id}/move`, a.token, { direction: 'up' })).status).toBe(404);
    expect((await request(`${a.base}/categories/${b.category.id}`, a.token, { name_ky: 'Чоочун' })).status).toBe(404);
    expect((await request(`${a.base}/items/${a.item.id}`, a.token, fullItemForm(b.category.id))).status).toBe(403);
    expect((await request(`${a.base}/categories/${a.category.id}/delete`, a.token, { action: 'move-items', target_category_id: String(b.category.id) })).status).toBe(400);
    expect(await version(a.cafeId)).toBe(beforeA);
    expect(await version(b.cafeId)).toBe(beforeB);
    expect((await getItem(db, b.cafeId, b.item.id))?.name_ky).toBe('Шорпо');
  });

  it('rolls back both item fields and variants if the version update fails', async () => {
    const { cafeId, item } = await fixture();
    const before = await version(cafeId);
    const originalVariants = await listVariants(db, cafeId, item.id);
    await db.prepare("CREATE TRIGGER fail_menu_version BEFORE UPDATE OF menu_version ON cafes BEGIN SELECT RAISE(ABORT, 'test version failure'); END;").run();
    await expect(updateItemWithVariants(db, cafeId, item.id, { name_ky: 'Өзгөрдү' }, [{ price: 999 }])).rejects.toThrow();
    expect((await getItem(db, cafeId, item.id))?.name_ky).toBe('Шорпо');
    expect(await listVariants(db, cafeId, item.id)).toEqual(originalVariants);
    expect(await version(cafeId)).toBe(before);
  });

  it('changes ui_lang without changing the menu version and uses the saved language on every owner page', async () => {
    const { base, token, cafeId, item } = await fixture();
    const before = await version(cafeId);
    expect((await request('/admin/language', token, { lang: 'ru', return_to: base })).status).toBe(303);
    const html = await (await request(base, token)).text();
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain('Семь лучей');
    expect(html).toContain('Супы');
    expect(html).toContain(t('ru', 'availabilityQuestion'));
    expect(html).toContain('Шорпо'); // Missing RU name falls back to KY.
    expect(await (await request(`${base}/items/${item.id}/edit`, token)).text()).toContain(t('ru', 'addVariant'));
    expect(await version(cafeId)).toBe(before);
  });

  it('publishes complete HTML and advances the version', async () => {
    const { cafeId } = await fixture();
    const before = await version(cafeId);
    expect((await publishMenu(db, cafeId)).version).toBe(before + 1);
    const published = await db.prepare('SELECT html, version FROM published_menus WHERE cafe_id = ?').bind(cafeId).first<{ html: string; version: number }>();
    expect(published?.version).toBe(before + 1);
    expect(published?.html).toContain('data-lang="ru"');
    expect(published?.html).toContain('180 сом');
  });
});
