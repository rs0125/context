import type { Principal } from './auth';
import { HttpError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 8_000;

type Row = Record<string, unknown>;
export type CrmView = 'accessible' | 'created' | 'assigned';
export type CrmAccess = { mode: 'all'; memberId: string }
  | { mode: 'related'; memberId: string; ids: string[] };
type Options = { view?: CrmView; fetch?: typeof fetch; env?: Partial<NodeJS.ProcessEnv> };
type Page = { rows: Row[]; hasNextPage: boolean; endCursor: string | null };

// Verified against Wareongo's live metadata API, 2026-09-25. This is Twenty's
// built-in role identity, not its renameable label or a WAG dashboard flag.
const ADMIN_ROLE_UNIVERSAL_IDENTIFIER = '20202020-02c2-43f2-b94d-cab1f2b532eb';
const ROLE_QUERY = `query ContextReadRoles {
  getRoles {
    id universalIdentifier isEditable canBeAssignedToUsers
    canUpdateAllSettings canReadAllObjectRecords
    workspaceMembers { id }
  }
}`;

function unavailable(): never {
  throw new HttpError(503, 'CRM_AUTHORIZATION_UNAVAILABLE', 'Current CRM assignment access could not be verified.');
}

function identityUnavailable(): never {
  throw new HttpError(403, 'CRM_IDENTITY_UNAVAILABLE', 'The employee could not be uniquely linked to a current CRM assignment identity.');
}

function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedEmail(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function configuration(env: Partial<NodeJS.ProcessEnv>) {
  let origin: URL;
  try { origin = new URL(env.TWENTY_CRM_BASE_URL ?? ''); }
  catch { throw new HttpError(503, 'CRM_CONFIGURATION', 'The CRM read connection is not configured.'); }
  const key = env.TWENTY_CRM_API_KEY;
  // Configuration is deployment-owned, never caller-supplied. Accept only an
  // HTTPS origin so neither paths nor redirects can redirect its credential.
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== '/' || !key || key.length > 4096 || /[^\x21-\x7e]/.test(key)) {
    throw new HttpError(503, 'CRM_CONFIGURATION', 'The CRM read connection is not configured.');
  }
  return { origin: origin.origin, key };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.redirected || !response.body) {
    if (response.body) await response.body.cancel();
    unavailable();
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    await response.body.cancel();
    unavailable();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        unavailable();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally { reader.releaseLock(); }
}

function parsePage(value: unknown, object: 'workspaceMembers' | 'opportunities'): Page {
  if (!record(value) || !record(value.data) || !record(value.pageInfo)) unavailable();
  const rows = value.data[object];
  const info = value.pageInfo;
  if (!Array.isArray(rows) || rows.length > PAGE_SIZE || !rows.every(record)
    || typeof info.hasNextPage !== 'boolean') unavailable();
  let endCursor: string | null = null;
  if (info.hasNextPage) {
    if (!rows.length || typeof info.endCursor !== 'string' || !info.endCursor || info.endCursor.length > 1024) unavailable();
    endCursor = info.endCursor;
  }
  return { rows, hasNextPage: info.hasNextPage, endCursor };
}

function employeeMember(principal: Principal, members: Row[]) {
  const email = principal.email.trim().toLowerCase();
  const memberId = principal.twentyUserId;
  if (typeof memberId !== 'string' || !UUID.test(memberId)) identityUnavailable();
  const byEmail = members.filter((member) => normalizedEmail(member.userEmail) === email);
  const byId = members.filter((member) => typeof member.id === 'string' && member.id.toLowerCase() === memberId.toLowerCase());
  if (byEmail.length !== 1 || byId.length !== 1 || byEmail[0] !== byId[0]) identityUnavailable();
  const member = byEmail[0];
  if (member.deletedAt !== null) identityUnavailable();
  return member;
}

function assignmentToken(member: Row, members: Row[]) {
  if (!record(member.name) || typeof member.name.firstName !== 'string') identityUnavailable();
  const token = member.name.firstName.trim().toUpperCase();
  if (!/^[A-Z]{1,64}$/.test(token)) identityUnavailable();
  const sameToken = members.filter((candidate) => record(candidate.name)
    && typeof candidate.name.firstName === 'string' && candidate.name.firstName.trim().toUpperCase() === token);
  if (sameToken.length !== 1) identityUnavailable();
  return token;
}

function isTwentyAdmin(value: unknown, memberId: string): boolean {
  if (!record(value) || (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0))
    || !record(value.data) || !Array.isArray(value.data.getRoles) || value.data.getRoles.length > 100) unavailable();
  const roles = value.data.getRoles;
  for (const role of roles) {
    if (!record(role) || typeof role.id !== 'string' || !UUID.test(role.id)
      || (role.universalIdentifier !== null && (typeof role.universalIdentifier !== 'string' || !UUID.test(role.universalIdentifier)))
      || typeof role.isEditable !== 'boolean' || typeof role.canBeAssignedToUsers !== 'boolean'
      || typeof role.canUpdateAllSettings !== 'boolean' || typeof role.canReadAllObjectRecords !== 'boolean'
      || !Array.isArray(role.workspaceMembers) || role.workspaceMembers.length > PAGE_SIZE
      || !role.workspaceMembers.every((member) => record(member) && typeof member.id === 'string' && UUID.test(member.id))) unavailable();
  }
  const adminRoles = roles.filter((role: Row) => role.universalIdentifier === ADMIN_ROLE_UNIVERSAL_IDENTIFIER);
  if (adminRoles.length > 1) unavailable();
  const admin = adminRoles[0] as Row | undefined;
  return !!admin && admin.isEditable === false && admin.canBeAssignedToUsers === true
    && admin.canUpdateAllSettings === true && admin.canReadAllObjectRecords === true
    && (admin.workspaceMembers as Row[]).some((member) => (member.id as string).toLowerCase() === memberId);
}

