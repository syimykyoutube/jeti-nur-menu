import type { Language } from '../db/types';
import { t } from './i18n.ts';

export function assertPrice(price: number): void {
  if (!Number.isSafeInteger(price) || price < 0) {
    throw new RangeError('Price must be a non-negative safe integer in som');
  }
}

export function formatPrice(price: number, lang: Language = 'ky'): string {
  assertPrice(price);
  return `${price} ${t(lang, 'currency')}`;
}
