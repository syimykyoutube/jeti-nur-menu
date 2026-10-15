import type { Context } from 'hono';
import type { AppEnv } from '../types';
import type { Category, Item, ItemVariant } from '../db/types';
import { MAX_VARIANTS, type ItemFormValues } from '../lib/menu-validation';
import { t } from '../lib/i18n';
import { e, field, page } from './layout';
import { menuScript } from './menu-script';
import { imageUploadField } from './upload';

export function itemValues(item: Item, variants: ItemVariant[]): ItemFormValues {
  return {
    image_key: item.image_key ?? '',
    name_ky: item.name_ky, name_ru: item.name_ru ?? '', category_id: String(item.category_id),
    ingredients_ky: item.ingredients_ky ?? '', ingredients_ru: item.ingredients_ru ?? '', is_available: item.is_available,
    variants: variants.map((variant) => ({ label: variant.label, price: String(variant.price) })),
  };
}

export function ownerDataAttributes(c: Context<AppEnv>): string {
  return ['soldOut', 'no', 'available', 'saving', 'sessionExpired', 'requestFailed', 'availabilitySaved', 'tooManyVariants'].map((key) =>
    `data-${key.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())}="${e(t(c.get('lang'), key))}"`,
  ).join(' ');
}

export function itemFormPage(c: Context<AppEnv>, categories: Category[], values: ItemFormValues, itemId?: number, error?: string): string {
  const lang = c.get('lang');
  const tr = (key: string) => e(t(lang, key));
  const base = `/admin/cafes/${c.get('cafe').id}`;
  const variantRow = (label = '', price = '') => `<fieldset class="variant" data-variant-row><legend>${tr('variant')}</legend><div class="grid">${field('variant_label', t(lang, 'variant'), label, 'maxlength="40"')}${field('variant_price', t(lang, 'price'), price, 'type="number" min="0" max="9007199254740991" step="1" inputmode="numeric" required')}</div><button type="button" class="secondary" data-remove-variant>${tr('removeVariantRow')}</button></fieldset>`;
  const options = categories.map((category) => `<option value="${category.id}" ${String(category.id) === values.category_id ? 'selected' : ''}>${e(lang === 'ru' ? category.name_ru || category.name_ky : category.name_ky)}</option>`).join('');
  return page(c, t(lang, itemId ? 'editItem' : 'newItem'), `<section class="item-editor" data-owner-ui ${ownerDataAttributes(c)}><p><a href="${base}">← ${tr('cancel')}</a></p><h1>${tr(itemId ? 'editItem' : 'newItem')}</h1>
    ${error ? `<p class="notice error" role="alert">${tr(error)}</p>` : ''}
    <form class="card" method="post" action="${base}/items${itemId ? '/' + itemId : ''}" data-item-form data-max-variants="${MAX_VARIANTS}">
    <input type="hidden" name="variants_form" value="1">
    <div class="grid">${field('name_ky', t(lang, 'nameKy'), values.name_ky, 'maxlength="120" required')}${field('name_ru', t(lang, 'nameRu'), values.name_ru, 'maxlength="120"')}</div>
    <label>${tr('category')}<select name="category_id" required><option value="">${tr('choose')}</option>${options}</select></label>
    ${imageUploadField(c, 'item', values.image_key ?? '')}
    <label>${tr('ingredientsKy')}<textarea name="ingredients_ky" maxlength="2000">${e(values.ingredients_ky)}</textarea></label>
    <label>${tr('ingredientsRu')}<textarea name="ingredients_ru" maxlength="2000">${e(values.ingredients_ru)}</textarea></label>
    <label>${tr('availabilityLabel')}<select name="is_available"><option value="1" ${values.is_available ? 'selected' : ''}>${tr('available')}</option><option value="0" ${values.is_available ? '' : 'selected'}>${tr('soldOut')}</option></select></label>
    <h2>${tr('variants')}</h2><p class="muted">${tr('variantsHint')}</p><div data-variant-list>${(values.variants.length ? values.variants : [{ label: '', price: '' }]).map((variant) => variantRow(variant.label, variant.price)).join('')}</div>
    <template data-variant-template>${variantRow()}</template><button type="button" class="secondary" data-add-variant>${tr('addVariant')}</button><p role="status" data-variant-status></p>
    <div class="actions editor-actions"><button>${tr('save')}</button><a class="button secondary" href="${base}">${tr('cancel')}</a></div></form>
    ${itemId ? `<form method="post" action="${base}/items/${itemId}/delete" data-confirm="${tr('deleteConfirm')}"><button class="danger full">${tr('deleteItem')}</button></form>` : ''}</section>`, menuScript);
}
