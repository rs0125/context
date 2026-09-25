import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import matter from 'gray-matter';
import { readEnv } from './env-utils.mjs';

const SCHEMA = 'context_engine_private';
const RELATION = `${SCHEMA}.knowledge_pages`;
const SCHEMA_MARKER = 'context-engine-private-schema-v1';
const TABLE_MARKER = 'context-engine-knowledge-pages-v1:';
const ALLOWED_SCOPES = ['knowledge:read', 'warehouses:read', 'crm:read'];
const BLOCKED_API_ROLES = ['anon', 'authenticated', 'service_role'];
const EXPECTED_COLUMNS = [
  ['id', 'text'], ['title', 'text'], ['summary', 'text'], ['body', 'text'],
  ['updated_at', 'date'], ['status', 'text'], ['scopes', 'text[]'],
];
const CONSTRAINT_NAMES = [
  'knowledge_pages_pkey', 'knowledge_pages_id_check', 'knowledge_pages_title_check',
  'knowledge_pages_summary_check', 'knowledge_pages_body_check',
  'knowledge_pages_status_check', 'knowledge_pages_scopes_check',
];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILE_BYTES = 420_000;

// Error codes never contain filenames, source text, SQL, credentials or driver
// messages. Even constraint-violation DETAIL can contain the complete document.
export class ImportError extends Error {
  constructor(code) { super(code); this.name = 'ImportError'; this.code = code; }
}
function fail(code) { throw new ImportError(code); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseKnowledgeDocument(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_FILE_BYTES || input.includes('\0')) fail('INVALID_SOURCE_DOCUMENT');
  // gray-matter supports executable JavaScript engines. Require a bare YAML
  // delimiter before invoking its safe YAML parser, never a language suffix.
  const normalized = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') || !/^---[ \t]*$/m.test(normalized.slice(4))) fail('YAML_FRONTMATTER_REQUIRED');
  let document;
  try { document = matter(normalized, { language: 'yaml', engines: { javascript: () => fail('UNSUPPORTED_FRONTMATTER_ENGINE') } }); }
  catch (error) { if (error instanceof ImportError) throw error; fail('INVALID_SOURCE_METADATA'); }
  const data = document.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_SOURCE_METADATA');
  const keys = ['id', 'title', 'summary', 'updatedAt', 'status', 'scopes'];
  if (Object.keys(data).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(data, key))) fail('INVALID_SOURCE_METADATA');
  if (typeof data.id !== 'string' || data.id.length > 100 || !SLUG.test(data.id)) fail('INVALID_SOURCE_ID');
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.trim().length > 200
    || typeof data.summary !== 'string' || !data.summary.trim() || data.summary.trim().length > 500) fail('INVALID_SOURCE_METADATA');
  if (!dateOnly(data.updatedAt)) fail('INVALID_SOURCE_DATE');
  if (!['reviewed', 'draft'].includes(data.status)) fail('INVALID_SOURCE_STATUS');
  if (!Array.isArray(data.scopes) || data.scopes.length < 1 || data.scopes.length > 3
    || new Set(data.scopes).size !== data.scopes.length || !data.scopes.includes('knowledge:read')
    || data.scopes.some(scope => typeof scope !== 'string' || !ALLOWED_SCOPES.includes(scope))) fail('INVALID_SOURCE_SCOPES');
  const body = document.content.trim();
  if (!body || body.length > 100_000) fail('INVALID_SOURCE_BODY');
  return { id: data.id, title: data.title.trim(), summary: data.summary.trim(), body,
    updated_at: data.updatedAt, status: data.status, scopes: [...data.scopes] };
}

