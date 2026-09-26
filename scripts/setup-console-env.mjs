import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readEnv, setEnvValues } from './env-utils.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    'dashboard-env': { type: 'string', default: '../Backend_Repository/.env' },
    origin: { type: 'string', default: 'http://localhost:3000' },
  } });
  const origin = new URL(values.origin);
  if (origin.origin !== values.origin || origin.username || origin.password
    || !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Supply an exact HTTPS origin, or localhost HTTP origin, without a trailing slash.');
  }
  const target = path.resolve('.env.local');
  const current = await readEnv(target);
  const dashboard = await readEnv(path.resolve(values['dashboard-env']));
  // Preserve a separately configured Context OAuth client. Import the dashboard
  // pair only when neither value exists; never mix credentials from two clients.
  const configured = current.GOOGLE_CLIENT_ID || current.GOOGLE_CLIENT_SECRET ? current : dashboard;
  if (!configured.GOOGLE_CLIENT_ID || !configured.GOOGLE_CLIENT_SECRET) {
    throw new Error('Configure both Google OAuth credentials, or supply --dashboard-env with the existing pair.');
  }
  await setEnvValues(target, {
    GOOGLE_CLIENT_ID: configured.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: configured.GOOGLE_CLIENT_SECRET,
    CONTEXT_CONSOLE_ORIGIN: origin.origin,
    CONTEXT_SESSION_SECRET: current.CONTEXT_SESSION_SECRET || randomBytes(32).toString('base64url'),
    CONTEXT_KEY_ENCRYPTION_SECRET: current.CONTEXT_KEY_ENCRYPTION_SECRET || randomBytes(32).toString('base64url'),
    // Setup never enables mutations or runs a database migration.
    CONTEXT_CONSOLE_WRITES_ENABLED: current.CONTEXT_CONSOLE_WRITES_ENABLED ?? 'false',
  });
  const lines = (await readFile(target, 'utf8')).split('\n')
    .filter(line => !/^\s*(?:CONTEXT_ADMIN_EMAIL|CONTEXT_ADMIN_PASSWORD|ADMIN_EMAILS)\s*=/.test(line));
  await writeFile(target, lines.join('\n'), { mode: 0o600 });
  await chmod(target, 0o600);
  console.log('Configured Google sign-in in ignored .env.local. Credentials were not printed.');
  console.log(`Add this authorized redirect URI to the Google OAuth client: ${origin.origin}/api/auth/google/callback`);
  console.log('Active VerifiedNumber entries control employee access; adminAccess controls knowledge editing.');
  console.log('No database changes were made. Existing API key encryption secrets were preserved.');
}

main().catch(() => {
  console.error('Console environment setup failed. Check the Google credential pair, dashboard environment path, origin, and existing configuration. No secrets were printed.');
  process.exitCode = 1;
});
