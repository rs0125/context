import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SCOPES, type Scope } from './auth';
import { consoleOrigin, consoleSecret } from './console-auth';
import { HttpError } from './errors';

export const MCP_ACCESS_SECONDS = 15 * 60;
export const MCP_REFRESH_SECONDS = 30 * 24 * 60 * 60;
export const MCP_CODE_SECONDS = 5 * 60;
export const MCP_CONSENT_SECONDS = 10 * 60;
export const OAUTH_SCHEMA = 'context_mcp_private';
export const hashOAuth = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomOAuth = (prefix: string) => prefix + randomBytes(32).toString('base64url');
export const mcpResource = () => `${consoleOrigin()}/mcp`;
export function requireMcpEnabled() {
  if (process.env.CONTEXT_MCP_ENABLED === 'false' || process.env.CONTEXT_CONSOLE_WRITES_ENABLED !== 'true') {
    throw new HttpError(503, 'MCP_SETUP_REQUIRED', 'The connector is not enabled yet.');
  }
}
export class OAuthError extends Error {
  constructor(public error: string, public description: string, public status = 400) { super(description); }
}
export function oauthFail(error = 'invalid_request', description = 'The authorization request is invalid.', status = 400): never {
  throw new OAuthError(error, description, status);
}
export function oauthScopes(value: unknown, fallback: readonly Scope[] = SCOPES): Scope[] {
  if (value === undefined || value === null) return [...fallback];
  if (typeof value !== 'string' || value.length > 100) oauthFail('invalid_scope', 'Only supported read scopes are available.');
  const scopes = value.split(' ');
  if (!scopes.length || scopes.length > 3 || new Set(scopes).size !== scopes.length || scopes.some(scope => !SCOPES.includes(scope as Scope))) {
    oauthFail('invalid_scope', 'Only supported read scopes are available.');
  }
  return scopes as Scope[];
}
export function trustedRedirectOrigins() {
  const origins = new Set(['https://claude.ai']);
  const extras = (process.env.CONTEXT_MCP_ALLOWED_REDIRECT_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (extras.length > 20) throw new HttpError(503, 'MCP_CONFIGURATION', 'Connector configuration is invalid.');
  for (const origin of extras) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new HttpError(503, 'MCP_CONFIGURATION', 'Connector configuration is invalid.'); }
    if (parsed.origin !== origin || parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new HttpError(503, 'MCP_CONFIGURATION', 'Connector configuration is invalid.');
    origins.add(origin);
  }
  return origins;
}
function localUrl(url: URL) {
  return consoleOrigin().startsWith('http:') && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
export function validateRedirect(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) oauthFail('invalid_redirect_uri', 'The callback URL is not allowed.');
  let url: URL;
  try { url = new URL(value); } catch { oauthFail('invalid_redirect_uri', 'The callback URL is not allowed.'); }
  if (url.username || url.password || url.hash || url.search || url.href !== value) oauthFail('invalid_redirect_uri', 'The callback URL is not allowed.');
  if (value === 'https://claude.ai/api/mcp/auth_callback') return value;
  if (localUrl(url)) return value;
  const extra = trustedRedirectOrigins();
  extra.delete('https://claude.ai');
  if (url.protocol !== 'https:' || !extra.has(url.origin)) oauthFail('invalid_redirect_uri', 'The callback URL is not allowed.');
  return value;
}

