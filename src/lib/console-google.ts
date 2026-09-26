import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {
  CONSOLE_DOMAIN, SESSION_SECONDS, consoleCookie, consoleErrorResponse, consoleOrigin,
  createConsoleSession, readConsoleCookie, readSignedConsoleValue, resolveConsoleEmployee, signedConsoleValue,
} from './console-auth';
import { withReadOnlyTransaction } from './db';
import { HttpError } from './errors';
import { anonymousRequestLimit } from './rate-limit';

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';
export const GOOGLE_FLOW_SECONDS = 10 * 60;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
type Flow = { state: string; nonce: string; verifier: string; clientId: string; iat: number; exp: number };
type VerifiedIdentity = { email: string; sub: string };
type Dependencies = {
  fetch: typeof fetch;
  transaction: typeof withReadOnlyTransaction;
  verify: typeof verifyGoogleIdToken;
  limit: typeof anonymousRequestLimit;
  now: () => number;
};
const defaults: Dependencies = {
  fetch: (...args) => fetch(...args), transaction: withReadOnlyTransaction,
  verify: verifyGoogleIdToken, limit: anonymousRequestLimit, now: Date.now,
};
function invalid() { return new HttpError(401, 'CONSOLE_GOOGLE_INVALID', 'Google sign-in expired or could not be verified. Please try again.'); }
function unavailable() { return new HttpError(503, 'CONSOLE_GOOGLE_UNAVAILABLE', 'Google sign-in is temporarily unavailable.'); }

function googleConfiguration() {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? '', clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  if (!/^[A-Za-z0-9._-]{1,250}\.apps\.googleusercontent\.com$/.test(clientId)
    || clientSecret.length < 8 || clientSecret.length > 512 || /\s/.test(clientSecret)) {
    throw new HttpError(503, 'CONSOLE_CONFIGURATION', 'Google sign-in is not configured.');
  }
  return { clientId, clientSecret, redirectUri: `${consoleOrigin()}${GOOGLE_CALLBACK_PATH}` };
}

/** Bounds the whole stream, including chunked replies. Provider response text
 * and credentials are never included in application errors. */
async function boundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel(); throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { reader.releaseLock(); }
}

// Fixed Google URL, verified HTTPS, bounded body/time, and bounded JWKS cache.
// The endpoint never comes from a token's jku/x5u or browser input.
const googleKeys = createRemoteJWKSet(new URL(JWKS_URL), {
  timeoutDuration: 4_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000,
  [customFetch]: async (url, options) => {
    if (String(url) !== JWKS_URL) throw unavailable();
    const response = await fetch(url, { ...options, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([...(options?.signal ? [options.signal] : []), AbortSignal.timeout(4_000)]) });
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    const body = await boundedBody(response, 64 * 1024);
    return new Response(body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  },
});

/** Verify the signature before trusting identity claims. Tests supply an actual
 * signing key through the resolver instead of bypassing JWT verification. */
export async function verifyGoogleIdToken(token: string, expected: { clientId: string; nonce: string; now: number }, getKey: JWTVerifyGetKey = googleKeys): Promise<VerifiedIdentity> {
  if (token.length > 16_384 || !RANDOM_VALUE.test(expected.nonce)) throw invalid();
  let result;
  try {
    result = await jwtVerify(token, getKey, {
      algorithms: ['RS256'], issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: expected.clientId, currentDate: new Date(expected.now), clockTolerance: 30,
      maxTokenAge: GOOGLE_FLOW_SECONDS,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce', 'email', 'email_verified', 'hd'],
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 503) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ERR_JWKS_TIMEOUT' || error instanceof TypeError || (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))) throw unavailable();
    throw invalid();
  }
  const { payload, protectedHeader } = result;
  const seconds = Math.floor(expected.now / 1000);
  if (typeof protectedHeader.kid !== 'string' || !protectedHeader.kid || protectedHeader.kid.length > 200
    || typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp! <= seconds
    || payload.iat! > seconds + 30 || payload.exp! <= payload.iat!
    || typeof payload.nonce !== 'string' || !RANDOM_VALUE.test(payload.nonce)
    || !timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(expected.nonce))
    || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== expected.clientId)
    || (payload.azp !== undefined && payload.azp !== expected.clientId)) throw invalid();
  if (payload.email_verified !== true || payload.hd !== CONSOLE_DOMAIN
    || typeof payload.email !== 'string' || payload.email.length > 254
    || !/^[^\s@]+@wareongo\.com$/i.test(payload.email)) {
    throw new HttpError(403, 'CONSOLE_ACCESS_DENIED', 'Sign in with an authorized Wareongo work account.');
  }
  return { sub: payload.sub, email: payload.email.toLowerCase() };
}

