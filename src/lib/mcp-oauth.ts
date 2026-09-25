import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { authenticateRequestKey, findDatabaseKey, parseKeyRegistry, resolvePrincipal, SCOPES, type KeyRegistration, type Scope } from './auth';
import { consoleOrigin, requireConsoleOrigin } from './console-auth';
import { withConsoleWriteTransaction, withReadOnlyTransaction } from './db';
import { HttpError } from './errors';
import { rateLimit } from './rate-limit';
import { boundedOAuthBody, consentCookie, createConsent, hashOAuth, MCP_ACCESS_SECONDS, MCP_CODE_SECONDS, MCP_REFRESH_SECONDS, mcpResource,
  OAuthError, oauthErrorResponse, oauthFail, oauthHeaders, oauthResponse, oauthScopes, parameters, parseAuthorization, randomOAuth, readConsent,
  requireMcpEnabled, validateRedirect, type AuthorizationRequest } from './mcp-oauth-protocol';
export { authorizationServerMetadata, protectedResourceMetadata } from './mcp-oauth-protocol';

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
export type McpOAuthDependencies = { readTransaction: Transaction; writeTransaction: Transaction; limit: (name: string, maximum: number) => void };
type Client = { id: string; name: string; redirect_uris: string[]; scopes: Scope[] };
type Grant = { id: string; client_id: string; key_id: string; key_hash: string; key_source: 'environment' | 'database'; employee_id: number;
  employee_email: string; scopes: Scope[]; resource: string; expires_at: Date | string; revoked_at: Date | string | null };
type McpKey = KeyRegistration & { mcpGrantId: string; mcpAccessHash: string };
const grantColumns = 'g.id, g.client_id, g.key_id, g.key_hash, g.key_source, g.employee_id, g.employee_email, g.scopes, g.resource, g.expires_at, g.revoked_at';
const defaults: McpOAuthDependencies = { readTransaction: withReadOnlyTransaction, writeTransaction: withConsoleWriteTransaction,
  limit: (name, maximum) => rateLimit(`mcp-oauth:${name}`, Date.now(), maximum) };
const milliseconds = (date: Date | string) => date instanceof Date ? date.getTime() : Date.parse(date);

async function registeredClient(client: PoolClient, id: string): Promise<Client> {
  if (!/^wog_client_[A-Za-z0-9_-]{43}$/.test(id)) oauthFail('invalid_client', 'The connector client is not registered.', 401);
  const result = await client.query<Client>('SELECT id, name, redirect_uris, scopes FROM context_mcp_private.oauth_clients WHERE id = $1', [id]);
  if (result.rows.length !== 1) oauthFail('invalid_client', 'The connector client is not registered.', 401);
  return result.rows[0];
}
function requireClientAuthorization(client: Client, request: AuthorizationRequest) {
  if (!client.redirect_uris.includes(request.redirectUri)) oauthFail('invalid_redirect_uri', 'The callback URL does not match this client.');
  if (request.scopes.some(scope => !client.scopes.includes(scope))) oauthFail('invalid_scope', 'The client did not register these read permissions.');
}
async function currentGrantKey(client: PoolClient, grant: Grant): Promise<KeyRegistration> {
  if (grant.revoked_at !== null || !Number.isFinite(milliseconds(grant.expires_at)) || milliseconds(grant.expires_at) <= Date.now() || grant.resource !== mcpResource()) {
    oauthFail('invalid_grant', 'Reconnect this connector.');
  }
  const current = grant.key_source === 'database' ? await findDatabaseKey(client, grant.key_hash)
    : parseKeyRegistry().find(key => key.id === grant.key_id && key.hash === grant.key_hash);
  if (!current || current.id !== grant.key_id || current.hash !== grant.key_hash || current.employeeEmail !== grant.employee_email
    || Date.parse(current.expiresAt) <= Date.now() || current.employeeId !== undefined && current.employeeId !== grant.employee_id) oauthFail('invalid_grant', 'Reconnect this connector.');
  const principal = await resolvePrincipal(client, current).catch(error => {
    if (error instanceof HttpError && [401, 403].includes(error.status)) oauthFail('invalid_grant', 'Reconnect this connector.');
    throw error;
  });
  if (principal.employeeId !== grant.employee_id || principal.email !== grant.employee_email) oauthFail('invalid_grant', 'Reconnect this connector.');
  const scopes = grant.scopes.filter(scope => current.scopes.includes(scope) && principal.scopes.includes(scope));
  if (!scopes.length) oauthFail('invalid_grant', 'Employee read access is unavailable.');
  return { ...current, employeeId: principal.employeeId, scopes };
}

