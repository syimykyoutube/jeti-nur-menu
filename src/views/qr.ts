import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { t } from '../lib/i18n';
import { isLocalMenuUrl, menuUrl } from '../lib/qr';
import { e, page } from './layout';

export function qrPage(c: Context<AppEnv>): string {
  const cafe = c.get('cafe');
  const lang = c.get('lang');
  const tr = (key: string) => e(t(lang, key));
  const base = `/admin/cafes/${cafe.id}`;
  const url = menuUrl(c.req.url, cafe.slug);
  return page(c, t(lang, 'qrTitle'), `<section class="item-editor"><p><a href="${base}">← ${tr('cancel')}</a></p><h1>${tr('qrTitle')}</h1>
    <div class="card"><h2>${e(lang === 'ru' ? cafe.name_ru || cafe.name_ky : cafe.name_ky)}</h2>
    <p>${tr('qrLink')}</p><p class="qr-link"><a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(url)}</a></p>
    ${isLocalMenuUrl(url) ? `<p class="notice">${tr('qrLocalNotice')}</p>` : ''}${cafe.is_active ? '' : `<p class="notice error">${tr('qrPaused')}</p>`}
    <img class="qr-preview" src="${base}/qr.svg?preview=1" alt="${tr('qrImage')}" width="288" height="288" decoding="async">
    <p class="muted">${tr('qrPrintHint')}</p><div class="stack"><a class="button full" href="${base}/qr.svg" download="jeti-nur-${e(cafe.slug)}-qr.svg">${tr('qrDownloadSvg')}</a>
    <a class="button secondary full" href="${base}/qr.png" download="jeti-nur-${e(cafe.slug)}-qr.png">${tr('qrDownloadPng')}</a></div>
    <p class="muted">${tr('qrDomainHint')}</p></div></section>`);
}
