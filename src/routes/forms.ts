import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { AppError } from '../lib/errors';

export async function readForm(c: Context<AppEnv>): Promise<Record<string, string | File | (string | File)[]>> {
  if (!c.req.header('Content-Type')?.startsWith('application/x-www-form-urlencoded')) throw new AppError(400, 'invalidForm');
  return c.req.parseBody({ all: true });
}

export function text(form: Record<string, unknown>, name: string): string {
  const value = form[name];
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new AppError(400, 'invalidForm');
  return value;
}

export function parsePrice(value: string): number {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AppError(400, 'invalidPrice');
  return Number(value);
}
