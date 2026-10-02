/** Offline key generation into protected files. Never prints a private key or creates a user grant. */
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { directory: { type: 'string' }, kid: { type: 'string' } } });
if (!values.directory || !values.kid || !/^[A-Za-z0-9_-]{1,48}$/.test(values.kid)) throw new Error('DIRECTORY_AND_KEY_ID_REQUIRED');
const directory = path.resolve(values.directory);
await mkdir(directory, { mode: 0o700 }); // A new directory prevents accidentally replacing installed secrets.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const scopes = ['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read'];
const signing = { kid: values.kid, privateKey: privateKey.export({ format: 'jwk' }), scopes };
const verifying = [{ kid: values.kid, publicKey: publicKey.export({ format: 'jwk' }), scopes,
  expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString() }];
await writeFile(path.join(directory, 'worker-signing.json'), JSON.stringify(signing), { mode: 0o600, flag: 'wx' });
await writeFile(path.join(directory, 'context-public-keys.json'), JSON.stringify(verifying), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ created: true, kid: values.kid, expiresAt: verifying[0].expiresAt }));
