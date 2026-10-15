export function isValidSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{3,40}$/.test(value) && value !== 'admin' && value !== 'img';
}
