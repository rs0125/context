import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { KeyRegistration } from '../src/lib/auth';
import { handleApiRequest } from '../src/lib/api';
import { handleMcpRequest } from '../src/lib/mcp';
import { argumentsSha256 } from '../src/lib/mcp-read-contract';
import { resolveLocation } from '../src/lib/location-resolver';
import { getOpenApiDocument } from '../src/lib/openapi';
import { HttpError } from '../src/lib/errors';

const origin = 'https://context.example.test';
const employee = { id: 7, email: 'synthetic@example.test', is_active: true, dashboardAccess: false, adminAccess: false, twenty_user_id: null };
function harness() {
  const key: KeyRegistration = { id: randomUUID(), employeeId: 7, hash: 'a'.repeat(64), employeeEmail: employee.email,
    scopes: ['knowledge:read'], expiresAt: '2099-01-01T00:00:00Z' };
  let inTransaction = false;
  const query = vi.fn(async () => ({ rows: [employee] }));
  const client = { query } as unknown as PoolClient;
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
    inTransaction = true;
    try { return await work(client); } finally { inTransaction = false; }
  };
  const resolver = vi.fn(async (...args: Parameters<typeof resolveLocation>) => {
    expect(inTransaction).toBe(false);
    return resolveLocation(...args);
  });
  return { key, query, transaction, authenticate: vi.fn(async () => key), resolveLocation: resolver, audit: vi.fn(), revalidateKey: vi.fn(async () => {}) };
}
function request(query: string) { return new Request(`${origin}/api/v1/locations/resolve?${query}`); }
function rpc(method: string, params: object = {}) {
  return new Request(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
async function wire(response: Response) {
  const text = await response.text();
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).at(-1)!.slice(5)) : JSON.parse(text);
}
beforeEach(() => vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin));
afterEach(() => vi.unstubAllEnvs());

describe('authenticated location resolution boundary', () => {
  it('resolves a caller-supplied point without business/write access or a held database socket', async () => {
    const deps = harness();
    const response = await handleApiRequest(request('latitude=0&longitude=77.5'), ['locations', 'resolve'], deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.json()).data).toMatchObject({ status: 'resolved', candidates: [{ latitude: 0, longitude: 77.5, method: 'supplied_coordinates' }] });
    expect(deps.revalidateKey).toHaveBeenCalledTimes(2);
    expect(deps.query.mock.calls).toHaveLength(2);
    expect(JSON.stringify(deps.audit.mock.calls)).not.toContain('77.5');
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'locations/resolve', employeeId: 7, status: 200 }));
  });
  it('rejects unknown employees before resolving links', async () => {
    const deps = harness(); deps.query.mockResolvedValue({ rows: [] });
    expect((await handleApiRequest(request('location=https%3A%2F%2Fmaps.app.goo.gl%2Fsynthetic'), ['locations', 'resolve'], deps)).status).toBe(403);
    expect(deps.resolveLocation).not.toHaveBeenCalled();
  });
  it('rejects missing credentials before any provider or database access', async () => {
    const deps = harness(); deps.authenticate.mockRejectedValue(new HttpError(401, 'UNAUTHORIZED', 'Connect first.'));
    expect((await handleApiRequest(request('latitude=0&longitude=0'), ['locations', 'resolve'], deps)).status).toBe(401);
    expect(deps.resolveLocation).not.toHaveBeenCalled(); expect(deps.query).not.toHaveBeenCalled();
  });
  it('withholds resolution after the employee or grant is revoked during a provider read', async () => {
    for (const kind of ['employee', 'grant']) {
      const deps = harness();
      if (kind === 'employee') deps.query.mockResolvedValueOnce({ rows: [employee] }).mockResolvedValueOnce({ rows: [] });
      else deps.revalidateKey.mockResolvedValueOnce().mockRejectedValueOnce(new HttpError(401, 'UNAUTHORIZED', 'Revoked.'));
      const response = await handleApiRequest(request('latitude=12&longitude=77'), ['locations', 'resolve'], deps);
      expect(response.status).toBe(kind === 'employee' ? 403 : 401);
      expect(await response.json()).not.toHaveProperty('data');
      expect(deps.resolveLocation).toHaveBeenCalledOnce();
    }
  });
  it.each(['latitude=12', 'latitude=&longitude=77', 'latitude=12&longitude=77&latitude=13', 'location=12,77&latitude=12&longitude=77', 'employee_id=8&latitude=12&longitude=77'])('rejects malformed or impersonating input %s', async query => {
    const deps = harness();
    expect((await handleApiRequest(request(query), ['locations', 'resolve'], deps)).status).toBe(422);
    expect(deps.resolveLocation).not.toHaveBeenCalled();
  });
  it('documents the read-only resolver without adding a REST write', () => {
    const route = getOpenApiDocument().paths['/locations/resolve'];
    expect(Object.keys(route)).toEqual(['get']);
    expect(route.get.parameters.map(value => value.name)).toEqual(['location', 'latitude', 'longitude']);
  });
});

describe('location tool discovery and evidence', () => {
  it.each(['claude', 'whatsapp'] as const)('publishes the utility for authenticated %s without GIS write scopes', async platform => {
    const deps = harness();
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: deps.authenticate, prompts: async () => ({}), platform }));
    const tool = result.tools.find((value: { name: string }) => value.name === 'resolve_location');
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool._meta['wareongo/context-read-v1']).toEqual({ requiredScopes: [], sourceFamily: 'context' });
    expect(tool._meta['wareongo/context-write-v1']).toBeUndefined();
    expect(result.tools.map((value: { name: string }) => value.name)).not.toContain('create_gis_poi');
  });
  it('respects dynamically edited tool platform visibility', async () => {
    const deps = harness();
    const { result } = await wire(await handleMcpRequest(rpc('tools/list'), { authenticate: deps.authenticate,
      prompts: async () => ({ toolPlatforms: { resolve_location: ['claude'] } }), platform: 'whatsapp' }));
    expect(result.tools.map((value: { name: string }) => value.name)).not.toContain('resolve_location');
  });
  it('binds the original arguments and omits exact locations from citations without invoking creation', async () => {
    const deps = harness();
    const args = { location: 'https://www.google.com/maps/search/?api=1&query=12.9,77.6' };
    const write = vi.fn();
    const { result } = await wire(await handleMcpRequest(rpc('tools/call', { name: 'resolve_location', arguments: args }), {
      authenticate: deps.authenticate, prompts: async () => ({}), revalidateKey: deps.revalidateKey, gisWrite: write,
      read: (request, path) => handleApiRequest(request, path, deps),
    }));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.source_path).toBe('/api/v1/locations/resolve');
    expect(result.structuredContent.data).toMatchObject({ status: 'resolved', candidates: [{ latitude: 12.9, longitude: 77.6 }] });
    expect(result.structuredContent.meta).toMatchObject({ toolName: 'resolve_location', argumentsSha256: argumentsSha256(args) });
    expect(write).not.toHaveBeenCalled();
  });
});
