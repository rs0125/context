import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const modulePath = '../scripts/finish-gmail-disconnect.mjs';
const { finishPendingDisconnect } = await import(modulePath);
const script = fileURLToPath(new URL(modulePath, import.meta.url));
const owner = { employeeId: 7, employeeEmail: 'employee@wareongo.com' };
const current = { id: '11111111-1111-4111-8111-111111111111', encryptedRefreshToken: 'encrypted-fixture' };

describe('trusted pending Gmail revocation operator', () => {
  it('previews without loading environment files or connecting to a database', () => {
    const result = spawnSync(process.execPath, [script, '--employee-id', '7', '--email', owner.employeeEmail], {
      cwd: '/tmp', env: { NODE_ENV: 'test', CONTEXT_DATABASE_URL: 'invalid-do-not-connect' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ apply: false, ...owner, action: 'finish_pending_gmail_revocation', connectsToDatabase: false });
    expect(result.stderr).toBe('');
  });

  it('loads the actual storage and shared Google transport on the supported Node runtime without a database', () => {
    const source = `const {loadCleanupHelpers} = await import(${JSON.stringify(new URL(modulePath, import.meta.url).href)});
      const helpers = await loadCleanupHelpers();
      process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(helpers).map(([key,value]) => [key,typeof value]))));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: '/tmp', env: { NODE_ENV: 'test' }, encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ complete: 'function', decrypt: 'function', post: 'function' });
  });

  it('commits after bounded shared revocation succeeds and returns no credential', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) }, requestFetch = vi.fn();
    const helpers = {
      complete: vi.fn(async (_client: unknown, _owner: unknown, revoke: (value: typeof current) => Promise<void>) => { await revoke(current); return { status: 'disconnected' }; }),
      decrypt: vi.fn().mockReturnValue('synthetic-private-token'), post: vi.fn().mockResolvedValue({}),
    };
    const result = await finishPendingDisconnect(client, owner, helpers, {}, requestFetch);
    expect(result).toEqual({ completed: true, status: 'disconnected' });
    expect(helpers.post).toHaveBeenCalledWith('revoke', new URLSearchParams({ token: 'synthetic-private-token' }), { fetch: requestFetch });
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('treats an already-completed concurrent cleanup as an idempotent no-op', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const helpers = { complete: vi.fn().mockResolvedValue({ status: 'disconnected' }), decrypt: vi.fn(), post: vi.fn() };
    await expect(finishPendingDisconnect(client, owner, helpers, {})).resolves.toEqual({ completed: false, status: 'disconnected' });
    expect(helpers.post).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('does not revoke an active replacement and sanitizes provider failures while rolling back', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const helpers = { complete: vi.fn().mockRejectedValue(Object.assign(new Error('private active credential'), { code: 'GMAIL_CONNECTION_CHANGED' })),
      decrypt: vi.fn().mockReturnValue('synthetic-private-token'), post: vi.fn().mockRejectedValue(new Error('private provider detail')) };
    await expect(finishPendingDisconnect(client, owner, helpers, {})).rejects.toThrow(/^TARGET_NOT_PENDING_REVOCATION$/);
    expect(helpers.post).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    helpers.complete.mockImplementation(async (_client: unknown, _owner: unknown, revoke: (value: typeof current) => Promise<void>) => { await revoke(current); });
    await expect(finishPendingDisconnect(client, owner, helpers, {})).rejects.toThrow(/^GMAIL_REVOCATION_NOT_COMPLETED$/);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
