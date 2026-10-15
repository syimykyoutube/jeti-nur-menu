import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import initialMigration from '../migrations/0001_init.sql?raw';
import authMigration from '../migrations/0002_auth.sql?raw';
import imageMigration from '../migrations/0003_images.sql?raw';
import publicMigration from '../migrations/0004_public_menus.sql?raw';

// Migration files use one statement per block; trigger bodies also contain semicolons.
function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (const line of sql.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('--')) continue;
    current += line + '\n';
    const trigger = /^CREATE TRIGGER/i.test(current.trimStart());
    if (line.trimEnd().endsWith(';') && (!trigger || line.trim() === 'END;')) {
      statements.push(current);
      current = '';
    }
  }
  if (current.trim()) throw new Error('Incomplete migration statement');
  return statements;
}

export async function createTestDatabase() {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-10-15',
    d1Databases: { DB: 'test-menu' },
    r2Buckets: { IMAGES: 'test-images' },
    telemetry: { enabled: false },
  }));
  try {
    const db: D1Database = await runtime.getD1Database('DB');
    await db.batch(migrationStatements(initialMigration + '\n' + authMigration + '\n' + imageMigration + '\n' + publicMigration).map((sql) => db.prepare(sql)));
    // Miniflare's proxy uses Node's Headers type; the runtime API is the Workers R2 API.
    const bucket = await runtime.getR2Bucket('IMAGES') as unknown as R2Bucket;
    return { runtime, db, bucket };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
