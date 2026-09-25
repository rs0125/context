import path from 'node:path';
import { parseArgs } from 'node:util';
import { readEnv, setEnvValues } from './env-utils.mjs';

async function main() {
  const { values } = parseArgs({ options: { label: { type: 'string' } } });
  if (!values.label || !/^[a-zA-Z0-9_-]{1,64}$/.test(values.label)) throw new Error('Provide --label for the key to revoke.');
  const file = path.resolve('.env.local');
  const env = await readEnv(file);
  const keys = JSON.parse(env.CONTEXT_API_KEYS_JSON ?? '[]');
  if (!Array.isArray(keys) || !keys.some(key => key.id === values.label)) throw new Error('Key registration not found.');
  await setEnvValues(file, { CONTEXT_API_KEYS_JSON: JSON.stringify(keys.filter(key => key.id !== values.label)) });
  console.log(`Removed ${values.label} from .env.local. Restart the server, or update the deployed environment and redeploy, for revocation to take effect.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
