import { assertPrice } from '../lib/price';
import { isValidSlug } from '../lib/slug';
import { publishMenu, rebuildMenu } from '../lib/publish';
import type {
  Cafe, CafeInput, CafePatch, Category, CategoryInput, CategoryPatch,
  CategoryDeleteAction, Item, ItemInput, ItemPatch, ItemVariant,
  ItemWithVariants, VariantInput, VariantPatch,
} from './types';

// Identifiers come exclusively from these code-owned allowlists. Values use bind().
const cafeColumns = ['slug', 'name_ky', 'name_ru', 'logo_key', 'is_active', 'default_lang'] as const;
const categoryColumns = ['name_ky', 'name_ru', 'sort_order'] as const;
const itemColumns = ['category_id', 'name_ky', 'name_ru', 'image_key', 'ingredients_ky', 'ingredients_ru', 'is_available', 'sort_order'] as const;
const variantColumns = ['label', 'price', 'sort_order'] as const;

function patchStatement<T extends object>(
  db: D1Database,
  table: 'cafes' | 'categories' | 'items' | 'item_variants',
  columns: readonly (keyof T & string)[],
  patch: T,
  where: string,
  scope: number[],
): D1PreparedStatement | null {
  const keys = columns.filter((key) => patch[key] !== undefined);
  if (keys.length === 0) return null;
  return db.prepare(
    `UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE ${where} RETURNING *`,
  ).bind(...keys.map((key) => patch[key]), ...scope);
}

function validateSlug(slug: string): void {
  if (!isValidSlug(slug)) throw new RangeError('Slug must contain 3–40 lowercase letters, digits or hyphens');
}

export function getCafe(db: D1Database, id: number): Promise<Cafe | null> {
  return db.prepare('SELECT * FROM cafes WHERE id = ?').bind(id).first<Cafe>();
}

export function getCafeBySlug(db: D1Database, slug: string): Promise<Cafe | null> {
  return db.prepare('SELECT * FROM cafes WHERE slug = ?').bind(slug).first<Cafe>();
}

export async function listCafes(db: D1Database): Promise<Cafe[]> {
  return (await db.prepare('SELECT * FROM cafes ORDER BY id').all<Cafe>()).results;
}

