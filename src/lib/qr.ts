import { encode } from 'uqr';

export function menuUrl(requestUrl: string, slug: string): string {
  return new URL('/' + slug, new URL(requestUrl).origin).href;
}

export function isLocalMenuUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '[::1]';
}

/** Q correction, four-module quiet zone, whole-pixel modules, at least 2048 px. */
export function createQr(url: string) {
  const qr = encode(url, { ecc: 'Q', boostEcc: true, border: 4 });
  const scale = Math.ceil(2048 / qr.size);
  return { ...qr, scale, pixels: qr.size * scale };
}
type Qr = ReturnType<typeof createQr>;

export function qrSvg(qr: Qr): string {
  const path: string[] = [];
  qr.data.forEach((row, y) => row.forEach((black, x) => { if (black) path.push(`M${x} ${y}h1v1h-1z`); }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${qr.pixels}" height="${qr.pixels}" viewBox="0 0 ${qr.size} ${qr.size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path.join('')}" fill="black"/></svg>`;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let position = 0;
  for (const part of parts) { result.set(part, position); position += part.length; }
  return result;
}
function uint32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes;
}
function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = concat([new TextEncoder().encode(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return concat([uint32(data.length), body, uint32((crc ^ 0xffffffff) >>> 0)]);
}

/** Native Workers CompressionStream; no Node, canvas or PNG runtime dependency. */
export async function qrPng(qr: Qr): Promise<Uint8Array<ArrayBuffer>> {
  const stride = Math.ceil(qr.pixels / 8);
  const raw = new Uint8Array((stride + 1) * qr.pixels);
  qr.data.forEach((modules, moduleY) => {
    const scanline = new Uint8Array(stride + 1); // filter 0, grayscale, one bit per pixel
    scanline.fill(255, 1);
    for (let x = 0; x < qr.pixels; x++) if (modules[Math.floor(x / qr.scale)]) scanline[1 + (x >> 3)] &= ~(128 >> (x & 7));
    // Reuse a packed scanline instead of calculating millions of identical pixels.
    for (let repeat = 0; repeat < qr.scale; repeat++) raw.set(scanline, (moduleY * qr.scale + repeat) * (stride + 1));
  });
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = concat([uint32(qr.pixels), uint32(qr.pixels), new Uint8Array([1, 0, 0, 0, 0])]);
  const density = concat([uint32(11811), uint32(11811), new Uint8Array([1])]); // 300 DPI
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('pHYs', density), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]);
}
