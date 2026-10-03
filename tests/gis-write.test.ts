import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, jwtVerify, type CryptoKey } from 'jose';
import type { PoolClient } from 'pg';
import type { KeyRegistration, Principal } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';
import { executeGisWrite, executeGisRollback, gisWriteAvailability, gisWriteInputSchema, gisWriteOutputSchema, type GisWriteDependencies } from '../src/lib/gis-write';

const endpoint = 'https://dashboard.example.test/api/integrations/context-engine/geo/points';
const input = { operation_id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic site', category: 'POTENTIAL_WAREHOUSE', latitude: 0, longitude: 78.123456, notes: 'Synthetic scouting notes', city: 'Synthetic city' };
const principal: Principal = { employeeId: 23, email: 'synthetic@wareongo.test', scopes: ['gis:write'], keyId: 'fixture', isAnalyst: false };
const key: KeyRegistration = { id: 'fixture', hash: 'a'.repeat(64), employeeEmail: principal.email, employeeId: principal.employeeId, scopes: ['gis:write'], expiresAt: '2099-01-01T00:00:00Z' };
let privateJwk: string, publicKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { extractable: true });
  privateJwk = JSON.stringify(await exportJWK(pair.privateKey)); publicKey = pair.publicKey;
});
function environment(): NodeJS.ProcessEnv { return { NODE_ENV: 'test', CONTEXT_GIS_WRITES_ENABLED: 'true', CONTEXT_GIS_BACKEND_URL: endpoint, CONTEXT_GIS_SIGNING_KID: 'synthetic', CONTEXT_GIS_SIGNING_PRIVATE_JWK: privateJwk }; }
function receipt(changes: Record<string, unknown> = {}) {
  return { success: true, operationId: input.operation_id, replayed: false, data: {
    id: '22222222-2222-4222-8222-222222222222', name: input.name, category: input.category,
    lat: input.latitude, lng: input.longitude, notes: input.notes, city: input.city,
    createdBy: principal.email, createdAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z',
  }, ...changes };
}
function fixture(overrides: Partial<GisWriteDependencies> = {}) {
  const db = {} as PoolClient;
  const revalidate = vi.fn(async () => {});
  let inTransaction = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { expect(inTransaction).toBe(false); return Response.json(receipt(), { status: 201 }); });
  const deps: GisWriteDependencies = {
    transaction: async work => { inTransaction = true; try { return await work(db); } finally { inTransaction = false; } },
    principal: vi.fn(async () => ({ ...principal })), fetch, env: environment(), now: Date.now, timeoutMs: 8000, ...overrides,
  };
  return { deps, fetch, revalidate, db, run: (args: unknown = input, signal = new AbortController().signal) => executeGisWrite(args, key, signal, revalidate, deps) };
}

