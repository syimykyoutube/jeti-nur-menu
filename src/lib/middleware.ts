import { createMiddleware } from 'hono/factory';
import { getCafe } from '../db/queries';
import type { AppEnv } from '../types';
import { clearSessionCookie, getSession, randomToken, readSessionCookie, takeLoginAttempt } from './auth';
import { AppError } from './errors';
import { t } from './i18n';

export const adminHeaders = createMiddleware<AppEnv>(async (c, next) => {
  const nonce = randomToken();
  c.set('nonce', nonce);
  c.set('lang', c.req.query('lang') === 'ru' ? 'ru' : 'ky');
  c.header('Cache-Control', 'private, no-store');
  // no-referrer turns native form POST origins into "null", breaking strict CSRF.
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
  await next();
});

export const csrfOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    if (c.req.header('Origin') !== new URL(c.req.url).origin) throw new AppError(403, 'invalidOrigin');
  }
  await next();
});

export const loginRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  // Cloudflare sets this trusted header. Do not trust arbitrary X-Forwarded-For.
  const limit = await takeLoginAttempt(c.env.DB, c.req.header('CF-Connecting-IP') ?? 'local');
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter));
    throw new AppError(429, 'tooManyAttempts');
  }
  await next();
});

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const user = await getSession(c.env.DB, readSessionCookie(c));
  if (!user) {
    clearSessionCookie(c);
    if (c.req.header('Accept')?.includes('application/json')) return c.json({ error: t(c.get('lang') ?? 'ky', 'sessionExpired') }, 401);
    return c.redirect('/admin/login', 303);
  }
  c.set('user', user);
  c.set('lang', user.ui_lang);
  await next();
});

export const requireSuperadmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user').role !== 'superadmin') throw new AppError(403, 'forbidden');
  await next();
});

export function parseId(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AppError(404, 'notFound');
  return Number(value);
}

export const requireCafeAccess = createMiddleware<AppEnv>(async (c, next) => {
  const id = parseId(c.req.param('cafeId'));
  const user = c.get('user');
  if (user.role !== 'superadmin' && user.cafe_id !== id) throw new AppError(403, 'forbidden');
  const cafe = await getCafe(c.env.DB, id);
  if (!cafe || (user.role === 'owner' && !cafe.is_active)) throw new AppError(404, 'notFound');
  c.set('cafe', cafe);
  await next();
});
