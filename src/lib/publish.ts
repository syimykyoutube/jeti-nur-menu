import type { Cafe, Category, Item, ItemVariant } from '../db/types';
import { renderPublicMenu, type MenuSnapshot } from '../views/public-menu';
import { AppError } from './errors';

function snapshotQueries(db: D1Database, cafeId: number): D1PreparedStatement[] {
  return [
    db.prepare('SELECT * FROM cafes WHERE id = ?').bind(cafeId),
    db.prepare('SELECT * FROM categories WHERE cafe_id = ? ORDER BY sort_order, id').bind(cafeId),
    db.prepare('SELECT * FROM items WHERE cafe_id = ? ORDER BY sort_order, id').bind(cafeId),
    db.prepare(`SELECT v.* FROM item_variants v JOIN items i ON i.id = v.item_id WHERE i.cafe_id = ? ORDER BY v.sort_order, v.id`).bind(cafeId),
  ];
}

function snapshot(results: D1Result[]): MenuSnapshot | null {
  const cafe = results[0].results[0] as Cafe | undefined;
  return cafe ? { cafe, categories: results[1].results as Category[], items: results[2].results as Item[], variants: results[3].results as ItemVariant[] } : null;
}

/** Compare versions at commit: an older renderer cannot overwrite a newer menu. */
async function saveSnapshot(db: D1Database, initial: MenuSnapshot): Promise<void> {
  let current: MenuSnapshot | null = initial;
  for (let attempt = 0; current && attempt < 4; attempt++) {
    const { cafe } = current;
    const html = renderPublicMenu(current);
    const saved = await db.prepare(`
      INSERT INTO published_menus (cafe_id, slug, is_active, html, version)
      SELECT id, slug, is_active, ?, menu_version FROM cafes WHERE id = ? AND menu_version = ?
      ON CONFLICT(cafe_id) DO UPDATE SET slug = excluded.slug, is_active = excluded.is_active,
        html = excluded.html, version = excluded.version, published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE excluded.version >= published_menus.version
    `).bind(html, cafe.id, cafe.menu_version).run();
    if (saved.meta.changes) return;
    // Another request changed this café while we rendered; re-read one coherent transaction.
    current = snapshot(await db.batch(snapshotQueries(db, cafe.id)));
  }
  if (current) throw new AppError(503, 'publicationBusy');
}

/** Bootstrap an existing/new café without advancing its version. Also used by local seed tooling. */
export async function rebuildMenu(db: D1Database, cafeId: number): Promise<void> {
  const data = snapshot(await db.batch(snapshotQueries(db, cafeId)));
  if (data) await saveSnapshot(db, data);
}

/** Mutations, version, and the source snapshot share a transaction. HTML is saved before returning. */
export async function publishMenu<T = unknown>(
  db: D1Database,
  cafeId: number,
  mutations: D1PreparedStatement[] = [],
): Promise<{ version: number | null; results: D1Result<T>[] }> {
  const results = await db.batch([
    ...mutations,
    db.prepare(`UPDATE cafes SET menu_version = menu_version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (? = 0 OR changes() > 0) RETURNING menu_version`).bind(cafeId, mutations.length),
    ...snapshotQueries(db, cafeId),
  ]);
  const versionRow = results[mutations.length].results[0] as { menu_version: number } | undefined;
  const data = snapshot(results.slice(mutations.length + 1));
  if (versionRow && data) await saveSnapshot(db, data);
  return { version: versionRow?.menu_version ?? null, results: results.slice(0, mutations.length) as D1Result<T>[] };
}
