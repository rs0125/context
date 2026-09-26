import { redactCrmText } from './crm-redaction';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown) { return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null; }
function labels(value: unknown) {
  if (value == null || (Array.isArray(value) && !value.length)) return { state: 'missing' as const, values: null, redacted: false };
  if (!Array.isArray(value) || value.length > 32 || !value.every(item => typeof item === 'string' && item.length <= 500)) {
    return { state: 'unsupported' as const, values: null, redacted: false };
  }
  const parsed = value.map(item => redactCrmText(item, { maxCharacters: 160 }));
  if (parsed.some(item => item.state === 'unsupported' || item.truncated)) return { state: 'unsupported' as const, values: null, redacted: parsed.some(item => item.redacted) };
  const values = [...new Set(parsed.map(item => item.text).filter((item): item is string => item !== null))];
  const redacted = parsed.some(item => item.redacted);
  return { state: redacted ? 'redacted' as const : values.length ? 'present' as const : 'missing' as const, values: values.length ? values : null, redacted };
}
function actor(id: unknown, name: unknown, source: unknown) {
  return { workspace_member_id: uuid(id), name: redactCrmText(name, { maxCharacters: 160 }), source: redactCrmText(source, { maxCharacters: 80 }) };
}
/** Only explicitly projected aliases are accepted, never a whole upstream row. */
export function crmOwnership(row: Row) {
  return {
    assigned_to: labels(row.assigned_to), supply_owners: labels(row.supply_owners),
    owner_workspace_member_id: uuid(row.owner_workspace_member_id),
    created_by: actor(row.creator_id, row.creator_name, row.creator_source),
    updated_by: actor(row.updater_id, row.updater_name, row.updater_source),
  };
}

export function crmNarrative(row: Row) {
  return { description: redactCrmText(row.description, { maxCharacters: 6000 }), loss_reason: redactCrmText(row.loss_reason, { maxCharacters: 2000 }) };
}
