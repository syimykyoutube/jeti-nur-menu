import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { validateName } from '../db/admin';
import {
  updateCafe, createCategory, updateCategory, deleteCategory, moveCategory, listCategories, getCategory,
  createItem, updateItemWithVariants, deleteItem, getItem, listItems, setItemAvailability,
  createVariant, updateVariant, deleteVariant, getVariant, listVariants, listCafeVariants, getCafe,
} from '../db/queries';
import { AppError } from '../lib/errors';
import { readItemValues, validateItemValues, validateVariant, type ItemFormValues, MAX_VARIANTS } from '../lib/menu-validation';
import { parseId, requireCafeAccess } from '../lib/middleware';
import { menuPage } from '../views/menu';
import { itemFormPage, itemValues } from '../views/item';
import { readForm, text } from './forms';
import { cleanupImages, validateImageReference } from '../lib/images';
import { settingsPage } from '../views/settings';
import { qrPage } from '../views/qr';
import { createQr, menuUrl, qrSvg, qrPng } from '../lib/qr';

export const menuRoutes = new Hono<AppEnv>();
menuRoutes.use('*', requireCafeAccess);
menuRoutes.use('*', async (c, next) => {
  await next();
  if (c.req.method === 'POST' && c.res.status < 400) {
    // Image references and retirement markers commit together. Retry queued R2 failures later.
    await cleanupImages(c.env, c.get('cafe').id).catch(() => {});
  }
});

function optionalName(value: string): string | null {
  return value.trim() ? validateName(value) : null;
}

async function dashboard(c: Context<AppEnv>) {
  const id = c.get('cafe').id;
  const [categories, items, variants] = await Promise.all([
    listCategories(c.env.DB, id), listItems(c.env.DB, id), listCafeVariants(c.env.DB, id),
  ]);
  return c.html(menuPage(c, categories, items, variants));
}

menuRoutes.get('/', dashboard);
menuRoutes.get('/qr', (c) => c.html(qrPage(c)));
menuRoutes.get('/qr.svg', (c) => {
  const cafe = c.get('cafe');
  c.header('Content-Type', 'image/svg+xml; charset=utf-8');
  c.header('Content-Disposition', `${c.req.query('preview') === '1' ? 'inline' : 'attachment'}; filename="jeti-nur-${cafe.slug}-qr.svg"`);
  return c.body(qrSvg(createQr(menuUrl(c.req.url, cafe.slug))));
});
menuRoutes.get('/qr.png', async (c) => {
  const cafe = c.get('cafe');
  c.header('Content-Type', 'image/png');
  c.header('Content-Disposition', `attachment; filename="jeti-nur-${cafe.slug}-qr.png"`);
  return c.body(await qrPng(createQr(menuUrl(c.req.url, cafe.slug))));
});
menuRoutes.get('/settings', (c) => c.html(settingsPage(c, c.get('cafe'))));
menuRoutes.post('/settings', async (c) => {
  const form = await readForm(c);
  const cafe = c.get('cafe');
  const values = { name_ky: text(form, 'name_ky'), name_ru: text(form, 'name_ru'), default_lang: text(form, 'default_lang'), logo_key: text(form, 'logo_key') };
  try {
    const name_ky = validateName(values.name_ky);
    const name_ru = optionalName(values.name_ru);
    if (values.default_lang !== 'ky' && values.default_lang !== 'ru') throw new AppError(400, 'invalidForm');
    const logo_key = await validateImageReference(c.env, cafe.id, 'logo', values.logo_key, cafe.logo_key);
    await updateCafe(c.env.DB, cafe.id, { name_ky, name_ru, default_lang: values.default_lang, logo_key });
    return c.redirect(`/admin/cafes/${cafe.id}/settings?saved=1`, 303);
  } catch (error) {
    if (error instanceof AppError && error.status === 400) return c.html(settingsPage(c, values, error.key), 400);
    throw error;
  }
});

