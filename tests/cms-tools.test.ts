import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  callCms,
  cmsAvailability,
  cmsInputs,
  type CmsDependencies,
} from '../src/lib/cms-tools';
import {
  rosterScopes,
  rosterReadScopes,
  resolvePrincipal,
  type KeyRegistration,
  type Principal,
} from '../src/lib/auth';
import { handleMcpRequest } from '../src/lib/mcp';
import { argumentsSha256 } from '../src/lib/mcp-read-contract';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { handleApiRequest } from '../src/lib/api';
import type { PoolClient } from 'pg';

vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));
const pair = generateKeyPairSync('ed25519');
const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  CONTEXT_CMS_ENABLED: 'true',
  CONTEXT_CMS_URL: 'https://cms.example.test/api/integrations/context-engine',
  CONTEXT_CMS_SIGNING_KID: 'test',
  CONTEXT_CMS_SIGNING_PRIVATE_JWK: JSON.stringify(
    pair.privateKey.export({ format: 'jwk' }),
  ),
};
const key = (): KeyRegistration => ({
  id: randomUUID(),
  hash: 'a'.repeat(64),
  employeeId: 7,
  employeeEmail: 'editor@example.test',
  scopes: ['cms:read', 'cms:write'],
  expiresAt: '2099-01-01T00:00:00Z',
});
const actor: Principal = {
  employeeId: 7,
  email: 'editor@example.test',
  scopes: ['cms:read', 'cms:write'],
  keyId: 'test',
  isAnalyst: false,
};
const args = {
  preview_id: randomUUID(),
  preview_hash: 'a'.repeat(64),
  review_url: 'https://cms.example.test/imports/test',
  operation_id: randomUUID(),
};
const receipt = {
  operation_id: args.operation_id,
  outcome: 'updated' as const,
  code: 'CMS_DRAFTS_SAVED',
  message: 'Saved private drafts',
  data: {
    published: false,
    preview_id: args.preview_id,
    pages: ['blog/test'],
    review_url: args.review_url,
  },
};
function harness(extra: Partial<CmsDependencies> = {}) {
  const principal = vi.fn(async () => actor),
    revalidate = vi.fn(async () => {});
  const fetcher = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      const value = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        request_id: value.request_id,
        data: value.action.endsWith('drafts')
          ? receipt
          : { page_types: ['blog'] },
      });
    },
  );
  const deps: Partial<CmsDependencies> = {
    env,
    principal,
    fetch: fetcher,
    transaction: async (work) => work({} as never),
    now: Date.now,
    ...extra,
  };
  return {
    principal,
    revalidate,
    fetcher,
    call: (name: keyof typeof cmsInputs, input: unknown) =>
      callCms(
        name,
        input,
        key(),
        new AbortController().signal,
        revalidate,
        deps,
      ),
  };
}
beforeEach(() => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', 'https://context.example.test');
});
afterEach(() => vi.unstubAllEnvs());

it('signs bounded requests with freshly resolved employee identity and checks access again after I/O', async () => {
  const h = harness();
  await h.call('cms_schema', {});
  expect(h.principal).toHaveBeenCalledTimes(2);
  expect(h.revalidate).toHaveBeenCalledTimes(2);
  const [url, init] = h.fetcher.mock.calls[0];
  expect(url).toBe(env.CONTEXT_CMS_URL);
  const body = JSON.parse(String(init?.body)),
    auth = new Headers(init?.headers).get('authorization')!;
  expect(body).toMatchObject({
    actor_email: actor.email,
    actor_id: actor.employeeId,
    action: 'schema',
    audience: 'wareongo:cms-drafts:v1',
  });
  expect(body.expires_at - body.issued_at).toBeLessThanOrEqual(60000);
  expect(
    verify(
      null,
      Buffer.from(String(init?.body)),
      pair.publicKey,
      Buffer.from(auth.split('.')[1], 'base64url'),
    ),
  ).toBe(true);
  expect(init?.redirect).toBe('error');
  expect(init?.cache).toBe('no-store');
});
it.each([
  'http://cms.example.test/api/integrations/context-engine',
  'https://127.0.0.1/api/integrations/context-engine',
  'https://cms.example.test/wrong',
  'https://cms.example.test/api/integrations/context-engine?x=1',
  'https://cms.internal/api/integrations/context-engine',
])('does not enable unsafe CMS endpoint %s', (url) =>
  expect(cmsAvailability({ ...env, CONTEXT_CMS_URL: url })).toBe(false),
);
const roster = {
  id: actor.employeeId, email: actor.email, name: 'Synthetic editor', is_active: true,
  adminAccess: false, analystAccess: false, dashboardAccess: false, twenty_user_id: null,
};
const rosterClient = (rows: Record<string, unknown>[]) =>
  ({ query: vi.fn(async () => ({ rows })) }) as unknown as PoolClient;
