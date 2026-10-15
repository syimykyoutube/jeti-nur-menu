// Isolated local D1/R2 fixture: real admin endpoints publish a rich 30-dish menu.
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { deflateSync, gzipSync } from 'node:zlib';

const folder = resolve('.wrangler/menu-benchmark');
const wrangler = resolve('node_modules/wrangler/bin/wrangler.js');
const config = resolve(folder, 'wrangler.toml');
const state = resolve(folder, 'state');
const origin = 'http://localhost:8788';
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
if (!existsSync(folder)) {
  mkdirSync(folder);
  writeFileSync(config, `name="jeti-nur-menu-benchmark"\nmain=${JSON.stringify(resolve('src/index.ts'))}\ncompatibility_date="2026-10-15"\n[[d1_databases]]\nbinding="DB"\ndatabase_name="menu-benchmark"\ndatabase_id="00000000-0000-0000-0000-000000000000"\nmigrations_dir=${JSON.stringify(resolve('migrations'))}\n[[r2_buckets]]\nbinding="IMAGES"\nbucket_name="menu-benchmark"\n[assets]\ndirectory=${JSON.stringify(resolve('public'))}\n`);
  writeFileSync(resolve(folder, '.dev.vars'), `PASSWORD_VIEW_KEY=${randomBytes(32).toString('base64url')}\nSETUP_LOGIN=benchmark-super\nSETUP_PASSWORD=Menu-super-test-123\n`, { mode: 0o600 });
}
execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'menu-benchmark', '--local', '--config', config, '--persist-to', state], { env: { ...env, CI: 'true' }, stdio: 'inherit' });
const server = spawn(process.execPath, [wrangler, 'dev', '--config', config, '--persist-to', state, '--port', '8788', '--ip', '127.0.0.1'], { env, stdio: 'inherit' });
process.on('SIGINT', () => { server.kill('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { server.kill('SIGTERM'); process.exit(0); });
server.on('exit', code => process.exit(code ?? 0));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(origin + '/')).ok; } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 250)); }
  if (!ready) throw new Error('Local Wrangler did not start');
  async function post(path: string, data: URLSearchParams | FormData, cookie?: string) {
    const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: data, redirect: 'manual' });
    if (![201, 303].includes(response.status)) throw new Error(`Local fixture request failed: ${path} (${response.status})`);
    return response;
  }
  const slug = 'jeti-nur-demo-30';
  if (!(await fetch(origin + '/' + slug)).ok) {
    await post('/admin/setup', new URLSearchParams({ login: 'benchmark-super', password: 'Menu-super-test-123' }));
    const session = await post('/admin/login', new URLSearchParams({ login: 'benchmark-super', password: 'Menu-super-test-123' }));
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    await post('/admin/super/cafes', new URLSearchParams({ slug, name_ky: 'Жети Нур · даамдуу меню', name_ru: 'Жети Нур · меню с душой', login: 'benchmark-owner', password: 'Menu-owner-test-123' }), cookie);
    const listing = await fetch(origin + '/admin/super', { headers: { Cookie: cookie } }).then(response => response.text());
    const cafeId = listing.match(/href="\/admin\/cafes\/(\d+)"/)![1];
    const base = `/admin/cafes/${cafeId}`;
    const categories = [ ['Эртең мененки тамактар', 'Завтраки'], ['Шорполор', 'Супы'], ['Негизги тамактар', 'Основные блюда'], ['Салаттар', 'Салаты'], ['Суусундуктар', 'Напитки'] ];
    const names = [['Каймактуу ботко','Каша со сливками'],['Жумуртка жана жашылча','Омлет с овощами'],['Бал кошулган куймак','Блинчики с мёдом'],['Сыр кошулган нан','Тосты с сыром'],['Үй быштактары','Домашние сырники'],['Эртең мененки топтом','Завтрак целиком'],['Эттүү шорпо','Мясной бульон'],['Кесме шорпо','Суп с лапшой'],['Жашылча шорпосу','Овощной суп'],['Чүчпара','Пельмени в бульоне'],['Жасмык шорпосу','Чечевичный суп'],['Тоок шорпосу','Куриный суп'],['Үй лагманы','Домашний лагман'],['Казан кебеп','Казан-кебаб'],['Тоок жана күрүч','Курица с рисом'],['Уй эти жана жашылча','Говядина с овощами'],['Бешбармак','Бешбармак'],['Чоң манты','Манты'],['Жаңы жашылча салаты','Свежий овощной салат'],['Тоок салаты','Салат с курицей'],['Бадыраң жана каймак','Огурцы со сметаной'],['Кызылча салаты','Свекольный салат'],['Сыр жана жашылча','Сыр с зеленью'],['Мезгил салаты','Сезонный салат'],['Көк чай','Зелёный чай'],['Кара чай','Чёрный чай'],['Бал кошулган чай','Чай с мёдом'],['Үй компоту','Домашний компот'],['Мөмө ширеси','Морс'],['Лимондуу суу','Вода с лимоном']];
    // Representative 640×448 PNG (~60–100 KB), generated locally with no external assets.
    function crc(bytes: Uint8Array) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); } return (value ^ 0xffffffff) >>> 0; }
    function chunk(type: string, data: Buffer) { const body = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(body)); return Buffer.concat([length,body,checksum]); }
    const width = 640, height = 448, raw = Buffer.alloc((width * 3 + 1) * height);
    const shades = randomBytes(width / 4 * height / 4 * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 3 + 1) + 1 + x * 3; const pixel = (Math.floor(y / 4) * width / 4 + Math.floor(x / 4)) * 3; raw[offset] = 85 + (shades[pixel] % 120); raw[offset + 1] = 65 + (shades[pixel + 1] % 100); raw[offset + 2] = 35 + (shades[pixel + 2] % 80); }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height,4); ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
    async function image(kind: string) { const form = new FormData(); form.set('cafe_id',cafeId); form.set('kind',kind); form.set('file',new File([png],'fixture.png',{type:'image/png'})); const response = await post('/admin/upload',form,cookie); return (await response.json() as {key:string}).key; }
    await post(base + '/settings', new URLSearchParams({ name_ky: 'Жети Нур · даамдуу меню', name_ru: 'Жети Нур · меню с душой', default_lang: 'ky', logo_key: await image('logo') }),cookie);
    let position = 0;
    for (const [ky,ru] of categories) {
      const response = await post(base + '/categories', new URLSearchParams({name_ky:ky,name_ru:ru}),cookie);
      const id = response.headers.get('location')!.match(/category-(\d+)/)![1];
      for (let j = 0; j < 6; j++,position++) {
        const form = new URLSearchParams({ variants_form:'1', name_ky:names[position][0], name_ru:position%7===0?'':names[position][1], category_id:id, ingredients_ky:'Жаңы азыктардан күн сайын даярдалат. Курамы: эт же жашылча, пияз, сабиз, табигый татымалдар. Каалооңуз болсо, кызматкерден тактап сураңыз. '.repeat(3), ingredients_ru:'Готовим каждый день из свежих продуктов. Состав: мясо или овощи, лук, морковь, натуральные специи. При особых предпочтениях уточните у сотрудника. '.repeat(3), is_available:position%9===0?'0':'1', image_key:await image('item') });
        for (const [label,extra] of [['0,5',0],['0,7',70],['1,0',140]] as const) { form.append('variant_label',label); form.append('variant_price',String(120+position*10+extra)); }
        await post(base + '/items',form,cookie);
      }
      console.log(`Published category ${ky}: ${position}/30 dishes.`);
    }
    await post('/admin/logout', new URLSearchParams(),cookie);
    console.log(`Images: ${png.length} bytes each; 31 independent R2 keys.`);
  }
  const times = [];
  let html = '';
  for (let i = 0; i < 5; i++) { const start = performance.now(); const response = await fetch(origin + '/' + slug, { cache:'no-cache' }); const headersAt = performance.now(); html = await response.text(); times.push({ttfbMs:Math.round(headersAt-start),totalMs:Math.round(performance.now()-start)}); }
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('');
  const result = { url:origin+'/'+slug, dishes:(html.match(/<details /g)||[]).length, images:(html.match(/<img /g)||[]).length, htmlBytes:Buffer.byteLength(html), gzipBytes:gzipSync(html).length, inlineJsBytes:Buffer.byteLength(scripts), swBytes:Buffer.byteLength(readFileSync('public/sw.js')), localhostRequests:times };
  writeFileSync(resolve(folder,'metrics.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  console.log('Benchmark café is ready. Keep this process running for browser/Lighthouse checks; Ctrl+C stops it.');
} catch (error) { server.kill('SIGTERM'); throw error; }
