import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  IMAGES: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => c.text('Жети Нур Меню'));

export default app;
