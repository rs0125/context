/** First-party request authentication. No employee OAuth grant or refresh token is created. */
import { createHash } from 'node:crypto';
import { importJWK, jwtVerify } from 'jose';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { type KeyRegistration, resolvePrincipal, SCOPES } from './auth';
import { consoleOrigin } from './console-auth';
import { withReadOnlyTransaction } from './db';
import { HttpError } from './errors';
import { consumeRameshNonce } from './ramesh-replay';

export const RAMESH_ISSUER = 'wareongo:ramesh';
export const RAMESH_TYPE = 'ramesh-request+jwt';
// Use the same capability vocabulary as every other Context Engine client.
// Current employee permissions remain the authority; Ramesh adds no domain restriction.
export const RAMESH_SCOPES = SCOPES;
export const rameshResource = () => `${consoleOrigin()}/mcp/ramesh`;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('base64url');
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/);
const scopes = z.array(z.enum(RAMESH_SCOPES)).min(1).max(RAMESH_SCOPES.length).refine(v => new Set(v).size === v.length);
const publicKey = z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const registration = z.object({ kid: identifier, publicKey, scopes, expiresAt: z.string().datetime() }).strict();
const registry = z.array(registration).min(1).max(3).refine(v => new Set(v.map(k => k.kid)).size === v.length);
const claims = z.object({
  iss: z.literal(RAMESH_ISSUER), aud: z.string(), sub: z.string().regex(/^[1-9]\d{0,9}$/),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/), chat_type: z.literal('dm'),
  htm: z.literal('POST'), htu: z.string(), body_sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  iat: z.number().int().positive(), exp: z.number().int().positive(), jti: z.string().uuid(), scopes,
}).strict();
type Claims = z.infer<typeof claims>;
type Registration = z.infer<typeof registration>;
type Metadata = { kid: string; fingerprint: string; claims: Claims };
const metadata = new WeakMap<KeyRegistration, Metadata>();
const denied = () => new HttpError(401, 'RAMESH_UNAUTHORIZED', 'A valid signed Ramesh request is required.');

function configuration(): Registration[] {
  if (process.env.CONTEXT_RAMESH_AUTH_ENABLED !== 'true') throw new HttpError(503, 'RAMESH_AUTH_DISABLED', 'Ramesh authentication is not enabled.');
  try { return registry.parse(JSON.parse(process.env.CONTEXT_RAMESH_PUBLIC_KEYS_JSON ?? '')); }
  catch { throw new HttpError(503, 'RAMESH_AUTH_CONFIGURATION', 'Ramesh authentication is not configured.'); }
}
function registeredKey(kid: string, now = Date.now()) {
  const key = configuration().find(k => k.kid === kid);
  if (!key || Date.parse(key.expiresAt) <= now) throw denied();
  return key;
}
const fingerprint = (key: Registration) => digest(JSON.stringify(key));

/** Only roster strings use the legacy Indian national-number compatibility rule. */
function phone(value: unknown) {
  if (typeof value !== 'string' || !/^\+?[0-9(). -]{8,40}$/.test(value.trim())) return null;
  const raw = value.trim(); let digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10) digits = `91${digits}`;
  }
  return /^\+[1-9]\d{7,14}$/.test(`+${digits}`) ? `+${digits}` : null;
}
async function employee(client: PoolClient, identity: Claims) {
  const digits = identity.phone.slice(1), variants = [digits];
  if (/^91\d{10}$/.test(digits)) variants.push(digits.slice(2), `0${digits.slice(2)}`);
  const { rows } = await client.query(`SELECT id, phone_number, email, is_active FROM public."VerifiedNumber"
    WHERE phone_number ~ '^[+0-9(). -]{8,40}$' AND regexp_replace(phone_number, '[^0-9]', '', 'g') = ANY($1::text[]) LIMIT 2`, [variants]);
  const row = rows[0];
  if (rows.length !== 1 || !row || row.id !== Number(identity.sub) || row.is_active !== true
    || phone(row.phone_number) !== identity.phone || typeof row.email !== 'string'
    || !z.email().safeParse(row.email.trim().toLowerCase()).success) throw denied();
  return { id: row.id as number, email: row.email.trim().toLowerCase() as string };
}

