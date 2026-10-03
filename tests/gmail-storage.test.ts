import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  assertGmailOwnerActive, claimGmailDraftOperation, decryptGmailSecret, disconnectGmailConnection,
  encryptGmailSecret, finishGmailDraftOperation, getGmailConnection, getGmailDraftOperation,
  saveGmailConnection, listGmailDraftReferences, completeGmailDisconnect, quarantineGmailIssuedToken, markGmailNeedsReauth, type GmailOwner,
} from '../src/lib/gmail-storage';

const owner: GmailOwner = { employeeId: 7, employeeEmail: 'employee@wareongo.com' };
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CONTEXT_GMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64url') };
const operationId = '11111111-1111-4111-8111-111111111111';
const scopes = ['https://www.googleapis.com/auth/gmail.compose'];
const content = JSON.stringify({ to: ['customer@example.test'], subject: 'Synthetic', body: 'Synthetic draft body' });
const hash = createHash('sha256').update(content).digest('hex');
const instant = '2026-10-04T09:00:00.000Z';
type Row = Record<string, unknown>;

function database() {
  let databaseNow = Date.parse(instant);
  const employees: Row[] = [{ id: owner.employeeId, email: owner.employeeEmail, is_active: true }];
  const connections: Row[] = [], operations: Row[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: Row[] }> => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM public."VerifiedNumber"')) return { rows: employees.filter(row => String(row.email).toLowerCase() === values[0]) };
    if (sql.startsWith('SELECT') && sql.includes('FROM context_gmail_private.connections')) {
      return { rows: connections.filter(row => row.employee_id === values[0] && row.employee_email === values[1]).map(row => ({ ...row })) };
    }
    if (sql.startsWith('INSERT INTO context_gmail_private.connections')) {
      const [id, employee_id, employee_email, google_sub, account_email, encrypted_refresh_token, granted_scopes, version] = values;
      const existing = connections.find(row => row.employee_id === employee_id);
      if (existing && (existing.id !== id || existing.employee_email !== employee_email)) return { rows: [] };
      const row = values.length === 3
        ? { id, employee_id, employee_email, google_sub: null, account_email: employee_email, encrypted_refresh_token: null,
          granted_scopes: [], version: 1, status: 'disconnected', created_at: instant, updated_at: instant }
        : values.length === 7 ? { id, employee_id, employee_email, google_sub, account_email: employee_email,
          encrypted_refresh_token: values[4], granted_scopes: values[5], version: values[6], status: 'revoking', created_at: existing?.created_at ?? instant, updated_at: instant }
        : { id, employee_id, employee_email, google_sub, account_email, encrypted_refresh_token, granted_scopes, version,
          status: 'active', created_at: existing?.created_at ?? instant, updated_at: instant };
      if (existing) Object.assign(existing, row); else connections.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE context_gmail_private.connections')) {
      const row = connections.find(row => row.employee_id === values[0] && row.employee_email === values[1] && row.id === values[2]);
      if (!row) return { rows: [] };
      if (sql.includes("SET status = 'needs_reauth'")) {
        if (row.version !== values[3] || row.status !== 'active') return { rows: [] };
        Object.assign(row, { status: 'needs_reauth', updated_at: instant });
        return { rows: [{ id: row.id }] };
      }
      if (sql.includes('SET encrypted_refresh_token = NULL')) {
        if (row.version !== values[3] || row.status !== 'revoking') return { rows: [] };
        Object.assign(row, { encrypted_refresh_token: null, status: 'disconnected', updated_at: instant });
      } else if (sql.includes('SET status = CASE')) {
        Object.assign(row, { status: row.encrypted_refresh_token === null ? 'disconnected' : 'revoking',
          version: Number(row.version) + 1, updated_at: instant });
      } else throw new Error('Unexpected connection update');
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM context_gmail_private.draft_operations')) {
      if (sql.includes('connection_id=$3 AND google_sub=$4')) {
        const scoped = operations.filter(row => row.employee_id === values[0] && row.employee_email === values[1]
          && row.connection_id === values[2] && row.google_sub === values[3] && row.state === 'created');
        if (sql.includes('AS cursor_time')) return {rows: scoped.filter(row => row.operation_id === values[4]).map(row => ({cursor_time: String(row.created_at)}))};
        const preceding = scoped.filter(row => values[4] === null || String(row.created_at) < String(values[4])
          || (String(row.created_at) === String(values[4]) && String(row.operation_id) < String(values[5])))
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.operation_id).localeCompare(String(a.operation_id)));
        return {rows: preceding.slice(0, Number(values[6])).map(row => ({operation_id: row.operation_id, created_at: row.created_at}))};
      }
      return { rows: operations.filter(row => row.employee_id === values[0] && row.employee_email === values[1] && row.operation_id === values[2]).map(row => ({ ...row })) };
    }
    if (sql.startsWith('INSERT INTO context_gmail_private.draft_operations')) {
      const [employee_id, employee_email, operation_id, connection_id, connection_version, request_hash, google_sub] = values;
      if (operations.some(row => row.employee_id === employee_id && row.operation_id === operation_id)) return { rows: [] };
      const row = { employee_id, employee_email, operation_id, connection_id, connection_version, request_hash, google_sub,
        retry_at: null, state: 'dispatching', draft_id: null, message_id: null, reason: null, created_at: instant, updated_at: instant };
      operations.push(row); return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE context_gmail_private.draft_operations') && sql.includes("reason = 'CONNECTION_CHANGED'")) {
      for (const row of operations.filter(row => row.employee_id === values[0] && row.employee_email === values[1] && row.state === 'dispatching')) {
        Object.assign(row, { state: 'unknown', reason: 'CONNECTION_CHANGED', updated_at: instant });
      }
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE context_gmail_private.draft_operations')) {
      if (sql.includes('retry_at <= CURRENT_TIMESTAMP')) {
        const row = operations.find(row => row.employee_id === values[0] && row.employee_email === values[1]
          && row.operation_id === values[2] && row.state === 'retryable' && Date.parse(String(row.retry_at)) <= databaseNow);
        if (!row) return { rows: [] };
        Object.assign(row, { state: 'dispatching', retry_at: null, reason: null, updated_at: instant });
        return { rows: [{ ...row }] };
      }
      const row = operations.find(row => row.employee_id === values[0] && row.employee_email === values[1] && row.operation_id === values[2] && row.state === values[7]);
      if (!row) return { rows: [] };
      Object.assign(row, { state: values[3], draft_id: values[4], message_id: values[5], reason: values[6],
        retry_at: values[8] === null ? null : new Date(databaseNow + Number(values[8])).toISOString(), updated_at: instant });
      return { rows: [{ ...row }] };
    }
    throw new Error('Unexpected database statement');
  });
  return { client: { query } as unknown as PoolClient, query, employees, connections, operations,
    advance: (milliseconds: number) => { databaseNow += milliseconds; } };
}

