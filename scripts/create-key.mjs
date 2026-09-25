import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readEnv, setEnvValues } from './env-utils.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    email: { type: 'string' }, label: { type: 'string' },
    days: { type: 'string', default: '30' },
    scopes: { type: 'string', default: 'knowledge:read,warehouses:read,crm:read' },
  } });
  const email = values.email?.toLowerCase();
  const label = values.label;
  const days = Number(values.days);
  if (!email || !/^[a-z0-9._+-]+@wareongo\.com$/.test(email)) throw new Error('Provide --email with a Wareongo employee email.');
  if (!label || !/^[a-zA-Z0-9_-]{1,64}$/.test(label)) throw new Error('Provide --label using 1–64 letters, numbers, hyphens, or underscores.');
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be between 1 and 90.');
  const scopes = [...new Set(values.scopes.split(','))];
  if (!scopes.length || scopes.some(scope => !['knowledge:read', 'warehouses:read', 'crm:read'].includes(scope))) throw new Error('Unknown read scope.');
  const file = path.resolve('.env.local');
  const env = await readEnv(file);
  let keys;
  try { keys = JSON.parse(env.CONTEXT_API_KEYS_JSON ?? '[]'); } catch { throw new Error('Invalid existing key registry.'); }
  if (!Array.isArray(keys)) throw new Error('Invalid existing key registry.');
  if (keys.some(key => key.id === label)) throw new Error('This label already exists. Use a new label or revoke it first.');
  const apiKey = `wog_ctx_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();
  const registration = { id: label, hash: createHash('sha256').update(apiKey).digest('hex'), employeeEmail: email, scopes, expiresAt };
  const directory = path.resolve('.local/keys');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const keyFile = path.join(directory, `${label}.json`);
  await writeFile(keyFile, `${JSON.stringify({ apiKey, employeeEmail: email, scopes, expiresAt }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await setEnvValues(file, { CONTEXT_API_KEYS_JSON: JSON.stringify([...keys, registration]) });
  console.log(`Registered ${label} for ${email}. The employee must also pass the live roster and service-access checks.`);
  console.log(`Credential saved to .local/keys/${label}.json (owner-readable, gitignored).`);
  console.log('Restart the local server after changing keys. For Vercel, update the key registry environment variable and redeploy.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