export async function createCafe(db: D1Database, input: CafeInput): Promise<Cafe> {
  validateSlug(input.slug);
  const row = await db.prepare(`
    INSERT INTO cafes (slug, name_ky, name_ru, logo_key, is_active, default_lang)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).bind(input.slug, input.name_ky, input.name_ru ?? null, input.logo_key ?? null,
    input.is_active ?? 1, input.default_lang ?? 'ky').first<Cafe>();
  if (!row) throw new Error('Cafe was not created');
  await rebuildMenu(db, row.id);
  return row;
}

export async function updateCafe(db: D1Database, id: number, patch: CafePatch): Promise<Cafe | null> {
  if (patch.slug !== undefined) validateSlug(patch.slug);
  const statement = patchStatement(db, 'cafes', cafeColumns, patch, 'id = ?', [id]);
  if (!statement) return getCafe(db, id);
  await publishMenu(db, id, [statement]);
  return getCafe(db, id);
}

export async function deleteCafe(db: D1Database, id: number): Promise<boolean> {
  return (await db.prepare('DELETE FROM cafes WHERE id = ?').bind(id).run()).meta.changes > 0;
}

export function getCategory(db: D1Database, cafeId: number, id: number): Promise<Category | null> {
  return db.prepare('SELECT * FROM categories WHERE cafe_id = ? AND id = ?').bind(cafeId, id).first<Category>();
}

export async function listCategories(db: D1Database, cafeId: number): Promise<Category[]> {
  return (await db.prepare('SELECT * FROM categories WHERE cafe_id = ? ORDER BY sort_order, id')
    .bind(cafeId).all<Category>()).results;
}

export async function createCategory(db: D1Database, cafeId: number, input: CategoryInput): Promise<Category> {
  const statement = db.prepare(`
    INSERT INTO categories (cafe_id, name_ky, name_ru, sort_order)
    SELECT ?, ?, ?, COALESCE(?, COALESCE(MAX(sort_order) + 1, 0))
    FROM categories WHERE cafe_id = ? RETURNING *
  `).bind(cafeId, input.name_ky, input.name_ru ?? null, input.sort_order ?? null, cafeId);
  const { results } = await publishMenu<Category>(db, cafeId, [statement]);
  const row = results[0].results[0];
  if (!row) throw new Error('Category was not created');
  return row;
}

export async function updateCategory(db: D1Database, cafeId: number, id: number, patch: CategoryPatch): Promise<Category | null> {
  const statement = patchStatement(db, 'categories', categoryColumns, patch, 'cafe_id = ? AND id = ?', [cafeId, id]);
  if (!statement) return getCategory(db, cafeId, id);
  const { results } = await publishMenu<Category>(db, cafeId, [statement]);
  return results[0].results[0] ?? null;
}

/** The caller must explicitly choose what happens to the category's items. */
export async function deleteCategory(db: D1Database, cafeId: number, id: number, choice: CategoryDeleteAction): Promise<boolean> {
  let contents: D1PreparedStatement;
  if (choice.action === 'move-items') {
    if (choice.targetCategoryId === id || !await getCategory(db, cafeId, choice.targetCategoryId)) {
      throw new RangeError('Target must be another category of the same cafe');
    }
    contents = db.prepare('UPDATE items SET category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE cafe_id = ? AND category_id = ?')
      .bind(choice.targetCategoryId, cafeId, id);
  } else if (choice.action === 'delete-items') {
    contents = db.prepare('DELETE FROM items WHERE cafe_id = ? AND category_id = ?').bind(cafeId, id);
  } else {
    throw new RangeError('Choose whether to delete or move the items');
  }
  const { results } = await publishMenu(db, cafeId, [
    contents,
    db.prepare('DELETE FROM categories WHERE cafe_id = ? AND id = ? RETURNING id').bind(cafeId, id),
  ]);
  return results[1].results.length > 0;
}

export function getItem(db: D1Database, cafeId: number, id: number): Promise<Item | null> {
  return db.prepare('SELECT * FROM items WHERE cafe_id = ? AND id = ?').bind(cafeId, id).first<Item>();
}

export async function listItems(db: D1Database, cafeId: number, categoryId?: number): Promise<Item[]> {
  const statement = categoryId === undefined
    ? db.prepare('SELECT * FROM items WHERE cafe_id = ? ORDER BY sort_order, id').bind(cafeId)
    : db.prepare('SELECT * FROM items WHERE cafe_id = ? AND category_id = ? ORDER BY sort_order, id').bind(cafeId, categoryId);
  return (await statement.all<Item>()).results;
}

/** D1 batch is a transaction: an invalid variant rolls back the new item too. */
export async function createItem(db: D1Database, cafeId: number, input: ItemInput): Promise<ItemWithVariants> {
  validateVariants(input.variants);
  const variants = input.variants.map((variant) => {
    assertPrice(variant.price);
    return { label: variant.label ?? '', price: variant.price, sort_order: variant.sort_order ?? 0 };
  });
  const { results } = await publishMenu(db, cafeId, [
    db.prepare(`
      INSERT INTO items (cafe_id, category_id, name_ky, name_ru, image_key, ingredients_ky, ingredients_ru, is_available, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).bind(cafeId, input.category_id, input.name_ky, input.name_ru ?? null, input.image_key ?? null,
      input.ingredients_ky ?? null, input.ingredients_ru ?? null, input.is_available ?? 1, input.sort_order ?? 0),
    // Capture the new item's id once, before variant inserts change last_insert_rowid().
    db.prepare(`
      WITH new_item AS MATERIALIZED (SELECT last_insert_rowid() AS id)
      INSERT INTO item_variants (item_id, label, price, sort_order)
      SELECT new_item.id, json_extract(value, '$.label'), json_extract(value, '$.price'), json_extract(value, '$.sort_order')
      FROM new_item, json_each(?) RETURNING *
    `).bind(JSON.stringify(variants)),
  ]);
  return { ...results[0].results[0] as Item, variants: results[1].results as ItemVariant[] };
}