async function connected() {
  const db = database();
  const connection = await saveGmailConnection(db.client, owner, {
    googleSub: 'synthetic_subject', accountEmail: owner.employeeEmail, refreshToken: 'synthetic-refresh-token', grantedScopes: scopes,
  }, env);
  const claim = { operationId, connectionId: connection.id, connectionVersion: connection.version, requestHash: hash };
  return { ...db, connection, claim };
}

describe('Gmail private encrypted storage', () => {
  it('lists only current owner/Google-account created references and paginates without fetching private payloads', async () => {
    const db = await connected();
    const ids = [1, 2, 3, 4, 5].map(n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
    const seed = (id: string, overrides: Row = {}): Row => ({operation_id: id, employee_id: owner.employeeId, employee_email: owner.employeeEmail,
      connection_id: db.connection.id, connection_version: db.connection.version, google_sub: db.connection.googleSub,
      state: 'created', created_at: '2026-10-04T09:00:00.123456Z', draft_id: 'private-provider-draft', message_id: 'private-provider-message', ...overrides});
    db.operations.push(seed(ids[0]), seed(ids[1]), seed(ids[2]),
      seed(ids[3], {employee_id: 8, employee_email: 'other@wareongo.com'}),
      seed(ids[4], {google_sub: 'other_google_account'}),
      seed('20000000-0000-4000-8000-000000000001', {connection_id: '30000000-0000-4000-8000-000000000001'}),
      seed('40000000-0000-4000-8000-000000000001', {state: 'unknown'}),
      seed('40000000-0000-4000-8000-000000000002', {state: 'dispatching'}));
    const first = await listGmailDraftReferences(db.client, owner, db.connection, {limit: 2});
    expect(first).toEqual({items: [{draft_ref: ids[2], created_at: '2026-10-04T09:00:00.123Z'}, {draft_ref: ids[1], created_at: '2026-10-04T09:00:00.123Z'}], nextCursor: ids[1]});
    db.operations.push(seed('50000000-0000-4000-8000-000000000001', {created_at: '2026-10-04T09:01:00.000000Z'}));
    const second = await listGmailDraftReferences(db.client, owner, db.connection, {limit: 2, cursor: first.nextCursor!});
    expect(second).toEqual({items: [{draft_ref: ids[0], created_at: '2026-10-04T09:00:00.123Z'}], nextCursor: null});
    expect(JSON.stringify([first, second])).not.toMatch(/private-provider|synthetic-private|encrypted_content|subject|body|recipient/);
    const queries = db.query.mock.calls.filter(([sql]) => sql.includes('FROM context_gmail_private.draft_operations'));
    for (const [sql, parameters] of queries) {
      expect(sql).toContain('employee_id=$1 AND employee_email=$2 AND connection_id=$3 AND google_sub=$4');
      expect(sql).toContain("state='created'");
      expect(sql.split('FROM')[0]).not.toMatch(/encrypted_content|draft_id|message_id|\*/);
      expect(parameters?.slice(0, 4)).toEqual([owner.employeeId, owner.employeeEmail, db.connection.id, db.connection.googleSub]);
    }
    expect(queries.at(-1)?.[1]?.[4]).toBe('2026-10-04T09:00:00.123456Z');
  });

  it('refuses forged, foreign, unconfirmed and different-account list cursors', async () => {
    const db = await connected();
    const cases = [
      {employee_id: 8}, {employee_email: 'other@wareongo.com'}, {connection_id: '30000000-0000-4000-8000-000000000001'},
      {google_sub: 'other_google_account'}, {google_sub: null}, {state: 'unknown'}, {state: 'dispatching'}, {state: 'retryable'},
    ];
    for (const override of cases) {
      db.operations.length = 0;
      db.operations.push({operation_id: operationId, employee_id: owner.employeeId, employee_email: owner.employeeEmail,
        connection_id: db.connection.id, connection_version: db.connection.version, google_sub: db.connection.googleSub,
        state: 'created', created_at: instant, ...override});
      await expect(listGmailDraftReferences(db.client, owner, db.connection, {limit: 10, cursor: operationId})).rejects.toMatchObject({status: 422, code: 'GMAIL_INVALID_CURSOR'});
    }
    db.operations.length = 0;
    await expect(listGmailDraftReferences(db.client, owner, db.connection, {limit: 10, cursor: operationId})).rejects.toMatchObject({code: 'GMAIL_INVALID_CURSOR'});
  });

  it('rechecks active owner, preserves same-account history across reconnects and hides a different Google account', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    await finishGmailDraftOperation(db.client, owner, operationId, {state: 'created', draftId: 'private-draft', messageId: 'private-message'});
    const first = await listGmailDraftReferences(db.client, owner, db.connection, {limit: 10});
    expect(first.items).toHaveLength(1);
    db.employees[0].is_active = false;
    await expect(listGmailDraftReferences(db.client, owner, db.connection, {limit: 10})).rejects.toMatchObject({code: 'GMAIL_EMPLOYEE_INACTIVE'});
    db.employees[0].is_active = true;
    await disconnectGmailConnection(db.client, owner);
    await completeGmailDisconnect(db.client, owner, async () => {});
    const same = await saveGmailConnection(db.client, owner, {googleSub: db.connection.googleSub!, accountEmail: owner.employeeEmail, refreshToken: 'same-account-token', grantedScopes: scopes}, env);
    expect(same.version).toBe(3);
    expect(await listGmailDraftReferences(db.client, owner, same, {limit: 10})).toEqual(first);
    expect(await listGmailDraftReferences(db.client, owner, same, {limit: 10, cursor: first.items[0].draft_ref})).toEqual({items: [], nextCursor: null});
    const next = await saveGmailConnection(db.client, owner, {googleSub: 'different_google_account', accountEmail: owner.employeeEmail, refreshToken: 'new-token', grantedScopes: scopes}, env);
    expect(await listGmailDraftReferences(db.client, owner, next, {limit: 10})).toEqual({items: [], nextCursor: null});
    await expect(listGmailDraftReferences(db.client, owner, next, {limit: 10, cursor: first.items[0].draft_ref})).rejects.toMatchObject({code: 'GMAIL_INVALID_CURSOR'});
  });

  it('uses randomized, purpose/owner/id-bound authenticated encryption and rejects corruption or wrong keys', () => {
    const context = { purpose: 'draft_content' as const, employeeId: owner.employeeId, id: operationId };
    const encrypted = encryptGmailSecret(content, context, env);
    expect(encrypted).not.toContain('Synthetic');
    expect(encryptGmailSecret(content, context, env)).not.toBe(encrypted);
    expect(decryptGmailSecret(encrypted, context, env)).toBe(content);
    for (const binding of [{ ...context, purpose: 'refresh_token' as const }, { ...context, employeeId: 8 },
      { ...context, id: '22222222-2222-4222-8222-222222222222' }]) {
      expect(() => decryptGmailSecret(encrypted, binding, env)).toThrowError(expect.objectContaining({ code: 'GMAIL_STORAGE_UNAVAILABLE' }));
    }
    const parts = encrypted.split('.'); parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    expect(() => decryptGmailSecret(parts.join('.'), context, env)).toThrow();
    expect(() => decryptGmailSecret(encrypted, context, { ...env, CONTEXT_GMAIL_ENCRYPTION_KEY: Buffer.alloc(32, 18).toString('base64url') })).toThrow();
    expect(() => encryptGmailSecret('token', context, { NODE_ENV: 'test' })).toThrowError(expect.objectContaining({ code: 'GMAIL_ENCRYPTION_CONFIGURATION' }));
    expect(() => encryptGmailSecret('x'.repeat(8193), { ...context, purpose: 'refresh_token' }, env)).toThrow();
  });

  it('encrypts credentials, archives no draft content and binds every read to the employee', async () => {
    const db = await connected();
    expect(db.connections[0].encrypted_refresh_token).not.toContain('synthetic-refresh-token');
    expect(await getGmailConnection(db.client, owner)).toEqual(db.connection);
    const first = await claimGmailDraftOperation(db.client, owner, db.claim);
    expect(first).toMatchObject({ claimed: true, operation: { state: 'dispatching', requestHash: hash, draftId: null, googleSub: db.connection.googleSub, retryAt: null } });
    expect(await getGmailDraftOperation(db.client, owner, operationId)).toEqual(first.operation);
    expect(JSON.stringify(db.operations)).not.toContain('Synthetic draft body');
    expect(db.operations[0]).not.toHaveProperty('encrypted_content');
    expect(first.operation).not.toHaveProperty('encryptedContent');
    const statements = JSON.stringify(db.query.mock.calls);
    expect(statements).not.toMatch(/encrypted_content|Synthetic draft body|customer@example\.test/);
    db.employees.push({ id: 8, email: 'other@wareongo.com', is_active: true });
    const other = { employeeId: 8, employeeEmail: 'other@wareongo.com' };
    expect(await getGmailDraftOperation(db.client, other, operationId)).toBeNull();
    expect(await getGmailConnection(db.client, other)).toBeNull();
    expect(db.query.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) public\./);
    expect(db.query.mock.calls.map(([sql]) => sql)).not.toContain('COMMIT');
  });

  it('checks the current unique active roster identity on reads and after obtaining the mutation lock', async () => {
    const db = await connected();
    db.employees[0].is_active = false;
    await expect(getGmailConnection(db.client, owner)).rejects.toMatchObject({ status: 403, code: 'GMAIL_EMPLOYEE_INACTIVE' });
    await expect(claimGmailDraftOperation(db.client, owner, db.claim)).rejects.toMatchObject({ code: 'GMAIL_EMPLOYEE_INACTIVE' });
    expect(db.operations).toHaveLength(0);
    db.employees[0].is_active = true;
    db.employees.push({ id: 9, email: owner.employeeEmail.toUpperCase(), is_active: true });
    await expect(assertGmailOwnerActive(db.client, owner)).rejects.toMatchObject({ code: 'GMAIL_EMPLOYEE_INACTIVE' });
    const mutationStart = db.query.mock.calls.findIndex(([sql]) => sql.includes('pg_advisory_xact_lock'));
    expect(db.query.mock.calls[mutationStart + 1][0]).toContain('FROM public."VerifiedNumber"');
  });

  it('claims an operation only once and refuses content changes under the same operation ID', async () => {
    const db = await connected();
    expect((await claimGmailDraftOperation(db.client, owner, db.claim)).claimed).toBe(true);
    expect((await claimGmailDraftOperation(db.client, owner, db.claim)).claimed).toBe(false);
    await expect(claimGmailDraftOperation(db.client, owner, { ...db.claim, requestHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'GMAIL_OPERATION_CONFLICT' });
    const unknown = await finishGmailDraftOperation(db.client, owner, operationId, { state: 'unknown', reason: 'PROVIDER_TIMEOUT' });
    expect(unknown).toMatchObject({ state: 'unknown', draftId: null, reason: 'PROVIDER_TIMEOUT' });
    expect(await claimGmailDraftOperation(db.client, owner, db.claim)).toMatchObject({ claimed: false, operation: { state: 'unknown' } });
    expect(db.operations).toHaveLength(1);
  });

  it('never turns a zero-row conflicting insert into permission to dispatch', async () => {
    const db = await connected();
    const original = db.query.getMockImplementation()!;
    db.query.mockImplementation(async (sql: string, values: unknown[] = []) => sql.startsWith('INSERT INTO context_gmail_private.draft_operations')
      ? { rows: [] } : original(sql, values));
    await expect(claimGmailDraftOperation(db.client, owner, db.claim)).rejects.toMatchObject({ code: 'GMAIL_STORAGE_UNAVAILABLE' });
  });

  it('permits verified reconciliation after the same Google account reconnects without authorizing another create', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    await finishGmailDraftOperation(db.client, owner, operationId, { state: 'unknown', reason: 'PROVIDER_TIMEOUT' });
    await saveGmailConnection(db.client, owner, {googleSub: db.connection.googleSub!, accountEmail: owner.employeeEmail,
      refreshToken: 'replacement-token', grantedScopes: scopes}, env);
    expect(await finishGmailDraftOperation(db.client, owner, operationId, { state: 'created', draftId: 'verified-draft', messageId: 'verified-message' }))
      .toMatchObject({ state: 'created', draftId: 'verified-draft', messageId: 'verified-message' });
    await expect(claimGmailDraftOperation(db.client, owner, db.claim)).rejects.toMatchObject({code: 'GMAIL_CONNECTION_CHANGED'});
  });

  it('reconnecting invalidates pending operations and freezes the original connection version', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    const next = await saveGmailConnection(db.client, owner, {
      googleSub: 'synthetic_new_subject', accountEmail: owner.employeeEmail, refreshToken: 'synthetic-new-token', grantedScopes: scopes,
    }, env);
    expect(next).toMatchObject({ id: db.connection.id, version: 2, status: 'active' });
    expect(db.operations[0]).toMatchObject({ state: 'unknown', reason: 'CONNECTION_CHANGED', connection_version: 1 });
    await expect(claimGmailDraftOperation(db.client, owner, db.claim)).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    await expect(claimGmailDraftOperation(db.client, owner, { ...db.claim, connectionVersion: 2 })).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    expect(await finishGmailDraftOperation(db.client, owner, operationId, { state: 'created', draftId: 'draft1', messageId: 'message1' }))
      .toMatchObject({ state: 'unknown', draftId: null });
  });

  it('disconnect disables access before revocation and erases the token only after successful revocation', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    const revoking = await disconnectGmailConnection(db.client, owner);
    expect(revoking).toMatchObject({ status: 'revoking', version: 2, encryptedRefreshToken: db.connection.encryptedRefreshToken });
    expect(await disconnectGmailConnection(db.client, owner)).toMatchObject({status: 'revoking', version: 3});
    expect(db.operations[0]).toMatchObject({ state: 'unknown', reason: 'CONNECTION_CHANGED' });
    await expect(claimGmailDraftOperation(db.client, owner, { ...db.claim, connectionVersion: 2 })).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    const revoke = vi.fn(async () => {});
    const disconnected = await completeGmailDisconnect(db.client, owner, revoke);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke.mock.calls[0]).toEqual([expect.objectContaining({status: 'revoking', version: 3, encryptedRefreshToken: db.connection.encryptedRefreshToken})]);
    expect(disconnected).toMatchObject({status: 'disconnected', version: 3, encryptedRefreshToken: null});
    expect(await completeGmailDisconnect(db.client, owner, revoke)).toEqual(disconnected);
    expect(revoke).toHaveBeenCalledOnce();
    expect(await disconnectGmailConnection(db.client, owner)).toMatchObject({status: 'disconnected', version: 4});
  });

  it('creates a first-disconnect tombstone and advances its generation to reject stale first-time callbacks', async () => {
    const db = database();
    const first = await disconnectGmailConnection(db.client, owner);
    expect(first).toMatchObject({status: 'disconnected', version: 1, googleSub: null, encryptedRefreshToken: null, grantedScopes: []});
    const input = {googleSub: 'subject', accountEmail: owner.employeeEmail, refreshToken: 'token', grantedScopes: scopes};
    await expect(saveGmailConnection(db.client, owner, {...input, expectedConnection: {id: null, version: null}}, env))
      .rejects.toMatchObject({code: 'GMAIL_CONNECTION_CHANGED'});
    const second = await disconnectGmailConnection(db.client, owner);
    expect(second).toMatchObject({id: first!.id, status: 'disconnected', version: 2});
    await expect(saveGmailConnection(db.client, owner, {...input, expectedConnection: {id: first!.id, version: 1}}, env))
      .rejects.toMatchObject({code: 'GMAIL_CONNECTION_CHANGED'});
    const active = await saveGmailConnection(db.client, owner, {...input, expectedConnection: {id: second!.id, version: 2}}, env);
    expect(active).toMatchObject({id: first!.id, status: 'active', version: 3, googleSub: 'subject'});
  });

  it('retains a disabled revocation-pending credential after provider failure and blocks reconnect until completion', async () => {
    const db = await connected();
    await disconnectGmailConnection(db.client, owner);
    const revoke = vi.fn(async () => {
      expect(db.query.mock.calls.at(-2)?.[0]).toContain('pg_advisory_xact_lock');
      expect(db.query.mock.calls.at(-1)?.[0]).toContain('FROM context_gmail_private.connections');
      throw new Error('Synthetic revocation failure');
    });
    await expect(completeGmailDisconnect(db.client, owner, revoke)).rejects.toThrow('Synthetic revocation failure');
    expect(await getGmailConnection(db.client, owner)).toMatchObject({status: 'revoking', version: 2, encryptedRefreshToken: db.connection.encryptedRefreshToken});
    await expect(saveGmailConnection(db.client, owner, {googleSub: 'subject', accountEmail: owner.employeeEmail,
      refreshToken: 'new-token', grantedScopes: scopes}, env)).rejects.toMatchObject({code: 'GMAIL_REVOCATION_PENDING'});
    expect(db.query.mock.calls.some(([sql]) => sql.includes('SET encrypted_refresh_token = NULL'))).toBe(false);
    await completeGmailDisconnect(db.client, owner, async () => {});
    expect(await getGmailConnection(db.client, owner)).toMatchObject({status: 'disconnected', encryptedRefreshToken: null});
  });

  it('refuses to revoke an active replacement and binds completion to the exact revoking generation', async () => {
    const db = await connected();
    const revoke = vi.fn(async () => {});
    await expect(completeGmailDisconnect(db.client, owner, revoke)).rejects.toMatchObject({code: 'GMAIL_CONNECTION_CHANGED'});
    expect(revoke).not.toHaveBeenCalled();
    const pending = await disconnectGmailConnection(db.client, owner);
    await completeGmailDisconnect(db.client, owner, revoke);
    const update = db.query.mock.calls.find(([sql]) => sql.includes('SET encrypted_refresh_token = NULL'))!;
    expect(update[0]).toContain("id = $3 AND version = $4 AND status = 'revoking'");
    expect(update[1]).toEqual([owner.employeeId, owner.employeeEmail, pending!.id, pending!.version]);
    const absent = database();
    expect(await completeGmailDisconnect(absent.client, owner, revoke)).toBeNull();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('marks only the current active credential as needing reauthorization and invalidates its in-flight operations', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    expect(await markGmailNeedsReauth(db.client, owner, db.connection)).toBe(true);
    expect(await getGmailConnection(db.client, owner)).toMatchObject({status: 'needs_reauth', version: 1, encryptedRefreshToken: db.connection.encryptedRefreshToken});
    expect(db.operations[0]).toMatchObject({state: 'unknown', reason: 'CONNECTION_CHANGED'});
    expect(await markGmailNeedsReauth(db.client, owner, db.connection)).toBe(false);
    await expect(claimGmailDraftOperation(db.client, owner, db.claim)).rejects.toMatchObject({code: 'GMAIL_CONNECTION_CHANGED'});
    const next = await saveGmailConnection(db.client, owner, {googleSub: db.connection.googleSub!, accountEmail: owner.employeeEmail,
      refreshToken: 'new-token', grantedScopes: scopes}, env);
    expect(await markGmailNeedsReauth(db.client, owner, db.connection)).toBe(false);
    expect(await getGmailConnection(db.client, owner)).toMatchObject({status: 'active', version: next.version});
    expect(await markGmailNeedsReauth(db.client, owner, {...next, id: operationId})).toBe(false);
  });

  it('reclaims only due definitive retries once and never reclaims a subsequent uncertain attempt', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    const limited = await finishGmailDraftOperation(db.client, owner, operationId,
      {state: 'retryable', reason: 'PROVIDER_RATE_LIMITED', retryAfterMs: 1000});
    expect(limited).toMatchObject({state: 'retryable', retryAt: '2026-10-04T09:00:01.000Z', draftId: null, messageId: null});
    expect(await claimGmailDraftOperation(db.client, owner, db.claim)).toMatchObject({claimed: false, operation: {state: 'retryable'}});
    db.advance(999);
    expect((await claimGmailDraftOperation(db.client, owner, db.claim)).claimed).toBe(false);
    db.advance(1);
    expect(await claimGmailDraftOperation(db.client, owner, db.claim)).toMatchObject({claimed: true, operation: {state: 'dispatching', retryAt: null, reason: null}});
    expect(await claimGmailDraftOperation(db.client, owner, db.claim)).toMatchObject({claimed: false, operation: {state: 'dispatching'}});
    await finishGmailDraftOperation(db.client, owner, operationId, {state: 'unknown', reason: 'PROVIDER_TIMEOUT'});
    db.advance(86400000);
    expect(await claimGmailDraftOperation(db.client, owner, db.claim)).toMatchObject({claimed: false, operation: {state: 'unknown', retryAt: null}});
    expect(db.operations).toHaveLength(1);
    const claims = db.query.mock.calls.filter(([sql]) => sql.includes('retry_at <= CURRENT_TIMESTAMP'));
    expect(claims).toHaveLength(3);
    expect(claims.every(([sql]) => sql.includes("state = 'retryable'") && sql.includes('operation_id = $3'))).toBe(true);
    expect(db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO context_gmail_private.draft_operations'))).toHaveLength(1);
  });

  it('cannot change content or connection binding while a definitive retry waits', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    await finishGmailDraftOperation(db.client, owner, operationId, {state: 'retryable', retryAfterMs: 1000});
    db.advance(1000);
    await expect(claimGmailDraftOperation(db.client, owner, {...db.claim, requestHash: 'b'.repeat(64)}))
      .rejects.toMatchObject({code: 'GMAIL_OPERATION_CONFLICT'});
    const next = await saveGmailConnection(db.client, owner, {googleSub: db.connection.googleSub!, accountEmail: owner.employeeEmail,
      refreshToken: 'new-token', grantedScopes: scopes}, env);
    await expect(claimGmailDraftOperation(db.client, owner, {...db.claim, connectionVersion: next.version}))
      .rejects.toMatchObject({code: 'GMAIL_CONNECTION_CHANGED'});
    expect(db.operations[0]).toMatchObject({state: 'retryable', connection_version: 1, request_hash: hash});
  });

  it('validates bounded retry delays and does not downgrade an uncertain outcome to retryable', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    for (const retryAfterMs of [undefined, 0, 999, 1000.5, 86400001])
      await expect(finishGmailDraftOperation(db.client, owner, operationId, {state: 'retryable', retryAfterMs})).rejects.toMatchObject({code: 'GMAIL_STORAGE_UNAVAILABLE'});
    await expect(finishGmailDraftOperation(db.client, owner, operationId, {state: 'unknown', retryAfterMs: 1000})).rejects.toThrow();
    await finishGmailDraftOperation(db.client, owner, operationId, {state: 'unknown', reason: 'PROVIDER_TIMEOUT'});
    expect(await finishGmailDraftOperation(db.client, owner, operationId, {state: 'retryable', retryAfterMs: 1000}))
      .toMatchObject({state: 'unknown', retryAt: null});
  });

  it('refuses a stale OAuth callback after disconnect/reconnect or another first-time callback', async () => {
    const db = await connected();
    const input = { googleSub: 'subject', accountEmail: owner.employeeEmail, refreshToken: 'replacement-token', grantedScopes: scopes };
    await expect(saveGmailConnection(db.client, owner, { ...input, expectedConnection: { id: null, version: null } }, env))
      .rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    const disconnected = await disconnectGmailConnection(db.client, owner);
    await expect(saveGmailConnection(db.client, owner, { ...input,
      expectedConnection: { id: db.connection.id, version: db.connection.version } }, env)).rejects.toMatchObject({ code: 'GMAIL_REVOCATION_PENDING' });
    await completeGmailDisconnect(db.client, owner, async () => {});
    await expect(saveGmailConnection(db.client, owner, { ...input,
      expectedConnection: { id: db.connection.id, version: db.connection.version } }, env)).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
    const replacement = await saveGmailConnection(db.client, owner, { ...input,
      expectedConnection: { id: disconnected!.id, version: disconnected!.version } }, env);
    expect(replacement).toMatchObject({ version: 3, status: 'active' });
    await expect(saveGmailConnection(db.client, owner, { ...input,
      expectedConnection: { id: disconnected!.id, version: disconnected!.version } }, env)).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_CHANGED' });
  });

  it('records provider identities only for created drafts and preserves terminal outcomes on repeats', async () => {
    const db = await connected();
    await claimGmailDraftOperation(db.client, owner, db.claim);
    await expect(finishGmailDraftOperation(db.client, owner, operationId, { state: 'created', draftId: 'only-a-draft-id' })).rejects.toThrow();
    await expect(finishGmailDraftOperation(db.client, owner, operationId, { state: 'unknown', reason: 'raw provider error with secret' })).rejects.toThrow();
    const created = await finishGmailDraftOperation(db.client, owner, operationId, { state: 'created', draftId: 'r-123', messageId: 'abc123' });
    expect(created).toMatchObject({ state: 'created', draftId: 'r-123', messageId: 'abc123' });
    expect(await finishGmailDraftOperation(db.client, owner, operationId, { state: 'unknown', reason: 'PROVIDER_TIMEOUT' })).toEqual(created);
    expect(await claimGmailDraftOperation(db.client, owner, db.claim)).toMatchObject({ claimed: false, operation: { state: 'created' } });
  });

  it('rejects cross-account connection storage and malformed persisted state', async () => {
    const db = await connected();
    await expect(saveGmailConnection(db.client, owner, {
      googleSub: 'subject', accountEmail: 'other@wareongo.com', refreshToken: 'token', grantedScopes: scopes,
    }, env)).rejects.toMatchObject({ code: 'GMAIL_STORAGE_UNAVAILABLE' });
    db.connections[0].account_email = 'other@wareongo.com';
    await expect(getGmailConnection(db.client, owner)).rejects.toMatchObject({ code: 'GMAIL_STORAGE_UNAVAILABLE' });
    db.connections[0].account_email = owner.employeeEmail;
    await claimGmailDraftOperation(db.client, owner, db.claim);
    db.operations[0].state = 'created';
    await expect(getGmailDraftOperation(db.client, owner, operationId)).rejects.toMatchObject({ code: 'GMAIL_STORAGE_UNAVAILABLE' });
  });
});

