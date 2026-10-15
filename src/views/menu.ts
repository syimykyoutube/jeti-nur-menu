import type { Context } from 'hono';
import type { AppEnv } from '../types';
import type { Category, Item, ItemVariant } from '../db/types';
import { t } from '../lib/i18n';
import { formatPrice } from '../lib/price';
import { e, field, page } from './layout';
import { ownerDataAttributes } from './item';
import { menuScript } from './menu-script';

export function menuPage(c: Context<AppEnv>, categories: Category[], items: Item[], variants: ItemVariant[], error?: string): string {
  const cafe = c.get('cafe');
  const lang = c.get('lang');
  const tr = (key: string) => e(t(lang, key));
  const base = `/admin/cafes/${cafe.id}`;
  const names = (ky = '', ru = '') => `<div class="grid">${field('name_ky', t(lang, 'nameKy'), ky, 'maxlength="120" required')}${field('name_ru', t(lang, 'nameRu'), ru, 'maxlength="120"')}</div>`;
  const sections = categories.map((category, position) => {
    const categoryName = lang === 'ru' ? category.name_ru || category.name_ky : category.name_ky;
    const moveOptions = categories.filter((row) => row.id !== category.id).map((row) => `<option value="${row.id}">${e(lang === 'ru' ? row.name_ru || row.name_ky : row.name_ky)}</option>`).join('');
    const categoryItems = items.filter((item) => item.category_id === category.id);
    return `<section class="card category-card" id="category-${category.id}"><div class="category-heading"><h2>${e(categoryName)}</h2><form class="actions" method="post" action="${base}/categories/${category.id}/move"><button class="secondary" name="direction" value="up" ${position === 0 ? 'disabled' : ''} aria-label="${e(categoryName)}: ${tr('up')}">↑ ${tr('up')}</button><button class="secondary" name="direction" value="down" ${position === categories.length - 1 ? 'disabled' : ''} aria-label="${e(categoryName)}: ${tr('down')}">↓ ${tr('down')}</button></form></div>
    <details><summary>${tr('editCategory')}</summary><form method="post" action="${base}/categories/${category.id}">${names(category.name_ky, category.name_ru ?? '')}<button>${tr('save')}</button></form></details>
    <div class="item-list">${categoryItems.map((item) => {
      const name = lang === 'ru' ? item.name_ru || item.name_ky : item.name_ky;
      const prices = variants.filter((variant) => variant.item_id === item.id).map((variant) => `${variant.label ? e(variant.label) + ' — ' : ''}${e(formatPrice(variant.price, lang))}`).join('<br>');
      return `<article class="menu-item${item.is_available ? '' : ' sold-out'}" id="item-${item.id}" data-item-row><div class="item-heading"><div class="item-summary"><h3>${e(name)}</h3>${item.image_key ? `<img class="dish-thumb" src="/img/${e(item.image_key)}" alt="" width="80" height="80" loading="lazy" decoding="async">` : ''}<p class="muted item-prices">${prices}</p><span class="status" data-availability-badge>${tr(item.is_available ? 'available' : 'soldOut')}</span></div>
      <form method="post" action="${base}/items/${item.id}/availability" data-availability><span class="toggle-caption muted">${tr('availabilityQuestion')}</span><input type="hidden" name="is_available" value="${item.is_available ? 0 : 1}"><button type="submit" class="availability-toggle" role="switch" aria-checked="${!item.is_available}" aria-label="${e(name)}: ${tr('availabilityQuestion')}"><span data-toggle-state>${tr(item.is_available ? 'no' : 'soldOut')}</span></button></form></div>
      <div class="actions"><a class="button secondary" href="${base}/items/${item.id}/edit">${tr('edit')}</a></div><p class="item-feedback muted" data-item-status role="status" aria-live="polite"></p></article>`;
    }).join('') || `<p class="muted">${tr('noItems')}</p>`}</div>
    <a class="button secondary full" href="${base}/items/new?category_id=${category.id}">${tr('newItem')}</a>
    <details class="category-delete"><summary>${tr('deleteCategory')}</summary><p class="muted">${tr('categoryDeleteHint')}</p><form method="post" action="${base}/categories/${category.id}/delete" data-confirm="${tr('deleteConfirm')}"><label>${tr('chooseAction')}<select name="action" data-delete-action required><option value="">${tr('choose')}</option><option value="delete-items">${tr('deleteItems')}</option><option value="move-items">${tr('moveItems')}</option></select></label><label data-destination>${tr('destination')}<select name="target_category_id"><option value="">${tr('choose')}</option>${moveOptions}</select></label><button class="danger">${tr('deleteCategory')}</button></form></details></section>`;
  }).join('');
  const name = lang === 'ru' ? cafe.name_ru || cafe.name_ky : cafe.name_ky;
  return page(c, t(lang, 'menu'), `<section data-owner-ui ${ownerDataAttributes(c)}>${c.get('user').role === 'superadmin' ? `<p><a href="/admin/super">← ${tr('backSuper')}</a></p>` : ''}${cafe.logo_key ? `<img class="cafe-logo" src="/img/${e(cafe.logo_key)}" alt="" width="80" height="80" decoding="async">` : ''}<h1>${e(name)}</h1><p>${tr('menu')}</p><p><a href="/${e(cafe.slug)}" target="_blank" rel="noopener noreferrer">${tr('publicMenu')}: /${e(cafe.slug)}</a></p>
    ${c.req.query('saved') === '1' ? `<p class="notice" role="status">${tr('saved')}</p>` : ''}${error ? `<p class="notice error" role="alert">${tr(error)}</p>` : ''}
    <p><a class="button secondary full" href="${base}/settings">${tr('cafeSettings')}</a></p><p><a class="button secondary full" href="${base}/qr">${tr('qrTitle')}</a></p>
    <details class="card"><summary>${tr('newCategory')}</summary><form method="post" action="${base}/categories">${names()}<button>${tr('newCategory')}</button></form></details>
    ${categories.length ? `<p><a class="button full" href="${base}/items/new">${tr('newItem')}</a></p>` : `<p class="muted">${tr('noCategories')}</p>`}${sections}</section>`, menuScript);
}
