import { Hono } from 'hono';
import type { AppEnv } from './types';
import { adminRoutes } from './routes/admin';
import { imgRoutes } from './routes/img';
import { publicRoutes } from './routes/public';
import { AppError } from './lib/errors';
import { t } from './lib/i18n';
import { errorPage } from './views/layout';

const app = new Hono<AppEnv>();

app.get('/', (c) => c.text(t('ky', 'appName')));
app.route('/admin', adminRoutes);
app.route('/img', imgRoutes);
app.route('/', publicRoutes);

app.onError((error, c) => {
  // Do not log request bodies, credentials, decrypted passwords or SQL bindings.
  if (error instanceof AppError) {
    if (c.req.header('Accept')?.includes('application/json')) return c.json({ error: t(c.get('lang') ?? 'ky', error.key) }, error.status);
    return c.html(errorPage(c, error.key), error.status);
  }
  if (c.req.header('Accept')?.includes('application/json')) return c.json({ error: t(c.get('lang') ?? 'ky', 'serverError') }, 500);
  return c.html(errorPage(c, 'serverError'), 500);
});
app.notFound((c) => c.html(errorPage(c, 'notFound'), 404));

export default app;
