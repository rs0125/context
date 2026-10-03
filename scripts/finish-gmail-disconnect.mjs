import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readEnv } from './env-utils.mjs';
import { migrationDatabaseOptions } from './migrate-knowledge.mjs';

// Node 22.15+ only. These three fixed source modules reuse the application's
// ownership, encryption and Google revocation rules; this is not a general loader.
export async function loadCleanupHelpers() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 22 || minor < 15) throw new Error('NODE_22_15_OR_NEWER_REQUIRED');
  const sources = ['gmail-storage.ts', 'google-oauth-transport.ts', 'errors.ts']
    .map(name => new URL(`../src/lib/${name}`, import.meta.url).href);
  const allowed = new Set(sources);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (allowed.has(context.parentURL) && specifier.startsWith('./')) {
        const url = new URL(`${specifier}.ts`, context.parentURL).href;
        if (allowed.has(url)) return { url, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!allowed.has(url)) return nextLoad(url, context);
      return { format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) };
    },
  });
  try {
    const [storage, transport] = await Promise.all([import(sources[0]), import(sources[1])]);
    return { complete: storage.completeGmailDisconnect, decrypt: storage.decryptGmailSecret, post: transport.googleOAuthPost };
  } finally { hooks.deregister(); }
}

/** Operator-only: complete one previously requested revocation. Never initiates
 * disconnect, replaces credentials, reads mail, or requires an active employee. */
export async function finishPendingDisconnect(client, owner, helpers, env, requestFetch = globalThis.fetch) {
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    let revoked = false;
    const connection = await helpers.complete(client, owner, async current => {
      const token = helpers.decrypt(current.encryptedRefreshToken,
        { purpose: 'refresh_token', employeeId: owner.employeeId, id: current.id }, env);
      if (!/^[\x21-\x7e]{1,8192}$/.test(token)) throw new Error('CREDENTIAL_INVALID');
      await helpers.post('revoke', new URLSearchParams({ token }), { fetch: requestFetch });
      revoked = true;
    });
    await client.query('COMMIT'); transaction = false;
    return { completed: revoked, status: connection?.status ?? 'absent' };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    // Driver/provider details may contain tokens or SQL values. Never print them.
    throw new Error(error?.code === 'GMAIL_CONNECTION_CHANGED' ? 'TARGET_NOT_PENDING_REVOCATION' : 'GMAIL_REVOCATION_NOT_COMPLETED');
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    'employee-id': { type: 'string' }, email: { type: 'string' },
  } });
  if (values.help) {
    console.log('node scripts/finish-gmail-disconnect.mjs --employee-id ID --email employee@wareongo.com [--apply]\nPreview by default; --apply completes only an already-pending Gmail revocation. Node 22.15+ is required.');
    return;
  }
  const employeeId = Number(values['employee-id']), employeeEmail = values.email;
  if (!Number.isInteger(employeeId) || employeeId < 1 || employeeId > 2147483647
    || typeof employeeEmail !== 'string' || employeeEmail.length > 254 || employeeEmail !== employeeEmail.toLowerCase()
    || !/^[^\s@]+@wareongo\.com$/.test(employeeEmail)) throw new Error('EXACT_EMPLOYEE_ID_AND_WORK_EMAIL_REQUIRED');
  if (!values.apply) {
    console.log(JSON.stringify({ apply: false, employeeId, employeeEmail, action: 'finish_pending_gmail_revocation', connectsToDatabase: false }));
    return;
  }
  const env = { ...await readEnv(path.resolve('.env.local')), ...process.env };
  if (!env.CONTEXT_DATABASE_URL) throw new Error('DEDICATED_CONTEXT_DATABASE_URL_REQUIRED');
  const helpers = await loadCleanupHelpers();
  const pool = new pg.Pool(migrationDatabaseOptions({ ...env, DATABASE_URL: env.CONTEXT_DATABASE_URL }));
  let client;
  try {
    client = await pool.connect();
    console.log(JSON.stringify(await finishPendingDisconnect(client, { employeeId, employeeEmail }, helpers, env)));
  } finally { client?.release(); await pool.end(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('Gmail revocation did not complete. Access remains unchanged or pending; check configuration and the target connection.'); process.exitCode = 1; });
}
