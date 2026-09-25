import { X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setEnvValues } from './env-utils.mjs';

// Supabase Studio's production certificate download:
// https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json
// https://supabase.com/docs/guides/platform/ssl-enforcement
const certificateUrl = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const expectedFingerprint = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';

async function main() {
  const { values } = parseArgs({ options: { 'from-file': { type: 'string' } } });
  let pem;
  if (values['from-file']) {
    pem = await readFile(path.resolve(values['from-file']), 'utf8');
  } else {
    const response = await fetch(certificateUrl, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('Unable to download the official Supabase CA certificate.');
    pem = await response.text();
  }
  if (pem.length > 16_384) throw new Error('Unexpected certificate size.');
  const certificate = new X509Certificate(pem);
  const now = Date.now();
  if (certificate.fingerprint256 !== expectedFingerprint
    || !certificate.ca
    || !certificate.verify(certificate.publicKey)
    || certificate.issuer !== certificate.subject
    || now < Date.parse(certificate.validFrom)
    || now >= Date.parse(certificate.validTo)) {
    throw new Error('The certificate does not match the current trusted Supabase CA; verify any rotation against official Supabase sources.');
  }
  const normalized = `${certificate.toString().trim()}\n`;
  await mkdir(path.resolve('.local'), { recursive: true, mode: 0o700 });
  const certificatePath = path.resolve('.local/supabase-ca.crt');
  await writeFile(certificatePath, normalized, { mode: 0o600 });
  await chmod(certificatePath, 0o600);
  await setEnvValues(path.resolve('.env.local'), { PG_SSL_CA: normalized.trim().replaceAll('\n', '\\n') });
  console.log('Configured the verified Supabase Root 2021 CA in .env.local; TLS and hostname verification remain enabled.');
  console.log(`Certificate expires ${new Date(certificate.validTo).toISOString()}. Restart the local server before retrying.`);
}

main().catch(() => {
  console.error('Supabase CA setup failed. Check the official certificate source, network access, and local file permissions.');
  process.exitCode = 1;
});
