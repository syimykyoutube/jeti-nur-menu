import type { Context } from 'hono';
import type { AppEnv } from '../types';
import type { ImageKind } from '../lib/images';
import { t } from '../lib/i18n';
import { e } from './layout';

export function imageUploadField(c: Context<AppEnv>, kind: ImageKind, key: string): string {
  const tr = (word: string) => e(t(c.get('lang'), word));
  const attributes = ['compressing', 'uploading', 'imageReady', 'imageTooLarge', 'invalidImage', 'imageBrowserUnsupported', 'imageCompressionFailed', 'requestFailed', 'sessionExpired', 'kilobytes', 'imagePending', 'imageRemoved']
    .map((word) => `data-${word.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())}="${tr(word)}"`).join(' ');
  return `<section class="image-upload" data-image-upload data-kind="${kind}" data-cafe-id="${c.get('cafe').id}" ${attributes}>
    <label>${tr(kind === 'item' ? 'dishImage' : 'logoImage')}<input type="file" accept="image/*" data-image-file></label>
    <p class="muted">${tr(kind === 'item' ? 'dishImageHint' : 'logoImageHint')}</p>
    <input type="hidden" name="${kind === 'item' ? 'image_key' : 'logo_key'}" value="${e(key)}" data-image-key>
    <img class="image-preview" data-image-preview ${key ? `src="/img/${e(key)}"` : 'hidden'} alt="${tr('imagePreview')}" width="320" height="180" decoding="async">
    <p class="muted" data-image-size></p><progress max="100" value="0" hidden aria-label="${tr('uploadProgress')}"></progress>
    <p class="image-status muted" data-image-status role="status" aria-live="polite"></p>
    <button type="button" class="secondary" data-image-remove ${key ? '' : 'hidden'}>${tr('removeImage')}</button>
  </section>`;
}
