import type { AppEnv } from '../types';
import { AppError } from './errors';

export const MAX_IMAGE_BYTES = 300 * 1024;
export const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const IMAGE_KEY_PATTERN = /^c[1-9][0-9]*-[0-9a-f]{32}-[0-9a-f]{64}\.(webp|png)$/;
export type ImageKind = 'item' | 'logo';

/** Check both declared MIME and the binary container, never a client filename. */
export function validateImage(bytes: Uint8Array, mime: string): 'webp' | 'png' {
  if (bytes.length > MAX_IMAGE_BYTES) throw new AppError(413, 'imageTooLarge');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (mime === 'image/png') {
    if (bytes.length >= 45 && bytes.slice(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i]) &&
        view.getUint32(8) === 13 && ascii(12, 4) === 'IHDR' && view.getUint32(16) > 0 && view.getUint32(20) > 0 &&
        ascii(bytes.length - 8, 4) === 'IEND') return 'png';
  } else if (mime === 'image/webp') {
    if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' &&
        view.getUint32(4, true) + 8 === bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 4))) return 'webp';
  } else throw new AppError(415, 'imageType');
  throw new AppError(400, 'invalidImage');
}

export async function storeImage(env: AppEnv['Bindings'], cafeId: number, kind: ImageKind, file: File) {
  if (file.size > MAX_IMAGE_BYTES) throw new AppError(413, 'imageTooLarge');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = validateImage(bytes, file.type);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
  // Random component makes each upload immutable and prevents sharing/re-claiming old keys.
  const key = `c${cafeId}-${crypto.randomUUID().replaceAll('-', '')}-${hash}.${ext}`;
  // Record first so an interrupted R2 upload can be cleaned on a later request too.
  await env.DB.prepare('INSERT INTO image_uploads (key, cafe_id, kind) VALUES (?, ?, ?)').bind(key, cafeId, kind).run();
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: file.type, cacheControl: IMAGE_CACHE_CONTROL } });
  return { key, url: `/img/${key}`, size: bytes.length };
}

/** An unchanged key is valid; every replacement must be an unclaimed upload of this café and kind. */
export async function validateImageReference(env: AppEnv['Bindings'], cafeId: number, kind: ImageKind, key: string, previous: string | null = null): Promise<string | null> {
  if (!key) return null;
  if (key === previous) return key;
  if (!IMAGE_KEY_PATTERN.test(key)) throw new AppError(400, 'invalidImage');
  const row = await env.DB.prepare("SELECT id FROM image_uploads WHERE key = ? AND cafe_id = ? AND kind = ? AND state = 'staged'")
    .bind(key, cafeId, kind).first();
  if (!row || !await env.IMAGES.head(key)) throw new AppError(400, 'invalidImage');
  return key;
}

/** Retire before deleting: no concurrent form can attach a retired object. Retry failures later. */
export async function cleanupImages(env: AppEnv['Bindings'], cafeId: number): Promise<void> {
  await env.DB.prepare(`UPDATE image_uploads SET state = 'retired', updated_at = CURRENT_TIMESTAMP
    WHERE cafe_id = ? AND state = 'staged' AND created_at < datetime('now', '-1 day')`).bind(cafeId).run();
  const rows = (await env.DB.prepare("SELECT key FROM image_uploads WHERE cafe_id = ? AND state = 'retired' LIMIT 100")
    .bind(cafeId).all<{ key: string }>()).results;
  for (const row of rows) {
    await env.IMAGES.delete(row.key);
    await env.DB.prepare("DELETE FROM image_uploads WHERE key = ? AND state = 'retired'").bind(row.key).run();
  }
}
