import path from 'node:path';
import { parseArgs } from 'node:util';
import { readEnv, setEnvValues } from './env-utils.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    'dashboard-env': { type: 'string', default: '../Backend_Repository/.env' },
    'crm-env': { type: 'string', default: '../../CRM-Automations/.env' },
  } });
  const dashboard = await readEnv(path.resolve(values['dashboard-env']));
  const crm = await readEnv(path.resolve(values['crm-env']));
  if (!dashboard.DATABASE_URL || !crm.DATABASE_URL) throw new Error('Both source environment files must define DATABASE_URL.');
  let first, second;
  try { first = new URL(dashboard.DATABASE_URL); second = new URL(crm.DATABASE_URL); }
  catch { throw new Error('A source database URL is invalid.'); }
  if (['hostname', 'pathname', 'username', 'password'].some(part => first[part] !== second[part])) {
    throw new Error('The source database credentials differ. Choose the correct shared database before continuing.');
  }
  if (!['postgres:', 'postgresql:'].includes(first.protocol) || !first.hostname.endsWith('.pooler.supabase.com')) {
    throw new Error('Expected an existing Supabase pooler connection.');
  }
  first.port = '6543';
  first.search = '';
  first.password = encodeURIComponent(decodeURIComponent(first.password));
  first.username = encodeURIComponent(decodeURIComponent(first.username));
  const target = path.resolve('.env.local');
  const current = await readEnv(target);
  let crmOrigin;
  try { crmOrigin = new URL(crm.TWENTY_CRM_BASE_URL); }
  catch { throw new Error('CRM environment must define TWENTY_CRM_BASE_URL.'); }
  if (crmOrigin.protocol !== 'https:' || crmOrigin.username || crmOrigin.password || !crm.TWENTY_CRM_API_KEY) {
    throw new Error('An HTTPS Twenty origin and API key are required for live assignment verification.');
  }
  if (current.DATABASE_URL && current.DATABASE_URL !== first.toString()) {
    throw new Error('An existing different DATABASE_URL is configured; it was not overwritten.');
  }
  await setEnvValues(target, {
    DATABASE_URL: first.toString(), PG_POOL_MAX: '1',
    CONTEXT_API_KEYS_JSON: current.CONTEXT_API_KEYS_JSON ?? '[]',
    TWENTY_CRM_BASE_URL: crmOrigin.origin,
    TWENTY_CRM_API_KEY: crm.TWENTY_CRM_API_KEY,
  });
  console.log('Configured .env.local using the shared database credentials; transaction mode 6543, pool maximum 1.');
  console.log('Copied the Twenty credential server-side for read-only identity, role, and lead checks. No messaging, storage, or model-provider credentials were copied.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