describe('GIS backend write contract', () => {
  it('clips the assertion expiry to the remaining authenticated grant lifetime', async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const ctx = fixture({ now: () => now });
    const shortGrant = { ...key, expiresAt: new Date(now + 17500).toISOString() };
    expect((await executeGisWrite(input, shortGrant, new AbortController().signal, ctx.revalidate, ctx.deps)).outcome).toBe('created');
    const init = ctx.fetch.mock.calls[0][1]!;
    const token = (init.headers as Record<string, string>).authorization.slice('ContextEngine '.length);
    const { payload } = await jwtVerify(token, publicKey, { currentDate: new Date(now) });
    expect(payload.iat).toBe(now / 1000);
    expect(payload.exp).toBe(now / 1000 + 17);
    expect((payload.exp as number) * 1000).toBeLessThanOrEqual(Date.parse(shortGrant.expiresAt));
  });

  it.each(['expired', 'invalid', 'less_than_one_second'])('does not dispatch when the grant has %s lifetime before signing', async kind => {
    const now = Math.floor(Date.now() / 1000) * 1000 + 250;
    const ctx = fixture({ now: () => now });
    const expiresAt = kind === 'invalid' ? 'invalid' : new Date(now + (kind === 'expired' ? -1 : 800)).toISOString();
    const result = await executeGisWrite(input, { ...key, expiresAt }, new AbortController().signal, ctx.revalidate, ctx.deps);
    expect(result).toMatchObject({ outcome: 'not_dispatched', code: 'GIS_WRITE_UNAUTHORIZED' });
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it('signs exact UTF-8 bytes for the authenticated actor and rechecks authority after a verified creation', async () => {
    const ctx = fixture();
    const result = await ctx.run();
    expect(result).toMatchObject({ outcome: 'created', operation_id: input.operation_id, data: { createdBy: principal.email, lat: 0 } });
    expect(gisWriteOutputSchema.safeParse(result).success).toBe(true);
    expect(ctx.revalidate).toHaveBeenCalledTimes(2);
    expect(ctx.deps.principal).toHaveBeenCalledTimes(2);
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = ctx.fetch.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    const token = (init!.headers as Record<string, string>).authorization.replace(/^ContextEngine /, '');
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, { issuer: 'wareongo:context-engine', audience: endpoint, algorithms: ['EdDSA'] });
    expect(protectedHeader).toEqual({ alg: 'EdDSA', typ: 'context-geo-write+jwt', kid: 'synthetic' });
    expect(payload).toMatchObject({ sub: '23', email: principal.email, scopes: ['geo:points:create'], htm: 'POST', htu: endpoint,
      body_sha256: createHash('sha256').update(init!.body as string, 'utf8').digest('base64url') });
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
    expect(payload.jti).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.parse(init!.body as string)).toEqual({ operationId: input.operation_id, name: input.name, category: input.category, lat: input.latitude, lng: input.longitude, notes: input.notes, city: input.city });
    expect(init!.headers).not.toHaveProperty('origin');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('reuses caller operation and canonical point input, but signs each explicit retry with a fresh nonce', async () => {
    const ctx = fixture();
    ctx.fetch.mockImplementation(async () => Response.json(receipt({ replayed: true }), { status: 200 }));
    const args = { ...input, name: ` ${input.name} `, city: ` ${input.city} ` };
    const first = await ctx.run(args), second = await ctx.run(args);
    expect(first.outcome).toBe('replayed'); expect(second.outcome).toBe('replayed');
    expect(first.message).toContain('not a current-state read');
    const attempts = await Promise.all(ctx.fetch.mock.calls.map(async ([, init]) => {
      const token = (init!.headers as Record<string, string>).authorization.slice('ContextEngine '.length);
      return { body: init!.body, jwt: (await jwtVerify(token, publicKey)).payload };
    }));
    expect(attempts[0].body).toBe(attempts[1].body);
    expect(attempts[0].jwt.jti).not.toBe(attempts[1].jwt.jti);
  });

  it('replays preserve the historical creation actor after a valid employee email change', async () => {
    const ctx = fixture();
    ctx.fetch.mockResolvedValue(Response.json(receipt({ replayed: true, data: { ...receipt().data, createdBy: 'old-email@wareongo.test' } }), { status: 200 }));
    expect(await ctx.run()).toMatchObject({ outcome: 'replayed', data: { createdBy: 'old-email@wareongo.test' } });
    expect(ctx.revalidate).toHaveBeenCalledTimes(2);
  });

  it('configuration rejects an unrelated public x attached to a valid private seed', async () => {
    const ctx = fixture();
    const other = await generateKeyPair('EdDSA', { extractable: true });
    ctx.deps.env.CONTEXT_GIS_SIGNING_PRIVATE_JWK = JSON.stringify({ ...JSON.parse(privateJwk), x: (await exportJWK(other.publicKey)).x });
    expect(gisWriteAvailability(ctx.deps.env).available).toBe(false);
    expect(await ctx.run()).toMatchObject({ outcome: 'not_dispatched', code: 'GIS_WRITE_CONFIGURATION' });
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { actor: 23 }, { employee_id: 23 }, { createdBy: 'attacker@wareongo.test' },
    { latitude: '0' }, { longitude: NaN }, { latitude: 91 }, { operation_id: 'fresh-id' }, { category: 'WAREHOUSE' }, { name: ' ' },
  ])('rejects unsupported or identity-bearing model input before any I/O: %j', async patch => {
    const ctx = fixture();
    expect(gisWriteInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    await expect(ctx.run({ ...input, ...patch })).rejects.toMatchObject({ code: 'GIS_WRITE_INVALID_INPUT' });
    expect(ctx.fetch).not.toHaveBeenCalled(); expect(ctx.revalidate).not.toHaveBeenCalled();
  });

  it.each([
    'http://dashboard.example.test/api/integrations/context-engine/geo/points',
    'https://127.0.0.1/api/integrations/context-engine/geo/points',
    'https://[::1]/api/integrations/context-engine/geo/points',
    'https://service.internal/api/integrations/context-engine/geo/points',
    'https://localhost/api/integrations/context-engine/geo/points',
    `${endpoint}?override=1`, `${endpoint}#fragment`, `${endpoint}/`,
    'https://user:secret@dashboard.example.test/api/integrations/context-engine/geo/points',
    'https://dashboard.example.test/api/other',
  ])('refuses unsafe or noncanonical configured targets: %s', async url => {
    const ctx = fixture(); ctx.deps.env.CONTEXT_GIS_BACKEND_URL = url;
    expect(gisWriteAvailability(ctx.deps.env)).toEqual({ enabled: true, configured: false, available: false });
    expect(await ctx.run()).toMatchObject({ outcome: 'not_dispatched', code: 'GIS_WRITE_CONFIGURATION' });
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it('discovery is disabled by default and never reveals private configuration', async () => {
    expect(gisWriteAvailability({ NODE_ENV: 'test' })).toEqual({ enabled: false, configured: false, available: false });
    const ctx = fixture(); ctx.deps.env.CONTEXT_GIS_WRITES_ENABLED = 'false';
    expect(gisWriteAvailability(ctx.deps.env)).toEqual({ enabled: false, configured: true, available: false });
    expect(await ctx.run()).toMatchObject({ outcome: 'not_dispatched', code: 'GIS_WRITE_DISABLED' });
    expect(ctx.fetch).not.toHaveBeenCalled();
    ctx.deps.env.CONTEXT_GIS_WRITES_ENABLED = 'true'; ctx.deps.env.CONTEXT_GIS_SIGNING_PRIVATE_JWK = 'secret broken config';
    const result = await ctx.run();
    expect(result.code).toBe('GIS_WRITE_CONFIGURATION'); expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('requires an explicit currently permitted write scope and both before/after key revalidation', async () => {
    const missingScope = fixture({ principal: async () => ({ ...principal, scopes: ['warehouses:read'] }) });
    expect(await missingScope.run()).toMatchObject({ outcome: 'not_dispatched', code: 'GIS_WRITE_FORBIDDEN' });
    expect(missingScope.fetch).not.toHaveBeenCalled();
    const revoked = fixture(); revoked.revalidate.mockRejectedValue(new HttpError(401, 'UNAUTHORIZED', 'secret credential detail'));
    expect(await revoked.run()).toMatchObject({ outcome: 'not_dispatched', code: 'GIS_WRITE_UNAUTHORIZED' });
    expect(revoked.fetch).not.toHaveBeenCalled();
    const during = fixture(); during.revalidate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new HttpError(401, 'UNAUTHORIZED', 'revoked'));
    const result = await during.run();
    expect(result.outcome).toBe('outcome_unknown'); expect(result).not.toHaveProperty('data');
    expect(during.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch if a configuration revocation occurs during authorization', async () => {
    const ctx = fixture(); ctx.revalidate.mockImplementation(async () => { ctx.deps.env.CONTEXT_GIS_WRITES_ENABLED = 'false'; });
    expect((await ctx.run()).outcome).toBe('not_dispatched'); expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { operationId: randomUUID() }, { replayed: true },
    { data: { ...receipt().data, createdBy: 'other@wareongo.test' } },
    { data: { ...receipt().data, name: 'Other site' } },
    { data: { ...receipt().data, lat: 17 } },
    { data: { ...receipt().data, notes: 'Changed notes' } },
    { data: { ...receipt().data, city: 'Changed city' } },
    { data: { ...receipt().data, id: 'not-a-record' } },
    { data: { ...receipt().data, updatedAt: '2020-01-01T00:00:00.000Z' } },
  ])('never confirms mismatched or malformed backend success: %j', async change => {
    const ctx = fixture(); ctx.fetch.mockResolvedValue(Response.json(receipt(change), { status: 201 }));
    const result = await ctx.run();
    expect(result.outcome).toBe('outcome_unknown'); expect(result).not.toHaveProperty('data');
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 409, 413, 415])('handles a recognized rejection without retrying: %i', async status => {
    const codes: Record<number, string> = { 400: 'CONTEXT_GEO_INVALID_POINT', 401: 'CONTEXT_GEO_UNAUTHORIZED', 403: 'CONTEXT_GEO_FORBIDDEN', 409: 'CONTEXT_GEO_IDEMPOTENCY_CONFLICT', 413: 'CONTEXT_GEO_BODY_TOO_LARGE', 415: 'CONTEXT_GEO_UNSUPPORTED_ENCODING' };
    const ctx = fixture(); ctx.fetch.mockResolvedValue(Response.json({ success: false, code: codes[status] }, { status }));
    expect(await ctx.run()).toMatchObject({ outcome: 'rejected', code: codes[status] });
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([302, 404, 429, 500, 503])('treats unverified HTTP outcomes as unknown, including 5xx: %i', async status => {
    const ctx = fixture(); ctx.fetch.mockResolvedValue(Response.json({ success: false, code: 'CONTEXT_GEO_UNAVAILABLE' }, { status }));
    expect(await ctx.run()).toMatchObject({ outcome: 'outcome_unknown', operation_id: input.operation_id });
    expect(ctx.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds streamed/declared response sizes and rejects invalid encoding without reflecting payloads', async () => {
    const oversized = JSON.stringify({ secret: 'x'.repeat(33000) });
    for (const response of [
      new Response(oversized, { status: 201, headers: { 'content-type': 'application/json' } }),
      new Response('{}', { status: 201, headers: { 'content-type': 'application/json', 'content-length': '33000' } }),
      new Response(new Uint8Array([0xff, 0xfe]), { status: 201, headers: { 'content-type': 'application/json' } }),
      new Response('<html>secret</html>', { status: 201 }),
    ]) {
      const ctx = fixture(); ctx.fetch.mockResolvedValue(response);
      const result = await ctx.run(); expect(result.outcome).toBe('outcome_unknown'); expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  it('returns promptly for timeout before dispatch and cannot dispatch after delayed authorization completes', async () => {
    let resolve!: (principal: Principal) => void;
    const ctx = fixture({ timeoutMs: 15, principal: () => new Promise(done => { resolve = done; }) });
    const result = await ctx.run(); expect(result).toMatchObject({ outcome: 'not_dispatched', code: 'GIS_WRITE_TIMEOUT' });
    resolve(principal); await new Promise(done => setTimeout(done, 5));
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it('timeout or cancellation after dispatch is unknown and never automatically retries', async () => {
    const timeout = fixture({ timeoutMs: 15 }); timeout.fetch.mockImplementation(() => new Promise(() => {}));
    expect((await timeout.run()).outcome).toBe('outcome_unknown'); expect(timeout.fetch).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const cancelled = fixture(); cancelled.fetch.mockImplementation(async () => { controller.abort(); throw new Error('secret network failure'); });
    const result = await cancelled.run(input, controller.signal);
    expect(result.outcome).toBe('outcome_unknown'); expect(result.message).toContain('same operation_id');
    expect(JSON.stringify(result)).not.toContain('secret'); expect(cancelled.fetch).toHaveBeenCalledTimes(1);
    const before = fixture();
    expect((await before.run(input, controller.signal)).outcome).toBe('not_dispatched'); expect(before.fetch).not.toHaveBeenCalled();
  });
});


describe('GIS owned compensation adapter', () => {
  const rollback = { operation_id:'33333333-3333-4333-8333-333333333333', original_operation_id:input.operation_id };
  const response = (replayed=false) => ({success:true,operationId:rollback.operation_id,replayed,data:{originalOperationId:input.operation_id,pointId:receipt().data.id,before:receipt().data,after:null}});
  it.each([false,true])('signs exact rollback audience/action and verifies compensation receipt (replay=%s)',async replayed=>{
    const ctx=fixture();ctx.fetch.mockResolvedValue(Response.json(response(replayed),{status:replayed?200:201}));
    const result=await executeGisRollback(rollback,key,new AbortController().signal,ctx.revalidate,ctx.deps);
    expect(result.outcome).toBe(replayed?'replayed':'rolled_back');expect(ctx.fetch).toHaveBeenCalledOnce();expect(ctx.revalidate).toHaveBeenCalledTimes(2);
    const [url,init]=ctx.fetch.mock.calls[0];expect(url).toBe(`${endpoint}/rollback`);
    const jwt=(init!.headers as Record<string,string>).authorization.slice('ContextEngine '.length);
    const {payload}=await jwtVerify(jwt,publicKey,{audience:`${endpoint}/rollback`});expect(payload.scopes).toEqual(['geo:points:rollback']);expect(payload.htu).toBe(`${endpoint}/rollback`);
    expect(JSON.parse(init!.body as string)).toEqual({operationId:rollback.operation_id,originalOperationId:input.operation_id});
    expect(result.data).toMatchObject({pointId:receipt().data.id,after:null});
  });
  it.each(['original','point','unexpected'])('redacts mismatched %s rollback receipts',async change=>{
    const ctx=fixture(), body=response();if(change==='original')body.data.originalOperationId=rollback.operation_id;if(change==='point')body.data.pointId=rollback.operation_id;if(change==='unexpected')Object.assign(body.data,{secret:'unapproved'});
    ctx.fetch.mockResolvedValue(Response.json(body,{status:201}));const result=await executeGisRollback(rollback,key,new AbortController().signal,ctx.revalidate,ctx.deps);expect(result.outcome).toBe('outcome_unknown');expect(result.data).toBeUndefined();expect(ctx.fetch).toHaveBeenCalledOnce();
  });
  it.each(['CONTEXT_GEO_POINT_CHANGED','CONTEXT_GEO_ALREADY_ROLLED_BACK','CONTEXT_GEO_ORIGINAL_NOT_FOUND'])('keeps guarded rejection %s explicit without retry',async code=>{
    const ctx=fixture();ctx.fetch.mockResolvedValue(Response.json({success:false,code},{status:code.endsWith('NOT_FOUND')?404:409}));
    expect(await executeGisRollback(rollback,key,new AbortController().signal,ctx.revalidate,ctx.deps)).toMatchObject({outcome:'rejected',code});expect(ctx.fetch).toHaveBeenCalledOnce();
  });
  it('rejects arbitrary point/actor identifiers and same operation IDs before dispatch',async()=>{
    const ctx=fixture();for(const args of [{...rollback,point_id:receipt().data.id},{...rollback,employeeId:7},{...rollback,operation_id:input.operation_id}])await expect(executeGisRollback(args,key,new AbortController().signal,ctx.revalidate,ctx.deps)).rejects.toMatchObject({code:'GIS_WRITE_INVALID_INPUT'});expect(ctx.fetch).not.toHaveBeenCalled();
  });
});
