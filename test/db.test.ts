import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { createTestDatabase } from './helpers';
import {
  createCafe, getCafe, getCafeBySlug, listCafes, updateCafe, deleteCafe,
  createCategory, getCategory, listCategories, updateCategory, deleteCategory,
  createItem, getItem, listItems, updateItem, deleteItem,
  createVariant, getVariant, listVariants, updateVariant, deleteVariant,
} from '../src/db/queries';

describe('D1 migration and queries', () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    ({ runtime, db } = await createTestDatabase());
  }, 30_000);

  beforeEach(async () => {
    await db.prepare('DELETE FROM cafes').run();
    await db.prepare('DELETE FROM users').run();
  });

  afterAll(async () => {
    await runtime?.dispose();
  });

  async function menu(slug = 'cafe-one') {
    const cafe = await createCafe(db, { slug, name_ky: 'Кафе' });
    const category = await createCategory(db, cafe.id, { name_ky: 'Тамактар' });
    const item = await createItem(db, cafe.id, {
      category_id: category.id, name_ky: 'Шорпо',
      variants: [{ label: '0,5', price: 180 }, { label: '0,7', price: 230 }],
    });
    return { cafe, category, item };
  }

  it('creates all seven tables, timestamps and the required indexes', async () => {
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results;
    for (const table of ['cafes', 'users', 'sessions', 'categories', 'items', 'item_variants', 'published_menus']) {
      expect(tables.map((row) => row.name)).toContain(table);
      const columns = (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string; pk: number }>()).results;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['created_at', 'updated_at']));
      expect(columns.find((column) => column.pk === 1)?.name).toBe(table === 'published_menus' ? 'cafe_id' : 'id');
    }
    const indexes = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>()).results.map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_cafes_slug', 'idx_users_login', 'idx_users_cafe_id', 'idx_sessions_token_hash',
      'idx_sessions_user_id', 'idx_categories_cafe_sort', 'idx_items_cafe_sort',
      'idx_items_category_sort', 'idx_item_variants_item_sort',
    ]));
    const userColumns = (await db.prepare('PRAGMA table_info(users)').all<{ name: string }>()).results;
    expect(userColumns.map((column) => column.name)).not.toContain('email');
  });

  it('supports cafe CRUD and binds SQL-shaped text as data', async () => {
    const name = "Кафе '); DROP TABLE cafes; --";
    const cafe = await createCafe(db, { slug: 'jeti-nur', name_ky: name });
    expect(cafe).toMatchObject({ name_ky: name, is_active: 1, default_lang: 'ky', name_ru: null });
    expect(cafe.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(await getCafe(db, cafe.id)).toEqual(cafe);
    expect(await getCafeBySlug(db, 'jeti-nur')).toEqual(cafe);
    expect(await getCafeBySlug(db, "' OR 1=1 --")).toBeNull();
    expect(await listCafes(db)).toHaveLength(1);
    expect(await updateCafe(db, cafe.id, { name_ru: 'Кафе', default_lang: 'ru' })).toMatchObject({ name_ky: name, name_ru: 'Кафе', default_lang: 'ru' });
    // Extra runtime keys cannot become SQL identifiers or overwrite the primary key.
    expect(await updateCafe(db, cafe.id, { id: 99, 'name_ky = NULL; --': 'oops' } as never)).toMatchObject({ id: cafe.id, name_ky: name });
    expect(await deleteCafe(db, cafe.id)).toBe(true);
    expect(await getCafe(db, cafe.id)).toBeNull();
    expect(await updateCafe(db, cafe.id, { name_ky: 'Жаңы' })).toBeNull();
    expect(await deleteCafe(db, cafe.id)).toBe(false);
  });

  it('enforces unique slugs and the database slug check', async () => {
    await createCafe(db, { slug: 'unique', name_ky: 'Кафе' });
    await expect(createCafe(db, { slug: 'unique', name_ky: 'Кафе' })).rejects.toThrow();
    for (const slug of ['ab', 'a'.repeat(41), 'ABC', 'abc_def']) {
      await expect(db.prepare('INSERT INTO cafes (slug, name_ky) VALUES (?, ?)').bind(slug, 'Кафе').run()).rejects.toThrow();
    }
  });

  it('supports category CRUD, ordering and empty patches', async () => {
    const cafe = await createCafe(db, { slug: 'category', name_ky: 'Кафе' });
    const second = await createCategory(db, cafe.id, { name_ky: 'Экинчи', sort_order: 2 });
    const first = await createCategory(db, cafe.id, { name_ky: 'Биринчи', sort_order: 1 });
    expect(await listCategories(db, cafe.id)).toEqual([first, second]);
    expect(await updateCategory(db, cafe.id, first.id, {})).toEqual(first);
    expect(await updateCategory(db, cafe.id, first.id, { name_ru: 'Первый' })).toMatchObject({ name_ru: 'Первый' });
    expect(await deleteCategory(db, cafe.id, first.id, { action: 'delete-items' })).toBe(true);
    expect(await getCategory(db, cafe.id, first.id)).toBeNull();
  });

  it('creates multiple variants atomically without mixing up item and variant ids', async () => {
    const { cafe, category, item } = await menu();
    expect(item.variants).toHaveLength(2);
    const another = await createItem(db, cafe.id, { category_id: category.id, name_ky: 'Чай', variants: [{ price: 50 }, { price: 90 }, { price: 120 }] });
    expect(another.variants.map((variant) => variant.item_id)).toEqual([another.id, another.id, another.id]);
    expect(await listVariants(db, cafe.id, item.id)).toHaveLength(2);
    expect(await listVariants(db, cafe.id, another.id)).toHaveLength(3);
    expect(await listItems(db, cafe.id, category.id)).toHaveLength(2);
    expect(await getItem(db, cafe.id, item.id)).toMatchObject({ name_ky: 'Шорпо', is_available: 1 });
    expect(await updateItem(db, cafe.id, item.id, { is_available: 0, ingredients_ky: 'Эт' })).toMatchObject({ is_available: 0, ingredients_ky: 'Эт' });
    expect(await deleteItem(db, cafe.id, another.id)).toBe(true);
    expect(await getItem(db, cafe.id, another.id)).toBeNull();
    expect(await listVariants(db, cafe.id, another.id)).toEqual([]);
  });

  it('rolls back the item if any variant violates a constraint', async () => {
    const { cafe, category } = await menu();
    await expect(createItem(db, cafe.id, { category_id: category.id, name_ky: 'Бош', variants: [] })).rejects.toThrow();
    await expect(createItem(db, cafe.id, {
      category_id: category.id, name_ky: 'Ката', variants: [{ price: 180 }, { price: 230, sort_order: 0.5 }],
    })).rejects.toThrow();
    expect(await listItems(db, cafe.id)).toHaveLength(1);
    expect((await db.prepare('SELECT count(*) AS n FROM item_variants').first<{ n: number }>())?.n).toBe(2);
  });

  it('supports variant CRUD and protects the last variant', async () => {
    const { cafe, item } = await menu();
    const variant = await createVariant(db, cafe.id, item.id, { label: "' OR 1=1 --", price: 350, sort_order: -1 });
    expect(variant).not.toBeNull();
    expect(await getVariant(db, cafe.id, item.id, variant!.id)).toEqual(variant);
    expect((await listVariants(db, cafe.id, item.id))[0].id).toBe(variant!.id);
    expect(await updateVariant(db, cafe.id, item.id, variant!.id, { price: 360 })).toMatchObject({ price: 360 });
    expect(await deleteVariant(db, cafe.id, item.id, variant!.id)).toBe(true);
    expect(await deleteVariant(db, cafe.id, item.id, item.variants[0].id)).toBe(true);
    expect(await deleteVariant(db, cafe.id, item.id, item.variants[1].id)).toBe(false);
    expect(await listVariants(db, cafe.id, item.id)).toHaveLength(1);
    expect(await createVariant(db, cafe.id, 999999, { price: 1 })).toBeNull();
  });

  it('blocks cross-cafe reads, edits, deletes, category assignment and variant creation', async () => {
    const a = await menu('cafe-one');
    const b = await menu('cafe-two');
    expect(await getCategory(db, b.cafe.id, a.category.id)).toBeNull();
    expect(await updateCategory(db, b.cafe.id, a.category.id, { name_ky: 'Чоочун' })).toBeNull();
    expect(await deleteCategory(db, b.cafe.id, a.category.id, { action: 'delete-items' })).toBe(false);
    expect(await getItem(db, b.cafe.id, a.item.id)).toBeNull();
    expect(await listItems(db, b.cafe.id, a.category.id)).toEqual([]);
    expect(await updateItem(db, b.cafe.id, a.item.id, { name_ky: 'Чоочун' })).toBeNull();
    expect(await deleteItem(db, b.cafe.id, a.item.id)).toBe(false);
    expect(await getVariant(db, b.cafe.id, a.item.id, a.item.variants[0].id)).toBeNull();
    expect(await listVariants(db, b.cafe.id, a.item.id)).toEqual([]);
    expect(await createVariant(db, b.cafe.id, a.item.id, { price: 1 })).toBeNull();
    expect(await updateVariant(db, b.cafe.id, a.item.id, a.item.variants[0].id, { price: 1 })).toBeNull();
    expect(await deleteVariant(db, b.cafe.id, a.item.id, a.item.variants[0].id)).toBe(false);
    await expect(createItem(db, b.cafe.id, { category_id: a.category.id, name_ky: 'Чоочун', variants: [{ price: 1 }] })).rejects.toThrow();
    await expect(updateItem(db, a.cafe.id, a.item.id, { category_id: b.category.id })).rejects.toThrow();
    expect(await getItem(db, a.cafe.id, a.item.id)).toMatchObject({ category_id: a.category.id, name_ky: 'Шорпо' });
  });

  it('moves category contents in one transaction and rejects an invalid destination', async () => {
    const { cafe, category, item } = await menu();
    const other = await menu('other-cafe');
    await expect(deleteCategory(db, cafe.id, category.id, { action: 'move-items', targetCategoryId: category.id })).rejects.toThrow();
    await expect(deleteCategory(db, cafe.id, category.id, { action: 'move-items', targetCategoryId: other.category.id })).rejects.toThrow();
    expect(await getCategory(db, cafe.id, category.id)).not.toBeNull();
    const destination = await createCategory(db, cafe.id, { name_ky: 'Жаңы' });
    expect(await deleteCategory(db, cafe.id, category.id, { action: 'move-items', targetCategoryId: destination.id })).toBe(true);
    expect(await getCategory(db, cafe.id, category.id)).toBeNull();
    expect(await getItem(db, cafe.id, item.id)).toMatchObject({ category_id: destination.id });
    expect(await listVariants(db, cafe.id, item.id)).toHaveLength(2);
    expect(await deleteCategory(db, cafe.id, destination.id, { action: 'delete-items' })).toBe(true);
    expect(await getItem(db, cafe.id, item.id)).toBeNull();
    expect((await db.prepare('SELECT count(*) AS n FROM item_variants WHERE item_id = ?').bind(item.id).first<{ n: number }>())?.n).toBe(0);
  });

  it('validates users, unique logins and sessions; cafe deletion cascades through all dependent tables', async () => {
    const { cafe } = await menu();
    const user = await db.prepare("INSERT INTO users (login, password_hash, role, cafe_id) VALUES (?, ?, 'owner', ?) RETURNING id")
      .bind('owner', 'test-hash', cafe.id).first<{ id: number }>();
    await expect(db.prepare("INSERT INTO users (login, password_hash, role, cafe_id) VALUES (?, ?, 'owner', ?)").bind('owner', 'test-hash', cafe.id).run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO users (login, password_hash, role) VALUES ('bad-owner', 'test-hash', 'owner')").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO users (login, password_hash, role, password_enc) VALUES ('bad-super', 'test-hash', 'superadmin', 'encrypted')").run()).rejects.toThrow();
    await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind('test-token-hash', user!.id, '2030-01-01 00:00:00').run();
    expect(await db.prepare('SELECT cafe_id FROM published_menus WHERE cafe_id = ?').bind(cafe.id).first()).not.toBeNull();
    await expect(db.prepare('INSERT INTO published_menus (cafe_id, html, version) VALUES (?, ?, ?)').bind(cafe.id, '<p>Меню</p>', 2).run()).rejects.toThrow();
    expect(await deleteCafe(db, cafe.id)).toBe(true);
    for (const table of ['users', 'sessions', 'categories', 'items', 'item_variants', 'published_menus']) {
      expect((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n).toBe(0);
    }
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
