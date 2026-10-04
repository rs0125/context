/** Server-owned discovery and request binding. Metadata never replaces live API authorization. */
import { createHash } from 'node:crypto';
import type { Scope } from './auth';
import { HttpError } from './errors';
import type { ToolPromptName } from './prompt-definitions';

export const MCP_READ_CONTRACT_KEY = 'wareongo/context-read-v1';
type ReadContract = {
  requiredScopes: Scope[];
  sourceFamily: 'context' | 'knowledge' | 'warehouses' | 'crm' | 'analytics' | 'mail';
};

/** Minimum discovery scopes. Individual arguments can require additional live permissions. */
export type ReadToolName = Exclude<ToolPromptName, 'create_gis_poi' | 'rollback_gis_poi' | 'create_email_draft' | 'update_email_draft' | 'create_crm_rfq' | 'update_crm_rfq' | 'undo_crm_rfq' | 'create_crm_note' | 'update_crm_note' | 'undo_crm_note'>;
export const MCP_READ_CONTRACTS: Record<ReadToolName, ReadContract> = {
  read_crm_note: { requiredScopes: ['crm:read', 'crm.notes:write'], sourceFamily: 'crm' },
  list_crm_note_changes: { requiredScopes: ['crm:read', 'crm.notes:write'], sourceFamily: 'crm' },
  read_crm_rfq: { requiredScopes: ['crm.rfq:write'], sourceFamily: 'crm' },
  list_crm_rfq_changes: { requiredScopes: ['crm.rfq:write'], sourceFamily: 'crm' },
  get_email_connection: { requiredScopes: ['mail:drafts'], sourceFamily: 'mail' },
  list_email_drafts: { requiredScopes: ['mail:drafts'], sourceFamily: 'mail' },
  read_email_draft: { requiredScopes: ['mail:drafts'], sourceFamily: 'mail' },
  get_context: { requiredScopes: [], sourceFamily: 'context' },
  resolve_location: { requiredScopes: [], sourceFamily: 'context' },
  analytics_capabilities: { requiredScopes: ['analytics:read'], sourceFamily: 'analytics' },
  ga4_report: { requiredScopes: ['analytics:read'], sourceFamily: 'analytics' },
  search_console_report: { requiredScopes: ['analytics:read'], sourceFamily: 'analytics' },
  search_knowledge: { requiredScopes: ['knowledge:read'], sourceFamily: 'knowledge' },
  read_knowledge: { requiredScopes: ['knowledge:read'], sourceFamily: 'knowledge' },
  warehouse_filters: { requiredScopes: ['warehouses:read'], sourceFamily: 'warehouses' },
  search_warehouses: { requiredScopes: ['warehouses:read'], sourceFamily: 'warehouses' },
  warehouse_summary: { requiredScopes: ['warehouses:read'], sourceFamily: 'warehouses' },
  read_warehouse: { requiredScopes: ['warehouses:read'], sourceFamily: 'warehouses' },
  // Checklist-only calls need CRM; supplying warehouse_ids also needs warehouse permission.
  assess_shortlist: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  crm_filters: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  search_crm_leads: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  crm_summary: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  read_crm_lead: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  read_crm_lead_context: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
  crm_briefing: { requiredScopes: ['crm:read'], sourceFamily: 'crm' },
};

export function readToolMetadata(name: ReadToolName) {
  return { [MCP_READ_CONTRACT_KEY]: structuredClone(MCP_READ_CONTRACTS[name]) };
}

/** Matches the read client's canonical JSON: ordinal object keys, unchanged array order. */
export function argumentsSha256(args: Record<string, unknown>): string {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 40) throw new HttpError(400, 'INVALID_ARGUMENTS', 'MCP arguments are too deeply nested.');
    if (Array.isArray(value)) return value.map(child => visit(child, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, visit(child, depth + 1)]),
    );
    return value;
  };
  return createHash('sha256').update(JSON.stringify(visit(args, 0))).digest('hex');
}

export type McpRequestBinding = Readonly<{ toolName: string; argumentsSha256: string }>;

/** Capture before the SDK applies tool schemas, trims strings or fills defaults. */
export function requestReadBinding(body: Buffer): McpRequestBinding | undefined {
  let rpc: unknown;
  try { rpc = JSON.parse(body.toString('utf8')); }
  catch { return undefined; } // The MCP transport retains its normal parse-error response.
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) return undefined;
  const message = rpc as { method?: unknown; params?: unknown };
  if (message.method !== 'tools/call' || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return undefined;
  const params = message.params as { name?: unknown; arguments?: unknown };
  const args = params.arguments === undefined ? {} : params.arguments;
  if (typeof params.name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return Object.freeze({ toolName: params.name, argumentsSha256: argumentsSha256(args as Record<string, unknown>) });
}
