import { describe, expect, it } from 'vitest';
const modulePath = '../scripts/runtime-platform-access.mjs';
const { REVIEWED_PLATFORM_OBJECTS, validatePlatformObject, reviewedPlatformAccess } = await import(modulePath);
const queue = REVIEWED_PLATFORM_OBJECTS.find((s: { name: string }) => s.name === 'net.http_request_queue');
const metadata = REVIEWED_PLATFORM_OBJECTS.find((s: { name: string }) => s.name === 'public.spatial_ref_sys');
const helper = REVIEWED_PLATFORM_OBJECTS.find((s: { name: string }) => s.name === 'public.rls_auto_enable()');
const queueObject = { oid: 123, owner: 'supabase_admin', extension: 'pg_net', relation_kind: 'r', privileges: ['SELECT', 'INSERT'] };

describe('reviewed Supabase PUBLIC access', () => {
  it('reports the inherited HTTP capability explicitly', async () => {
    const client = { query: async (_sql: string, values: string[]) => ({ rows: values[0] === queue.name ? [queueObject] : [] }) };
    expect(await reviewedPlatformAccess(client, 'context_engine_runtime')).toEqual({ tables: [123], functions: [],
      report: [{ kind: 'table', name: queue.name, extension: 'pg_net', privileges: ['SELECT', 'INSERT'] }] });
  });
  it.each([
    { owner: 'postgres' }, { extension: null }, { extension: 'unrelated' }, { relation_kind: 'v' },
    { privileges: ['EXECUTE'] }, { oid: 0 },
  ])('rejects changed provenance or shape: %j', change => {
    expect(() => validatePlatformObject(queue, { ...queueObject, ...change })).toThrow('REVIEWED_PLATFORM_OBJECT_CHANGED');
  });
  it('does not allow writes to the PostGIS metadata exception', () => {
    expect(() => validatePlatformObject(metadata, { ...queueObject, extension: 'postgis' })).toThrow('REVIEWED_PLATFORM_OBJECT_CHANGED');
  });
  it('only accepts the helper as an event-trigger function', () => {
    const object = { oid: 456, owner: 'postgres', extension: null, result_type: 'event_trigger', arguments: 0,
      security_definer: true, function_kind: 'f', privileges: ['EXECUTE'] };
    expect(() => validatePlatformObject(helper, object)).not.toThrow();
    expect(() => validatePlatformObject(helper, { ...object, result_type: 'integer' })).toThrow('REVIEWED_PLATFORM_OBJECT_CHANGED');
    expect(() => validatePlatformObject(helper, { ...object, arguments: 1 })).toThrow('REVIEWED_PLATFORM_OBJECT_CHANGED');
  });
});
