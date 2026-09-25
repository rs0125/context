import pg from 'pg';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { readEnv } from './env-utils.mjs';

// Read only product specifications. Never select contact, address, note, media,
// uploader, owner, or internal commercial fields, even for this local profile.
const numericFields = ['offeredSpaceSqft', 'numberOfDocks', 'clearHeightFt', 'centreHeight',
  'ratePerSqft', 'gateSizeFt', 'plinthHeightFt', 'dockApronLengthFt', 'floorStrengthPerSqm',
  'washroom_count', 'builtup_area', 'carpet_area', 'liftLoadCapacity', 'totalFloors',
  'approachRoadWidth', 'powerKva'];
const categoryFields = ['city', 'state', 'zone', 'warehouseType', 'availability', 'status',
  'flooringType', 'listing_type', 'waterSupply', 'handoverType', 'handoverLeadUnit',
  'landType', 'pollutionZone', 'insulationPresent', 'insulationType'];
const arrayFields = ['micromarket', 'suitableFor'];
const booleanFields = ['wogVerified', 'liftAccess', 'fireNocAvailable'];
const detailFields = new Set(['approachRoadWidth', 'powerKva', 'landType', 'pollutionZone', 'fireNocAvailable']);
const selected = [...numericFields, ...categoryFields, ...arrayFields, ...booleanFields,
  'chargeableArea', 'handoverLeadValue', 'totalSpaceSqft'];

function safeLabel(value) {
  const text = String(value).normalize('NFKC').trim();
  if (!text || text.length > 100 || /[\x00-\x1f<>@]/.test(text)
    || /(?:https?:|www\.|tel:|whatsapp|contact|call\s)/i.test(text)
    || /(?:\d[\s\p{P}\p{S}]*){7,}/u.test(text)) return '[withheld]';
  return text;
}
function shape(value) {
  if (value === null || value === undefined || String(value).trim() === '') return 'missing';
  const text = String(value).trim();
  if (/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return Number(text.replaceAll(',', '')) === 0 ? 'zero' : 'plain_numeric';
  if (/^(?:\d{1,2})(?:,\d{2})+,\d{3}(?:\.\d+)?$/.test(text)) return 'indian_grouping';
  if (/^\d[\d,.]*\s*(?:ft|feet|foot|'|kva|kw|m|meters?|metres?|nos?\.?|docks?|sq\.?\s*ft|sqft|tons?|tonnes?|kg|t)\.?$/i.test(text)) return 'number_with_unit';
  if (/\d\s*(?:-|–|to)\s*\d/i.test(text)) return 'range';
  if (/\d\s*(?:x|×|\*)\s*\d/i.test(text)) return 'multiple_dimensions';
  return 'other_text';
}
function frequencies(values, maximum = 15) {
  const counts = new Map();
  for (const value of values) {
    const label = value === null || value === undefined || String(value).trim() === '' ? '[missing]' : safeLabel(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, maximum).map(([value, count]) => ({ value, count }));
}

async function main() {
  const env = await readEnv('.env.local');
  const url = new URL(env.DATABASE_URL);
  if (!url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') throw new Error('TRANSACTION_POOLER_REQUIRED');
  url.search = '';
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1,
    ssl: { rejectUnauthorized: true, ...(env.PG_SSL_CA ? { ca: env.PG_SSL_CA.replace(/\\n/g, '\n') } : {}) },
    connectionTimeoutMillis: 3000, query_timeout: 6000, idleTimeoutMillis: 1000,
    application_name: 'wareongo-context-hygiene-readonly' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '4000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '6000ms'");
    const count = await client.query('SELECT count(*)::integer AS visible FROM public."Warehouse" WHERE visibility IS TRUE');
    const columns = selected.map(field => `${detailFields.has(field) ? 'd' : 'w'}."${field}"`).join(', ');
    // Stable hash sample spreads across IDs/ages; sort/scan remains time-bounded.
    const sample = await client.query(`SELECT ${columns} FROM public."Warehouse" w
      LEFT JOIN public."WarehouseData" d ON d."warehouseId" = w.id
      WHERE w.visibility IS TRUE ORDER BY md5(w.id::text) LIMIT 1500`);
    await client.query('COMMIT');
    client.release(); client = undefined;
    const rows = sample.rows;
    const numeric = Object.fromEntries(numericFields.map(field => {
      const shapes = {};
      for (const row of rows) { const key = shape(row[field]); shapes[key] = (shapes[key] ?? 0) + 1; }
      return [field, { shapes, common_values: frequencies(rows.map(row => row[field])),
        non_plain_examples: frequencies(rows.map(row => row[field]).filter(value => !['missing', 'zero', 'plain_numeric'].includes(shape(value))), 10) }];
    }));
    const categories = Object.fromEntries(categoryFields.map(field => [field, frequencies(rows.map(row => row[field]), 20)]));
    const booleans = Object.fromEntries(booleanFields.map(field => [field, frequencies(rows.map(row => row[field]))]));
    const arrays = Object.fromEntries(arrayFields.map(field => [field, { empty: rows.filter(row => !row[field]?.length).length,
      common_values: frequencies(rows.flatMap(row => row[field] ?? []), 20) }]));
    const report = { generatedAt: new Date().toISOString(), visibleRecords: count.rows[0].visible,
      sampleSize: rows.length, method: 'Visible records ordered by md5(id), limit 1500; specifications only; no raw rows saved.',
      numeric, categories, booleans, arrays,
      typedFields: { chargeableAreaPresent: rows.filter(row => row.chargeableArea !== null).length,
        handoverLeadValuePresent: rows.filter(row => row.handoverLeadValue !== null).length,
        emptyTotalArea: rows.filter(row => !row.totalSpaceSqft?.length).length,
        zeroTotalArea: rows.filter(row => row.totalSpaceSqft?.some(value => value === 0)).length } };
    await mkdir('.local/profiles', { recursive: true, mode: 0o700 });
    const output = '.local/profiles/warehouse-hygiene.json';
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await chmod(output, 0o600);
    console.log(JSON.stringify({ generatedAt: report.generatedAt, visibleRecords: report.visibleRecords,
      sampleSize: report.sampleSize, method: report.method,
      numeric: Object.fromEntries(Object.entries(numeric).map(([field, summary]) => [field, summary.shapes])),
      private_report: output }, null, 2));
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error(JSON.stringify({ error: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'PROFILE_FAILED' }));
    process.exitCode = 1;
  } finally { client?.release(); await pool.end(); }
}
await main();