async function bodyDigest(request: Request) {
  const size = request.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > 32768)) throw new HttpError(413, 'BODY_TOO_LARGE', 'MCP request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw denied();
  const hash = createHash('sha256'); let bytes = 0;
  const deadline = AbortSignal.timeout(5000);
  const signal = AbortSignal.any([request.signal, deadline]);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw denied();
      const { done, value } = await reader.read();
      if (signal.aborted) throw denied();
      if (done) break;
      bytes += value.length;
      if (bytes > 32768) { void reader.cancel().catch(() => {}); throw new HttpError(413, 'BODY_TOO_LARGE', 'MCP request is too large.'); }
      hash.update(value);
    }
    return hash.digest('base64url');
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export type RameshAuthDependencies = {
  readTransaction: typeof withReadOnlyTransaction;
  consumeNonce: (hash: string, expiresAt: Date) => Promise<boolean>;
  now: () => number;
};

export async function authenticateRameshRequest(request: Request, overrides: Partial<RameshAuthDependencies> = {}): Promise<KeyRegistration> {
  const now = overrides.now?.() ?? Date.now(), expected = rameshResource();
  configuration(); // Disabled or misconfigured never falls through to another authentication scheme.
  if (request.method !== 'POST' || request.url !== expected || request.headers.has('origin')
    || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw denied();
  const token = /^Ramesh ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token || token.length > 4096) throw denied();
  let verified: Claims, key!: Registration;
  try {
    const result = await jwtVerify(token, async header => {
      if (header.alg !== 'EdDSA' || header.typ !== RAMESH_TYPE || typeof header.kid !== 'string'
        || Object.keys(header).some(name => !['alg', 'typ', 'kid'].includes(name))) throw denied();
      key = registeredKey(identifier.parse(header.kid), now);
      return importJWK(key.publicKey, 'EdDSA');
    }, { algorithms: ['EdDSA'], typ: RAMESH_TYPE, issuer: RAMESH_ISSUER, audience: expected,
      clockTolerance: 5, currentDate: new Date(now), maxTokenAge: 60,
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'] });
    verified = claims.parse(result.payload);
    if (verified.aud !== expected || verified.htu !== expected || verified.exp <= verified.iat || verified.exp - verified.iat > 60
      || verified.iat > Math.floor(now / 1000) + 5 || verified.scopes.some(scope => !key.scopes.includes(scope))) throw denied();
  } catch (error) { if (error instanceof HttpError && error.status === 503) throw error; throw denied(); }
  if (await bodyDigest(request.clone()) !== verified.body_sha256) throw denied();
  const binding = await (overrides.readTransaction ?? withReadOnlyTransaction)(async client => {
    const current = await employee(client, verified);
    const credential: KeyRegistration = { id: `ramesh_${digest(key.kid).slice(0, 24)}_${current.id}`, hash: createHash('sha256').update(token).digest('hex'),
      employeeId: current.id, employeeEmail: current.email, scopes: [...verified.scopes],
      expiresAt: new Date(Math.min(verified.exp * 1000, Date.parse(key.expiresAt))).toISOString() };
    const principal = await resolvePrincipal(client, credential);
    credential.scopes = principal.scopes;
    if (!credential.scopes.length) throw denied();
    metadata.set(credential, { kid: key.kid, fingerprint: fingerprint(key), claims: verified });
    return credential;
  });
  if (!(await (overrides.consumeNonce ?? consumeRameshNonce)(digest(`${RAMESH_ISSUER}|${key.kid}|${verified.jti}`), new Date((verified.exp + 5) * 1000)))) throw denied();
  return binding;
}

/** Runs in every business-read transaction, also after upstream reads. Never trusts a saved phone or role. */
export async function revalidateRameshRequest(client: PoolClient, key: KeyRegistration) {
  const current = metadata.get(key);
  if (!current || Date.parse(key.expiresAt) <= Date.now() || fingerprint(registeredKey(current.kid)) !== current.fingerprint) throw denied();
  const binding = await employee(client, current.claims);
  if (binding.id !== key.employeeId || binding.email !== key.employeeEmail) throw denied();
}
