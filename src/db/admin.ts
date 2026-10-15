import type { Cafe, User } from './types';
import type { AppEnv, AuthUser } from '../types';
import { decryptOwnerPassword, encryptOwnerPassword, equalSecrets, hashPassword, validateCredentials } from '../lib/auth';
import { AppError } from '../lib/errors';
import { isValidSlug } from '../lib/slug';
import { publishMenu, rebuildMenu } from '../lib/publish';

export type CafeOwnerRow = Cafe & { owner_id: number | null; owner_login: string | null };

export function hasSuperadmin(db: D1Database): Promise<{ id: number } | null> {
  return db.prepare("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1").first<{ id: number }>();
}

export function setupConfigured(env: AppEnv['Bindings']): boolean {
  try {
    validateCredentials(env.SETUP_LOGIN ?? '', env.SETUP_PASSWORD ?? '');
    return true;
  } catch {
    return false;
  }
}

export async function setupSuperadmin(env: AppEnv['Bindings'], login: string, password: string): Promise<void> {
  if (await hasSuperadmin(env.DB)) throw new AppError(404, 'notFound');
  if (!setupConfigured(env)) throw new AppError(503, 'setupUnavailable');
  const [validLogin, validPassword] = await Promise.all([
    equalSecrets(login, env.SETUP_LOGIN!), equalSecrets(password, env.SETUP_PASSWORD!),
  ]);
  if (!validLogin || !validPassword) throw new AppError(401, 'invalidCredentials');
  const result = await env.DB.prepare(`
    INSERT INTO users (login, password_hash, role, cafe_id, password_enc)
    SELECT ?, ?, 'superadmin', NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'superadmin')
  `).bind(env.SETUP_LOGIN, await hashPassword(env.SETUP_PASSWORD!)).run();
  if (result.meta.changes !== 1) throw new AppError(404, 'notFound');
}

function assertSuperadmin(user: AuthUser): void {
  if (user.role !== 'superadmin') throw new AppError(403, 'forbidden');
}

export async function listCafeOwners(db: D1Database, requester: AuthUser): Promise<CafeOwnerRow[]> {
  assertSuperadmin(requester);
  // Deliberately exclude hashes and encrypted passwords from the list response.
  return (await db.prepare(`
    SELECT c.*, u.id AS owner_id, u.login AS owner_login FROM cafes c
    LEFT JOIN users u ON u.cafe_id = c.id AND u.role = 'owner' ORDER BY c.id DESC, u.id
  `).all<CafeOwnerRow>()).results;
}

export interface NewCafeOwner {
  slug: string;
  name_ky: string;
  name_ru?: string;
  login: string;
  password: string;
}

export function validateName(name: string): string {
  const value = name.trim();
  if (value.length < 1 || value.length > 120) throw new AppError(400, 'invalidName');
  return value;
}

export async function createCafeOwner(env: AppEnv['Bindings'], requester: AuthUser, input: NewCafeOwner): Promise<void> {
  assertSuperadmin(requester);
  validateCredentials(input.login, input.password);
  if (!isValidSlug(input.slug)) throw new AppError(400, 'invalidSlug');
  const nameKy = validateName(input.name_ky);
  const nameRu = input.name_ru?.trim() ? validateName(input.name_ru) : null;
  const [hash, encrypted] = await Promise.all([
    hashPassword(input.password), encryptOwnerPassword(input.password, env.PASSWORD_VIEW_KEY),
  ]);
  let cafeId: number;
  try {
    const results = await env.DB.batch([
      env.DB.prepare('INSERT INTO cafes (slug, name_ky, name_ru) VALUES (?, ?, ?) RETURNING id').bind(input.slug, nameKy, nameRu),
      env.DB.prepare(`
        INSERT INTO users (login, password_hash, role, cafe_id, password_enc)
        VALUES (?, ?, 'owner', last_insert_rowid(), ?)
      `).bind(input.login, hash, encrypted),
    ]);
    cafeId = (results[0].results[0] as { id: number }).id;
  } catch {
    throw new AppError(409, 'duplicateCafeOrLogin');
  }
  await rebuildMenu(env.DB, cafeId);
}

export async function updateOwnerCredentials(env: AppEnv['Bindings'], requester: AuthUser, cafeId: number, login: string, password?: string): Promise<void> {
  assertSuperadmin(requester);
  validateCredentials(login, password);
  const user = await env.DB.prepare("SELECT id FROM users WHERE cafe_id = ? AND role = 'owner'").bind(cafeId).first<{ id: number }>();
  if (!user) throw new AppError(404, 'notFound');
  let statement: D1PreparedStatement;
  if (password !== undefined) {
    const [hash, encrypted] = await Promise.all([hashPassword(password), encryptOwnerPassword(password, env.PASSWORD_VIEW_KEY)]);
    statement = env.DB.prepare(`
      UPDATE users SET login = ?, password_hash = ?, password_enc = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND cafe_id = ? AND role = 'owner'
    `).bind(login, hash, encrypted, user.id, cafeId);
  } else {
    statement = env.DB.prepare("UPDATE users SET login = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND cafe_id = ? AND role = 'owner'")
      .bind(login, user.id, cafeId);
  }
  try {
    // The migration trigger deletes every session in this same transaction.
    const result = await statement.run();
    if (result.meta.changes === 0) throw new AppError(404, 'notFound');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(409, 'duplicateCafeOrLogin');
  }
}

export async function setCafeActive(db: D1Database, requester: AuthUser, cafeId: number, active: 0 | 1): Promise<void> {
  assertSuperadmin(requester);
  if (active !== 0 && active !== 1) throw new AppError(400, 'invalidForm');
  const { results } = await publishMenu(db, cafeId, [db.prepare('UPDATE cafes SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(active, cafeId)]);
  if (results[0].meta.changes === 0) throw new AppError(404, 'notFound');
}

export async function revealOwnerPassword(env: AppEnv['Bindings'], requester: AuthUser, cafeId: number): Promise<string> {
  assertSuperadmin(requester);
  const owner = await env.DB.prepare("SELECT password_enc FROM users WHERE cafe_id = ? AND role = 'owner'")
    .bind(cafeId).first<Pick<User, 'password_enc'>>();
  if (!owner?.password_enc) throw new AppError(404, 'notFound');
  return decryptOwnerPassword(requester, owner.password_enc, env.PASSWORD_VIEW_KEY);
}