export async function updateItem(db: D1Database, cafeId: number, id: number, patch: ItemPatch): Promise<Item | null> {
  const statement = patchStatement(db, 'items', itemColumns, patch, 'cafe_id = ? AND id = ?', [cafeId, id]);
  if (!statement) return getItem(db, cafeId, id);
  const { results } = await publishMenu<Item>(db, cafeId, [statement]);
  return results[0].results[0] ?? null;
}

export async function deleteItem(db: D1Database, cafeId: number, id: number): Promise<boolean> {
  const { results } = await publishMenu(db, cafeId, [db.prepare('DELETE FROM items WHERE cafe_id = ? AND id = ?').bind(cafeId, id)]);
  return results[0].meta.changes > 0;
}

const variantScope = 'item_id = ? AND id = ? AND EXISTS (SELECT 1 FROM items WHERE id = item_variants.item_id AND cafe_id = ?)';

export function getVariant(db: D1Database, cafeId: number, itemId: number, id: number): Promise<ItemVariant | null> {
  return db.prepare(`SELECT * FROM item_variants WHERE ${variantScope}`).bind(itemId, id, cafeId).first<ItemVariant>();
}

export async function listVariants(db: D1Database, cafeId: number, itemId: number): Promise<ItemVariant[]> {
  return (await db.prepare(`
    SELECT v.* FROM item_variants v JOIN items i ON i.id = v.item_id
    WHERE i.cafe_id = ? AND v.item_id = ? ORDER BY v.sort_order, v.id
  `).bind(cafeId, itemId).all<ItemVariant>()).results;
}

export async function createVariant(db: D1Database, cafeId: number, itemId: number, input: VariantInput): Promise<ItemVariant | null> {
  assertPrice(input.price);
  const statement = db.prepare(`
    INSERT INTO item_variants (item_id, label, price, sort_order)
    SELECT id, ?, ?, ? FROM items WHERE cafe_id = ? AND id = ? RETURNING *
  `).bind(input.label ?? '', input.price, input.sort_order ?? 0, cafeId, itemId);
  const { results } = await publishMenu<ItemVariant>(db, cafeId, [statement]);
  return results[0].results[0] ?? null;
}

export async function updateVariant(db: D1Database, cafeId: number, itemId: number, id: number, patch: VariantPatch): Promise<ItemVariant | null> {
  if (patch.price !== undefined) assertPrice(patch.price);
  const statement = patchStatement(db, 'item_variants', variantColumns, patch, variantScope, [itemId, id, cafeId]);
  if (!statement) return getVariant(db, cafeId, itemId, id);
  const { results } = await publishMenu<ItemVariant>(db, cafeId, [statement]);
  return results[0].results[0] ?? null;
}

/** Returns false for a missing variant, a different cafe, or the item's last variant. */
export async function deleteVariant(db: D1Database, cafeId: number, itemId: number, id: number): Promise<boolean> {
  const statement = db.prepare(`
    DELETE FROM item_variants WHERE ${variantScope}
    AND (SELECT count(*) FROM item_variants WHERE item_id = ?) > 1
  `).bind(itemId, id, cafeId, itemId);
  const { results } = await publishMenu(db, cafeId, [statement]);
  return results[0].meta.changes > 0;
}

export function validateVariants(variants: readonly VariantInput[]): void {
  if (variants.length < 1 || variants.length > 50) throw new RangeError('An item needs 1–50 variants');
  for (const variant of variants) {
    assertPrice(variant.price);
    if ((variant.label ?? '').length > 40) throw new RangeError('Variant label is too long');
  }
}

