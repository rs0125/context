/** Employee and catalogue policy only. No mailbox, provider, database or model calls. */
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { READ_SCOPES, SCOPES, parseKeyRegistry, resolvePrincipal, rosterReadScopes, rosterScopes, type KeyRegistration } from '../src/lib/auth';
import { MCP_READ_CONTRACTS, readToolMetadata } from '../src/lib/mcp-read-contract';
import { oauthScopes } from '../src/lib/mcp-oauth-protocol';
import { TOOL_DEFAULT_PLATFORMS, TOOL_PROMPTS, toolPlatforms } from '../src/lib/prompt-definitions';

const employee = { id: 71, email: 'synthetic@wareongo.com', is_active: true,
  dashboardAccess: false, adminAccess: false, analystAccess: false, twenty_user_id: null };
const key: KeyRegistration = { employeeId: employee.id, employeeEmail: employee.email,
  id: 'synthetic', hash: 'a'.repeat(64), scopes: ['mail:drafts'], expiresAt: '2099-01-01T00:00:00Z' };
const client = (rows: Record<string, unknown>[]) => ({ query: vi.fn(async () => ({ rows })) }) as unknown as PoolClient;

describe('explicit own-mailbox draft capability', () => {
  it('is eligible for ordinary active employees without changing read or OAuth defaults', async () => {
    expect(SCOPES).toContain('mail:drafts');
    expect(READ_SCOPES).not.toContain('mail:drafts');
    expect(rosterReadScopes(employee)).toEqual(['knowledge:read']);
    expect(rosterScopes(employee)).toContain('mail:drafts');
    expect(oauthScopes(undefined)).toEqual([...READ_SCOPES]);
    expect(oauthScopes('mail:drafts')).toEqual(['mail:drafts']);
    expect((await resolvePrincipal(client([employee]), key)).scopes).toEqual(['mail:drafts']);
    expect((await resolvePrincipal(client([employee]), { ...key, scopes: ['knowledge:read'] })).scopes)
      .toEqual(['knowledge:read']);
  });

  it('requires the same current, unique, active employee for mailbox capability', async () => {
    for (const rows of [[], [{ ...employee, is_active: false }], [{ ...employee, id: 72 }],
      [{ ...employee, email: 'replacement@wareongo.com' }], [employee, { ...employee, id: 72 }]]) {
      await expect(resolvePrincipal(client(rows), key)).rejects.toMatchObject({ code: 'EMPLOYEE_INACTIVE' });
    }
  });

  it('accepts only the explicit draft capability in employee registrations', () => {
    expect(parseKeyRegistry(JSON.stringify([key]))[0].scopes).toEqual(['mail:drafts']);
    for (const scopes of [['mail:send'], ['mail:inbox'], ['mail:*'], ['mail:drafts', 'mail:drafts']]) {
      expect(() => parseKeyRegistry(JSON.stringify([{ ...key, scopes }]))).toThrow();
      expect(() => oauthScopes(scopes.join(' '))).toThrow();
    }
  });

  it('exposes mail reads separately from creation and defaults all mail tools to WhatsApp only', () => {
    for (const name of ['get_email_connection', 'read_email_draft'] as const) {
      expect(readToolMetadata(name)).toEqual({
        'wareongo/context-read-v1': { requiredScopes: ['mail:drafts'], sourceFamily: 'mail' },
      });
    }
    expect(MCP_READ_CONTRACTS).not.toHaveProperty('create_email_draft');
    for (const name of ['get_email_connection', 'create_email_draft', 'read_email_draft'] as const) {
      expect(TOOL_PROMPTS[name].group).toBe('Email drafts');
      expect(TOOL_DEFAULT_PLATFORMS[name]).toEqual(['whatsapp']);
      expect(toolPlatforms(name)).toEqual(['whatsapp']);
      expect(toolPlatforms(name, { toolPlatforms: { [name]: [] } })).toEqual([]);
    }
  });
});
