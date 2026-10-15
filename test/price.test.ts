import { describe, expect, it } from 'vitest';
import { formatPrice } from '../src/lib/price';

describe('formatPrice', () => {
  it.each([
    [0, '0 сом'], [180, '180 сом'], [1250, '1250 сом'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991 сом'],
  ])('formats %s as %s', (price, expected) => {
    expect(formatPrice(price)).toBe(expected);
  });

  it.each([-1, 0.5, 180.25, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid price: %s', (price) => {
      expect(() => formatPrice(price)).toThrow(RangeError);
    },
  );
});