/** Recheck in the existing source transaction, including after live CRM HTTP reads. */
export async function revalidateMcpGrant(client: PoolClient, key: KeyRegistration) {
  const metadata = key as Partial<McpKey>;
  if (metadata.mcpGrantId === undefined && metadata.mcpAccessHash === undefined) return;
  requireMcpEnabled();
  const result = await client.query(`SELECT g.scopes FROM context_mcp_private.oauth_grants g
    JOIN context_mcp_private.oauth_tokens t ON t.grant_id = g.id
    WHERE g.id = $1 AND t.hash = $2 AND t.kind = 'access' AND t.expires_at > CURRENT_TIMESTAMP
      AND g.revoked_at IS NULL AND g.expires_at > CURRENT_TIMESTAMP AND g.resource = $3
      AND g.key_id = $4 AND g.key_hash = $5 AND g.employee_id = $6 AND g.employee_email = $7`,
  [metadata.mcpGrantId, metadata.mcpAccessHash, mcpResource(), key.id, key.hash, key.employeeId, key.employeeEmail]);
  if (result.rows.length !== 1 || key.scopes.some(scope => !result.rows[0].scopes.includes(scope))) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Reconnect the connector to authorize this request.');
  }
}

export async function authenticateMcpRequest(request: Request, dependencies: Partial<McpOAuthDependencies> = {}): Promise<KeyRegistration> {
  requireMcpEnabled();
  const token = /^Bearer (wog_mcp_at_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Connect with employee authorization.');
  const deps = { ...defaults, ...dependencies };
  deps.limit('access', 120);
  try {
    return await deps.readTransaction(async client => {
      const hash = hashOAuth(token);
      const result = await client.query<Grant>(`SELECT ${grantColumns} FROM context_mcp_private.oauth_tokens t
        JOIN context_mcp_private.oauth_grants g ON g.id = t.grant_id
        WHERE t.hash = $1 AND t.kind = 'access' AND t.expires_at > CURRENT_TIMESTAMP
          AND g.revoked_at IS NULL AND g.expires_at > CURRENT_TIMESTAMP AND g.resource = $2`, [hash, mcpResource()]);
      if (result.rows.length !== 1) oauthFail('invalid_grant', 'Reconnect this connector.');
      const grant = result.rows[0];
      const key = await currentGrantKey(client, grant);
      return { ...key, mcpGrantId: grant.id, mcpAccessHash: hash } as McpKey;
    });
  } catch (error) {
    if (error instanceof OAuthError || error instanceof HttpError && [401, 403].includes(error.status)) {
      throw new HttpError(401, 'UNAUTHORIZED', 'Reconnect the connector to authorize this request.');
    }
    throw error;
  }
}

async function register(request: Request, deps: McpOAuthDependencies) {
  deps.limit('register', 10);
  const body = await boundedOAuthBody(request, true) as Record<string, unknown>;
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 5) oauthFail('invalid_client_metadata', 'Register one to five trusted callback URLs.');
  const redirects = body.redirect_uris.map(validateRedirect);
  if (new Set(redirects).size !== redirects.length || new Set(redirects.map(value => new URL(value).origin)).size !== 1) oauthFail('invalid_client_metadata', 'Callback URLs must belong to one trusted client origin.');
  const name = body.client_name ?? 'MCP client';
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) oauthFail('invalid_client_metadata', 'Supply a short client name.');
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') oauthFail('invalid_client_metadata', 'Public clients must use PKCE.');
  const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.length > 2 || grants.some(value => !['authorization_code', 'refresh_token'].includes(String(value)))) oauthFail('invalid_client_metadata', 'Only authorization-code and refresh grants are supported.');
  if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== 'code')) oauthFail('invalid_client_metadata', 'Only code responses are supported.');
  const scopes = oauthScopes(body.scope);
  const id = randomOAuth('wog_client_');
  await deps.writeTransaction(async client => {
    const lock = (await client.query('SELECT pg_try_advisory_xact_lock(1784056941, 1802406255) AS locked')).rows[0];
    if (!lock?.locked) oauthFail('temporarily_unavailable', 'Retry connector registration shortly.', 503);
    const count = (await client.query('SELECT count(*)::integer AS count FROM context_mcp_private.oauth_clients')).rows[0]?.count;
    if (!Number.isInteger(count) || count >= 2000) oauthFail('temporarily_unavailable', 'Connector registration capacity reached.', 503);
    await client.query('INSERT INTO context_mcp_private.oauth_clients (id, name, redirect_uris, scopes) VALUES ($1, $2, $3, $4)', [id, name.trim(), redirects, scopes]);
  });
  // RFC7591: ignore unknown client metadata; never fetch metadata/logo/JWKS URLs.
  return oauthResponse({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name.trim(), redirect_uris: redirects,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: scopes.join(' ') }, 201, request);
}

