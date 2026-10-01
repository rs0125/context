// Operator-only exceptions for the reviewed Supabase platform baseline.
// These are inherited PUBLIC permissions, never grants made by this script.
// Application-table permissions and employee authorization remain separate.
export const REVIEWED_PLATFORM_OBJECTS = [
  { kind: 'table', name: 'public.geography_columns', extension: 'postgis', relationKind: 'v', privileges: ['SELECT'] },
  { kind: 'table', name: 'public.geometry_columns', extension: 'postgis', relationKind: 'v', privileges: ['SELECT'] },
  { kind: 'table', name: 'public.spatial_ref_sys', extension: 'postgis', relationKind: 'r', privileges: ['SELECT'] },
  { kind: 'table', name: 'net.http_request_queue', extension: 'pg_net', relationKind: 'r', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] },
  { kind: 'table', name: 'net._http_response', extension: 'pg_net', relationKind: 'r', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] },
  { kind: 'function', name: 'public.st_estimatedextent(text,text,text,boolean)', extension: 'postgis', privileges: ['EXECUTE'] },
  { kind: 'function', name: 'public.st_estimatedextent(text,text,text)', extension: 'postgis', privileges: ['EXECUTE'] },
  { kind: 'function', name: 'public.st_estimatedextent(text,text)', extension: 'postgis', privileges: ['EXECUTE'] },
  // An event-trigger function cannot be called as an ordinary SQL function.
  { kind: 'function', name: 'public.rls_auto_enable()', extension: null, privileges: ['EXECUTE'] },
];

export function validatePlatformObject(spec, object) {
  const provenance = spec.extension === null
    ? object.owner === 'postgres' && object.extension === null && object.result_type === 'event_trigger' && object.arguments === 0
    : object.owner === 'supabase_admin' && object.extension === spec.extension;
  if (!provenance || !Number.isInteger(object.oid) || object.oid <= 0
    || (spec.kind === 'table' && object.relation_kind !== spec.relationKind)
    || (spec.kind === 'function' && (!object.security_definer || object.function_kind !== 'f'))
    || !Array.isArray(object.privileges) || !object.privileges.length
    || object.privileges.some(privilege => !spec.privileges.includes(privilege))) {
    throw new Error('REVIEWED_PLATFORM_OBJECT_CHANGED');
  }
}

/** Only accessible, positively identified objects are excepted from the audit. */
export async function reviewedPlatformAccess(client, role) {
  const tables = [], functions = [], report = [];
  for (const spec of REVIEWED_PLATFORM_OBJECTS) {
    const table = spec.kind === 'table';
    const result = await client.query(table
      ? `SELECT c.oid, c.relkind AS relation_kind, pg_get_userbyid(c.relowner) AS owner,
          (SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
           WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e') AS extension,
          ARRAY(SELECT privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege
            WHERE has_table_privilege($2,c.oid,privilege) OR CASE WHEN privilege IN ('SELECT','INSERT','UPDATE','REFERENCES')
              THEN has_any_column_privilege($2,c.oid,privilege) ELSE false END) AS privileges
         FROM pg_class c WHERE c.oid=to_regclass($1) AND has_schema_privilege($2,c.relnamespace,'USAGE')`
      : `SELECT p.oid, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer, p.prokind AS function_kind,
          p.prorettype::regtype::text AS result_type, p.pronargs AS arguments,
          (SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
           WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e') AS extension,
          ARRAY['EXECUTE']::text[] AS privileges
         FROM pg_proc p WHERE p.oid=to_regprocedure($1) AND p.prosecdef
          AND has_schema_privilege($2,p.pronamespace,'USAGE') AND has_function_privilege($2,p.oid,'EXECUTE')`, [spec.name, role]);
    const object = result.rows[0];
    if (!object || !object.privileges.length) continue;
    validatePlatformObject(spec, object);
    (table ? tables : functions).push(object.oid);
    report.push({ kind: spec.kind, name: spec.name, extension: spec.extension, privileges: object.privileges });
  }
  return { tables, functions, report };
}
