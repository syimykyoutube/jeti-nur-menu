import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { isValidSlug } from '../lib/slug';
import { publicNotFound } from '../views/public-menu';

export const MENU_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=86400';
export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/:slug', async c => {
  const slug = c.req.param('slug');
  const notFound = () => c.html(publicNotFound(), 404, { 'Cache-Control': 'no-store' });
  if (!isValidSlug(slug) || slug === 'admin' || slug === 'img') return notFound();
  const url = new URL(c.req.url); url.search = '';
  const key = new Request(url.toString());
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try { ctx = c.executionCtx; } catch { /* app.request() unit tests have no Worker context */ }
  const edge = ctx && typeof caches !== 'undefined' ? caches.default : undefined;
  const hit = await edge?.match(key);
  if (hit) {
    const response = new Response(hit.body, hit);
    response.headers.set('Cache-Control', MENU_CACHE_CONTROL);
    return response;
  }
  // Exactly ONE indexed row, ONE query. No joins, sessions, R2 calls, or rendering here.
  const menu = await c.env.DB.prepare('SELECT html, version FROM published_menus WHERE slug = ? AND is_active = 1')
    .bind(slug).first<{ html: string; version: number }>();
  if (!menu) return notFound();
  // Hash the saved script, so an older published page still works after a code deployment.
  const script = menu.html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script)));
  const hash = btoa(String.fromCharCode(...digest));
  const response = c.html(menu.html, 200, {
    'Cache-Control': MENU_CACHE_CONTROL,
    'X-Menu-Public': '1', 'X-Menu-Version': String(menu.version),
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  if (edge && ctx) {
    const cached = response.clone();
    // Workers Cache API does not implement SWR. The edge entry has a strict 60s TTL.
    cached.headers.set('Cache-Control', 'public, max-age=60');
    ctx.waitUntil(edge.put(key, cached).catch(() => {}));
  }
  return response;
});