describe('issued Gmail token cleanup', () => {
  const issued = { googleSub: 'synthetic_subject', refreshToken: 'fresh-issued-token', grantedScopes: scopes };
  it('quarantines an unattached token and permits pending-only completion after offboarding', async () => {
    const db = database(); db.employees[0].is_active = false;
    expect(await quarantineGmailIssuedToken(db.client, owner, issued, env)).toBe('pending');
    expect(db.connections[0]).toMatchObject({ status: 'revoking', version: 1 });
    const revoke = vi.fn(async (connection) => {
      expect(decryptGmailSecret(connection.encryptedRefreshToken, { purpose: 'refresh_token', employeeId: owner.employeeId, id: connection.id }, env)).toBe(issued.refreshToken);
    });
    expect(await completeGmailDisconnect(db.client, owner, revoke)).toMatchObject({ status: 'disconnected', encryptedRefreshToken: null });
    expect(revoke).toHaveBeenCalledTimes(1);
    await expect(saveGmailConnection(db.client, owner, { ...issued, accountEmail: owner.employeeEmail }, env)).rejects.toMatchObject({ code: 'GMAIL_EMPLOYEE_INACTIVE' });
  });
  it('preserves a current active grant to the same verified subject without revoking or replacing it', async () => {
    const db = await connected(), before = { ...db.connections[0] };
    expect(await quarantineGmailIssuedToken(db.client, owner, issued, env)).toBe('covered');
    expect(db.connections[0]).toEqual(before);
  });
  it('requires explicit manual cleanup instead of replacing a different live Google subject', async () => {
    const db = await connected(), before = { ...db.connections[0] };
    expect(await quarantineGmailIssuedToken(db.client, owner, { ...issued, googleSub: 'different_subject' }, env)).toBe('manual');
    expect(db.connections[0]).toEqual(before);
  });
  it('uses the newly issued token for pending revocation rather than an older possibly invalid token', async () => {
    const db = await connected(); await disconnectGmailConnection(db.client, owner);
    expect(await quarantineGmailIssuedToken(db.client, owner, issued, env)).toBe('pending');
    const row = db.connections[0];
    expect(row).toMatchObject({ status: 'revoking', version: 3 });
    expect(decryptGmailSecret(String(row.encrypted_refresh_token), { purpose: 'refresh_token', employeeId: owner.employeeId, id: String(row.id) }, env)).toBe(issued.refreshToken);
  });
  it('does not preserve an active grant after its employee is deactivated', async () => {
    const db = await connected(); db.employees[0].is_active = false;
    expect(await quarantineGmailIssuedToken(db.client, owner, issued, env)).toBe('pending');
    expect(db.connections[0]).toMatchObject({ status: 'revoking', version: 2 });
  });
});