/** Live role and creator/assignment checks. No source payload escapes this boundary.
 * Call outside a database transaction; it makes at most seven bounded HTTP reads.
 * The metadata POST contains a fixed GraphQL query, never a mutation.
 */
export async function getLiveCrmAccess(principal: Principal, options: Options = {}): Promise<CrmAccess> {
  const config = configuration(options.env ?? process.env);
  const view = options.view ?? 'accessible';
  if (!['accessible', 'created', 'assigned'].includes(view)) throw new HttpError(400, 'INVALID_QUERY', 'Unsupported CRM view.');
  const fetcher = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const deadline = Date.now() + DEADLINE_MS;
  async function request(url: URL, query?: string) {
    if (controller.signal.aborted || Date.now() >= deadline) unavailable();
    const response = await fetcher(url, {
      method: query ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json', ...(query ? { 'Content-Type': 'application/json' } : {}) },
      ...(query ? { body: JSON.stringify({ query }) } : {}),
      cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    const body = await boundedJson(response);
    if (controller.signal.aborted || Date.now() >= deadline) unavailable();
    return body;
  }
  async function page(object: 'workspaceMembers' | 'opportunities', filter: string, cursor?: string) {
    const url = new URL(`/rest/${object}`, config.origin);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('depth', '0');
    url.searchParams.set('order_by', 'id[AscNullsFirst]');
    url.searchParams.set('filter', filter);
    if (cursor) url.searchParams.set('starting_after', cursor);
    const body = await request(url);
    return parsePage(body, object);
  }
  try {
    const members = await page('workspaceMembers', 'deletedAt[is]:NULL');
    if (members.hasNextPage) unavailable();
    const member = employeeMember(principal, members.rows);
    const memberId = (member.id as string).toLowerCase();
    const roles = await request(new URL('/metadata', config.origin), ROLE_QUERY);
    const admin = isTwentyAdmin(roles, memberId);
    if (admin && view === 'accessible') return { mode: 'all', memberId };
    // Creator-only reads are independent of first-name assignment ambiguity.
    const token = view === 'created' ? null : assignmentToken(member, members.rows);
    const creatorFilter = `createdBy.workspaceMemberId[eq]:${JSON.stringify(memberId)}`;
    const assignedFilter = `assignedTo[containsAny]:${JSON.stringify([token])}`;
    const filter = view === 'created' ? creatorFilter : view === 'assigned' ? assignedFilter : `or(${creatorFilter},${assignedFilter})`;
    const ids = new Set<string>();
    const seenRecordIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let index = 0; index < MAX_PAGES; index++) {
      const result = await page('opportunities', `${filter},deletedAt[is]:NULL`, cursor);
      for (const opportunity of result.rows) {
        if (typeof opportunity.id !== 'string' || !UUID.test(opportunity.id)) unavailable();
        const id = opportunity.id.toLowerCase();
        if (seenRecordIds.has(id)) unavailable();
        seenRecordIds.add(id);
        const created = record(opportunity.createdBy) && typeof opportunity.createdBy.workspaceMemberId === 'string'
          && opportunity.createdBy.workspaceMemberId.toLowerCase() === memberId;
        const assigned = token !== null && Array.isArray(opportunity.assignedTo)
          && opportunity.assignedTo.every((value) => typeof value === 'string') && opportunity.assignedTo.includes(token);
        const permitted = view === 'created' ? created : view === 'assigned' ? assigned : created || assigned;
        if (opportunity.deletedAt === null && permitted) {
          ids.add(id);
        }
      }
      if (!result.hasNextPage) return { mode: 'related', memberId, ids: [...ids].sort() };
      if (index === MAX_PAGES - 1 || !result.endCursor || cursors.has(result.endCursor)) unavailable();
      cursors.add(result.endCursor);
      cursor = result.endCursor;
    }
    unavailable();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    unavailable();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
