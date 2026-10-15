import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { User } from '../db/types';
import type { AppEnv, AuthUser } from '../types';
import { AppError } from './errors';

export const SESSION_COOKIE = '__Host-jeti_session';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 2048) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0));
}

export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function equalSecrets(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hashToken(a), hashToken(b)]);
  return equalBytes(encoder.encode(left), encoder.encode(right));
}

export function isValidLogin(login: string): boolean {
  return /^[\p{L}\p{N}._-]{3,40}$/u.test(login);
}

export function validateCredentials(login: string, password?: string): void {
  if (!isValidLogin(login)) throw new AppError(400, 'invalidLogin');
  if (password !== undefined && (password.length < 8 || password.length > 128)) {
    throw new AppError(400, 'invalidPassword');
  }
}

async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8 || password.length > 128) throw new AppError(400, 'invalidPassword');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(await derivePassword(password, salt))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > 128) return false;
  try {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256' || parts[1] !== String(PBKDF2_ITERATIONS)) return false;
    const salt = fromBase64Url(parts[2]);
    const expected = fromBase64Url(parts[3]);
    if (salt.length !== 16 || expected.length !== 32) return false;
    return equalBytes(await derivePassword(password, salt), expected);
  } catch {
    return false;
  }
}

// An unknown login still performs PBKDF2, keeping the error and expensive work the same.
const dummyHash = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(new Uint8Array(16))}$${toBase64Url(new Uint8Array(32))}`;

export async function createSession(db: D1Database, credentials: Pick<User, 'id' | 'login' | 'password_hash'>): Promise<string | null> {
  const token = randomToken();
  // Recheck the credentials and cafe in the insert itself. A concurrent password
  // change or pause cannot issue a fresh session using an earlier successful check.
  const result = await db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    SELECT ?, u.id, datetime('now', '+30 days') FROM users u
    LEFT JOIN cafes c ON c.id = u.cafe_id
    WHERE u.id = ? AND u.login = ? AND u.password_hash = ?
      AND (u.role = 'superadmin' OR (u.role = 'owner' AND c.is_active = 1))
  `).bind(await hashToken(token), credentials.id, credentials.login, credentials.password_hash).run();
  return result.meta.changes === 1 ? token : null;
}

export async function getSession(db: D1Database, token?: string): Promise<AuthUser | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare(`
    SELECT u.id, u.login, u.role, u.cafe_id, u.ui_lang
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN cafes c ON c.id = u.cafe_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP
      AND (u.role = 'superadmin' OR (u.role = 'owner' AND c.is_active = 1))
  `).bind(await hashToken(token)).first<AuthUser>();
}

export async function login(db: D1Database, loginName: string, password: string): Promise<string | null> {
  if (!isValidLogin(loginName) || password.length > 128) return null;
  const user = await db.prepare('SELECT * FROM users WHERE login = ?').bind(loginName).first<User>();
  const valid = await verifyPassword(password, user?.password_hash ?? dummyHash);
  if (!user || !valid) return null;
  return createSession(db, user);
}

export async function logout(db: D1Database, token?: string): Promise<void> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
}

const cookieOptions = { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const };

export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function writeSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_SECONDS, expires: new Date(Date.now() + SESSION_SECONDS * 1000) });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  setCookie(c, SESSION_COOKIE, '', { ...cookieOptions, maxAge: 0, expires: new Date(0) });
}

async function passwordViewKey(secret?: string): Promise<CryptoKey> {
  try {
    const bytes = fromBase64Url(secret ?? '');
    if (bytes.length !== 32) throw new Error('Invalid key size');
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    throw new AppError(503, 'encryptionUnavailable');
  }
}

const passwordContext = encoder.encode('jeti-nur-menu:owner-password:v1');

export async function encryptOwnerPassword(password: string, secret?: string): Promise<string> {
  const key = await passwordViewKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: passwordContext }, key, encoder.encode(password));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Only call after checking a fresh session. This role check also protects service callers. */
export async function decryptOwnerPassword(requester: AuthUser, encrypted: string, secret?: string): Promise<string> {
  if (requester.role !== 'superadmin') throw new AppError(403, 'forbidden');
  const key = await passwordViewKey(secret);
  try {
    const parts = encrypted.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Invalid ciphertext');
    const iv = fromBase64Url(parts[1]);
    if (iv.length !== 12) throw new Error('Invalid nonce');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: passwordContext }, key, fromBase64Url(parts[2]));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
  } catch {
    throw new AppError(503, 'encryptionUnavailable');
  }
}

/** Atomic, shared across Worker isolates. No raw IP address is stored. */
export async function takeLoginAttempt(db: D1Database, ip: string, now = Math.floor(Date.now() / 1000)): Promise<{ allowed: boolean; retryAfter: number }> {
  const results = await db.batch<{ attempts: number; window_start: number }>([
    db.prepare('DELETE FROM auth_rate_limits WHERE window_start <= ?').bind(now - 60),
    db.prepare(`
      INSERT INTO auth_rate_limits (ip_hash, window_start, attempts) VALUES (?, ?, 1)
      ON CONFLICT(ip_hash) DO UPDATE SET attempts = min(auth_rate_limits.attempts + 1, 11)
      RETURNING attempts, window_start
    `).bind(await hashToken(ip), now),
  ]);
  const row = results[1].results[0];
  return { allowed: row.attempts <= 10, retryAfter: Math.max(1, row.window_start + 60 - now) };
}
