export const SCOPE_OPTIONS = [
  { value: 'knowledge:read', label: 'Company knowledge' },
  { value: 'warehouses:read', label: 'Warehouse context' },
  { value: 'crm:read', label: 'CRM context' },
] as const;

export type Employee = { email: string; name: string; isAdmin: boolean; scopes: string[] };
export type ConsoleSession = { employee: Employee; apiBaseUrl: string; capabilities?: { writesEnabled: boolean } };
export type PersonalKey = { id: string; token: string; expiresAt: string; scopes: string[] };
export type KnowledgeMetadata = {
  id: string; title: string; summary: string; status: 'draft' | 'reviewed';
  scopes: string[]; updatedAt: string; revision: string;
};
export type KnowledgePage = KnowledgeMetadata & { body: string };
export type PageDraft = Pick<KnowledgePage, 'id' | 'title' | 'summary' | 'status' | 'scopes' | 'body'>;
