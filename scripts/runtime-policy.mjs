// A single named, role-specific policy is compatible with the private-table
// migrations. Every other policy, role, command or expression remains a collision.
export const RUNTIME_ROLE = 'context_engine_runtime';
export const EXPECTED_RUNTIME_POLICY = `polname = 'context_runtime' AND polpermissive AND polcmd = '*'
  AND polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}')]::oid[]
  AND pg_get_expr(polqual, polrelid) = 'true' AND pg_get_expr(polwithcheck, polrelid) = 'true'`;
