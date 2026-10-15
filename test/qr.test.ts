import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import jsQR from 'jsqr';
import app from '../src/index';
import type { AppEnv } from '../src/types';
import type { User } from '../src/db/types';
import { createSession, hashPassword, SESSION_COOKIE } from '../src/lib/auth';
import { createCafe, updateCafe } from '../src/db/queries';
import { createQr, isLocalMenuUrl, menuUrl, qrPng, qrSvg } from '../src/lib/qr';
import { createTestDatabase } from './helpers';

const origin = 'https://menu.test';

/** Read the actual emitted 1-bit PNG, then let an independent scanner decode its pixels. */
async function decodePng(bytes: Uint8Array): Promise<{ url: string | undefined; width: number; dpi: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const width = view.getUint32(16), height = view.getUint32(20);
  expect([...bytes.slice(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
  expect(bytes[24]).toBe(1); expect(bytes[25]).toBe(0);
  let compressed = new Uint8Array(0); let dpi = 0;
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    if (type === 'IDAT') { const joined = new Uint8Array(compressed.length + length); joined.set(compressed); joined.set(bytes.slice(offset + 8, offset + 8 + length), compressed.length); compressed = joined; }
    if (type === 'pHYs') dpi = view.getUint32(offset + 8) * 0.0254;
    offset += length + 12;
  }
  const raw = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = Math.ceil(width / 8) + 1;
  const downsample = 4, w = Math.floor(width / downsample), h = Math.floor(height / downsample);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    expect(raw[y * downsample * stride]).toBe(0);
    for (let x = 0; x < w; x++) {
      const px = x * downsample, py = y * downsample;
      const white = (raw[py * stride + 1 + (px >> 3)] & (128 >> (px & 7))) !== 0;
      const offset = (y * w + x) * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = white ? 255 : 0; rgba[offset + 3] = 255;
    }
  }
  return { url: jsQR(rgba, w, h, { inversionAttempts:'dontInvert' })?.data, width, dpi };
}

function decodeSvg(svg: string): string | undefined {
  const size = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)![1]);
  const scale = 8, width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const match of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const x = Number(match[1]) * scale, y = Number(match[2]) * scale;
    for (let row = y; row < y + scale; row++) for (let col = x; col < x + scale; col++) {
      const offset = (row * width + col) * 4; pixels[offset] = pixels[offset+1] = pixels[offset+2] = 0;
    }
  }
  return jsQR(pixels,width,width,{inversionAttempts:'dontInvert'})?.data;
}

export { decodePng, decodeSvg };

describe('printable QR', () => {
  it.each(['https://jeti-nur-menu.example.workers.dev/coffee-name','http://localhost:8788/jeti-nur-demo-30','https://menu.example.com/' + 'a'.repeat(40)])('SVG and 300 DPI PNG independently scan to the exact café URL: %s', async url => {
    const qr = createQr(url);
    expect(qr.pixels).toBeGreaterThanOrEqual(2048);
    const result = await decodePng(await qrPng(qr));
    expect(result.url).toBe(url); expect(result.width).toBe(qr.pixels); expect(result.dpi).toBeCloseTo(300,1);
    expect(decodeSvg(qrSvg(qr))).toBe(url);
    expect(qr.data.slice(0,4).flat().every(value=>!value)).toBe(true);
  });
  it('uses the current origin without an admin path or query; identifies local-only links', () => {
    expect(menuUrl('https://menu.example.com/admin/cafes/9/qr?x=1','coffee-name')).toBe('https://menu.example.com/coffee-name');
    for (const url of ['http://localhost:8787/cafe','http://127.0.0.1/cafe','http://[::1]/cafe']) expect(isLocalMenuUrl(url)).toBe(true);
    expect(isLocalMenuUrl('https://menu.example.com/cafe')).toBe(false);
  });
});

