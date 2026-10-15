import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import app from '../src/index';
import type { AppEnv, AuthUser } from '../src/types';
import type { User } from '../src/db/types';
import {
  createSession, decryptOwnerPassword, encryptOwnerPassword, getSession, hashPassword,
  hashToken, isValidLogin, login, logout, PBKDF2_ITERATIONS, randomToken, SESSION_COOKIE,
  takeLoginAttempt, verifyPassword,
} from '../src/lib/auth';
import { createCafeOwner, hasSuperadmin, revealOwnerPassword, setCafeActive, setupSuperadmin, updateOwnerCredentials } from '../src/db/admin';
import { createCategory } from '../src/db/queries';
import { createTestDatabase } from './helpers';

const origin = 'https://menu.test';
const superPassword = 'Superadmin-test-123';
const ownerPassword = 'Owner-test-123';

describe('authentication and protected routes', () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: AppEnv['Bindings'];

  beforeAll(async () => {
    ({ runtime, db } = await createTestDatabase());
    env = { DB: db, IMAGES: {} as R2Bucket, PASSWORD_VIEW_KEY: randomToken(), SETUP_LOGIN: 'project-admin', SETUP_PASSWORD: superPassword };
  }, 30_000);

  beforeEach(async () => {
    await db.prepare('DELETE FROM cafes').run();
    await db.prepare('DELETE FROM users').run();
    await db.prepare('DELETE FROM auth_rate_limits').run();
  });

  afterAll(async () => { await runtime?.dispose(); });

  function request(path: string, options: {
    method?: string; token?: string; form?: Record<string, string>; ip?: string; origin?: string | null;
  } = {}) {
    const method = options.method ?? (options.form ? 'POST' : 'GET');
    const headers = new Headers({ 'CF-Connecting-IP': options.ip ?? '192.0.2.1' });
    if (options.token) headers.set('Cookie', `${SESSION_COOKIE}=${options.token}`);
    if (method !== 'GET' && method !== 'HEAD' && options.origin !== null) headers.set('Origin', options.origin ?? origin);
    if (options.form) headers.set('Content-Type', 'application/x-www-form-urlencoded');
    return app.request(`${origin}${path}`, { method, headers, body: options.form ? new URLSearchParams(options.form) : undefined }, env);
  }

  async function fixture() {
    await setupSuperadmin(env, 'project-admin', superPassword);
    const superToken = (await login(db, 'project-admin', superPassword))!;
    const superUser = (await getSession(db, superToken))!;
    await createCafeOwner(env, superUser, { slug: 'first-cafe', name_ky: 'Биринчи кафе', login: 'first-owner', password: ownerPassword });
    const owner = (await db.prepare("SELECT * FROM users WHERE login = 'first-owner'").first<User>())!;
    const ownerToken = (await login(db, 'first-owner', ownerPassword))!;
    return { superUser, superToken, owner, ownerToken, cafeId: owner.cafe_id! };
  }

  it('PBKDF2 uses a fresh salt, accepts the right password and rejects wrong or malformed values', async () => {
    const hash = await hashPassword('туура-пароль-123');
    expect(hash).toContain(`pbkdf2-sha256$${PBKDF2_ITERATIONS}$`);
    expect(hash).not.toContain('туура-пароль-123');
    expect(await hashPassword('туура-пароль-123')).not.toBe(hash);
    expect(await verifyPassword('туура-пароль-123', hash)).toBe(true);
    expect(await verifyPassword('башка-пароль-123', hash)).toBe(false);
    expect(await verifyPassword('туура-пароль-123', 'malformed')).toBe(false);
    expect(await verifyPassword('туура-пароль-123', hash.replace('$100000$', '$1$'))).toBe(false);
    expect(await verifyPassword('x'.repeat(129), hash)).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow();
    expect(isValidLogin('бекболот_1')).toBe(true);
    expect(isValidLogin('test.owner-1')).toBe(true);
    expect(isValidLogin('test@example.com')).toBe(false);
    expect(isValidLogin('ab')).toBe(false);
    expect(isValidLogin('has space')).toBe(false);
  });

  it('AES-GCM preserves passwords, uses random nonces, rejects tampering and never decrypts for an owner', async () => {
    const key = env.PASSWORD_VIEW_KEY;
    const encrypted = await encryptOwnerPassword(ownerPassword, key);
    const requester = { role: 'superadmin' } as AuthUser;
    expect(encrypted).not.toContain(ownerPassword);
    expect(await encryptOwnerPassword(ownerPassword, key)).not.toBe(encrypted);
    expect(await decryptOwnerPassword(requester, encrypted, key)).toBe(ownerPassword);
    const parts = encrypted.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    await expect(decryptOwnerPassword(requester, parts.join('.'), key)).rejects.toThrow();
    await expect(decryptOwnerPassword(requester, encrypted, randomToken())).rejects.toThrow();
    await expect(decryptOwnerPassword({ role: 'owner' } as AuthUser, encrypted, key)).rejects.toThrow();
    await expect(encryptOwnerPassword(ownerPassword, undefined)).rejects.toThrow();
    await expect(encryptOwnerPassword(ownerPassword, 'short')).rejects.toThrow();
  });

  it('setup requires secret credentials, creates only one superadmin and closes GET and POST afterwards', async () => {
    const form = await request('/admin/setup?lang=ru');
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('<html lang="ru">');
    expect(html).not.toContain(superPassword);
    expect((await request('/admin/setup', { form: { login: 'intruder', password: 'intruder-123' } })).status).toBe(401);
    expect(await hasSuperadmin(db)).toBeNull();
    expect((await request('/admin/setup', { form: { login: 'project-admin', password: superPassword } })).status).toBe(303);
    const admin = await db.prepare("SELECT * FROM users WHERE role = 'superadmin'").first<User>();
    expect(admin?.password_enc).toBeNull();
    expect(await verifyPassword(superPassword, admin!.password_hash)).toBe(true);
    expect((await request('/admin/setup')).status).toBe(404);
    expect((await request('/admin/setup', { form: { login: 'project-admin', password: superPassword } })).status).toBe(404);
    expect((await db.prepare("SELECT count(*) AS n FROM users WHERE role = 'superadmin'").first<{ n: number }>())?.n).toBe(1);
  });

  it('setup remains disabled without configured secrets and is safe under simultaneous setup requests', async () => {
    const response = await app.request(`${origin}/admin/setup`, {}, { ...env, SETUP_PASSWORD: '' });
    expect(response.status).toBe(503);
    const results = await Promise.allSettled([
      setupSuperadmin(env, 'project-admin', superPassword), setupSuperadmin(env, 'project-admin', superPassword),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await db.prepare("SELECT count(*) AS n FROM users WHERE role = 'superadmin'").first<{ n: number }>())?.n).toBe(1);
  });

  it('logs in with a secure 30-day cookie, stores only its hash and revokes it on logout', async () => {
    const { owner } = await fixture();
    expect(await login(db, owner.login, 'wrong-password')).toBeNull();
    expect(await login(db, 'unknown-owner', ownerPassword)).toBeNull();
    const response = await request('/admin/login?lang=ru', { form: { login: owner.login, password: ownerPassword } });
    expect(response.status).toBe(303);
    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=2592000', 'Path=/']) expect(cookie).toContain(attribute);
    const token = cookie.split(';')[0].split('=')[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const session = await db.prepare('SELECT token_hash, expires_at, created_at FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).first<{ token_hash: string; expires_at: string; created_at: string }>();
    expect(session?.token_hash).not.toBe(token);
    expect(Date.parse(session!.expires_at.replace(' ', 'T') + 'Z') - Date.parse(session!.created_at.replace(' ', 'T') + 'Z')).toBe(30 * 86400 * 1000);
    expect(await getSession(db, token)).toMatchObject({ id: owner.id, ui_lang: 'ru' });
    const panel = await request(`/admin/cafes/${owner.cafe_id}`, { token });
    expect(panel.status).toBe(200);
    expect(await panel.text()).toContain('<html lang="ru">');
    const out = await request('/admin/logout', { method: 'POST', token });
    expect(out.status).toBe(303);
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await getSession(db, token)).toBeNull();
  });

  it('rejects expired, malformed and deleted sessions on the next protected request', async () => {
    const { ownerToken, cafeId } = await fixture();
    await db.prepare("UPDATE sessions SET expires_at = datetime('now', '-1 second') WHERE token_hash = ?").bind(await hashToken(ownerToken)).run();
    expect(await getSession(db, ownerToken)).toBeNull();
    const response = await request(`/admin/cafes/${cafeId}`, { token: ownerToken });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/admin/login');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(await getSession(db, 'malformed')).toBeNull();
    const token = (await login(db, 'first-owner', ownerPassword))!;
    await logout(db, token);
    expect((await request(`/admin/cafes/${cafeId}`, { token })).status).toBe(303);
  });

  it('enforces Origin for every unsafe method, including JSON and missing or null origins', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const foreign of ['https://evil.test', 'https://menu.test.evil.test', 'null', null]) {
        expect((await request('/admin/login', { method, origin: foreign, form: { login: 'a', password: 'b' } })).status).toBe(403);
      }
    }
    expect((await app.request(`${origin}/admin/login`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' }, env)).status).toBe(403);
    expect((await request('/admin/login', { form: { login: 'unknown', password: 'wrong-password' } })).status).toBe(401);
    expect((await request('/admin/login')).status).toBe(200);
  });

  it('limits an IP to ten attempts atomically, isolates other IPs, and resets after a minute', async () => {
    const now = Math.floor(Date.now() / 1000);
    const attempts = await Promise.all(Array.from({ length: 11 }, () => takeLoginAttempt(db, '192.0.2.1', now)));
    expect(attempts.filter((value) => value.allowed)).toHaveLength(10);
    const response = await request('/admin/login', { form: { login: 'unknown', password: 'wrong-password' } });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await takeLoginAttempt(db, '192.0.2.2', now)).allowed).toBe(true);
    expect((await takeLoginAttempt(db, '192.0.2.1', now + 60)).allowed).toBe(true);
    const rows = (await db.prepare('SELECT ip_hash FROM auth_rate_limits').all<{ ip_hash: string }>()).results;
    expect(rows.every((row) => !row.ip_hash.includes('192.0.2.'))).toBe(true);
  });

  it('rejects another cafe, superadmin pages and password disclosure for an owner', async () => {
    const { superUser, ownerToken, cafeId } = await fixture();
    await createCafeOwner(env, superUser, { slug: 'private-cafe', name_ky: 'Жашыруун кафе', login: 'second-owner', password: 'Second-owner-123' });
    const second = await db.prepare("SELECT cafe_id FROM users WHERE login = 'second-owner'").first<{ cafe_id: number }>();
    const response = await request(`/admin/cafes/${second!.cafe_id}`, { token: ownerToken });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('Жашыруун кафе');
    expect((await request(`/admin/cafes/${second!.cafe_id}/categories`, { token: ownerToken, form: { name_ky: 'Чоочун' } })).status).toBe(403);
    expect((await request('/admin/super', { token: ownerToken })).status).toBe(403);
    const password = await request(`/admin/super/cafes/${cafeId}/password`, { token: ownerToken });
    expect(password.status).toBe(403);
    expect(await password.text()).not.toContain(ownerPassword);
    expect((await request(`/admin/super/cafes/${cafeId}/status`, { token: ownerToken, form: { is_active: '0' } })).status).toBe(403);
    const foreignCategory = await createCategory(db, second!.cafe_id, { name_ky: 'Чоочун категория' });
    expect((await request(`/admin/cafes/${cafeId}/items`, { token: ownerToken, form: { category_id: String(foreignCategory.id), name_ky: 'Тамак', price: '180' } })).status).toBe(403);
  });

  it('revokes all devices on password change and never creates a session from an earlier credential check', async () => {
    const { superUser, superToken, owner, ownerToken, cafeId } = await fixture();
    const secondDevice = (await login(db, owner.login, ownerPassword))!;
    const response = await request(`/admin/super/cafes/${cafeId}/credentials`, { token: superToken, form: { login: owner.login, password: 'Changed-password-123' } });
    expect(response.status).toBe(303);
    expect(await getSession(db, ownerToken)).toBeNull();
    expect(await getSession(db, secondDevice)).toBeNull();
    expect((await db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').bind(owner.id).first<{ n: number }>())?.n).toBe(0);
    expect((await request(`/admin/cafes/${cafeId}`, { token: secondDevice })).status).toBe(303);
    expect(await createSession(db, owner)).toBeNull();
    expect(await login(db, owner.login, ownerPassword)).toBeNull();
    expect(await login(db, owner.login, 'Changed-password-123')).not.toBeNull();
    expect(await revealOwnerPassword(env, superUser, cafeId)).toBe('Changed-password-123');
  });

  it('revokes all sessions on login-only changes and leaves the existing password valid', async () => {
    const { superUser, owner, ownerToken, cafeId } = await fixture();
    const secondDevice = (await login(db, owner.login, ownerPassword))!;
    await updateOwnerCredentials(env, superUser, cafeId, 'renamed-owner');
    expect(await getSession(db, ownerToken)).toBeNull();
    expect(await getSession(db, secondDevice)).toBeNull();
    expect(await login(db, owner.login, ownerPassword)).toBeNull();
    expect(await login(db, 'renamed-owner', ownerPassword)).not.toBeNull();
    expect(await revealOwnerPassword(env, superUser, cafeId)).toBe(ownerPassword);
  });

  it('cafe pause deletes every owner session and blocks login; resume never restores old sessions', async () => {
    const { superUser, superToken, owner, ownerToken, cafeId } = await fixture();
    const secondDevice = (await login(db, owner.login, ownerPassword))!;
    expect((await request(`/admin/super/cafes/${cafeId}/status`, { token: superToken, form: { is_active: '0' } })).status).toBe(303);
    expect(await getSession(db, ownerToken)).toBeNull();
    expect(await getSession(db, secondDevice)).toBeNull();
    expect(await login(db, owner.login, ownerPassword)).toBeNull();
    expect(await createSession(db, owner)).toBeNull();
    expect((await request('/admin/login', { form: { login: owner.login, password: ownerPassword } })).status).toBe(401);
    expect((await db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').bind(owner.id).first<{ n: number }>())?.n).toBe(0);
    expect((await request(`/admin/cafes/${cafeId}`, { token: superToken })).status).toBe(200);
    expect(await getSession(db, superToken)).not.toBeNull();
    await setCafeActive(db, superUser, cafeId, 1);
    expect(await getSession(db, ownerToken)).toBeNull();
    expect(await login(db, owner.login, ownerPassword)).not.toBeNull();
  });

  it('superadmin sees masked passwords, counts and dates; only the authorized endpoint decrypts them', async () => {
    const { superToken, cafeId } = await fixture();
    const response = await request('/admin/super', { token: superToken });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const html = await response.text();
    expect(html).toContain('Кафелердин жалпы саны');
    expect(html).toContain('<p class="stat">1</p>');
    expect(html).toContain('first-owner');
    expect(html).toContain('••••••');
    expect(html).toContain('Бишкек убактысы');
    expect(html).not.toContain(ownerPassword);
    expect(html).not.toContain(superPassword);
    expect(html).not.toContain('pbkdf2-sha256$');
    const password = await request(`/admin/super/cafes/${cafeId}/password`, { token: superToken });
    expect(password.headers.get('Cache-Control')).toContain('no-store');
    expect(await password.json()).toEqual({ password: ownerPassword });
    await logout(db, superToken);
    const stale = await request(`/admin/super/cafes/${cafeId}/password`, { token: superToken });
    expect(stale.status).toBe(303);
    expect(await stale.text()).not.toContain(ownerPassword);
  });

  it('creates cafe and manually supplied owner credentials together; duplicate login leaves no partial cafe', async () => {
    const { superToken } = await fixture();
    const form = { name_ky: '<img src=x onerror=alert(1)>', name_ru: 'Кафе', slug: 'new-cafe', login: 'manual-owner', password: 'Manual-password-123' };
    expect((await request('/admin/super/cafes', { token: superToken, form })).status).toBe(303);
    const user = await db.prepare("SELECT * FROM users WHERE login = 'manual-owner'").first<User>();
    expect(await verifyPassword(form.password, user!.password_hash)).toBe(true);
    expect(user!.password_enc).not.toContain(form.password);
    expect(await login(db, form.login, form.password)).not.toBeNull();
    const html = await (await request('/admin/super', { token: superToken })).text();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect((await request('/admin/super/cafes', { token: superToken, form: { ...form, slug: 'orphan-cafe' } })).status).toBe(409);
    expect(await db.prepare('SELECT id FROM cafes WHERE slug = ?').bind('orphan-cafe').first()).toBeNull();
    expect((await request('/admin/super/cafes', { token: superToken, form: { ...form, slug: 'Bad slug', login: 'new-login' } })).status).toBe(400);
  });

  it('superadmin can enter and edit a cafe menu while every item and variant stays scoped', async () => {
    const { superToken, ownerToken, cafeId } = await fixture();
    const base = `/admin/cafes/${cafeId}`;
    expect((await request(base, { token: superToken })).status).toBe(200);
    expect((await request(`${base}/categories`, { token: superToken, form: { name_ky: 'Суусундуктар' } })).status).toBe(303);
    const category = await db.prepare('SELECT id FROM categories WHERE cafe_id = ?').bind(cafeId).first<{ id: number }>();
    expect((await request(`${base}/items`, { token: superToken, form: { category_id: String(category!.id), name_ky: 'Чай', price: '50', label: 'Чыны' } })).status).toBe(303);
    const item = await db.prepare('SELECT id FROM items WHERE cafe_id = ?').bind(cafeId).first<{ id: number }>();
    expect((await request(`${base}/items/${item!.id}`, { token: ownerToken, form: { category_id: String(category!.id), name_ky: 'Көк чай', is_available: '1', ingredients_ky: 'Чай' } })).status).toBe(303);
    const variant = await db.prepare('SELECT id FROM item_variants WHERE item_id = ?').bind(item!.id).first<{ id: number }>();
    expect((await request(`${base}/items/${item!.id}/variants/${variant!.id}`, { token: superToken, form: { label: 'Чыны', price: '60' } })).status).toBe(303);
    const html = await (await request(base, { token: ownerToken })).text();
    expect(html).toContain('Көк чай');
    expect(html).toContain('60 сом');
    expect(html).not.toContain(ownerPassword);
  });

  it('persists KY/RU for the signed-in user and prevents external return redirects', async () => {
    const { ownerToken, owner, superUser } = await fixture();
    const response = await request('/admin/language', { token: ownerToken, form: { lang: 'ru', return_to: 'https://evil.test', user_id: String(superUser.id) } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/admin');
    expect(await getSession(db, ownerToken)).toMatchObject({ id: owner.id, ui_lang: 'ru' });
    expect((await db.prepare('SELECT ui_lang FROM users WHERE id = ?').bind(superUser.id).first<{ ui_lang: string }>())?.ui_lang).toBe('ky');
    const page = await request(`/admin/cafes/${owner.cafe_id}`, { token: ownerToken });
    expect(await page.text()).toContain('<html lang="ru">');
  });

  it('does not register users, echoes no submitted passwords, and applies nonce CSP and no-store', async () => {
    const page = await request('/admin/login?lang=ru');
    const html = await page.text();
    expect(html).toContain('name="login"');
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('/register');
    const nonce = html.match(/<style nonce="([^"]+)"/)![1];
    expect(page.headers.get('Content-Security-Policy')).toContain(`'nonce-${nonce}'`);
    expect(page.headers.get('Cache-Control')).toContain('no-store');
    expect(page.headers.get('Referrer-Policy')).toBe('same-origin');
    expect((await request('/admin/register')).status).not.toBe(200);
    const invalid = await request('/admin/login', { form: { login: 'unknown', password: 'Do-not-echo-123' } });
    expect(await invalid.text()).not.toContain('Do-not-echo-123');
    const large = await request('/admin/login', { form: { login: 'unknown', password: 'x'.repeat(20_000) } });
    expect(large.status).toBe(413);
  });
});