async function preview(request: Request, deps: McpOAuthDependencies) {
  if (request.url.length > 4096 || request.headers.get('sec-fetch-site') === 'cross-site') oauthFail();
  deps.limit('preview', 60);
  const authorization = parseAuthorization(new URL(request.url).searchParams);
  const client = await deps.readTransaction(active => registeredClient(active, authorization.clientId));
  requireClientAuthorization(client, authorization);
  const consent = createConsent(request, authorization);
  const redirectOrigin = new URL(authorization.redirectUri).origin;
  const response = oauthResponse({ requestHandle: consent.requestHandle, clientName: client.name, clientOrigin: redirectOrigin,
    redirectOrigin, redirectUri: authorization.redirectUri, resource: authorization.resource, requestedScopes: authorization.scopes }, 200);
  response.headers.append('Set-Cookie', consent.cookie);
  return response;
}
function authorizationRedirect(authorization: AuthorizationRequest, parameter: 'code' | 'error', value: string) {
  const redirect = new URL(authorization.redirectUri);
  redirect.searchParams.set(parameter, value);
  if (authorization.state !== undefined) redirect.searchParams.set('state', authorization.state);
  return redirect.toString();
}
async function approve(request: Request, deps: McpOAuthDependencies) {
  requireConsoleOrigin(request);
  deps.limit('authorize', 20);
  const body = await boundedOAuthBody(request, true) as Record<string, unknown>;
  if (Object.keys(body).some(name => !['requestHandle', 'apiKey', 'approve'].includes(name)) || typeof body.approve !== 'boolean') oauthFail();
  const authorization = readConsent(request, body.requestHandle);
  if (!body.approve) {
    const response = oauthResponse({ redirectUrl: authorizationRedirect(authorization, 'error', 'access_denied') });
    response.headers.append('Set-Cookie', consentCookie('', 0));
    return response;
  }
  if (typeof body.apiKey !== 'string' || !/^wog_ctx_[A-Za-z0-9_-]{43}$/.test(body.apiKey)) throw new HttpError(401, 'UNAUTHORIZED', 'Use your employee API key to connect.');
  const keyRequest = new Request(`${consoleOrigin()}/mcp`, { headers: { Authorization: `Bearer ${body.apiKey}` } });
  const code = randomOAuth('wog_mcp_code_');
  await deps.writeTransaction(async client => {
    requireClientAuthorization(await registeredClient(client, authorization.clientId), authorization);
    const key = await authenticateRequestKey(keyRequest, hash => findDatabaseKey(client, hash));
    const principal = await resolvePrincipal(client, key);
    const scopes = authorization.scopes.filter(scope => key.scopes.includes(scope) && principal.scopes.includes(scope));
    if (!scopes.length) oauthFail('invalid_scope', 'This employee has none of the requested read permissions.', 403);
    const lock = (await client.query('SELECT pg_try_advisory_xact_lock(1784056941, 1802406256) AS locked')).rows[0];
    if (!lock?.locked) oauthFail('temporarily_unavailable', 'Retry connector authorization shortly.', 503);
    const count = (await client.query('SELECT count(*)::integer AS count FROM context_mcp_private.oauth_grants WHERE expires_at > CURRENT_TIMESTAMP AND revoked_at IS NULL')).rows[0]?.count;
    if (!Number.isInteger(count) || count >= 2000) oauthFail('temporarily_unavailable', 'Connector authorization capacity reached.', 503);
    const id = randomUUID();
    const expires = new Date(Math.min(Date.now() + MCP_REFRESH_SECONDS * 1000, Date.parse(key.expiresAt)));
    const inserted = await client.query(`INSERT INTO context_mcp_private.oauth_grants
      (id, client_id, key_id, key_hash, key_source, employee_id, employee_email, scopes, resource, expires_at, consent_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (consent_hash) DO NOTHING RETURNING id`,
    [id, authorization.clientId, key.id, key.hash, key.source ?? 'environment', principal.employeeId, principal.email, scopes, authorization.resource, expires, hashOAuth(String(body.requestHandle))]);
    if (inserted.rows.length !== 1) oauthFail('invalid_request', 'This authorization was already used. Restart the connection.', 409);
    await client.query(`INSERT INTO context_mcp_private.oauth_codes (hash, grant_id, challenge, redirect_uri, expires_at)
      VALUES ($1, $2, $3, $4, $5)`, [hashOAuth(code), id, authorization.challenge, authorization.redirectUri, new Date(Math.min(expires.getTime(), Date.now() + MCP_CODE_SECONDS * 1000))]);
  });
  const response = oauthResponse({ redirectUrl: authorizationRedirect(authorization, 'code', code) });
  response.headers.append('Set-Cookie', consentCookie('', 0));
  return response;
}

