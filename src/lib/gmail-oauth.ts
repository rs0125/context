import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CONSOLE_DOMAIN, consoleErrorResponse, consoleJson, consoleOrigin, consoleSecret,
  getConsoleIdentity, readConsoleSession, readSignedConsoleValue, requireConsoleOrigin, signedConsoleValue,
} from './console-auth';
import { verifyGoogleIdToken } from './console-google';
import { withGmailWriteTransaction, withReadOnlyTransaction, withSessionWriteTransaction } from './db';
import { GMAIL_COMPOSE_SCOPE } from './gmail-client';
import { completeGmailDisconnect, decryptGmailSecret, disconnectGmailConnection, getGmailConnection, saveGmailConnection, type GmailConnection } from './gmail-storage';
import { HttpError } from './errors';
import { anonymousRequestLimit } from './rate-limit';

export const GMAIL_CALLBACK_PATH = '/api/mail/google/callback';
const FLOW_SECONDS = 600;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const ALLOWED_SCOPES = new Set(['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email', GMAIL_COMPOSE_SCOPE]);
type Flow = {
  kind: 'gmail-connect'; state: string; nonce: string; verifier: string; clientId: string;
  employeeId: number; email: string; sub: string; sid: string;
  connectionId: string | null; connectionVersion: number | null; iat: number; exp: number;
};
type Dependencies = {
  fetch: typeof fetch; transaction: typeof withReadOnlyTransaction;
  writeTransaction: typeof withGmailWriteTransaction; disconnectTransaction: typeof withSessionWriteTransaction;
  verify: typeof verifyGoogleIdToken; limit: typeof anonymousRequestLimit; now: () => number;
};
const defaults: Dependencies = {
  fetch: (...args) => fetch(...args), transaction: withReadOnlyTransaction, writeTransaction: withGmailWriteTransaction,
  disconnectTransaction: withSessionWriteTransaction, verify: verifyGoogleIdToken, limit: anonymousRequestLimit, now: Date.now,
};
function unavailable() { return new HttpError(503, 'GMAIL_OAUTH_UNAVAILABLE', 'Gmail connection is temporarily unavailable.'); }
function invalid() { return new HttpError(401, 'GMAIL_OAUTH_INVALID', 'Gmail connection expired or could not be verified. Please try again.'); }
function changed() { return new HttpError(409, 'GMAIL_CONNECTION_CHANGED', 'Your Gmail connection changed. Please start again.'); }
function scopeRequired() { return new HttpError(403, 'GMAIL_SCOPE_REQUIRED', 'Allow Gmail draft access to connect your mailbox.'); }
function configuration(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.CONTEXT_GMAIL_CLIENT_ID ?? '', clientSecret = env.CONTEXT_GMAIL_CLIENT_SECRET ?? '';
  const key = env.CONTEXT_GMAIL_ENCRYPTION_KEY ?? '';
  if (!/^[A-Za-z0-9._-]{1,250}\.apps\.googleusercontent\.com$/.test(clientId)
    || clientSecret.length < 8 || clientSecret.length > 512 || /\s/.test(clientSecret)
    || !RANDOM.test(key) || Buffer.from(key, 'base64url').length !== 32 || Buffer.from(key, 'base64url').toString('base64url') !== key) {
    throw new HttpError(503, 'GMAIL_CONFIGURATION', 'Gmail connection is not configured.');
  }
  consoleSecret('CONTEXT_SESSION_SECRET', env);
  return { clientId, clientSecret, redirectUri: `${consoleOrigin(env)}${GMAIL_CALLBACK_PATH}` };
}
export function gmailAvailability(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; configured: boolean; available: boolean } {
  const enabled = env.CONTEXT_GMAIL_ENABLED === 'true';
  let configured = false;
  try { configuration(env); configured = true; } catch { /* Configuration details stay server-side. */ }
  return { enabled, configured, available: enabled && configured };
}
function requireAvailable(env: NodeJS.ProcessEnv = process.env) {
  if (env.CONTEXT_GMAIL_ENABLED !== 'true') throw new HttpError(503, 'GMAIL_DISABLED', 'Gmail drafts are not enabled yet.');
  return configuration(env);
}
function redirect(url: string, status = 303) {
  return new Response(null, { status, headers: { Location: url, 'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache', Vary: 'Cookie', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
function cookieName() { return `${consoleOrigin().startsWith('https:') ? '__Host-' : ''}context_gmail_oauth`; }
function flowCookie(value: string, seconds: number) {
  return `${cookieName()}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${consoleOrigin().startsWith('https:') ? '; Secure' : ''}`;
}
function readFlowCookie(request: Request) {
  const cookie = request.headers.get('cookie') ?? '';
  if (cookie.length > 16_384) throw invalid();
  const entries = cookie.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName()}=`));
  if (entries.length !== 1) throw invalid();
  return entries[0].slice(cookieName().length + 1);
}
function failure(error: unknown, clear = false) {
  try {
    const code = error instanceof HttpError && error.code === 'GMAIL_OAUTH_CANCELLED' ? 'cancelled'
      : error instanceof HttpError && error.code === 'GMAIL_SCOPE_REQUIRED' ? 'scope'
        : error instanceof HttpError && error.code === 'GMAIL_SCOPE_UNSUPPORTED' ? 'scope_excess'
        : error instanceof HttpError && error.code === 'GMAIL_DISCONNECT_PENDING' ? 'disconnect_pending'
        : error instanceof HttpError && error.code === 'GMAIL_CONNECTION_CHANGED' ? 'changed'
          : error instanceof HttpError && error.status === 403 ? 'denied'
            : error instanceof HttpError && [400, 401].includes(error.status) ? 'expired' : 'unavailable';
    const response = redirect(`${consoleOrigin()}/mail?error=${code}`);
    if (clear) response.headers.append('Set-Cookie', flowCookie('', 0));
    return response;
  } catch { return consoleErrorResponse(unavailable()); }
}
function owner(identity: { employeeId: number; email: string }) { return { employeeId: identity.employeeId, employeeEmail: identity.email }; }
function summary(connection: GmailConnection | null) {
  return connection ? { connected: connection.status === 'active', status: connection.status, accountEmail: connection.accountEmail, updatedAt: connection.updatedAt }
    : { connected: false, status: 'disconnected' as const, accountEmail: null, updatedAt: null };
}
function sameConnection(connection: GmailConnection | null, flow: Flow) {
  if ((connection?.id ?? null) !== flow.connectionId || (connection?.version ?? null) !== flow.connectionVersion) throw changed();
}

/** Fixed Google OAuth endpoints; never return provider descriptions.
 * The deadline also covers a body stream that ignores fetch cancellation. */
async function googlePost(parameters: URLSearchParams, requestFetch: typeof fetch, signal?: AbortSignal, operation: 'token' | 'revoke' = 'token'): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw new HttpError(499, 'GMAIL_ABORTED', 'Gmail connection was cancelled.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, operation === 'revoke' ? 2_000 : 5_000);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(unavailable());
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await Promise.race([requestFetch(operation === 'revoke' ? REVOKE_URL : TOKEN_URL, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: parameters,
    }), aborted]);
    if (response.redirected) throw unavailable();
    // Google documents an empty 200 response for successful revocation.
    if (operation === 'revoke' && response.status === 200) return {};
    if ((response.ok && response.status !== 200)
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw unavailable();
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 32_768)) throw unavailable();
    if (!response.body) throw unavailable();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) throw unavailable();
      chunks.push(value);
    }
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw unavailable();
    if (!response.ok) {
      // Retrying after a lost success response may encounter an already invalid token.
      if (operation === 'revoke' && response.status === 400 && 'error' in data && data.error === 'invalid_token') return {};
      if ('error' in data && data.error === 'invalid_grant') throw new HttpError(401, 'GMAIL_RECONNECT_REQUIRED', 'Reconnect your Gmail account to continue.');
      throw unavailable();
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
    controller.abort();
  }
}
async function revokeGmailRefreshToken(connection: GmailConnection, requestFetch: typeof fetch, signal?: AbortSignal) {
  if (!connection.encryptedRefreshToken) throw unavailable();
  const token = decryptGmailSecret(connection.encryptedRefreshToken, {
    purpose: 'refresh_token', employeeId: connection.employeeId, id: connection.id,
  });
  if (!TOKEN.test(token)) throw unavailable();
  // Revocation deliberately works even if drafting or OAuth client config is disabled.
  await googlePost(new URLSearchParams({ token }), requestFetch, signal, 'revoke');
}
function grantedScopes(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 4096) throw scopeRequired();
  const scopes = [...new Set(value.split(' ').filter(Boolean))];
  if (scopes.length > 20 || scopes.some(scope => !/^[A-Za-z0-9_:/.-]{1,200}$/.test(scope)) || !scopes.includes(GMAIL_COMPOSE_SCOPE)) throw scopeRequired();
  if (scopes.some(scope => !ALLOWED_SCOPES.has(scope))) throw new HttpError(403, 'GMAIL_SCOPE_UNSUPPORTED', 'The Google grant contains unsupported permissions. Remove existing app access in your Google Account, then reconnect.');
  return scopes;
}
export async function refreshGmailAccessToken(refreshToken: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env, requestFetch: typeof fetch = globalThis.fetch): Promise<string> {
  const config = requireAvailable(env);
  if (!TOKEN.test(refreshToken)) throw invalid();
  const data = await googlePost(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
    grant_type: 'refresh_token', refresh_token: refreshToken }), requestFetch, signal);
  if (typeof data.access_token !== 'string' || !TOKEN.test(data.access_token)
    || data.token_type !== 'Bearer' || typeof data.expires_in !== 'number' || !Number.isInteger(data.expires_in) || data.expires_in <= 0) throw unavailable();
  if (data.scope !== undefined) grantedScopes(data.scope);
  return data.access_token;
}

export async function handleGmailConnect(request: Request, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  try {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/mail/google/connect' || new URL(request.url).search) throw invalid();
    requireConsoleOrigin(request);
    const config = requireAvailable();
    const session = readConsoleSession(request);
    deps.limit(request, 'gmail:connect', 20);
    const { identity, connection } = await deps.transaction(async client => {
      const identity = await getConsoleIdentity(request, client);
      return { identity, connection: await getGmailConnection(client, owner(identity)) };
    });
    if (connection?.status === 'revoking') throw new HttpError(409, 'GMAIL_DISCONNECT_PENDING', 'Finish disconnecting Gmail before reconnecting.');
    const iat = Math.floor(deps.now() / 1000);
    const flow: Flow = {
      kind: 'gmail-connect', state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'), clientId: config.clientId, employeeId: identity.employeeId,
      email: identity.email, sub: session.sub, sid: session.sid,
      connectionId: connection?.id ?? null, connectionVersion: connection?.version ?? null, iat, exp: iat + FLOW_SECONDS,
    };
    const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code',
      scope: `openid email ${GMAIL_COMPOSE_SCOPE}`, redirect_uri: config.redirectUri,
      state: flow.state, nonce: flow.nonce, code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'),
      code_challenge_method: 'S256', access_type: 'offline', include_granted_scopes: 'false', prompt: 'consent', hd: CONSOLE_DOMAIN, login_hint: identity.email }).toString();
    const response = redirect(authorization.toString());
    response.headers.append('Set-Cookie', flowCookie(signedConsoleValue(flow, 'google-oauth'), FLOW_SECONDS));
    return response;
  } catch (error) { return failure(error); }
}
function callbackFlow(request: Request, clientId: string, now: number) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.url.length > 8192 || url.origin !== consoleOrigin() || url.pathname !== GMAIL_CALLBACK_PATH) throw invalid();
  const raw = readSignedConsoleValue(readFlowCookie(request), 'google-oauth');
  const seconds = Math.floor(now / 1000);
  if (raw.kind !== 'gmail-connect' || raw.clientId !== clientId
    || typeof raw.state !== 'string' || !RANDOM.test(raw.state) || typeof raw.nonce !== 'string' || !RANDOM.test(raw.nonce)
    || typeof raw.verifier !== 'string' || !RANDOM.test(raw.verifier)
    || !Number.isInteger(raw.iat) || !Number.isInteger(raw.exp) || Number(raw.iat) > seconds + 30
    || Number(raw.exp) <= seconds || Number(raw.exp) - Number(raw.iat) !== FLOW_SECONDS
    || Object.keys(raw).some(key => !['kind', 'state', 'nonce', 'verifier', 'clientId', 'employeeId', 'email', 'sub', 'sid', 'connectionId', 'connectionVersion', 'iat', 'exp'].includes(key))) throw invalid();
  const session = readConsoleSession(request);
  if (raw.employeeId !== session.employeeId || raw.email !== session.email || raw.sub !== session.sub || raw.sid !== session.sid) throw invalid();
  if ((raw.connectionId === null) !== (raw.connectionVersion === null)
    || (raw.connectionId !== null && (typeof raw.connectionId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.connectionId)
      || !Number.isInteger(raw.connectionVersion) || Number(raw.connectionVersion) < 1))) throw invalid();
  const state = url.searchParams.get('state');
  if (url.searchParams.getAll('state').length !== 1 || !state || !RANDOM.test(state)
    || !timingSafeEqual(Buffer.from(state), Buffer.from(raw.state))) throw invalid();
  return { flow: raw as Flow, params: url.searchParams };
}
function authorizationCode(params: URLSearchParams): string {
  for (const field of ['code', 'error', 'iss']) if (params.getAll(field).length > 1) throw invalid();
  const issuer = params.get('iss');
  if (issuer !== null && !['https://accounts.google.com', 'accounts.google.com'].includes(issuer)) throw invalid();
  if (params.has('error')) {
    if (params.has('code')) throw invalid();
    if (params.get('error') === 'access_denied') throw new HttpError(401, 'GMAIL_OAUTH_CANCELLED', 'Gmail connection was cancelled.');
    throw invalid();
  }
  const code = params.get('code');
  if (!code || code.length > 2048 || /[\s\x00-\x1f\x7f]/.test(code)) throw invalid();
  return code;
}
export async function handleGmailCallback(request: Request, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  let clear = false;
  try {
    const config = requireAvailable();
    const { flow, params } = callbackFlow(request, config.clientId, deps.now());
    clear = true;
    const code = authorizationCode(params);
    deps.limit(request, 'gmail:callback', 20);
    await deps.transaction(async client => {
      const identity = await getConsoleIdentity(request, client);
      sameConnection(await getGmailConnection(client, owner(identity)), flow);
    });
    const data = await googlePost(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: 'authorization_code', code, code_verifier: flow.verifier }), deps.fetch, request.signal);
    if (typeof data.id_token !== 'string' || data.id_token.length > 16_384
      || typeof data.refresh_token !== 'string' || !TOKEN.test(data.refresh_token)
      || typeof data.access_token !== 'string' || !TOKEN.test(data.access_token) || data.token_type !== 'Bearer') throw unavailable();
    const scopes = grantedScopes(data.scope);
    const verified = await deps.verify(data.id_token, { clientId: config.clientId, nonce: flow.nonce, now: deps.now() });
    if (verified.email !== flow.email || `google:${verified.sub}` !== flow.sub) {
      throw new HttpError(403, 'GMAIL_ACCOUNT_MISMATCH', 'Connect the same Wareongo work account that you used to sign in.');
    }
    await deps.writeTransaction(async client => {
      const identity = await getConsoleIdentity(request, client);
      // Storage checks expectedConnection under its owner lock, including a
      // disconnected row's version; a stale flow cannot restore newer access.
      await saveGmailConnection(client, owner(identity), {
        googleSub: verified.sub, accountEmail: verified.email, refreshToken: data.refresh_token as string,
        grantedScopes: scopes, expectedConnection: { id: flow.connectionId, version: flow.connectionVersion },
      });
    });
    const response = redirect(`${consoleOrigin()}/mail?connected=1`);
    response.headers.append('Set-Cookie', flowCookie('', 0));
    return response;
  } catch (error) { return failure(error, clear); }
}
export async function handleGmailConnection(request: Request, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  try {
    if (request.method !== 'GET' || new URL(request.url).origin !== consoleOrigin()
      || new URL(request.url).pathname !== '/api/mail/connection' || new URL(request.url).search) throw invalid();
    readConsoleSession(request);
    const result = await deps.transaction(async client => {
      const identity = await getConsoleIdentity(request, client);
      const connection = await getGmailConnection(client, owner(identity));
      return { employee: { email: identity.email, name: identity.name }, connection: summary(connection), availability: gmailAvailability() };
    });
    return consoleJson(result);
  } catch (error) { return consoleErrorResponse(error); }
}
export async function handleGmailDisconnect(request: Request, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  try {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/mail/connection' || new URL(request.url).search) throw invalid();
    requireConsoleOrigin(request);
    readConsoleSession(request);
    deps.limit(request, 'gmail:disconnect', 20);
    const connection = await deps.disconnectTransaction(async client => {
      const identity = await getConsoleIdentity(request, client), employee = owner(identity);
      return disconnectGmailConnection(client, employee);
    });
    let googleGrantRevoked = false, revocationPending = false;
    if (connection.status === 'revoking') {
      try {
        await deps.disconnectTransaction(async client => {
          const identity = await getConsoleIdentity(request, client);
          // A deliberately bounded exception to ordinary no-I/O transactions:
          // the owner lock serializes Google's project-wide revocation with
          // reconnect. Local access was durably disabled in the earlier commit.
          await completeGmailDisconnect(client, owner(identity), async current => {
            await revokeGmailRefreshToken(current, deps.fetch, request.signal);
            googleGrantRevoked = true;
          });
        });
      } catch { googleGrantRevoked = false; revocationPending = true; }
    }
    const response = consoleJson({ disconnected: true, googleGrantRevoked, revocationPending }, revocationPending ? 202 : 200);
    response.headers.append('Set-Cookie', flowCookie('', 0));
    return response;
  } catch (error) { return consoleErrorResponse(error); }
}