menuRoutes.get('/items/new', async (c) => {
  const categories = await listCategories(c.env.DB, c.get('cafe').id);
  if (!categories.length) return c.redirect(`/admin/cafes/${c.get('cafe').id}`, 303);
  const chosen = c.req.query('category_id');
  const values: ItemFormValues = {
    name_ky: '', name_ru: '', ingredients_ky: '', ingredients_ru: '', is_available: 1,
    category_id: categories.some((category) => String(category.id) === chosen) ? chosen! : String(categories[0].id),
    variants: [{ label: '', price: '' }],
  };
  return c.html(itemFormPage(c, categories, values));
});

menuRoutes.get('/items/:itemId/edit', async (c) => {
  const cafeId = c.get('cafe').id;
  const item = await getItem(c.env.DB, cafeId, parseId(c.req.param('itemId')));
  if (!item) throw new AppError(404, 'notFound');
  const [categories, variants] = await Promise.all([listCategories(c.env.DB, cafeId), listVariants(c.env.DB, cafeId, item.id)]);
  return c.html(itemFormPage(c, categories, itemValues(item, variants), item.id));
});

menuRoutes.post('/categories', async (c) => {
  const form = await readForm(c);
  const row = await createCategory(c.env.DB, c.get('cafe').id, {
    name_ky: validateName(text(form, 'name_ky')), name_ru: optionalName(text(form, 'name_ru')),
  });
  return c.redirect(`/admin/cafes/${c.get('cafe').id}?saved=1#category-${row.id}`, 303);
});

menuRoutes.post('/categories/:categoryId', async (c) => {
  const form = await readForm(c);
  const row = await updateCategory(c.env.DB, c.get('cafe').id, parseId(c.req.param('categoryId')), {
    name_ky: validateName(text(form, 'name_ky')), name_ru: optionalName(text(form, 'name_ru')),
  });
  if (!row) throw new AppError(404, 'notFound');
  return c.redirect(`/admin/cafes/${c.get('cafe').id}?saved=1#category-${row.id}`, 303);
});

menuRoutes.post('/categories/:categoryId/move', async (c) => {
  const form = await readForm(c);
  const direction = text(form, 'direction');
  if (direction !== 'up' && direction !== 'down') throw new AppError(400, 'invalidForm');
  const id = parseId(c.req.param('categoryId'));
  const cafeId = c.get('cafe').id;
  if (!await getCategory(c.env.DB, cafeId, id)) throw new AppError(404, 'notFound');
  const moved = await moveCategory(c.env.DB, cafeId, id, direction);
  return c.redirect(`/admin/cafes/${cafeId}${moved ? '?saved=1' : ''}#category-${id}`, 303);
});

menuRoutes.post('/categories/:categoryId/delete', async (c) => {
  const form = await readForm(c);
  const cafeId = c.get('cafe').id;
  const categoryId = parseId(c.req.param('categoryId'));
  const action = text(form, 'action');
  if (action !== 'move-items' && action !== 'delete-items') throw new AppError(400, 'invalidForm');
  const target = text(form, 'target_category_id');
  if (action === 'move-items' && !/^[1-9][0-9]*$/.test(target)) throw new AppError(400, 'invalidDestination');
  const targetId = action === 'move-items' ? parseId(target) : undefined;
  if (targetId !== undefined && (targetId === categoryId || !await getCategory(c.env.DB, cafeId, targetId))) throw new AppError(400, 'invalidDestination');
  const removed = await deleteCategory(c.env.DB, cafeId, categoryId, action === 'delete-items' ? { action } : { action, targetCategoryId: targetId! });
  if (!removed) throw new AppError(404, 'notFound');
  return c.redirect(`/admin/cafes/${cafeId}?saved=1`, 303);
});

menuRoutes.post('/items', async (c) => {
  const form = await readForm(c);
  const cafeId = c.get('cafe').id;
  const values = readItemValues(form);
  try {
    const input = validateItemValues(values);
    if (!await getCategory(c.env.DB, cafeId, input.category_id)) throw new AppError(403, 'forbidden');
    input.image_key = await validateImageReference(c.env, cafeId, 'item', values.image_key ?? '');
    const item = await createItem(c.env.DB, cafeId, input);
    return c.redirect(`/admin/cafes/${cafeId}?saved=1#item-${item.id}`, 303);
  } catch (error) {
    if (error instanceof AppError && error.status === 400) return c.html(itemFormPage(c, await listCategories(c.env.DB, cafeId), values, undefined, error.key), 400);
    throw error;
  }
});

