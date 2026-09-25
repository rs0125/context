import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readEnv, setEnvValues } from './env-utils.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    email: { type: 'string' },
    origin: { type: 'string', default: 'http://localhost:3100' },
  } });
  const origin = new URL(values.origin);
  if (origin.origin !== values.origin || origin.username || origin.password
    || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Supply an exact HTTPS origin, or localhost HTTP origin, without a trailing slash.');
  }
  const target = path.resolve('.env.local');
  const current = await readEnv(target);
  const email = (values.email ?? current.CONTEXT_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@wareongo\.com$/.test(email) || email.length > 254) {
    throw new Error('Supply --email for the active work account that will own the console API key.');
  }
  if (current.CONTEXT_ADMIN_EMAIL && current.CONTEXT_ADMIN_EMAIL !== email) {
    throw new Error('A different console administrator is already configured; it was not overwritten.');
  }
  const newPassword = !current.CONTEXT_ADMIN_PASSWORD;
  await setEnvValues(target, {
    CONTEXT_ADMIN_EMAIL: email,
    CONTEXT_ADMIN_PASSWORD: current.CONTEXT_ADMIN_PASSWORD || randomBytes(32).toString('base64url'),
    CONTEXT_CONSOLE_ORIGIN: origin.origin,
    CONTEXT_SESSION_SECRET: !newPassword && current.CONTEXT_SESSION_SECRET || randomBytes(32).toString('base64url'),
    CONTEXT_KEY_ENCRYPTION_SECRET: current.CONTEXT_KEY_ENCRYPTION_SECRET || randomBytes(32).toString('base64url'),
    // Setup never enables mutations or runs a database migration.
    CONTEXT_CONSOLE_WRITES_ENABLED: current.CONTEXT_CONSOLE_WRITES_ENABLED ?? 'false',
  });
  const lines = (await readFile(target, 'utf8')).split('\n')
    .filter(line => !/^\s*(?:GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)\s*=/.test(line));
  await writeFile(target, lines.join('\n'), { mode: 0o600 });
  await chmod(target, 0o600);
  console.log('Configured one administrator in ignored .env.local. The password is stored as CONTEXT_ADMIN_PASSWORD and was not printed.');
  console.log('No database changes were made. Existing API key encryption secrets were preserved.');
}

main().catch(() => {
  console.error('Console environment setup failed. Check the administrator email, origin, and existing configuration. No secrets were printed.');
  process.exitCode = 1;
});
