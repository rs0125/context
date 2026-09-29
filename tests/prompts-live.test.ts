import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { describe, it } from 'vitest';
import { readPrompts, savePrompt } from '../src/lib/prompts';
import { HttpError } from '../src/lib/errors';

function check(condition: unknown, stage: string): asserts condition {
  if (!condition) throw new Error(`PROMPTS_LIVE_${stage}`);
}

// Explicit opt-in. Fixture edits are never committed or visible to other clients.
describe.skipIf(process.env.CONTEXT_LIVE_PROMPTS_TEST !== '1')('prompt storage on the configured database', () => {
  it('reads, saves, checks conflicts and restores defaults, then rolls everything back', async () => {
    let pool: pg.Pool | undefined;
    let client: PoolClient | undefined;
    let transaction = false;
    let stage = 'CONNECT';
    const marker = `Synthetic rollback-only prompt ${randomUUID()}`;
    try {
      const envModule = '../scripts/env-utils.mjs';
      const migrationModule = '../scripts/migrate-knowledge.mjs';
      const { readEnv } = await import(envModule);
      const { migrationDatabaseOptions } = await import(migrationModule);
      pool = new pg.Pool({ ...migrationDatabaseOptions(await readEnv('.env.local')), max: 1, application_name: 'context-prompts-rollback-verification' });
      pool.on('error', () => {});
      client = await pool.connect();
      await client.query('BEGIN'); transaction = true;
      await client.query("SET LOCAL statement_timeout = '4000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
      stage = 'READ';
      const initial = await readPrompts(client);
      check(initial.storageReady && initial.prompts.length === 20, stage);
      const original = initial.prompts.find(prompt => prompt.id === 'mcp')!;
      stage = 'SAVE';
      const saved = await savePrompt(client, { id: 'mcp', body: marker, revision: original.revision }, 'verification@wareongo.com');
      check(saved.prompt.body === marker && saved.prompt.revision !== original.revision, stage);
      check((await readPrompts(client)).prompts.find(prompt => prompt.id === 'mcp')?.body === marker, stage);
      stage = 'CONFLICT';
      let rejected = false;
      try { await savePrompt(client, { id: 'mcp', body: 'Stale edit', revision: original.revision }, 'verification@wareongo.com'); }
      catch (error) { rejected = error instanceof HttpError && error.code === 'REVISION_CONFLICT'; }
      check(rejected, stage);
      stage = 'RESTORE';
      const restored = await savePrompt(client, { id: 'mcp', body: null, revision: saved.prompt.revision }, 'verification@wareongo.com');
      check(!restored.prompt.customized && restored.prompt.body === original.defaultBody && restored.prompt.revision !== saved.prompt.revision, stage);
      stage = 'ROLLBACK';
      await client.query('ROLLBACK'); transaction = false;
      const after = await readPrompts(client);
      check(after.prompts.every(prompt => prompt.body !== marker), stage);
      console.log(JSON.stringify({ promptStorageVerified: true, prompts: after.prompts.length, fixtureWritesRolledBack: true }));
    } catch { throw new Error(`PROMPTS_LIVE_${stage}`); }
    finally {
      if (transaction && client) await client.query('ROLLBACK').catch(() => undefined);
      client?.release(true); await pool?.end();
    }
  }, 30000);
});
