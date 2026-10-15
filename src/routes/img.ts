import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { t } from '../lib/i18n';
import { IMAGE_CACHE_CONTROL, IMAGE_KEY_PATTERN } from '../lib/images';

export const imgRoutes = new Hono<AppEnv>();
imgRoutes.get('/:key', async (c) => {
  const key = c.req.param('key');
  if (!IMAGE_KEY_PATTERN.test(key)) return c.text(t('ky', 'notFound'), 404, { 'Cache-Control': 'no-store' });
  const object = await c.env.IMAGES.get(key);
  if (!object) return c.text(t('ky', 'notFound'), 404, { 'Cache-Control': 'no-store' });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', IMAGE_CACHE_CONTROL);
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Length', String(object.size));
  if (c.req.header('If-None-Match')?.split(',').map((v) => v.trim()).includes(object.httpEtag)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
});