describe('QR screen and authenticated downloads', () => {
  let runtime: Miniflare, db: D1Database, env: AppEnv['Bindings'], hash: string;
  beforeAll(async () => { const test = await createTestDatabase(); runtime=test.runtime; db=test.db; env={DB:db,IMAGES:test.bucket}; hash=await hashPassword('Qr-owner-test-123'); },30_000);
  beforeEach(async () => { await db.prepare('DELETE FROM cafes').run(); await db.prepare('DELETE FROM users').run(); });
  afterAll(async()=>{await runtime?.dispose();});
  async function fixture(slug='qr-cafe') {
    const cafe=await createCafe(db,{slug,name_ky:'Жети Нур',name_ru:'Семь лучей'});
    const user=(await db.prepare("INSERT INTO users (login,password_hash,role,cafe_id) VALUES (?,?,'owner',?) RETURNING *").bind(slug,hash,cafe.id).first<User>())!;
    const token=(await createSession(db,user))!;
    return {cafe,user,token,base:`/admin/cafes/${cafe.id}`};
  }
  function get(path:string,token?:string,host=origin) {return app.request(host+path,{headers:token?{Cookie:`${SESSION_COOKIE}=${token}`} : {}},env);}
  it('renders mobile KY/RU controls, exact link and both download formats; localhost has a meaningful notice',async()=>{
    const f=await fixture();
    const dashboard=await (await get(f.base,f.token)).text(); expect(dashboard).toContain(`href="${f.base}/qr"`);
    const html=await (await get(f.base+'/qr',f.token)).text();
    expect(html).toContain(`https://menu.test/${f.cafe.slug}`); expect(html).toContain('SVG жүктөө'); expect(html).toContain('2048+ px'); expect(html).toContain('width="288" height="288"');
    const local=await (await get(f.base+'/qr',f.token,'http://localhost:8787')).text(); expect(local).toContain('локалдык шилтеме');
    await db.prepare("UPDATE users SET ui_lang='ru' WHERE id=?").bind(f.user.id).run();
    expect(await (await get(f.base+'/qr',f.token)).text()).toContain('Скачать PNG');
  });
  it('downloads decodable SVG and PNG with private headers and safe filenames',async()=>{
    const f=await fixture();
    const svg=await get(f.base+'/qr.svg',f.token); expect(svg.status).toBe(200);
    expect(svg.headers.get('Content-Type')).toContain('image/svg+xml'); expect(svg.headers.get('Content-Disposition')).toContain('attachment; filename="jeti-nur-qr-cafe-qr.svg"');
    expect(decodeSvg(await svg.text())).toBe(origin+'/'+f.cafe.slug);
    const png=await get(f.base+'/qr.png',f.token); expect(png.status).toBe(200);
    expect(png.headers.get('Content-Type')).toBe('image/png'); expect(png.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await decodePng(new Uint8Array(await png.arrayBuffer()))).url).toBe(origin+'/'+f.cafe.slug);
    expect((await get(f.base+'/qr.svg?preview=1',f.token)).headers.get('Content-Disposition')).toContain('inline');
    expect((await get('/'+f.cafe.slug)).status).toBe(200);
  });
  it('blocks unauthenticated, cross-café, revoked and paused owners for the page AND files',async()=>{
    const a=await fixture(), b=await fixture('other-qr-cafe');
    for (const suffix of ['/qr','/qr.svg','/qr.png']) {
      expect((await get(a.base+suffix)).status).toBe(303);
      expect((await get(b.base+suffix,a.token)).status).toBe(403);
    }
    await updateCafe(db,a.cafe.id,{is_active:0});
    expect((await get(a.base+'/qr.png',a.token)).status).toBe(303);
  });
  it('allows a superadmin to get any café QR and regenerates the URL after a slug change',async()=>{
    const f=await fixture();
    const user=(await db.prepare("INSERT INTO users (login,password_hash,role) VALUES ('qr-super',?,'superadmin') RETURNING *").bind(hash).first<User>())!;
    const token=(await createSession(db,user))!;
    await updateCafe(db,f.cafe.id,{slug:'changed-qr-cafe'});
    const result=await get(f.base+'/qr.svg',token);
    expect(result.status).toBe(200); expect(decodeSvg(await result.text())).toBe(origin+'/changed-qr-cafe');
  });
});
