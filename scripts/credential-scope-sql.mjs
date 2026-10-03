// Credential storage only. Knowledge-page audiences retain their own three
// existing scopes. These checks constrain syntax, not employee authorization;
// live VerifiedNumber permissions are intersected on every authenticated operation.
export const CREDENTIAL_SCOPE_CHECK = `cardinality(scopes) BETWEEN 1 AND 6 AND array_ndims(scopes) = 1 AND array_lower(scopes, 1) = 1
  AND array_position(scopes, NULL) IS NULL AND scopes <@ ARRAY['knowledge:read', 'warehouses:read', 'crm:read', 'analytics:read', 'gis:write', 'mail:drafts']::text[]
  AND cardinality(scopes) = (CASE WHEN 'knowledge:read' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'warehouses:read' = ANY(scopes) THEN 1 ELSE 0 END + CASE WHEN 'crm:read' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'analytics:read' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'gis:write' = ANY(scopes) THEN 1 ELSE 0 END
    + CASE WHEN 'mail:drafts' = ANY(scopes) THEN 1 ELSE 0 END)`;
export const CONSOLE_CREDENTIAL_SCOPE_CHECK = `scopes @> ARRAY['knowledge:read']::text[] AND ${CREDENTIAL_SCOPE_CHECK}`;