async function issueTokens(client: PoolClient, grant: Grant, key: KeyRegistration) {
  const expiry = Math.min(milliseconds(grant.expires_at), Date.parse(key.expiresAt));
  const accessExpiry = Math.min(expiry, Date.now() + MCP_ACCESS_SECONDS * 1000);
  const access = randomOAuth('wog_mcp_at_');
  const refresh = randomOAuth('wog_mcp_rt_');
  const count = (await client.query('SELECT count(*)::integer AS count FROM context_mcp_private.oauth_tokens WHERE grant_id = $1', [grant.id])).rows[0]?.count;
  if (!Number.isInteger(count) || count >= 8192) oauthFail('invalid_grant', 'Reconnect this connector.');
  // Persist narrowing, so permissions removed at refresh cannot reappear later.
  await client.query('UPDATE context_mcp_private.oauth_grants SET scopes = $2 WHERE id = $1', [grant.id, key.scopes]);
  await client.query(`INSERT INTO context_mcp_private.oauth_tokens (hash, grant_id, kind, expires_at)
    VALUES ($1, $3, 'access', $4), ($2, $3, 'refresh', $5)`, [hashOAuth(access), hashOAuth(refresh), grant.id, new Date(accessExpiry), new Date(expiry)]);
  return { access_token: access, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((accessExpiry - Date.now()) / 1000)),
    refresh_token: refresh, scope: key.scopes.join(' '), resource: mcpResource() };
}

