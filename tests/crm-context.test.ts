import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/lib/auth';
import type { CrmAccess } from '../src/lib/crm-live';
import { CRM_CONTEXT_SECTIONS, parseCrmContextQuery } from '../src/lib/crm-context-query';
import { getCrmStageHistory } from '../src/lib/data';

const leadId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const principal: Principal = { employeeId: 17, email: 'example@example.test', keyId: 'synthetic', scopes: ['crm:read'], twentyUserId: otherId };
const access: CrmAccess = { mode: 'related', memberId: otherId, ids: [leadId] };
function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, client: { query } as unknown as PoolClient };
}
const observation = (id: string) => ({ id, from_stage: 'NEW_LEAD', to_stage: 'SITE_VISIT',
  changed_at: '2026-09-20T12:00:00.000Z', detected_at: '2026-09-20T12:02:00.000Z' });

describe('CRM context query validation', () => {
  it.each(CRM_CONTEXT_SECTIONS)('requires one explicit %s section and defaults to ten records', section => {
    expect(parseCrmContextQuery(new URLSearchParams({ section }))).toEqual({ section, limit: 10, cursor: undefined });
    expect(parseCrmContextQuery(new URLSearchParams({ section, limit: '1' })).limit).toBe(1);
  });
  it.each(['', 'section=all', 'section=notes&section=tasks', 'section=notes&limit=0', 'section=notes&limit=11',
    'section=notes&limit=1.5', 'section=notes&limit=01', 'section=notes&limit=', 'section=notes&cursor=',
    'section=notes&cursor=bad%3D', 'section=company&cursor=abc', 'section=notes&phone=123',
    `section=notes&cursor=${'x'.repeat(2049)}`])('rejects ambiguous or unsupported query %s', value => {
    expect(() => parseCrmContextQuery(new URLSearchParams(value))).toThrowError(expect.objectContaining({ status: 400, code: 'INVALID_QUERY' }));
  });
});

describe('scoped observed CRM stage history', () => {
  it('binds the lead and live permissions, orders observations by log ID, and retains both clocks', async () => {
    const db = database([observation('7')]);
    const result = await getCrmStageHistory(db.client, principal, leadId, access, 10);
    expect(db.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('JOIN public.opportunities o ON o.opportunity_id = t.opportunity_id'), [leadId, '0', 11, [leadId]]);
    const sql = db.query.mock.calls[0][0] as string;
    expect(sql).toContain('o.deleted_at IS NULL');
    expect(sql).toContain('o.opportunity_id = ANY($4::text[])');
    expect(sql).toContain('t.opportunity_id = $1 AND t.id > $2::bigint ORDER BY t.id ASC LIMIT $3');
    expect(sql).not.toContain('o.data');
    expect(result).toMatchObject({ section: 'stage_history', items: [observation('7')], nextCursor: null,
      freshness_basis: 'observed_mirror_history', coverage: { has_more: false, history_complete: false } });
    expect(result.text_guidance).toContain('Earlier or intermediate changes may be missing');
  });

  it('allows verified admins without weakening deletion checks and binds empty scopes as empty', async () => {
    const db = database();
    await getCrmStageHistory(db.client, principal, leadId, { mode: 'all', memberId: otherId }, 2);
    expect(db.query.mock.calls[0][1]).toEqual([leadId, '0', 3]);
    expect(db.query.mock.calls[0][0]).toContain('o.deleted_at IS NULL');
    expect(db.query.mock.calls[0][0]).not.toContain('ANY(');
    await getCrmStageHistory(db.client, principal, leadId, { ...access, ids: [] }, 2);
    expect(db.query.mock.calls[1][1]).toEqual([leadId, '0', 3, []]);
    const denied = database();
    await expect(getCrmStageHistory(denied.client, principal, leadId, { ...access, memberId: leadId }, 2)).rejects.toMatchObject({ status: 503, code: 'CRM_AUTHORIZATION_UNAVAILABLE' });
    expect(denied.query).not.toHaveBeenCalled();
  });

  it('continues at the last returned observation while preserving the lead and employee binding', async () => {
    const db = database([observation('7'), observation('9')]);
    const first = await getCrmStageHistory(db.client, principal, leadId, access, 1);
    expect(first.items.map(item => item.id)).toEqual(['7']);
    expect(first.coverage.has_more).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    db.query.mockResolvedValueOnce({ rows: [observation('9')] });
    const second = await getCrmStageHistory(db.client, principal, leadId, access, 5, first.nextCursor!);
    expect(db.query.mock.calls[1][1]).toEqual([leadId, '7', 6, [leadId]]);
    expect(second.nextCursor).toBeNull();
    const denied = database();
    await expect(getCrmStageHistory(denied.client, principal, otherId, access, 5, first.nextCursor!)).rejects.toMatchObject({ status: 400 });
    await expect(getCrmStageHistory(denied.client, { ...principal, employeeId: 18 }, leadId, access, 5, first.nextCursor!)).rejects.toMatchObject({ status: 400 });
    expect(denied.query).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', '9223372036854775808', 'not-an-id'])('rejects invalid or overflowing history cursor ID %s before querying', async after => {
    const db = database();
    const cursor = Buffer.from(JSON.stringify({ v: 1, section: 'stage_history', lead: leadId, employee: principal.employeeId, after })).toString('base64url');
    await expect(getCrmStageHistory(db.client, principal, leadId, access, 10, cursor)).rejects.toMatchObject({ status: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([0, 11, 1.5, NaN])('bounds history page limit %s before querying', async limit => {
    const db = database();
    await expect(getCrmStageHistory(db.client, principal, leadId, access, limit)).rejects.toMatchObject({ status: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('redacts unexpected stage labels without exposing contact text or pretending it was a known enum', async () => {
    const db = database([{ ...observation('7'), from_stage: 'Call 9876543210', to_stage: 'private@example.test' }]);
    const result = await getCrmStageHistory(db.client, principal, leadId, access, 10);
    expect(JSON.stringify(result)).not.toMatch(/9876543210|private@example/);
    expect(result.items[0].to_stage).toContain('omitted');
  });

  it.each([{ id: 'bad' }, { changed_at: 'not-a-date' }, { detected_at: null }])('fails closed when an observation lacks a valid ID or clock: %j', async changes => {
    const db = database([{ ...observation('7'), ...changes }]);
    await expect(getCrmStageHistory(db.client, principal, leadId, access, 10)).rejects.toMatchObject({ status: 503, code: 'CRM_CONTEXT_UNAVAILABLE' });
  });
});
