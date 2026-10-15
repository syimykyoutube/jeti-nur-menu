// Run after migrations to publish cafés which predate automatic HTML publication.
// Node 24 strips TypeScript; only the pure HTML renderer is imported here.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { renderPublicMenu } from '../src/views/public-menu.ts';
import type { Cafe, Category, Item, ItemVariant } from '../src/db/types.ts';

const args = process.argv.slice(2);
if (args.some(arg => arg === '--remote')) throw new Error('This script only supports local D1.');
function query(sql: string) {
  const text = execFileSync(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'jeti-nur-menu', '--local', '--json', '--command', sql, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  const result = JSON.parse(text);
  if (!result.every((entry: { success: boolean }) => entry.success)) throw new Error('Local D1 command failed');
  return result[0].results;
}
const cafes = query('SELECT * FROM cafes ORDER BY id') as Cafe[];
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
let count = 0;
for (const cafe of cafes) {
  const categories = query(`SELECT * FROM categories WHERE cafe_id = ${cafe.id} ORDER BY sort_order,id`) as Category[];
  const items = query(`SELECT * FROM items WHERE cafe_id = ${cafe.id} ORDER BY sort_order,id`) as Item[];
  const variants = query(`SELECT v.* FROM item_variants v JOIN items i ON i.id=v.item_id WHERE i.cafe_id=${cafe.id} ORDER BY v.sort_order,v.id`) as ItemVariant[];
  const html = renderPublicMenu({ cafe, categories, items, variants });
  // Local trusted tooling: values are SQL-quoted; runtime application queries use bind().
  query(`INSERT INTO published_menus (cafe_id,slug,is_active,html,version)
    SELECT id,slug,is_active,${quote(html)},menu_version FROM cafes WHERE id=${cafe.id} AND menu_version=${cafe.menu_version}
    ON CONFLICT(cafe_id) DO UPDATE SET slug=excluded.slug,is_active=excluded.is_active,html=excluded.html,
      version=excluded.version,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE excluded.version>=published_menus.version`);
  count++;
}
console.log(`Published ${count} local café menu(s); versions were preserved.`);
