import { describe, expect, it } from 'vitest';
import { isValidSlug } from '../src/lib/slug';

describe('isValidSlug', () => {
  it.each(['abc', '123', 'coffee-name', 'jeti-nur-7', 'a'.repeat(40), '-ab', 'ab-'])(
    'accepts the specified alphabet and length: %s', (slug) => {
      expect(isValidSlug(slug)).toBe(true);
    },
  );

  it.each(['admin', 'img', '', 'a', 'ab', 'a'.repeat(41), 'Coffee', 'жети-нур', 'café', 'foo_bar',
    'foo.bar', 'foo bar', ' abc', 'abc ', 'abc\n', 'abc/def', "abc'; DROP TABLE cafes;--", null, undefined, 123])(
    'rejects invalid input: %s', (slug) => {
      expect(isValidSlug(slug)).toBe(false);
    },
  );
});
