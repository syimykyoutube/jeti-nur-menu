import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getCafe } from '../db/queries';
import { AppError } from '../lib/errors';
import { cleanupImages, storeImage } from '../lib/images';
import { parseId } from '../lib/middleware';

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.post('/', async (c) => {
  if (!c.req.header('Content-Type')?.startsWith('multipart/form-data;')) throw new AppError(400, 'invalidForm');
  let form: FormData;
  try { form = await c.req.raw.formData(); } catch { throw new AppError(400, 'invalidForm'); }
  const cafeValue = form.get('cafe_id');
  const kind = form.get('kind');
  const file = form.get('file');
  if (form.getAll('cafe_id').length !== 1 || form.getAll('kind').length !== 1 || form.getAll('file').length !== 1 ||
      typeof cafeValue !== 'string' || (kind !== 'item' && kind !== 'logo') || !file || typeof file === 'string') throw new AppError(400, 'invalidForm');
  const cafeId = parseId(cafeValue);
  const user = c.get('user');
  if (user.role !== 'superadmin' && user.cafe_id !== cafeId) throw new AppError(403, 'forbidden');
  const cafe = await getCafe(c.env.DB, cafeId);
  if (!cafe) throw new AppError(404, 'notFound');
  if (user.role !== 'superadmin' && !cafe.is_active) throw new AppError(403, 'forbidden');
  // D1 retains the queue if R2 is temporarily unavailable. Do not lose a successful form save.
  await cleanupImages(c.env, cafeId).catch(() => {});
  return c.json(await storeImage(c.env, cafeId, kind, file), 201);
});