it.each([
  [{ analystAccess: true }, true],
  [{ adminAccess: true }, true],
  [{ analystAccess: true, adminAccess: true }, true],
  [{}, false],
  [{ dashboardAccess: true }, false],
  [{ twenty_user_id: '11111111-1111-4111-8111-111111111111' }, false],
  [{ analystAccess: 'true', adminAccess: 1 }, false],
] as const)('grants CMS eligibility only to analysts and admins: %j', async (access, allowed) => {
  const employee = { ...roster, ...access };
  expect(rosterReadScopes(employee).includes('cms:read')).toBe(allowed);
  expect(rosterReadScopes(employee)).not.toContain('cms:write');
  expect(rosterScopes(employee).includes('cms:write')).toBe(allowed);
  expect((await resolvePrincipal(rosterClient([employee]), key())).scopes)
    .toEqual(allowed ? ['cms:read', 'cms:write'] : []);
});
it('requires explicit CMS credential grants and removes access after role revocation', async () => {
  const employee = { ...roster, analystAccess: true };
  const client = rosterClient([employee]);
  expect((await resolvePrincipal(client, { ...key(), scopes: ['knowledge:read'] })).scopes)
    .toEqual(['knowledge:read']);
  expect((await resolvePrincipal(client, { ...key(), scopes: ['cms:read'] })).scopes)
    .toEqual(['cms:read']);
  expect((await resolvePrincipal(client, key())).scopes).toEqual(['cms:read', 'cms:write']);
  employee.analystAccess = false;
  expect((await resolvePrincipal(client, key())).scopes).toEqual([]);
});
it('CMS eligibility requires a unique, active employee bound to the credential', async () => {
  const employee = { ...roster, adminAccess: true };
  for (const rows of [[], [{ ...employee, is_active: false }], [{ ...employee, id: 8 }],
    [{ ...employee, email: 'replacement@example.test' }], [employee, { ...employee, id: 8 }]]) {
    await expect(resolvePrincipal(rosterClient(rows), key())).rejects.toMatchObject({ code: 'EMPLOYEE_INACTIVE' });
  }
});
it('preview creation needs write rights; disabled/revoked writes never dispatch', async () => {
  const h = harness({
    principal: async () => ({ ...actor, scopes: ['cms:read'] }),
  });
  await expect(
    h.call('cms_prepare_import', {
      page_type: 'blog',
      schema_version: 'a'.repeat(64),
      csv_text: 'slug,title\nx,y',
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(await h.call('cms_edit_drafts', args)).toMatchObject({
    outcome: 'not_dispatched',
  });
  expect(h.fetcher).not.toHaveBeenCalled();
  expect(
    await harness({ env: { ...env, CONTEXT_CMS_ENABLED: 'false' } }).call(
      'cms_edit_drafts',
      args,
    ),
  ).toMatchObject({ outcome: 'not_dispatched' });
});
it('uncertain outcomes preserve the operation ID and never automatically replay a POST', async () => {
  const fetcher = vi.fn(async () => {
    throw new Error('timeout');
  });
  const h = harness({ fetch: fetcher });
  expect(await h.call('cms_edit_drafts', args)).toMatchObject({
    operation_id: args.operation_id,
    outcome: 'outcome_unknown',
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('malformed receipts, response overflow and post-dispatch revocation preserve uncertainty', async () => {
  for (const data of [
    { ...receipt, operation_id: randomUUID() },
    { ...receipt, data: { published: true } },
    { ...receipt, message: 'x'.repeat(96000) },
  ]) {
    const h = harness({
      fetch: async (_url, init) =>
        Response.json({
          ok: true,
          request_id: JSON.parse(String(init?.body)).request_id,
          data,
        }),
    });
    expect(await h.call('cms_edit_drafts', args)).toMatchObject({
      outcome: 'outcome_unknown',
    });
  }
  let calls = 0;
  expect(
    await harness({
      principal: async () => ({
        ...actor,
        scopes: ++calls === 1 ? actor.scopes : [],
      }),
    }).call('cms_edit_drafts', args),
  ).toMatchObject({ outcome: 'outcome_unknown' });
  expect(
    await harness({
      fetch: async () =>
        Response.json({ ok: false, code: 'STALE_PAGE' }, { status: 409 }),
    }).call('cms_edit_drafts', args),
  ).toMatchObject({ outcome: 'rejected', code: 'STALE_PAGE' });
});

async function clientFor(
  platform: 'claude' | 'whatsapp',
  cmsCall = vi.fn(async () => ({ page_types: ['blog'] })),
  scopes = key().scopes,
) {
  const client = new Client({ name: 'cms-raw-mcp-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL('https://context.example.test/mcp'),
      {
        fetch: (url, init) =>
          handleMcpRequest(new Request(url, init), {
            authenticate: async () => ({ ...key(), scopes }),
            platform,
            cmsCall,
          }),
      },
    ),
  );
  return client;
}
it.each(['claude', 'whatsapp'] as const)(
  'ordinary MCP on %s advertises all seven scoped tools with dynamic CMS discovery',
  async (platform) => {
    const client = await clientFor(platform);
    try {
      const all = (await client.listTools()).tools,
        tools = all.filter((t) => t.name.startsWith('cms_'));
      expect(tools).toHaveLength(7);
      for (const tool of tools) {
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool._meta?.['wareongo/tool-discovery-v1']).toMatchObject({
          capability: 'cms',
          loading: 'deferred',
        });
      }
      const named = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(
        named.cms_fill_empty_drafts._meta?.['wareongo/context-write-v1'],
      ).toMatchObject({
        executionMode: 'direct_request',
        requiredScopes: ['cms:read', 'cms:write'],
      });
      expect(
        named.cms_edit_drafts._meta?.['wareongo/context-write-v1'],
      ).toMatchObject({ executionMode: 'confirmation' });
      const result = await client.callTool({
        name: 'cms_schema',
        arguments: { page_type: 'blog' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        source_path: '/api/v1/cms/schema?page_type=blog',
        meta: {
          toolName: 'cms_schema',
          argumentsSha256: argumentsSha256({ page_type: 'blog' }),
        },
      });
    } finally {
      await client.close();
    }
  },
);
it('ordinary MCP narrows discovery for read-only keys and when disabled', async () => {
  for (const enabled of ['true', 'false']) {
    vi.stubEnv('CONTEXT_CMS_ENABLED', enabled);
    const client = await clientFor('claude', undefined, ['cms:read']);
    try {
      expect(
        (await client.listTools()).tools
          .filter((t) => t.name.startsWith('cms_'))
          .map((t) => t.name)
          .sort(),
      ).toEqual(
        enabled === 'true'
          ? ['cms_list_pages', 'cms_read_import', 'cms_read_page', 'cms_schema']
          : [],
      );
    } finally {
      await client.close();
    }
  }
});
it('MCP draft writes bind receipts to exact arguments and report uncertain outcomes as errors', async () => {
  for (const outcome of ['updated', 'outcome_unknown'] as const) {
    const cmsCall = vi.fn(async () => ({ ...receipt, outcome }));
    const client = await clientFor('whatsapp', cmsCall as never);
    try {
      const result = await client.callTool({
        name: 'cms_edit_drafts',
        arguments: args,
      });
      expect(result.isError === true).toBe(outcome === 'outcome_unknown');
      expect(result.structuredContent).toMatchObject({
        meta: {
          toolName: 'cms_edit_drafts',
          employeeId: 7,
          argumentsSha256: argumentsSha256(args),
        },
      });
      expect(cmsCall).toHaveBeenCalledOnce();
      const invalid = await client.callTool({
        name: 'cms_edit_drafts',
        arguments: { ...args, actor_email: 'other@example.test' },
      });
      expect(invalid.isError).toBe(true);
      expect(cmsCall).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  }
});

it('read citations resolve with validated query arguments, and REST never exposes writes', async () => {
  const cmsCall = vi.fn(async () => ({ items: [] }));
  const deps = { cmsCall, authenticate: async () => key(), audit: vi.fn() };
  const response = await handleApiRequest(
    new Request(
      'https://context.example.test/api/v1/cms/list_pages?page_type=blog&limit=3&has_import_draft=true',
    ),
    ['cms', 'list_pages'],
    deps,
  );
  expect(response.status).toBe(200);
  expect(cmsCall).toHaveBeenCalledWith(
    'cms_list_pages',
    { page_type: 'blog', limit: 3, has_import_draft: true },
    expect.anything(),
    expect.any(AbortSignal),
    expect.any(Function),
    expect.anything(),
  );
  for (const query of [
    'page_type=blog&page_type=city',
    'page_type=blog&status=PUBLISHED',
    'page_type=blog&limit=0',
  ]) {
    expect(
      (
        await handleApiRequest(
          new Request(
            `https://context.example.test/api/v1/cms/list_pages?${query}`,
          ),
          ['cms', 'list_pages'],
          deps,
        )
      ).status,
    ).toBe(422);
  }
  expect(
    (
      await handleApiRequest(
        new Request('https://context.example.test/api/v1/cms/edit_drafts'),
        ['cms', 'edit_drafts'],
        deps,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await handleApiRequest(
        new Request('https://context.example.test/api/v1/cms/schema', {
          method: 'POST',
        }),
        ['cms', 'schema'],
        deps,
      )
    ).status,
  ).toBe(405);
  expect(cmsCall).toHaveBeenCalledOnce();
});
