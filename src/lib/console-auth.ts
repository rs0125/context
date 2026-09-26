import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpError } from './errors';
import { rosterReadScopes, type Scope } from './auth';

export type ConsoleIdentity = { employeeId: number; email: string; name: string; isAdmin: boolean; scopes: Scope[] };
type Session = { employeeId: number; email: string; sub: string; iat: number; exp: number; sid: string };
export const CONSOLE_DOMAIN = 'wareongo.com';
export const SESSION_SECONDS = 8 * 60 * 60;
const GOOGLE_SUBJECT = /^google:[A-Za-z0-9_-]{1,255}$/;
function workEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && email === email.toLowerCase() && /^[^\s@]+@wareongo\.com$/.test(email);
}

export function consoleOrigin(env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try { url = new URL(env.CONTEXT_CONSOLE_ORIGIN ?? ''); }
  catch { throw new HttpError(503, 'CONSOLE_CONFIGURATION', 'Console sign-in is not configured.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new HttpError(503, 'CONSOLE_CONFIGURATION', 'Console sign-in is not configured.');
  }
  return url.origin;
}

export function consoleSecret(name: 'CONTEXT_SESSION_SECRET' | 'CONTEXT_KEY_ENCRYPTION_SECRET', env: NodeJS.ProcessEnv = process.env) {
  const value = env[name] ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new HttpError(503, 'CONSOLE_CONFIGURATION', 'Console secrets are not configured.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new HttpError(503, 'CONSOLE_CONFIGURATION', 'Console secrets are not configured.');
  return bytes;
}

export function consoleCookieName(kind: 'session' | 'oauth', env: NodeJS.ProcessEnv = process.env) {
  return `${consoleOrigin(env).startsWith('https:') ? '__Host-' : ''}context_console_${kind}`;
}

export function signedConsoleValue(payload: Record<string, unknown>, purpose: 'session' | 'google-oauth', env: NodeJS.ProcessEnv = process.env) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', consoleSecret('CONTEXT_SESSION_SECRET', env)).update(`${consoleOrigin(env)}|${purpose}.${body}`).digest('base64url');
  return `${body}.${signature}`;
}

export function readSignedConsoleValue(value: string, purpose: 'session' | 'google-oauth', env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.');
  const [body, signature] = value.split('.');
  const expected = createHmac('sha256', consoleSecret('CONTEXT_SESSION_SECRET', env)).update(`${consoleOrigin(env)}|${purpose}.${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.');
  try {
    const decoded: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    return decoded as Record<string, unknown>;
  } catch { throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.'); }
}

export function readConsoleCookie(request: Request, kind: 'session' | 'oauth', env: NodeJS.ProcessEnv = process.env) {
  const name = consoleCookieName(kind, env);
  const header = request.headers.get('cookie') ?? '';
  if (header.length > 16384) throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.');
  const entries = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (entries.length !== 1) throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.');
  return entries[0].slice(name.length + 1);
}

export function consoleCookie(kind: 'session' | 'oauth', value: string, maxAge: number, env: NodeJS.ProcessEnv = process.env) {
  return `${consoleCookieName(kind, env)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${consoleOrigin(env).startsWith('https:') ? '; Secure' : ''}`;
}

export function createConsoleSession(identity: ConsoleIdentity, sub: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  if (!GOOGLE_SUBJECT.test(sub) || !workEmail(identity.email)) throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.');
  const iat = Math.floor(now / 1000);
  return signedConsoleValue({ employeeId: identity.employeeId, email: identity.email, sub, iat, exp: iat + SESSION_SECONDS, sid: randomBytes(24).toString('base64url') }, 'session', env);
}

export function readConsoleSession(request: Request, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Session {
  const value = readSignedConsoleValue(readConsoleCookie(request, 'session', env), 'session', env);
  const seconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(value.employeeId) || Number(value.employeeId) <= 0
    || !workEmail(value.email)
    || typeof value.sub !== 'string' || !GOOGLE_SUBJECT.test(value.sub)
    || typeof value.sid !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.sid)
    || !Number.isInteger(value.iat) || !Number.isInteger(value.exp) || Number(value.iat) > seconds + 60
    || Number(value.exp) <= seconds || Number(value.exp) - Number(value.iat) !== SESSION_SECONDS
    || Object.keys(value).some(key => !['employeeId', 'email', 'sub', 'iat', 'exp', 'sid'].includes(key))) {
    throw new HttpError(401, 'CONSOLE_UNAUTHENTICATED', 'Sign in with your work account.');
  }
  return value as Session;
}

export async function resolveConsoleEmployee(client: PoolClient, email: string, expectedId?: number): Promise<ConsoleIdentity> {
  if (!workEmail(email)) throw new HttpError(403, 'CONSOLE_ACCESS_DENIED', 'Console access is unavailable for this account.');
  const { rows } = await client.query<{ id: number; email: string; name: string; is_active: boolean; adminAccess: boolean; dashboardAccess: boolean; twenty_user_id: string | null }>(
    `SELECT id, email, name, is_active, "adminAccess", "dashboardAccess", twenty_user_id
       FROM public."VerifiedNumber" WHERE lower(email) = $1 LIMIT 2`, [email]);
  const employee = rows[0];
  if (rows.length !== 1 || !employee || employee.is_active !== true || !Number.isSafeInteger(employee.id) || employee.id <= 0
    || (expectedId !== undefined && employee.id !== expectedId) || employee.email?.toLowerCase() !== email) {
    throw new HttpError(403, 'CONSOLE_ACCESS_DENIED', 'Console access is unavailable for this account.');
  }
  return { employeeId: employee.id, email, name: typeof employee.name === 'string' ? employee.name.slice(0, 200) : '',
    isAdmin: employee.adminAccess === true, scopes: rosterReadScopes(employee) };
}

export async function getConsoleIdentity(request: Request, client: PoolClient): Promise<ConsoleIdentity> {
  const session = readConsoleSession(request);
  return resolveConsoleEmployee(client, session.email, session.employeeId);
}

export function requireConsoleOrigin(request: Request) {
  const expected = consoleOrigin();
  if (new URL(request.url).origin !== expected || request.headers.get('origin') !== expected
    || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'CONSOLE_ORIGIN_DENIED', 'This action must come from the console.');
}

export function consoleWritesEnabled() { return process.env.CONTEXT_CONSOLE_WRITES_ENABLED === 'true'; }
export function requireConsoleWrites() {
  if (!consoleWritesEnabled()) throw new HttpError(503, 'CONSOLE_SETUP_REQUIRED', 'Console storage is not enabled yet.');
}

export function consoleJson(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
}

export function consoleErrorResponse(error: unknown) {
  const safe = error instanceof HttpError ? error : new HttpError(503, 'CONSOLE_UNAVAILABLE', 'The console is temporarily unavailable.');
  const response = consoleJson({ error: { code: safe.code, message: safe.message } }, safe.status);
  if (safe.status === 429) response.headers.set('Retry-After', '60');
  return response;
}
