import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { t } from '../lib/i18n';
import { e, field, page } from './layout';

export function loginPage(c: Context<AppEnv>, setup = false, error?: string): string {
  const lang = c.get('lang');
  const tr = (key: string) => e(t(lang, key));
  const title = setup ? 'setupTitle' : 'loginTitle';
  return page(c, t(lang, title), `<section class="auth card"><h1>${tr(title)}</h1>
    ${setup ? `<p class="muted">${tr('setupHint')}</p>` : ''}
    ${c.req.query('created') === '1' ? `<p class="notice" role="status">${tr('created')}</p>` : ''}
    ${error ? `<p class="notice error" role="alert">${tr(error)}</p>` : ''}
    <form method="post" action="/admin/${setup ? 'setup' : 'login'}?lang=${lang}">
    ${field('login', t(lang, 'login'), '', 'autocomplete="username" minlength="3" maxlength="40" autocapitalize="none" spellcheck="false" required')}
    ${field('password', t(lang, 'password'), '', 'type="password" autocomplete="current-password" maxlength="128" required')}
    <button class="full">${tr(setup ? 'setup' : 'signIn')}</button></form></section>`);
}
