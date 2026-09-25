import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { readEnv, setEnvValues } from './env-utils.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    'dashboard-env': { type: 'string', default: '../Backend_Repository/.env' },
    origin: { type: 'string', default: 'http://localhost:3100' },
  } });
  const origin = new URL(values.origin);
  if (origin.origin !== values.origin || origin.username || origin.password
    || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Supply an exact HTTPS origin, or localhost HTTP origin, without a trailing slash.');
  }
  const dashboard = await readEnv(path.resolve(values['dashboard-env']));
  if (!dashboard.GOOGLE_CLIENT_ID || !dashboard.GOOGLE_CLIENT_SECRET) {
    throw new Error('The dashboard environment must contain the Google OAuth client ID and secret.');
  }
  const target = path.resolve('.env.local');
  const current = await readEnv(target);
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    if (current[name] && current[name] !== dashboard[name]) {
      throw new Error(`A different ${name} is already configured; it was not overwritten.`);
    }
  }
  await setEnvValues(target, {
    GOOGLE_CLIENT_ID: dashboard.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: dashboard.GOOGLE_CLIENT_SECRET,
    CONTEXT_CONSOLE_ORIGIN: origin.origin,
    CONTEXT_SESSION_SECRET: current.CONTEXT_SESSION_SECRET || randomBytes(32).toString('base64url'),
    CONTEXT_KEY_ENCRYPTION_SECRET: current.CONTEXT_KEY_ENCRYPTION_SECRET || randomBytes(32).toString('base64url'),
    ADMIN_EMAILS: current.ADMIN_EMAILS ?? dashboard.ADMIN_EMAILS ?? '',
    // Setup never enables mutations or runs a database migration.
    CONTEXT_CONSOLE_WRITES_ENABLED: current.CONTEXT_CONSOLE_WRITES_ENABLED ?? 'false',
  });
  console.log('Configured Google credentials and independent console secrets in ignored .env.local. No database changes were made.');
  console.log(`Register this Google OAuth redirect URI: ${origin.origin}/api/auth/google/callback`);
}

main().catch(() => {
  console.error('Console environment setup failed. Check the source credentials, origin, and any existing conflicting configuration. No secrets were printed.');
  process.exitCode = 1;
});
