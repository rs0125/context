export const SCOPE_OPTIONS = [
  { value: 'knowledge:read', label: 'Company knowledge' },
  { value: 'warehouses:read', label: 'Warehouse context' },
  { value: 'crm:read', label: 'CRM context' },
] as const;

// Knowledge-page restrictions intentionally retain their existing three scopes.
export const READ_SCOPE_OPTIONS = [
  ...SCOPE_OPTIONS,
  { value: 'analytics:read', label: 'Website analytics' },
] as const;

/** Explicit OAuth consent vocabulary; console key issuance still defaults to reads only. */
export const AGENT_SCOPE_OPTIONS = [
  ...READ_SCOPE_OPTIONS,
  { value: 'gis:write', label: 'Create and undo own GIS points' },
] as const;

export type Employee = { email: string; name: string; isAdmin: boolean; isAnalyst: boolean; scopes: string[] };
export type ConsoleSession = { employee: Employee; apiBaseUrl: string; restPromptTemplate?: string; capabilities?: { writesEnabled: boolean } };
export type PersonalKey = { id: string; token: string; expiresAt: string; scopes: string[] };
export type KnowledgeMetadata = {
  id: string; title: string; summary: string; status: 'draft' | 'reviewed';
  scopes: string[]; updatedAt: string; revision: string;
};
export type KnowledgePage = KnowledgeMetadata & { body: string };
export type PageDraft = Pick<KnowledgePage, 'id' | 'title' | 'summary' | 'status' | 'scopes' | 'body'>;
