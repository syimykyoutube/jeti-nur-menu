import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { t } from '../lib/i18n';
import { e, field, page } from './layout';
import { imageUploadField } from './upload';

export function settingsPage(c: Context<AppEnv>, values: { name_ky: string; name_ru: string | null; default_lang: string; logo_key: string | null }, error?: string): string {
  const lang = c.get('lang');
  const tr = (key: string) => e(t(lang, key));
  const base = `/admin/cafes/${c.get('cafe').id}`;
  return page(c, t(lang, 'cafeSettings'), `<section class="item-editor"><p><a href="${base}">← ${tr('cancel')}</a></p><h1>${tr('cafeSettings')}</h1>
    ${error ? `<p class="notice error" role="alert">${tr(error)}</p>` : ''}${c.req.query('saved') === '1' ? `<p class="notice" role="status">${tr('saved')}</p>` : ''}
    <form class="card" method="post" action="${base}/settings">
    ${field('name_ky', t(lang, 'nameKy'), values.name_ky, 'maxlength="120" required')}${field('name_ru', t(lang, 'nameRu'), values.name_ru ?? '', 'maxlength="120"')}
    <label>${tr('defaultLanguage')}<select name="default_lang"><option value="ky" ${values.default_lang === 'ky' ? 'selected' : ''}>${tr('langKy')}</option><option value="ru" ${values.default_lang === 'ru' ? 'selected' : ''}>${tr('langRu')}</option></select></label>
    ${imageUploadField(c, 'logo', values.logo_key ?? '')}<div class="actions editor-actions"><button>${tr('save')}</button></div></form></section>`);
}