menuRoutes.post('/items/:itemId', async (c) => {
  const cafeId = c.get('cafe').id;
  const itemId = parseId(c.req.param('itemId'));
  const item = await getItem(c.env.DB, cafeId, itemId);
  if (!item) throw new AppError(404, 'notFound');
  const form = await readForm(c);
  const previous = itemValues(item, await listVariants(c.env.DB, cafeId, itemId));
  const values = readItemValues(form, previous);
  try {
    const { variants, ...patch } = validateItemValues(values);
    if (!await getCategory(c.env.DB, cafeId, patch.category_id)) throw new AppError(403, 'forbidden');
    patch.image_key = await validateImageReference(c.env, cafeId, 'item', values.image_key ?? '', item.image_key);
    if (!await updateItemWithVariants(c.env.DB, cafeId, itemId, patch, variants)) throw new AppError(404, 'notFound');
    return c.redirect(`/admin/cafes/${cafeId}?saved=1#item-${itemId}`, 303);
  } catch (error) {
    if (error instanceof AppError && error.status === 400) return c.html(itemFormPage(c, await listCategories(c.env.DB, cafeId), values, itemId, error.key), 400);
    throw error;
  }
});

menuRoutes.post('/items/:itemId/availability', async (c) => {
  const form = await readForm(c);
  const value = text(form, 'is_available');
  if (value !== '0' && value !== '1') throw new AppError(400, 'invalidForm');
  const cafeId = c.get('cafe').id;
  const item = await setItemAvailability(c.env.DB, cafeId, parseId(c.req.param('itemId')), value === '1' ? 1 : 0);
  if (!item) throw new AppError(404, 'notFound');
  if (c.req.header('Accept')?.includes('application/json')) {
    const cafe = await getCafe(c.env.DB, cafeId);
    return c.json({ is_available: item.is_available, menu_version: cafe!.menu_version });
  }
  return c.redirect(`/admin/cafes/${cafeId}?saved=1#item-${item.id}`, 303);
});

menuRoutes.post('/items/:itemId/delete', async (c) => {
  if (!await deleteItem(c.env.DB, c.get('cafe').id, parseId(c.req.param('itemId')))) throw new AppError(404, 'notFound');
  return c.redirect(`/admin/cafes/${c.get('cafe').id}?saved=1`, 303);
});

menuRoutes.post('/items/:itemId/variants', async (c) => {
  const form = await readForm(c);
  const cafeId = c.get('cafe').id;
  const id = parseId(c.req.param('itemId'));
  const input = validateVariant(text(form, 'label'), text(form, 'price'));
  const variants = await listVariants(c.env.DB, cafeId, id);
  if (variants.length >= MAX_VARIANTS) throw new AppError(400, 'tooManyVariants');
  const row = await createVariant(c.env.DB, cafeId, id, input);
  if (!row) throw new AppError(404, 'notFound');
  return c.redirect(`/admin/cafes/${cafeId}/items/${id}/edit?saved=1`, 303);
});

menuRoutes.post('/items/:itemId/variants/:variantId', async (c) => {
  const form = await readForm(c);
  const row = await updateVariant(c.env.DB, c.get('cafe').id, parseId(c.req.param('itemId')), parseId(c.req.param('variantId')), validateVariant(text(form, 'label'), text(form, 'price')));
  if (!row) throw new AppError(404, 'notFound');
  return c.redirect(`/admin/cafes/${c.get('cafe').id}/items/${row.item_id}/edit?saved=1`, 303);
});

menuRoutes.post('/items/:itemId/variants/:variantId/delete', async (c) => {
  const cafeId = c.get('cafe').id;
  const itemId = parseId(c.req.param('itemId'));
  const variantId = parseId(c.req.param('variantId'));
  if (!await getVariant(c.env.DB, cafeId, itemId, variantId)) throw new AppError(404, 'notFound');
  if (!await deleteVariant(c.env.DB, cafeId, itemId, variantId)) throw new AppError(400, 'lastVariant');
  return c.redirect(`/admin/cafes/${cafeId}/items/${itemId}/edit?saved=1`, 303);
});
