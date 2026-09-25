import { createHash, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { consoleAdminEmail, consoleCookie, consoleErrorResponse, consoleJson, createConsoleSession, PASSWORD_SESSION_SUBJECT, requireConsoleOrigin, resolveConsoleEmployee, SESSION_SECONDS } from './console-auth';
import { withReadOnlyTransaction } from './db';
import { HttpError } from './errors';
import { rateLimit } from './rate-limit';

const MAX_BODY_BYTES = 4096;
type Dependencies = {
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
  limit: () => void;
};

function configuredPassword(env: NodeJS.ProcessEnv = process.env) {
  const value = env.CONTEXT_ADMIN_PASSWORD ?? '';
  if (value.length < 24 || value.length > 256 || value.trim().length < 24) {
    throw new HttpError(503, 'CONSOLE_CONFIGURATION', 'Console sign-in is not configured.');
  }
  return value;
}

export function matchesConsolePassword(candidate: string, env: NodeJS.ProcessEnv = process.env) {
  const expected = createHash('sha256').update(configuredPassword(env)).digest();
  const actual = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expected, actual);
}

async function readPassword(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'INVALID_CONTENT_TYPE', 'Send a JSON password request.');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'The sign-in request is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_BODY', 'Send a JSON password request.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'BODY_TOO_LARGE', 'The sign-in request is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new HttpError(400, 'INVALID_BODY', 'Send a JSON password request.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !('password' in value) || typeof value.password !== 'string' || value.password.length > 256) {
    throw new HttpError(400, 'INVALID_BODY', 'Send a JSON password request.');
  }
  return value.password;
}

export async function handlePasswordLogin(request: Request, dependencies: Partial<Dependencies> = {}) {
  try {
    requireConsoleOrigin(request);
    if (request.method !== 'POST' || new URL(request.url).search) {
      throw new HttpError(400, 'INVALID_REQUEST', 'Send a password sign-in request.');
    }
    // One fixed process-wide bucket also bounds invalid attempts without allocating per-user state.
    (dependencies.limit ?? (() => rateLimit('auth:console-password', Date.now(), 10)))();
    const email = consoleAdminEmail();
    const password = await readPassword(request);
    if (!matchesConsolePassword(password)) {
      throw new HttpError(401, 'CONSOLE_INVALID_CREDENTIALS', 'Password verification failed.');
    }
    const identity = await (dependencies.transaction ?? withReadOnlyTransaction)(client => resolveConsoleEmployee(client, email));
    const response = consoleJson({ ok: true });
    response.headers.append('Set-Cookie', consoleCookie('session', createConsoleSession(identity, PASSWORD_SESSION_SUBJECT), SESSION_SECONDS));
    return response;
  } catch (error) { return consoleErrorResponse(error); }
}
