import { ConsoleApiError } from '@/components/console/helpers';
import { SCOPE_OPTIONS } from '@/components/console/types';
import type { ConsentDetails } from './consent-view';

export type AuthorizationPreview = ConsentDetails & { requestHandle: string };

export function authorizationQuery(search: string) {
  const query = new URLSearchParams(search);
  const allowed = new Set(['response_type', 'client_id', 'redirect_uri', 'resource', 'code_challenge', 'code_challenge_method', 'state', 'scope']);
  for (const name of query.keys()) {
    if (!allowed.has(name) || query.getAll(name).length !== 1) throw new Error('This connection request is invalid. Start again from your AI tool’s connector settings.');
  }
  for (const name of ['response_type', 'client_id', 'redirect_uri', 'resource', 'code_challenge', 'code_challenge_method']) {
    if (!query.get(name)) throw new Error('This connection request is incomplete. Start again from your AI tool’s connector settings.');
  }
  if (query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256') {
    throw new Error('This connection request is not supported. Start again from your AI tool’s connector settings.');
  }
  return query.toString();
}

function safeUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('Invalid authorization response');
  const parsed = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) || parsed.username || parsed.password) throw new Error('Invalid authorization response');
  return parsed;
}

export function readAuthorizationPreview(value: unknown, currentOrigin: string): AuthorizationPreview {
  if (!value || typeof value !== 'object') throw new Error('Invalid authorization response');
  const data = value as Record<string, unknown>;
  if (typeof data.requestHandle !== 'string' || !data.requestHandle || typeof data.clientName !== 'string' || !data.clientName.trim()
    || !Array.isArray(data.requestedScopes) || !data.requestedScopes.length || data.requestedScopes.some(scope => !SCOPE_OPTIONS.some(option => option.value === scope))) {
    throw new Error('Invalid authorization response');
  }
  const clientOrigin = safeUrl(data.clientOrigin).origin;
  const redirectOrigin = safeUrl(data.redirectOrigin).origin;
  const redirectUri = safeUrl(data.redirectUri);
  const resource = safeUrl(data.resource);
  if (redirectUri.origin !== redirectOrigin || resource.origin !== currentOrigin || resource.pathname !== '/mcp' || resource.search || resource.hash) throw new Error('Invalid authorization response');
  return { requestHandle: data.requestHandle, clientName: data.clientName, clientOrigin, redirectOrigin, redirectUri: redirectUri.toString(), resource: resource.toString(), scopes: [...new Set(data.requestedScopes as string[])] };
}

export function authorizationRedirect(value: unknown, preview: AuthorizationPreview) {
  if (!value || typeof value !== 'object' || !('redirectUrl' in value)) throw new Error('Invalid authorization response');
  const target = safeUrl(value.redirectUrl);
  const registered = safeUrl(preview.redirectUri);
  if (target.origin !== preview.redirectOrigin || target.pathname !== registered.pathname || target.hash) throw new Error('Invalid authorization response');
  // Server validation binds the full URI and OAuth state. Also retain every
  // registered query value, and never follow an arbitrary external destination.
  for (const name of new Set(registered.searchParams.keys())) {
    if (JSON.stringify(target.searchParams.getAll(name)) !== JSON.stringify(registered.searchParams.getAll(name))) throw new Error('Invalid authorization response');
  }
  const hasCode = target.searchParams.getAll('code').length === 1 && Boolean(target.searchParams.get('code')) && !target.searchParams.has('error');
  const denied = target.searchParams.getAll('error').length === 1 && target.searchParams.get('error') === 'access_denied' && !target.searchParams.has('code');
  if (!hasCode && !denied) throw new Error('Invalid authorization response');
  return target.toString();
}

export async function oauthRequest(query?: string, body?: { requestHandle: string; apiKey?: string; approve: boolean }, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/oauth/authorize${query ? `?${query}` : ''}`, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ConsoleApiError('CONNECTION_FAILED', 'Connection failed', 0);
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ConsoleApiError(typeof value?.error?.code === 'string' ? value.error.code : 'AUTHORIZATION_FAILED', 'Authorization failed', response.status);
  if (!value || typeof value !== 'object') throw new Error('Invalid authorization response');
  return value;
}

export function authorizationError(error: unknown) {
  if (error instanceof ConsoleApiError) {
    if (error.code === 'CONNECTION_FAILED') return 'Cannot reach Wareongo Context. Check your connection and try again.';
    if (error.code === 'invalid_client') return 'The requesting application is not registered or its request is no longer valid. Start again from your AI tool’s connector settings.';
    if (error.status === 401) return 'The employee API key is invalid or expired. Check your own key and try again.';
    if (error.status === 403) return 'This connection is not permitted. Check the application address and your employee key’s permissions.';
    if (error.status === 409) return 'This authorization request has expired or was already used. Start the connection again from your AI tool.';
    if (error.status === 429) return 'Too many connection attempts. Wait a moment, then start again from your AI tool.';
    if (error.status >= 500) return 'Connector authorization is temporarily unavailable. An administrator may need to complete MCP setup or restore the service.';
    if (error.status === 400 || error.status === 422) return 'This connection request is invalid. Start again from your AI tool’s connector settings.';
  }
  return 'The connection request could not be verified. Start again from your AI tool’s connector settings.';
}
