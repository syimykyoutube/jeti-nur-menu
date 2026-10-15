import type { Context } from 'hono';
import type { AppEnv } from '../types';
import type { CafeOwnerRow } from '../db/admin';
import { t } from '../lib/i18n';
import { e, field, page } from './layout';

function createdTime(timestamp: string, lang: 'ky' | 'ru'): string {
  const date = new Date(timestamp.replace(' ', 'T') + 'Z');
  const locale = lang === 'ky' && Intl.DateTimeFormat.supportedLocalesOf('ky-KG').length ? 'ky-KG' : 'ru-RU';
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'Asia/Bishkek', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

export function superPage(c: Context<AppEnv>, cafes: CafeOwnerRow[]): string {
  const lang = c.get('lang');
  const tr = (key: string) => e(t(lang, key));
  const cards = cafes.map((cafe) => {
    const base = `/admin/super/cafes/${cafe.id}`;
    const name = lang === 'ru' ? cafe.name_ru || cafe.name_ky : cafe.name_ky;
    const output = `password-${cafe.id}`;
    const status = `password-status-${cafe.id}`;
    return `<article class="card"><div class="actions"><h2>${e(name)}</h2><span class="status${cafe.is_active ? '' : ' paused'}">${tr(cafe.is_active ? 'active' : 'paused')}</span></div>
      <p><a href="/${e(cafe.slug)}" target="_blank" rel="noopener noreferrer">/${e(cafe.slug)}</a></p>
      <p class="muted">${tr('createdAt')}: ${e(createdTime(cafe.created_at, lang))}<br>${tr('timezone')}</p>
      ${cafe.owner_id ? `<p><strong>${tr('ownerLogin')}:</strong> ${e(cafe.owner_login)}</p><strong>${tr('ownerPassword')}</strong>
      <output class="secret" id="${output}">${tr('hiddenPassword')}</output><div class="actions"><button class="secondary" type="button" data-password-url="${base}/password" data-output="${output}" data-status="${status}" data-mode="show">${tr('show')}</button><button class="secondary" type="button" data-password-url="${base}/password" data-output="${output}" data-status="${status}" data-mode="copy">${tr('copy')}</button></div><p id="${status}" role="status" class="muted"></p>
      <details><summary>${tr('credentials')}</summary><form method="post" action="${base}/credentials">
      ${field('login', t(lang, 'ownerLogin'), cafe.owner_login ?? '', 'minlength="3" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false" required')}
      ${field('password', t(lang, 'newPassword'), '', 'type="password" minlength="8" maxlength="128" autocomplete="new-password"')}
      <p class="muted">${tr('revokeHint')}</p><button>${tr('save')}</button></form></details>` : `<p>${tr('noOwner')}</p>`}
      <div class="actions"><a class="button" href="/admin/cafes/${cafe.id}">${tr('enterCafe')}</a><form method="post" action="${base}/status" ${cafe.is_active ? `data-confirm="${tr('pauseConfirm')}"` : ''}><input type="hidden" name="is_active" value="${cafe.is_active ? 0 : 1}"><button class="${cafe.is_active ? 'danger' : 'secondary'}">${tr(cafe.is_active ? 'pause' : 'resume')}</button></form></div></article>`;
  }).join('');
  return page(c, t(lang, 'superTitle'), `<h1>${tr('superTitle')}</h1>
    <section class="card"><p class="muted">${tr('totalCafes')}</p><p class="stat">${cafes.length}</p></section>
    ${c.req.query('saved') === '1' ? `<p class="notice" role="status">${tr('saved')}</p>` : ''}
    <details class="card new-cafe"><summary>${tr('newCafe')}</summary><p class="muted">${tr('manualCredentials')}</p><form method="post" action="/admin/super/cafes">
      <div class="grid">${field('name_ky', t(lang, 'nameKy'), '', 'maxlength="120" required')}${field('name_ru', t(lang, 'nameRu'), '', 'maxlength="120"')}</div>
      ${field('slug', t(lang, 'slug'), '', 'pattern="[a-z0-9\\-]{3,40}" minlength="3" maxlength="40" autocapitalize="none" spellcheck="false" required')}
      <p class="muted">${tr('slugHint')}</p>
      ${field('login', t(lang, 'ownerLogin'), '', 'minlength="3" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false" required')}
      <p class="muted">${tr('loginHint')}</p>
      ${field('password', t(lang, 'ownerPassword'), '', 'type="password" minlength="8" maxlength="128" autocomplete="new-password" required')}
      <p class="muted">${tr('passwordHint')}</p><button>${tr('createCafe')}</button></form></details>
      <section class="cafes">${cards || `<p>${tr('emptyCafes')}</p>`}</section>`);
}
