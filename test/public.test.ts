import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import app from '../src/index';
import { createTestDatabase } from './helpers';
import { createCafe, createCategory, createItem, updateCafe, updateCategory, updateItem, updateVariant, deleteItem, deleteCategory, getCafe, moveCategory, setItemAvailability } from '../src/db/queries';
import { publishMenu, rebuildMenu } from '../src/lib/publish';
import { menuClientScript } from '../src/views/public-menu';
import { MENU_CACHE_CONTROL } from '../src/routes/public';
import type { AppEnv } from '../src/types';

const origin = 'https://menu.test';
describe('pre-rendered public menus', () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: AppEnv['Bindings'];
  beforeAll(async () => { const test = await createTestDatabase(); runtime = test.runtime; db = test.db; env = { DB: db, IMAGES: test.bucket }; }, 30_000);
  beforeEach(async () => { await db.prepare('DROP TRIGGER IF EXISTS fail_html_save').run(); await db.prepare('DELETE FROM cafes').run(); });
  afterAll(async () => { await runtime?.dispose(); });
  async function fixture(slug = 'public-cafe') {
    const cafe = await createCafe(db, { slug, name_ky: 'Жети Нур', name_ru: 'Семь лучей' });
    const category = await createCategory(db, cafe.id, { name_ky: 'Шорполор', name_ru: 'Супы' });
    const item = await createItem(db, cafe.id, { category_id: category.id, name_ky: 'Шорпо', name_ru: 'Бульон', ingredients_ky: 'Эт, суу', ingredients_ru: 'Мясо, вода', variants: [{ label: '0,5', price: 180 }, { label: '0,7', price: 230 }] });
    return { cafe, category, item };
  }
  async function published(id: number) { return (await db.prepare('SELECT html, version, slug, is_active FROM published_menus WHERE cafe_id = ?').bind(id).first<{ html: string; version: number; slug: string; is_active: number }>())!; }
  async function get(slug: string, bindings = env) { return app.request(`${origin}/${slug}`, {}, bindings); }

  it('bootstraps an empty café, publishes two languages, variants and native details with no private fields', async () => {
    const empty = await createCafe(db, { slug: 'empty-cafe', name_ky: 'Бош кафе', default_lang: 'ru' });
    expect((await published(empty.id)).html).toContain('<html lang="ru"');
    const { cafe, item } = await fixture();
    const page = await published(cafe.id);
    expect(page.version).toBe((await getCafe(db, cafe.id))!.menu_version);
    for (const text of ['Жети Нур', 'Семь лучей', 'Шорпо', 'Бульон', '180 сом', '230 сом', 'Мясо, вода', '<details', 'system-ui', 'data-lang="ru"']) expect(page.html).toContain(text);
    expect(page.html).toContain(`id="dish-${item.id}"`);
    expect(page.html).not.toMatch(/password|token_hash|login|admin\.js|https:\/\//);
    expect(new TextEncoder().encode(menuClientScript).length).toBeLessThan(3 * 1024);
  });

  it('serves the saved bytes with exactly one indexed SELECT, without touching R2 or other tables', async () => {
    const { cafe } = await fixture();
    const expected = await published(cafe.id);
    const queries: string[] = [];
    const counted = new Proxy(db, { get(target, property) {
      if (property === 'prepare') return (sql: string) => { queries.push(sql); return target.prepare(sql); };
      throw new Error('Public route must only call prepare().bind().first()');
    } });
    const response = await get(cafe.slug + '?lang=ru', { DB: counted, IMAGES: new Proxy({} as R2Bucket, { get() { throw new Error('No R2 lookup for menu HTML'); } }) });
    expect(response.status).toBe(200); expect(await response.text()).toBe(expected.html);
    expect(response.headers.get('Cache-Control')).toBe(MENU_CACHE_CONTROL);
    expect(response.headers.get('X-Menu-Public')).toBe('1');
    expect(response.headers.get('X-Menu-Version')).toBe(String(expected.version));
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'sha256-");
    expect(queries).toEqual(['SELECT html, version FROM published_menus WHERE slug = ? AND is_active = 1']);
    const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT html, version FROM published_menus WHERE slug = ? AND is_active = 1').bind(cafe.slug).all<{ detail: string }>();
    expect(plan.results.map(row => row.detail).join(' ')).toContain('idx_published_menus_slug');
  });

  it('returns a non-cacheable 404 for missing, unpublished, paused and invalid slugs', async () => {
    const { cafe } = await fixture();
    await db.prepare('UPDATE cafes SET is_active = 0 WHERE id = ?').bind(cafe.id).run();
    for (const slug of [cafe.slug, 'missing-cafe', 'Bad', 'foo.js']) {
      const response = await get(slug); expect(response.status).toBe(404); expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    await updateCafe(db, cafe.id, { is_active: 1 }); expect((await get(cafe.slug)).status).toBe(200);
    await db.prepare('DELETE FROM published_menus WHERE cafe_id = ?').bind(cafe.id).run();
    expect((await get(cafe.slug)).status).toBe(404);
    await rebuildMenu(db, cafe.id); expect((await get(cafe.slug)).status).toBe(200);
  });

  it('escapes HTML in names, ingredients and labels and uses Kyrgyz when Russian is missing', async () => {
    const cafe = await createCafe(db, { slug: 'safe-cafe', name_ky: '<script>alert("x")</script>' });
    const category = await createCategory(db, cafe.id, { name_ky: '<b>Суп</b>' });
    await createItem(db, cafe.id, { category_id: category.id, name_ky: '<img src=x onerror=alert(1)>', ingredients_ky: 'Суу & чай', variants: [{ label: '<svg/onload=alert(2)>', price: 1 }] });
    const html = (await published(cafe.id)).html;
    expect(html).not.toContain('<img src=x'); expect(html).not.toContain('<svg/onload');
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('Суу &amp; чай');
    expect(html).toContain('data-lang="ru" lang="ru">&lt;img');
  });

  it('re-publishes category order, item state, prices, names and deletions automatically', async () => {
    const { cafe, category, item } = await fixture();
    const next = await createCategory(db, cafe.id, { name_ky: 'Суусундуктар' });
    await moveCategory(db, cafe.id, next.id, 'up');
    expect((await published(cafe.id)).html.indexOf(`id="category-${next.id}"`)).toBeLessThan((await published(cafe.id)).html.indexOf(`id="category-${category.id}"`));
    await updateCategory(db, cafe.id, category.id, { name_ky: 'Жаңы бөлүм' });
    await updateItem(db, cafe.id, item.id, { name_ky: 'Жаңы тамак' });
    await updateVariant(db, cafe.id, item.id, item.variants[0].id, { price: 777 });
    await setItemAvailability(db, cafe.id, item.id, 0);
    const html = (await published(cafe.id)).html;
    for (const text of ['Жаңы бөлүм', 'Жаңы тамак', '777 сом', 'dish unavailable', 'Бүттү', 'Закончилось', 'text-decoration:line-through']) expect(html).toContain(text);
    await deleteItem(db, cafe.id, item.id); expect((await published(cafe.id)).html).not.toContain('Жаңы тамак');
    await deleteCategory(db, cafe.id, next.id, { action: 'delete-items' }); expect((await published(cafe.id)).html).not.toContain('Суусундуктар');
  });

  it('moves a renamed slug to the new index entry and never includes another café’s data', async () => {
    const a = await fixture(); const b = await fixture('another-cafe');
    await updateItem(db, b.cafe.id, b.item.id, { name_ky: 'PRIVATE-OTHER-CAFE' });
    await updateCafe(db, a.cafe.id, { slug: 'renamed-cafe', name_ky: 'Жаңы кафе' });
    expect((await get('public-cafe')).status).toBe(404);
    const response = await get('renamed-cafe'); expect(response.status).toBe(200);
    const html = await response.text(); expect(html).toContain('Жаңы кафе'); expect(html).not.toContain('PRIVATE-OTHER-CAFE');
  });

  it('does not let a delayed older publisher overwrite a newer version', async () => {
    const { cafe, item } = await fixture();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    const delayedDb = new Proxy(db, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes('INSERT INTO published_menus')) return statement;
        return { bind(...values: unknown[]) { const bound = statement.bind(...values); return { async run() { if (first) { first = false; entered(); await gate; } return bound.run(); } }; } };
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const older = publishMenu(delayedDb, cafe.id);
    await blocked;
    try { await updateItem(db, cafe.id, item.id, { name_ky: 'LATEST-VERSION' }); }
    finally { release(); }
    await older;
    expect((await published(cafe.id)).version).toBe((await getCafe(db, cafe.id))!.menu_version);
    expect((await published(cafe.id)).html).toContain('LATEST-VERSION');
  });

  it('generates a rich 30-dish menu below 30 KB gzip and a page script below 3 KB', async () => {
    const { cafe, category } = await fixture();
    for (let i = 1; i < 30; i++) await createItem(db, cafe.id, { category_id: category.id, name_ky: `Тамак ${i}: кыргызча толук аталышы`, name_ru: `Блюдо ${i}: полное описание`, ingredients_ky: `Курамы ${i}: эт, пияз, сабиз, татымалдар. `.repeat(12), ingredients_ru: `Состав ${i}: мясо, лук, морковь, специи. `.repeat(12), variants: [{ label: '0,5', price: 180 + i }, { label: '0,7', price: 230 + i }, { label: '1,0', price: 300 + i }] });
    const html = (await published(cafe.id)).html;
    expect((html.match(/<details /g) ?? []).length).toBe(30);
    const compressed = await new Response(new Blob([html]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    expect(compressed.byteLength).toBeLessThan(30 * 1024);
    expect(new TextEncoder().encode(menuClientScript).length).toBeLessThan(3 * 1024);
  }, 15_000);
});
