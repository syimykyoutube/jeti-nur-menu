import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../types';
import { hasSuperadmin, setupConfigured, setupSuperadmin } from '../db/admin';
import { clearSessionCookie, getSession, login, logout, readSessionCookie, writeSessionCookie } from '../lib/auth';
import { AppError } from '../lib/errors';
import { adminHeaders, csrfOrigin, loginRateLimit, requireSession } from '../lib/middleware';
import { loginPage } from '../views/admin';
import { errorPage } from '../views/layout';
import { readForm, text } from './forms';
import { superRoutes } from './super';
import { menuRoutes } from './menu';
import { uploadRoutes } from './upload';
import { t } from '../lib/i18n';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', adminHeaders, csrfOrigin, async (c, next) => bodyLimit({
  maxSize: c.req.path === '/admin/upload' ? 310 * 1024 : /\/admin\/(login|setup)$/.test(c.req.path) ? 16 * 1024 : 64 * 1024,
  onError: (ctx) => ctx.req.header('Accept')?.includes('application/json')
    ? ctx.json({ error: t(ctx.get('lang') ?? 'ky', ctx.req.path === '/admin/upload' ? 'imageTooLarge' : 'invalidForm') }, 413)
    : ctx.html(errorPage(ctx, 'invalidForm'), 413),
})(c, next));

adminRoutes.get('/login', async (c) => {
  if (await getSession(c.env.DB, readSessionCookie(c))) return c.redirect('/admin', 303);
  return c.html(loginPage(c));
});

adminRoutes.post('/login', loginRateLimit, async (c) => {
  const form = await readForm(c);
  const token = await login(c.env.DB, text(form, 'login'), text(form, 'password'));
  if (!token) return c.html(loginPage(c, false, 'invalidCredentials'), 401);
  // Preserve the language selected on the login screen in the user's preferences.
  const user = await getSession(c.env.DB, token);
  if (!user) return c.html(loginPage(c, false, 'invalidCredentials'), 401);
  await c.env.DB.prepare('UPDATE users SET ui_lang = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(c.get('lang'), user.id).run();
  writeSessionCookie(c, token);
  return c.redirect('/admin', 303);
});

adminRoutes.get('/setup', async (c) => {
  if (await hasSuperadmin(c.env.DB)) throw new AppError(404, 'notFound');
  if (!setupConfigured(c.env)) throw new AppError(503, 'setupUnavailable');
  return c.html(loginPage(c, true));
});

adminRoutes.post('/setup', async (c, next) => {
  if (await hasSuperadmin(c.env.DB)) throw new AppError(404, 'notFound');
  if (!setupConfigured(c.env)) throw new AppError(503, 'setupUnavailable');
  await next();
}, loginRateLimit, async (c) => {
  const form = await readForm(c);
  try {
    await setupSuperadmin(c.env, text(form, 'login'), text(form, 'password'));
  } catch (error) {
    if (error instanceof AppError && error.status === 401) return c.html(loginPage(c, true, 'invalidCredentials'), 401);
    throw error;
  }
  return c.redirect(`/admin/login?created=1&lang=${c.get('lang')}`, 303);
});

adminRoutes.post('/logout', async (c) => {
  await logout(c.env.DB, readSessionCookie(c));
  clearSessionCookie(c);
  return c.redirect('/admin/login', 303);
});

// Every protected request goes back to D1. No JWT or in-memory session cache.
adminRoutes.use('*', requireSession);
adminRoutes.get('/', (c) => {
  const user = c.get('user');
  return c.redirect(user.role === 'superadmin' ? '/admin/super' : `/admin/cafes/${user.cafe_id}`, 303);
});

adminRoutes.post('/language', async (c) => {
  const form = await readForm(c);
  const lang = text(form, 'lang');
  if (lang !== 'ky' && lang !== 'ru') throw new AppError(400, 'invalidForm');
  await c.env.DB.prepare('UPDATE users SET ui_lang = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(lang, c.get('user').id).run();
  const returnTo = text(form, 'return_to');
  return c.redirect(/^\/admin(?:\/[A-Za-z0-9/_-]*)?$/.test(returnTo) ? returnTo : '/admin', 303);
});

adminRoutes.route('/upload', uploadRoutes);
adminRoutes.route('/super', superRoutes);
adminRoutes.route('/cafes/:cafeId', menuRoutes);
