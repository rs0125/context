import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export async function readEnv(file) {
  try { return parseEnv(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Unable to read the environment file.'); }
}

export async function setEnvValues(file, updates) {
  let existing = '';
  try { existing = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const keys = new Set(Object.keys(updates));
  const lines = existing.split('\n').filter(line => !keys.has(/^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1]));
  for (const [name, value] of Object.entries(updates)) {
    // JSON uses double quotes internally; single dotenv quotes prevent expansion.
    if (String(value).includes("'") || /[\r\n]/.test(String(value))) throw new Error('Unexpected environment value format.');
    lines.push(`${name}='${value}'`);
  }
  await writeFile(file, `${lines.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