function redirect(url: string, status = 303) {
  return new Response(null, { status, headers: { Location: url, 'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache', Vary: 'Cookie', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}

/** Only fixed error codes and the canonical home path reach the browser. */
function failureResponse(error: unknown, clearFlow = false): Response {
  try {
    const code = error instanceof HttpError && error.code === 'CONSOLE_GOOGLE_CANCELLED' ? 'google_cancelled'
      : error instanceof HttpError && error.status === 403 ? 'google_denied'
        : error instanceof HttpError && [400, 401].includes(error.status) ? 'google_invalid' : 'google_unavailable';
    const response = redirect(`${consoleOrigin()}/?error=${code}`);
    // A stale tab or unsolicited callback must not erase another pending flow.
    // Only a callback bound to the current signed cookie can consume it.
    if (clearFlow) response.headers.append('Set-Cookie', consoleCookie('oauth', '', 0));
    return response;
  } catch { return consoleErrorResponse(unavailable()); }
}

export async function handleGoogleLogin(request: Request, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  try {
    const config = googleConfiguration(), url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== consoleOrigin() || url.search) throw invalid();
    deps.limit(request, 'console-google:login', 30);
    const iat = Math.floor(deps.now() / 1000);
    const flow: Flow = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'), clientId: config.clientId, iat, exp: iat + GOOGLE_FLOW_SECONDS };
    const authorization = new URL(AUTHORIZATION_URL);
    authorization.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code',
      scope: 'openid email', redirect_uri: config.redirectUri, state: flow.state, nonce: flow.nonce,
      code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256',
      hd: CONSOLE_DOMAIN, prompt: 'select_account' }).toString();
    const response = redirect(authorization.toString(), 302);
    response.headers.append('Set-Cookie', consoleCookie('oauth', signedConsoleValue(flow, 'google-oauth'), GOOGLE_FLOW_SECONDS));
    return response;
  } catch (error) { return failureResponse(error); }
}

function callbackFlow(request: Request, clientId: string, now: number) {
  if (request.method !== 'GET' || request.url.length > 8192) throw invalid();
  const url = new URL(request.url);
  if (url.origin !== consoleOrigin() || url.pathname !== GOOGLE_CALLBACK_PATH) throw invalid();
  if (url.searchParams.getAll('state').length !== 1) throw invalid();
  const flow = readSignedConsoleValue(readConsoleCookie(request, 'oauth'), 'google-oauth');
  const seconds = Math.floor(now / 1000), state = url.searchParams.get('state');
  if (typeof flow.state !== 'string' || !RANDOM_VALUE.test(flow.state)
    || typeof flow.nonce !== 'string' || !RANDOM_VALUE.test(flow.nonce)
    || typeof flow.verifier !== 'string' || !RANDOM_VALUE.test(flow.verifier)
    || flow.clientId !== clientId || !Number.isInteger(flow.iat) || !Number.isInteger(flow.exp)
    || Number(flow.iat) > seconds + 30 || Number(flow.exp) <= seconds
    || Number(flow.exp) - Number(flow.iat) !== GOOGLE_FLOW_SECONDS
    || Object.keys(flow).some(key => !['state', 'nonce', 'verifier', 'clientId', 'iat', 'exp'].includes(key))
    || !state || !RANDOM_VALUE.test(state) || !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))) throw invalid();
  return { flow: flow as Flow, params: url.searchParams };
}

function callbackCode(params: URLSearchParams) {
  // Ignore unrecognized Google response fields, but never accept ambiguous
  // duplicate security-sensitive parameters. At this point the browser flow
  // has been bound, so an error consumes only that matching flow's cookie.
  for (const field of ['code', 'error', 'iss']) if (params.getAll(field).length > 1) throw invalid();
  const issuer = params.get('iss');
  if (issuer !== null && !['https://accounts.google.com', 'accounts.google.com'].includes(issuer)) throw invalid();
  if (params.has('error')) {
    if (params.has('code')) throw invalid();
    if (params.get('error') === 'access_denied') throw new HttpError(401, 'CONSOLE_GOOGLE_CANCELLED', 'Google sign-in was cancelled.');
    throw invalid();
  }
  const code = params.get('code');
  if (!code || code.length > 2048 || /[\s\x00-\x1f\x7f]/.test(code)) throw invalid();
  return code;
}

async function exchangeCode(code: string, verifier: string, config: ReturnType<typeof googleConfiguration>, requestFetch: typeof fetch) {
  try {
    const response = await requestFetch(TOKEN_URL, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: config.redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier }) });
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        // Read only the bounded, enumerated OAuth error code. Descriptions and
        // other provider content are neither returned nor logged. A bad client
        // credential is an operator issue, not an expired employee sign-in.
        let body: unknown;
        try { body = JSON.parse(await boundedBody(response, 8 * 1024)); }
        catch { throw unavailable(); }
        if (body && typeof body === 'object' && !Array.isArray(body) && 'error' in body
          && body.error === 'invalid_grant') throw invalid();
        // Includes invalid_client, unauthorized_client, and unknown failures.
        throw unavailable();
      }
      await response.body?.cancel();
      throw unavailable();
    }
    const body: unknown = JSON.parse(await boundedBody(response, 32 * 1024));
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('id_token' in body)
      || typeof body.id_token !== 'string' || body.id_token.length > 16_384) throw unavailable();
    return body.id_token;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}

export async function handleGoogleCallback(request: Request, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  let clearFlow = false;
  try {
    const config = googleConfiguration();
    const { flow, params } = callbackFlow(request, config.clientId, deps.now());
    clearFlow = true;
    const code = callbackCode(params);
    deps.limit(request, 'console-google:callback', 30);
    // No database socket is checked out while talking to Google. Authorization
    // codes are one-use at Google and bound to this browser's PKCE verifier.
    const token = await exchangeCode(code, flow.verifier, config, deps.fetch);
    const verified = await deps.verify(token, { clientId: config.clientId, nonce: flow.nonce, now: deps.now() });
    const identity = await deps.transaction(client => resolveConsoleEmployee(client, verified.email));
    const response = redirect(`${consoleOrigin()}/`);
    response.headers.append('Set-Cookie', consoleCookie('oauth', '', 0));
    response.headers.append('Set-Cookie', consoleCookie('session', createConsoleSession(identity, `google:${verified.sub}`, process.env, deps.now()), SESSION_SECONDS));
    return response;
  } catch (error) { return failureResponse(error, clearFlow); }
}
