import { describe, expect, it, vi } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import { handleMcpRequest } from '../src/lib/mcp';
import { TOOL_CATALOG, type ToolName } from '../src/lib/tools/catalog';
import {
  CAPABILITIES,
  TOOL_DISCOVERY_KEY,
  toolMetadata,
} from '../src/lib/tools/registry';
import type { KeyRegistration } from '../src/lib/auth';

vi.mock('../src/lib/prompts', () => ({ loadPromptValues: async () => ({}) }));

describe('shared tool registry', () => {
  it('gives every tool a coherent discovery and permission contract', () => {
    for (const name of Object.keys(TOOL_CATALOG) as ToolName[]) {
      const tool = TOOL_CATALOG[name];
      const meta = toolMetadata(name);
      expect(meta[TOOL_DISCOVERY_KEY]).toEqual({
        capability: tool.capability,
        description: CAPABILITIES[tool.capability],
        loading: tool.loading,
      });
      expect(tool.platforms.length).toBeGreaterThan(0);
      expect(Boolean('read' in tool) !== Boolean('write' in tool)).toBe(true);
      expect(tool.loading).toBe(name === 'get_context' ? 'eager' : 'deferred');
    }
  });

  it.each(['claude', 'whatsapp'] as const)(
    'keeps ordinary MCP discovery and calls usable on %s',
    async (platform) => {
      const origin = 'https://registry.example.test';
      vi.stubEnv('CONTEXT_CONSOLE_ORIGIN', origin);
      const key: KeyRegistration = {
        id: randomUUID(),
        employeeId: 7,
        employeeEmail: 'synthetic@example.test',
        hash: 'a'.repeat(64),
        scopes: ['knowledge:read'],
        expiresAt: '2099-01-01T00:00:00Z',
      };
      const read = vi.fn(async () =>
        Response.json({
          data: { items: [], nextCursor: null },
          meta: { requestId: 'toy', generatedAt: new Date().toISOString() },
        }),
      );
      const client = new Client({
        name: 'ordinary-mcp-registry-test',
        version: '1',
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            fetch: (url, init) =>
              handleMcpRequest(new Request(url, init), {
                authenticate: async () => key,
                platform,
                read,
              }),
          }),
        );
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'get_context',
          'read_knowledge',
          'resolve_location',
          'search_knowledge',
        ]);
        for (const tool of tools) {
          expect(tool.inputSchema.type).toBe('object');
          expect(tool).not.toHaveProperty('defer_loading');
          expect(tool._meta?.[TOOL_DISCOVERY_KEY]).toEqual(
            toolMetadata(tool.name as ToolName)[TOOL_DISCOVERY_KEY],
          );
        }
        const result = await client.callTool({
          name: 'search_knowledge',
          arguments: { q: 'synthetic' },
        });
        expect(result.isError).not.toBe(true);
        expect(read).toHaveBeenCalledOnce();
        await expect(
          client.callTool({ name: 'crm_summary', arguments: {} }),
        ).rejects.toThrow('not found');
        expect(read).toHaveBeenCalledOnce();
      } finally {
        await client.close();
        vi.unstubAllEnvs();
      }
    },
  );
});