export function oauthHeaders(request?: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' });
  const origin = request?.headers.get('origin');
  if (origin) {
    let url: URL;
    try { url = new URL(origin); } catch { oauthFail('invalid_request', 'This browser origin is not allowed.', 403); }
    if (origin !== consoleOrigin() && !trustedRedirectOrigins().has(origin) && !localUrl(url)) oauthFail('invalid_request', 'This browser origin is not allowed.', 403);
    headers.set('Access-Control-Allow-Origin', origin);
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return headers;
}
export function oauthResponse(body: unknown, status = 200, request?: Request) { return Response.json(body, { status, headers: oauthHeaders(request) }); }
export function oauthErrorResponse(error: unknown, request?: Request, consent = false) {
  const status = error instanceof OAuthError || error instanceof HttpError ? error.status : 503;
  const code = error instanceof OAuthError ? error.error : error instanceof HttpError ? error.code : 'OAUTH_UNAVAILABLE';
  const message = error instanceof OAuthError ? error.description : error instanceof HttpError ? error.message : 'The connector is temporarily unavailable.';
  let headers: Headers;
  try { headers = oauthHeaders(request); } catch { headers = oauthHeaders(); }
  if (status === 429) headers.set('Retry-After', '60');
  return Response.json(consent ? { error: { code, message } } : { error: error instanceof OAuthError ? code : status === 503 ? 'temporarily_unavailable' : status === 429 ? 'slow_down' : 'invalid_request', error_description: message }, { status, headers });
}
export async function boundedOAuthBody(request: Request, json: boolean) {
  const max = 8192;
  const media = json ? 'application/json' : 'application/x-www-form-urlencoded';
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== media) oauthFail('invalid_request', `Send ${media}.`, 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) oauthFail('invalid_request', 'The request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) oauthFail();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); oauthFail('invalid_request', 'The request is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { oauthFail(); }
  if (!json) return new URLSearchParams(text);
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) oauthFail();
    return value as Record<string, unknown>;
  } catch { oauthFail(); }
}
export function parameters(params: URLSearchParams, allowed: readonly string[]) {
  for (const name of params.keys()) if (!allowed.includes(name) || params.getAll(name).length !== 1) oauthFail();
  return Object.fromEntries(params);
}
export type AuthorizationRequest = { clientId: string; redirectUri: string; resource: string; challenge: string; scopes: Scope[]; state?: string };
export function parseAuthorization(params: URLSearchParams): AuthorizationRequest {
  const values = parameters(params, ['response_type', 'client_id', 'redirect_uri', 'resource', 'code_challenge', 'code_challenge_method', 'scope', 'state']);
  if (values.response_type !== 'code') oauthFail('unsupported_response_type', 'Only authorization codes are supported.');
  if (!/^wog_client_[A-Za-z0-9_-]{43}$/.test(values.client_id ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(values.code_challenge ?? '') || values.code_challenge_method !== 'S256') oauthFail();
  if (values.resource !== mcpResource()) oauthFail('invalid_target', 'Use the configured connector resource.');
  if (values.state !== undefined && (!/^[\x20-\x7e]{1,1024}$/.test(values.state))) oauthFail();
  return { clientId: values.client_id, redirectUri: validateRedirect(values.redirect_uri), resource: values.resource,
    challenge: values.code_challenge, scopes: oauthScopes(values.scope), ...(values.state === undefined ? {} : { state: values.state }) };
}

const cookieName = () => `${consoleOrigin().startsWith('https:') ? '__Host-' : ''}context_mcp_consent`;
export function consentCookie(value: string, maxAge = MCP_CONSENT_SECONDS) { return `${cookieName()}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${consoleOrigin().startsWith('https:') ? '; Secure' : ''}`; }
function browserBinding(request: Request) {
  const cookies = (request.headers.get('cookie') ?? '');
  if (cookies.length > 16384) return null;
  const matches = cookies.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName()}=`));
  const value = matches.length === 1 ? matches[0].slice(cookieName().length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function createConsent(request: Request, authorization: AuthorizationRequest, now = Date.now()) {
  const binding = browserBinding(request) ?? randomBytes(32).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...authorization, binding: hashOAuth(binding), nonce: randomOAuth(''), exp: Math.floor(now / 1000) + MCP_CONSENT_SECONDS })).toString('base64url');
  const signature = createHmac('sha256', consoleSecret('CONTEXT_SESSION_SECRET')).update(`mcp-consent|${consoleOrigin()}|${body}`).digest('base64url');
  return { requestHandle: `${body}.${signature}`, cookie: consentCookie(binding) };
}
export function readConsent(request: Request, handle: unknown, now = Date.now()): AuthorizationRequest {
  if (typeof handle !== 'string' || handle.length > 6144 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(handle)) oauthFail('invalid_request', 'Restart connector authorization.', 409);
  const [body, signature] = handle.split('.');
  const expected = createHmac('sha256', consoleSecret('CONTEXT_SESSION_SECRET')).update(`mcp-consent|${consoleOrigin()}|${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) oauthFail('invalid_request', 'Restart connector authorization.', 409);
  let value: Record<string, unknown>;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { oauthFail(); }
  const binding = browserBinding(request);
  if (!binding || value.binding !== hashOAuth(binding) || !Number.isInteger(value.exp) || Number(value.exp) <= Math.floor(now / 1000)
    || Number(value.exp) > Math.floor(now / 1000) + MCP_CONSENT_SECONDS) oauthFail('invalid_request', 'Restart connector authorization.', 409);
  return parseAuthorization(new URLSearchParams({ response_type: 'code', client_id: String(value.clientId), redirect_uri: String(value.redirectUri),
    resource: String(value.resource), code_challenge: String(value.challenge), code_challenge_method: 'S256', scope: Array.isArray(value.scopes) ? value.scopes.join(' ') : '', ...(value.state === undefined ? {} : { state: String(value.state) }) }));
}

export function authorizationServerMetadata() {
  const origin = consoleOrigin();
  return { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [...SCOPES] };
}
export function protectedResourceMetadata() {
  return { resource: mcpResource(), resource_name: 'Wareongo read-only context', authorization_servers: [consoleOrigin()], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'] };
}