async function token(request: Request, deps: McpOAuthDependencies) {
  deps.limit('token', 120);
  if (request.headers.has('authorization')) oauthFail('invalid_client', 'Use a public client with PKCE.', 401);
  const values = parameters(await boundedOAuthBody(request, false) as URLSearchParams,
    ['grant_type', 'client_id', 'code', 'redirect_uri', 'code_verifier', 'refresh_token', 'resource', 'scope']);
  if (values.resource !== mcpResource()) oauthFail('invalid_target', 'Use the configured connector resource.');
  if (!['authorization_code', 'refresh_token'].includes(values.grant_type)) oauthFail('unsupported_grant_type', 'Use authorization-code or refresh-token grants.');
  const result = await deps.writeTransaction(async client => {
    const registered = await registeredClient(client, values.client_id ?? '');
    if (values.grant_type === 'authorization_code') {
      if (!/^wog_mcp_code_[A-Za-z0-9_-]{43}$/.test(values.code ?? '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(values.code_verifier ?? '')
        || values.refresh_token !== undefined || values.scope !== undefined || !registered.redirect_uris.includes(values.redirect_uri)) oauthFail('invalid_grant', 'The authorization code is invalid.');
      const found = await client.query<Grant & { challenge: string; redirect_uri: string; code_expires_at: Date | string; used_at: Date | string | null }>(
        `SELECT ${grantColumns}, c.challenge, c.redirect_uri, c.expires_at AS code_expires_at, c.used_at
          FROM context_mcp_private.oauth_codes c JOIN context_mcp_private.oauth_grants g ON g.id = c.grant_id
          WHERE c.hash = $1 AND g.client_id = $2 FOR UPDATE OF c, g`, [hashOAuth(values.code), registered.id]);
      const grant = found.rows[0];
      const challenge = createHash('sha256').update(values.code_verifier).digest('base64url');
      if (!grant || grant.redirect_uri !== values.redirect_uri || grant.resource !== values.resource || grant.challenge.length !== challenge.length
        || !timingSafeEqual(Buffer.from(grant.challenge), Buffer.from(challenge)) || milliseconds(grant.code_expires_at) <= Date.now()) oauthFail('invalid_grant', 'The authorization code is invalid.');
      if (grant.used_at !== null) {
        await client.query('UPDATE context_mcp_private.oauth_grants SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1', [grant.id]);
        return null; // Commit revocation before returning invalid_grant outside this transaction.
      }
      const key = await currentGrantKey(client, grant);
      await client.query('UPDATE context_mcp_private.oauth_codes SET used_at = CURRENT_TIMESTAMP WHERE hash = $1', [hashOAuth(values.code)]);
      return issueTokens(client, grant, key);
    }
    if (!/^wog_mcp_rt_[A-Za-z0-9_-]{43}$/.test(values.refresh_token ?? '') || ['code', 'code_verifier', 'redirect_uri'].some(field => values[field] !== undefined)) oauthFail('invalid_grant', 'The refresh token is invalid.');
    const found = await client.query<Grant & { token_expires_at: Date | string; used_at: Date | string | null }>(`SELECT ${grantColumns}, t.expires_at AS token_expires_at, t.used_at
      FROM context_mcp_private.oauth_tokens t JOIN context_mcp_private.oauth_grants g ON g.id = t.grant_id
      WHERE t.hash = $1 AND t.kind = 'refresh' AND g.client_id = $2 FOR UPDATE OF t, g`, [hashOAuth(values.refresh_token), registered.id]);
    const grant = found.rows[0];
    if (!grant || grant.resource !== values.resource || milliseconds(grant.token_expires_at) <= Date.now()) oauthFail('invalid_grant', 'The refresh token is invalid.');
    if (grant.used_at !== null) {
      await client.query('UPDATE context_mcp_private.oauth_grants SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1', [grant.id]);
      return null;
    }
    const key = await currentGrantKey(client, grant);
    if (values.scope !== undefined) {
      const requested = oauthScopes(values.scope);
      if (requested.some(scope => !key.scopes.includes(scope))) oauthFail('invalid_scope', 'Refresh cannot increase read permissions.');
      key.scopes = requested;
    }
    await client.query('UPDATE context_mcp_private.oauth_tokens SET used_at = CURRENT_TIMESTAMP WHERE hash = $1', [hashOAuth(values.refresh_token)]);
    return issueTokens(client, grant, key);
  });
  if (!result) oauthFail('invalid_grant', 'This authorization was already used. Reconnect the connector.');
  return oauthResponse(result, 200, request);
}

async function revoke(request: Request, deps: McpOAuthDependencies) {
  deps.limit('revoke', 30);
  if (request.headers.has('authorization')) oauthFail('invalid_client', 'Use the registered public client.', 401);
  const values = parameters(await boundedOAuthBody(request, false) as URLSearchParams, ['token', 'token_type_hint', 'client_id']);
  if (!/^wog_mcp_(?:at|rt)_[A-Za-z0-9_-]{43}$/.test(values.token ?? '')) return oauthResponse({}, 200, request);
  await deps.writeTransaction(async client => {
    const registered = await registeredClient(client, values.client_id ?? '');
    await client.query(`UPDATE context_mcp_private.oauth_grants g SET revoked_at = CURRENT_TIMESTAMP
      FROM context_mcp_private.oauth_tokens t WHERE t.grant_id = g.id AND t.hash = $1 AND g.client_id = $2`, [hashOAuth(values.token), registered.id]);
  });
  return oauthResponse({}, 200, request);
}

export async function handleMcpOAuthRequest(request: Request, action: 'authorize' | 'register' | 'token' | 'revoke', dependencies: Partial<McpOAuthDependencies> = {}) {
  try {
    requireMcpEnabled();
    if (new URL(request.url).origin !== consoleOrigin()) oauthFail('invalid_request', 'Use the configured connector URL.');
    const headers = oauthHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const deps = { ...defaults, ...dependencies };
    if (action === 'authorize' && request.method === 'GET') return await preview(request, deps);
    if (request.method !== 'POST') oauthFail('invalid_request', 'Use HTTP POST.', 405);
    if (new URL(request.url).search) oauthFail();
    if (action === 'authorize') return await approve(request, deps);
    if (action === 'register') return await register(request, deps);
    if (action === 'revoke') return await revoke(request, deps);
    return await token(request, deps);
  } catch (error) { return oauthErrorResponse(error, request, action === 'authorize'); }
}