export async function listCafeVariants(db: D1Database, cafeId: number): Promise<ItemVariant[]> {
  return (await db.prepare(`
    SELECT v.* FROM item_variants v JOIN items i ON i.id = v.item_id
    WHERE i.cafe_id = ? ORDER BY v.sort_order, v.id
  `).bind(cafeId).all<ItemVariant>()).results;
}

/** Save the item and its complete variant list, keeping at least one, atomically. */
export async function updateItemWithVariants(db: D1Database, cafeId: number, id: number, patch: ItemPatch, variants: readonly VariantInput[]): Promise<ItemWithVariants | null> {
  validateVariants(variants);
  const statement = patchStatement(db, 'items', itemColumns, patch, 'cafe_id = ? AND id = ?', [cafeId, id])
    ?? db.prepare('SELECT * FROM items WHERE cafe_id = ? AND id = ?').bind(cafeId, id);
  const values = variants.map((variant, position) => ({ label: variant.label ?? '', price: variant.price, sort_order: position }));
  const { results } = await publishMenu(db, cafeId, [
    statement,
    db.prepare(`DELETE FROM item_variants WHERE item_id = ? AND EXISTS (SELECT 1 FROM items WHERE id = ? AND cafe_id = ?)`).bind(id, id, cafeId),
    db.prepare(`
      INSERT INTO item_variants (item_id, label, price, sort_order)
      SELECT i.id, json_extract(v.value, '$.label'), json_extract(v.value, '$.price'), json_extract(v.value, '$.sort_order')
      FROM items i, json_each(?) v WHERE i.id = ? AND i.cafe_id = ? RETURNING *
    `).bind(JSON.stringify(values), id, cafeId),
  ]);
  const item = results[0].results[0] as Item | undefined;
  return item ? { ...item, variants: results[2].results as ItemVariant[] } : null;
}

/** Explicit desired state makes retries safe: repeating the request is a no-op. */
export async function setItemAvailability(db: D1Database, cafeId: number, id: number, available: 0 | 1): Promise<Item | null> {
  const { results } = await publishMenu<Item>(db, cafeId, [
    db.prepare(`UPDATE items SET is_available = ?, updated_at = CURRENT_TIMESTAMP
      WHERE cafe_id = ? AND id = ? AND is_available <> ? RETURNING *`).bind(available, cafeId, id, available),
  ]);
  return results[0].results[0] ?? getItem(db, cafeId, id);
}

/** Re-rank from one SQL snapshot, including old data where sort_order values tie. */
export async function moveCategory(db: D1Database, cafeId: number, id: number, direction: 'up' | 'down'): Promise<boolean> {
  if (direction !== 'up' && direction !== 'down') throw new RangeError('Invalid direction');
  const { results } = await publishMenu(db, cafeId, [
    db.prepare(`
      WITH ordered AS MATERIALIZED (
        SELECT id, row_number() OVER (ORDER BY sort_order, id) - 1 AS position
        FROM categories WHERE cafe_id = ?
      ), target AS (SELECT position FROM ordered WHERE id = ?),
      neighbor AS (SELECT id, position FROM ordered WHERE position = (SELECT position FROM target) + ?)
      UPDATE categories SET sort_order = CASE
        WHEN id = ? THEN (SELECT position FROM neighbor)
        WHEN id = (SELECT id FROM neighbor) THEN (SELECT position FROM target)
        ELSE (SELECT position FROM ordered WHERE ordered.id = categories.id) END,
        updated_at = CURRENT_TIMESTAMP
      WHERE cafe_id = ? AND EXISTS (SELECT 1 FROM neighbor)
    `).bind(cafeId, id, direction === 'up' ? -1 : 1, id, cafeId),
  ]);
  return results[0].meta.changes > 0;
}
