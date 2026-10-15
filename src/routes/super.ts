import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createCafeOwner, listCafeOwners, revealOwnerPassword, setCafeActive, updateOwnerCredentials } from '../db/admin';
import { AppError } from '../lib/errors';
import { parseId, requireSuperadmin } from '../lib/middleware';
import { superPage } from '../views/super';
import { readForm, text } from './forms';

export const superRoutes = new Hono<AppEnv>();
superRoutes.use('*', requireSuperadmin);

superRoutes.get('/', async (c) => c.html(superPage(c, await listCafeOwners(c.env.DB, c.get('user')))));

superRoutes.post('/cafes', async (c) => {
  const form = await readForm(c);
  await createCafeOwner(c.env, c.get('user'), {
    slug: text(form, 'slug'), name_ky: text(form, 'name_ky'), name_ru: text(form, 'name_ru'),
    login: text(form, 'login'), password: text(form, 'password'),
  });
  return c.redirect('/admin/super?saved=1', 303);
});

superRoutes.get('/cafes/:cafeId/password', async (c) => {
  const password = await revealOwnerPassword(c.env, c.get('user'), parseId(c.req.param('cafeId')));
  return c.json({ password });
});

superRoutes.post('/cafes/:cafeId/credentials', async (c) => {
  const form = await readForm(c);
  await updateOwnerCredentials(c.env, c.get('user'), parseId(c.req.param('cafeId')), text(form, 'login'), text(form, 'password') || undefined);
  return c.redirect('/admin/super?saved=1', 303);
});

superRoutes.post('/cafes/:cafeId/status', async (c) => {
  const form = await readForm(c);
  const active = text(form, 'is_active');
  if (active !== '0' && active !== '1') throw new AppError(400, 'invalidForm');
  await setCafeActive(c.env.DB, c.get('user'), parseId(c.req.param('cafeId')), active === '1' ? 1 : 0);
  return c.redirect('/admin/super?saved=1', 303);
});
