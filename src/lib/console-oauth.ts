import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { HttpError } from './errors';
import { CONSOLE_DOMAIN, OAUTH_SECONDS, consoleCookie, consoleOrigin, consoleSecret, readConsoleCookie, readSignedConsoleValue, signedConsoleValue } from './console-auth';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
type GoogleKey = JsonWebKey & { kid: string; alg?: string; use?: string };
let keyCache: { keys: GoogleKey[]; expires: number } | undefined;
let pendingKeys: Promise<GoogleKey[]> | undefined;

function oauthFailure(status = 401): never { throw new HttpError(status, status === 503 ? 'GOOGLE_UNAVAILABLE' : 'GOOGLE_SIGN_IN_DENIED', status === 503 ? 'Google sign-in is temporarily unavailable.' : 'Work-account sign-in could not be verified.'); }

function configuration(env: NodeJS.ProcessEnv) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_ID.length > 300 || env.GOOGLE_CLIENT_SECRET.length > 500) {
    throw new HttpError(503, 'CONSOLE_CONFIGURATION', 'Google sign-in is not configured.');
  }
  consoleSecret('CONTEXT_SESSION_SECRET', env);
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, callback: `${consoleOrigin(env)}/api/auth/google/callback` };
}

export function beginGoogleSignIn(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const config = configuration(env);
  const iat = Math.floor(now / 1000);
  const transaction = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), iat, exp: iat + OAUTH_SECONDS };
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
    response_type: 'code', scope: 'openid email profile', state: transaction.state, nonce: transaction.nonce,
    code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'), code_challenge_method: 'S256',
    hd: CONSOLE_DOMAIN, prompt: 'select_account' }).toString();
  return { url: url.toString(), cookie: consoleCookie('oauth', signedConsoleValue(transaction, 'oauth', env), OAUTH_SECONDS, env) };
}

async function boundedJson(response: Response, maximum: number): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > maximum) oauthFailure(503);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength; if (size > maximum) { await reader.cancel(); oauthFailure(503); }
      chunks.push(chunk.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) oauthFailure(503);
    return result as Record<string, unknown>;
  } catch (error) { if (error instanceof HttpError) throw error; oauthFailure(503); }
}

async function googleKeys(fetcher: typeof fetch, now: number, signal: AbortSignal, refresh = false): Promise<GoogleKey[]> {
  if (!refresh && keyCache && keyCache.expires > now) return keyCache.keys;
  if (pendingKeys) return pendingKeys;
  pendingKeys = (async () => {
    const response = await fetcher(JWKS_URL, { redirect: 'error', cache: 'no-store', signal });
    const body = await boundedJson(response, 128 * 1024);
    if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 10) oauthFailure(503);
    const keys = body.keys as GoogleKey[];
    if (keys.some(key => !key || key.kty !== 'RSA' || typeof key.kid !== 'string' || key.kid.length > 200
      || typeof key.n !== 'string' || typeof key.e !== 'string' || (key.alg !== undefined && key.alg !== 'RS256')
      || (key.use !== undefined && key.use !== 'sig')) || new Set(keys.map(key => key.kid)).size !== keys.length) oauthFailure(503);
    const maxAge = Number(/(?:^|,)\s*max-age=([0-9]+)/i.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 300);
    keyCache = { keys, expires: now + Math.min(3600, Math.max(0, maxAge)) * 1000 };
    return keys;
  })();
  try { return await pendingKeys; } finally { pendingKeys = undefined; }
}

export function verifyGoogleIdToken(token: string, nonce: string, clientId: string, keys: GoogleKey[], now = Date.now()) {
  if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) oauthFailure();
  const [encodedHeader, encodedClaims, signature] = token.split('.');
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try { header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')); }
  catch { oauthFailure(); }
  if (!header || !claims || Array.isArray(header) || Array.isArray(claims) || header.alg !== 'RS256'
    || typeof header.kid !== 'string' || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined) oauthFailure();
  const matching = keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
  if (matching.length !== 1) oauthFailure();
  try {
    const key = createPublicKey({ key: matching[0], format: 'jwk' });
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      || !verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), key, Buffer.from(signature, 'base64url'))) oauthFailure();
  } catch { oauthFailure(); }
  const seconds = Math.floor(now / 1000);
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(String(claims.iss))
    || !Array.isArray(audiences) || !audiences.length || audiences.some(value => typeof value !== 'string') || !audiences.includes(clientId)
    || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp !== undefined && claims.azp !== clientId)
    || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || Number(claims.iat) > seconds + 60
    || (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || Number(claims.nbf) > seconds + 60))
    || Number(claims.iat) < seconds - 600 || Number(claims.exp) <= seconds || Number(claims.exp) > seconds + 7200
    || Number(claims.exp) <= Number(claims.iat) || claims.nonce !== nonce
    || claims.hd !== CONSOLE_DOMAIN || claims.email_verified !== true
    || typeof claims.email !== 'string' || !/^[^\s@]+@wareongo\.com$/i.test(claims.email)
    || typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) oauthFailure();
  return { email: claims.email.toLowerCase(), sub: claims.sub };
}

export async function finishGoogleSignIn(request: Request, options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: number } = {}) {
  const env = options.env ?? process.env; const now = options.now ?? Date.now(); const fetcher = options.fetch ?? fetch;
  const config = configuration(env);
  const url = new URL(request.url);
  if (url.origin !== consoleOrigin(env) || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('state').length !== 1 || url.searchParams.has('error')) oauthFailure();
  const transaction = readSignedConsoleValue(readConsoleCookie(request, 'oauth', env), 'oauth', env);
  const seconds = Math.floor(now / 1000);
  if (typeof transaction.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(transaction.state) || transaction.state !== url.searchParams.get('state')
    || typeof transaction.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(transaction.nonce)
    || typeof transaction.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(transaction.verifier)
    || !Number.isInteger(transaction.exp) || !Number.isInteger(transaction.iat) || Number(transaction.exp) <= seconds
    || Number(transaction.iat) > seconds + 60 || Number(transaction.exp) - Number(transaction.iat) !== OAUTH_SECONDS) oauthFailure();
  const code = url.searchParams.get('code')!;
  if (!code || code.length > 4096) oauthFailure();
  const signal = AbortSignal.timeout(8000);
  try {
    const tokenResponse = await fetcher(TOKEN_URL, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId,
        client_secret: config.clientSecret, redirect_uri: config.callback, code_verifier: transaction.verifier }) });
    if (!tokenResponse.ok) oauthFailure(tokenResponse.status >= 500 ? 503 : 401);
    const tokens = await boundedJson(tokenResponse, 128 * 1024);
    if (typeof tokens.id_token !== 'string') oauthFailure();
    let keys = await googleKeys(fetcher, now, signal);
    // A freshly rotated Google signing key may be newer than our bounded cache.
    // Only the token from Google's fixed HTTPS token endpoint reaches this path.
    // Refresh once, within the original deadline; an unknown key still fails.
    let kid: unknown;
    try { kid = JSON.parse(Buffer.from(tokens.id_token.split('.')[0], 'base64url').toString('utf8'))?.kid; } catch { oauthFailure(); }
    if (typeof kid === 'string' && !keys.some(key => key.kid === kid)) keys = await googleKeys(fetcher, now, signal, true);
    return verifyGoogleIdToken(tokens.id_token, transaction.nonce, config.clientId, keys, now);
  } catch (error) { if (error instanceof HttpError) throw error; oauthFailure(503); }
}