export async function loadKnowledgeImport(directory, expectedCount) {
  if (expectedCount !== undefined && (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 1000)) fail('INVALID_EXPECTED_COUNT');
  const folder = path.resolve(directory);
  let stat, entries;
  try { stat = await lstat(folder); entries = await readdir(folder, { withFileTypes: true }); }
  catch { fail('SOURCE_DIRECTORY_UNAVAILABLE'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SOURCE_DIRECTORY_MUST_BE_REGULAR');
  const files = entries.filter(entry => entry.name.endsWith('.md'));
  if (!files.length || files.length > 1000 || (expectedCount !== undefined && files.length !== expectedCount)
    || files.some(entry => !entry.isFile() || !SLUG.test(entry.name.slice(0, -3)))) fail('SOURCE_FILE_SET_MISMATCH');
  const pages = [];
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    let handle;
    try {
      // NOFOLLOW also prevents a symlink swapped in after the directory scan.
      handle = await open(path.join(folder, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const details = await handle.stat();
      if (!details.isFile() || details.size > MAX_FILE_BYTES) fail('INVALID_SOURCE_FILE');
      const page = parseKnowledgeDocument(await handle.readFile('utf8'));
      if (page.id !== file.name.slice(0, -3)) fail('SOURCE_FILENAME_ID_MISMATCH');
      pages.push(page);
    } catch (error) { if (error instanceof ImportError) throw error; fail('SOURCE_FILE_UNAVAILABLE'); }
    finally { if (handle) await handle.close(); }
  }
  if (new Set(pages.map(page => page.id)).size !== pages.length) fail('DUPLICATE_SOURCE_ID');
  return pages.sort((a, b) => a.id.localeCompare(b.id));
}

function canonicalPage(page) {
  // Stable property order and literal DATE text make readback independent of
  // session timezone and JavaScript Date conversion.
  return { id: page.id, title: page.title, summary: page.summary, body: page.body,
    updated_at: page.updated_at, status: page.status, scopes: page.scopes };
}

export function knowledgeChecksum(pages) {
  return sha256(JSON.stringify([...pages].sort((a, b) => a.id.localeCompare(b.id)).map(canonicalPage)));
}

function aggregate(pages) {
  return { pages: pages.length, reviewed: pages.filter(page => page.status === 'reviewed').length,
    draft: pages.filter(page => page.status === 'draft').length, checksum_sha256: knowledgeChecksum(pages) };
}

export function migrationDatabaseOptions(env) {
  let url;
  try { url = new URL(env.DATABASE_URL ?? ''); } catch { fail('DATABASE_CONFIGURATION'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') fail('TRANSACTION_POOLER_REQUIRED');
  url.search = '';
  return { connectionString: url.toString(), max: 1, min: 0, idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 4000,
    ssl: { rejectUnauthorized: true, ...(env.PG_SSL_CA ? { ca: env.PG_SSL_CA.replace(/\\n/g, '\n') } : {}) },
    application_name: 'context-private-knowledge-import' };
}

async function inspectTable(client) {
  const relation = (await client.query(`SELECT c.oid, c.relkind, c.relpersistence, c.relispartition,
      c.relrowsecurity, c.relforcerowsecurity, c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
      obj_description(c.oid, 'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'knowledge_pages'`, [SCHEMA])).rows[0];
  if (!relation) return null;
  if (relation.relkind !== 'r' || relation.relpersistence !== 'p' || relation.relispartition || !relation.owned) fail('TARGET_RELATION_COLLISION');
  const columns = (await client.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
      a.attisdropped AS dropped, pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 ORDER BY a.attnum`, [relation.oid])).rows;
  const constraints = (await client.query(`SELECT conname AS name, contype AS type, convalidated AS validated,
      pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE conrelid = $1 ORDER BY conname`, [relation.oid])).rows;
  const unsafeObjects = (await client.query(`SELECT
      (SELECT count(*)::integer FROM pg_policy WHERE polrelid = $1) AS policies,
      (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal) AS triggers,
      (SELECT count(*)::integer FROM pg_rewrite WHERE ev_class = $1) AS rules,
      (SELECT count(*)::integer FROM pg_inherits WHERE inhrelid = $1 OR inhparent = $1) AS inheritance`, [relation.oid])).rows[0];
  if (columns.length !== EXPECTED_COLUMNS.length || columns.some((column, index) =>
    column.name !== EXPECTED_COLUMNS[index][0] || column.type !== EXPECTED_COLUMNS[index][1]
    || !column.not_null || column.identity || column.generated || column.dropped || column.default_expression !== null)
    || constraints.length !== CONSTRAINT_NAMES.length || constraints.some(constraint =>
      !CONSTRAINT_NAMES.includes(constraint.name) || !constraint.validated
      || constraint.type !== (constraint.name === 'knowledge_pages_pkey' ? 'p' : 'c'))
    || !relation.relrowsecurity || !relation.relforcerowsecurity
    || !unsafeObjects || Object.values(unsafeObjects).some(count => count !== 0)) fail('TARGET_SCHEMA_INCOMPATIBLE');
  const signature = sha256(JSON.stringify({ columns, constraints }));
  return { ...relation, signature };
}

async function verifyPrivacy(client, relationOid) {
  const result = (await client.query(`SELECT
      NOT EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname = $1 AND a.grantee = 0) AS no_public_schema,
      NOT EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a WHERE c.oid = $2 AND a.grantee = 0) AS no_public_table,
      NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') AND
        (has_schema_privilege(r.oid, $1, 'USAGE, CREATE') OR has_table_privilege(r.oid, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))) AS no_api_role_access`, [SCHEMA, relationOid])).rows[0];
  if (!result || Object.values(result).some(value => value !== true)) fail('PRIVATE_PERMISSIONS_UNVERIFIED');
}

const CREATE_TABLE = `CREATE TABLE context_engine_private.knowledge_pages (
  id text NOT NULL CONSTRAINT knowledge_pages_pkey PRIMARY KEY,
  title text NOT NULL, summary text NOT NULL, body text NOT NULL,
  updated_at date NOT NULL, status text NOT NULL, scopes text[] NOT NULL,
  CONSTRAINT knowledge_pages_id_check CHECK (char_length(id) BETWEEN 1 AND 100 AND id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT knowledge_pages_title_check CHECK (char_length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  CONSTRAINT knowledge_pages_summary_check CHECK (char_length(summary) BETWEEN 1 AND 500 AND summary = btrim(summary)),
  CONSTRAINT knowledge_pages_body_check CHECK (char_length(body) BETWEEN 1 AND 100000),
  CONSTRAINT knowledge_pages_status_check CHECK (status IN ('reviewed', 'draft')),
  CONSTRAINT knowledge_pages_scopes_check CHECK (cardinality(scopes) BETWEEN 1 AND 3
    AND array_ndims(scopes) = 1 AND array_lower(scopes, 1) = 1 AND array_position(scopes, NULL) IS NULL
    AND scopes @> ARRAY['knowledge:read']::text[]
    AND scopes <@ ARRAY['knowledge:read', 'warehouses:read', 'crm:read']::text[]
    AND cardinality(scopes) = (CASE WHEN 'knowledge:read' = ANY(scopes) THEN 1 ELSE 0 END
      + CASE WHEN 'warehouses:read' = ANY(scopes) THEN 1 ELSE 0 END + CASE WHEN 'crm:read' = ANY(scopes) THEN 1 ELSE 0 END))
)`;

export async function migrateKnowledge(client, pages) {
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const lock = (await client.query('SELECT pg_try_advisory_xact_lock(1784056941, 1802406253) AS locked')).rows[0];
    if (!lock?.locked) fail('IMPORT_ALREADY_RUNNING');
    const role = (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!role || (!role.rolsuper && !role.rolbypassrls)) fail('IMPORT_ROLE_REQUIRES_RLS_BYPASS');
    const namespace = (await client.query(`SELECT n.oid, n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned,
      obj_description(n.oid, 'pg_namespace') AS marker FROM pg_namespace n WHERE n.nspname = $1`, [SCHEMA])).rows[0];
    let table;
    if (namespace) {
      if (!namespace.owned || namespace.marker !== SCHEMA_MARKER) fail('TARGET_SCHEMA_COLLISION');
      const collisions = (await client.query(`SELECT
        (SELECT count(*)::integer FROM pg_class WHERE relnamespace = $1 AND relname NOT IN ('knowledge_pages', 'knowledge_pages_pkey')) AS relations,
        (SELECT count(*)::integer FROM pg_proc WHERE pronamespace = $1) AS routines`, [namespace.oid])).rows[0];
      if (!collisions || Object.values(collisions).some(count => count !== 0)) fail('TARGET_SCHEMA_COLLISION');
      table = await inspectTable(client);
      if (!table || table.marker !== `${TABLE_MARKER}${table.signature}`) fail('TARGET_RELATION_COLLISION');
      // Prevent another importer/editor from changing pages between conflict
      // detection and exact readback. This never locks warehouse/CRM relations.
      await client.query('LOCK TABLE context_engine_private.knowledge_pages IN SHARE ROW EXCLUSIVE MODE');
      table = await inspectTable(client);
      if (!table || table.marker !== `${TABLE_MARKER}${table.signature}`) fail('TARGET_RELATION_COLLISION');
    } else {
      await client.query('CREATE SCHEMA context_engine_private');
      await client.query(`COMMENT ON SCHEMA context_engine_private IS '${SCHEMA_MARKER}'`);
      await client.query(CREATE_TABLE);
      await client.query('ALTER TABLE context_engine_private.knowledge_pages ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE context_engine_private.knowledge_pages FORCE ROW LEVEL SECURITY');
      table = await inspectTable(client);
      if (!table) fail('TARGET_SCHEMA_UNVERIFIED');
      // Signature derives only from validated system-catalog schema metadata.
      await client.query(`COMMENT ON TABLE context_engine_private.knowledge_pages IS '${TABLE_MARKER}${table.signature}'`);
    }
    await client.query('REVOKE ALL ON SCHEMA context_engine_private FROM PUBLIC');
    await client.query('REVOKE ALL ON TABLE context_engine_private.knowledge_pages FROM PUBLIC');
    const apiRoles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname")).rows;
    for (const { rolname } of apiRoles) {
      // Both values originate in the fixed allowlist, never untrusted input.
      if (!BLOCKED_API_ROLES.includes(rolname)) fail('UNEXPECTED_DATABASE_ROLE');
      await client.query(`REVOKE ALL ON SCHEMA context_engine_private FROM "${rolname}"`);
      await client.query(`REVOKE ALL ON TABLE context_engine_private.knowledge_pages FROM "${rolname}"`);
    }
    await verifyPrivacy(client, table.oid);
    const ids = pages.map(page => page.id);
    const selected = 'id, title, summary, body, updated_at::text AS updated_at, status, scopes';
    const existing = (await client.query(`SELECT ${selected} FROM context_engine_private.knowledge_pages WHERE id = ANY($1::text[]) ORDER BY id`, [ids])).rows;
    const expected = new Map(pages.map(page => [page.id, JSON.stringify(canonicalPage(page))]));
    if (existing.some(page => JSON.stringify(canonicalPage(page)) !== expected.get(page.id))) fail('EXISTING_PAGE_CONTENT_DIFFERS');
    let inserted = 0;
    for (const page of pages) {
      const result = await client.query(`INSERT INTO context_engine_private.knowledge_pages
        (id, title, summary, body, updated_at, status, scopes) VALUES ($1, $2, $3, $4, $5::date, $6, $7::text[])
        ON CONFLICT (id) DO NOTHING`, [page.id, page.title, page.summary, page.body, page.updated_at, page.status, page.scopes]);
      inserted += result.rowCount;
    }
    const readback = (await client.query(`SELECT ${selected} FROM context_engine_private.knowledge_pages WHERE id = ANY($1::text[]) ORDER BY id`, [ids])).rows;
    if (readback.length !== pages.length || knowledgeChecksum(readback) !== knowledgeChecksum(pages)) fail('IMPORT_READBACK_MISMATCH');
    await verifyPrivacy(client, table.oid);
    await client.query('COMMIT'); transaction = false;
    return { ...aggregate(pages), inserted, unchanged: pages.length - inserted, verified: true };
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { /* caller destroys the connection */ } }
    if (error instanceof ImportError) throw error;
    fail('DATABASE_IMPORT_FAILED');
  }
}

async function main() {
  let values;
  try { ({ values } = parseArgs({ options: {
    source: { type: 'string', default: '.local/knowledge-import' },
    'env-file': { type: 'string', default: '.env.local' },
    'expected-count': { type: 'string' },
    'validate-only': { type: 'boolean', default: false },
  } })); } catch { fail('INVALID_ARGUMENTS'); }
  if (values['expected-count'] !== undefined && !/^[1-9][0-9]{0,3}$/.test(values['expected-count'])) fail('INVALID_EXPECTED_COUNT');
  const pages = await loadKnowledgeImport(values.source, values['expected-count'] === undefined ? undefined : Number(values['expected-count']));
  if (values['validate-only']) { console.log(JSON.stringify({ validated: true, ...aggregate(pages) })); return; }
  const env = await readEnv(path.resolve(values['env-file']));
  const pool = new pg.Pool(migrationDatabaseOptions(env));
  // Idle errors are intentionally opaque; node-postgres errors can reveal
  // connection details or failed-row contents.
  pool.on('error', () => {});
  let client;
  try {
    client = await pool.connect();
    console.log(JSON.stringify(await migrateKnowledge(client, pages)));
  } catch (error) { if (error instanceof ImportError) throw error; fail('DATABASE_IMPORT_FAILED'); }
  finally { if (client) client.release(true); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ error: error instanceof ImportError ? error.code : 'KNOWLEDGE_IMPORT_FAILED' })); process.exitCode = 1; });
}
