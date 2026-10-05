import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptCrmSnapshot, encryptCrmSnapshot, type CrmSnapshotContext } from '../src/lib/crm-writes/snapshots';

const env = { CONTEXT_KEY_ENCRYPTION_SECRET: 'test-only-secret-that-is-over-32-characters' };
const context: CrmSnapshotContext = { employeeId: 7, email: 'employee@wareongo.com', memberId: randomUUID(),
  operationId: randomUUID(), action: 'update_crm_rfq', requestHash: 'a'.repeat(64) };
const value = { before: { companyName: 'Private RFQ', budget: '₹20/month', pocName: null }, after: { companyName: 'Revised RFQ' } };

describe('actor-bound CRM snapshots', () => {
  it('roundtrips encrypted JSON with a fresh nonce and no plaintext in storage', () => {
    const first = encryptCrmSnapshot(value, context, env), second = encryptCrmSnapshot(value, context, env);
    expect(first).not.toBe(second);
    expect(first).not.toContain('Private RFQ');
    expect(decryptCrmSnapshot(first, context, env)).toEqual(value);
  });
  it('binds all actor/request/action fields and fails closed on wrong keys', () => {
    const ciphertext = encryptCrmSnapshot(value, context, env);
    for (const changed of [
      { employeeId: 8 }, { email: 'other@wareongo.com' }, { memberId: randomUUID() },
      { operationId: randomUUID() }, { action: 'create_crm_rfq' as const }, { requestHash: 'b'.repeat(64) },
    ]) expect(() => decryptCrmSnapshot(ciphertext, { ...context, ...changed }, env)).toThrowError(expect.objectContaining({ code: 'CRM_SNAPSHOT_UNAVAILABLE' }));
    expect(() => decryptCrmSnapshot(ciphertext, context, { CONTEXT_KEY_ENCRYPTION_SECRET: 'different-test-key-with-more-than-32-characters' })).toThrow();
  });
  it.each(['create_crm_note', 'update_crm_note', 'undo_crm_note', 'delete_crm_rfq', 'delete_crm_note'] as const)('encrypts %s snapshots without allowing replay as another note or RFQ action', action => {
    const noteContext = { ...context, action };
    const note = { deal_id: randomUUID(), note_id: randomUUID(), before: { body: 'Private deal discussion' } };
    const ciphertext = encryptCrmSnapshot(note, noteContext, env);
    expect(ciphertext).not.toContain('Private deal discussion');
    expect(decryptCrmSnapshot(ciphertext, noteContext, env)).toEqual(note);
    for (const otherAction of ['create_crm_rfq', 'update_crm_rfq', 'undo_crm_rfq', 'create_crm_note', 'update_crm_note', 'undo_crm_note', 'delete_crm_rfq', 'delete_crm_note'] as const) {
      if (otherAction !== action) expect(() => decryptCrmSnapshot(ciphertext, { ...noteContext, action: otherAction }, env))
        .toThrowError(expect.objectContaining({ code: 'CRM_SNAPSHOT_UNAVAILABLE' }));
    }
  });
  it('detects changes to the IV, ciphertext, tag and envelope', () => {
    const ciphertext = encryptCrmSnapshot(value, context, env);
    for (const index of [1, 2, 3]) {
      const parts = ciphertext.split('.');
      parts[index] = (parts[index][0] === 'A' ? 'B' : 'A') + parts[index].slice(1);
      expect(() => decryptCrmSnapshot(parts.join('.'), context, env)).toThrow();
    }
    for (const malformed of ['', ciphertext + '=', ciphertext.replace('v1.', 'v2.'), `v1.${'A'.repeat(90_000)}`])
      expect(() => decryptCrmSnapshot(malformed, context, env)).toThrow();
  });
  it('requires the configured key with no fallback and rejects invalid bindings', () => {
    for (const secret of [undefined, '', 'short']) {
      expect(() => encryptCrmSnapshot(value, context, { CONTEXT_KEY_ENCRYPTION_SECRET: secret })).toThrowError(expect.objectContaining({ code: 'CRM_SNAPSHOT_CONFIGURATION' }));
    }
    expect(() => encryptCrmSnapshot(value, { ...context, email: 'EMPLOYEE@wareongo.com' }, env)).toThrow();
    expect(() => encryptCrmSnapshot(value, { ...context, operationId: 'not-a-uuid' }, env)).toThrow();
  });
  it('bounds plaintext bytes and requires a JSON object', () => {
    const bounded = { value: 'a'.repeat(65_524) }; // Exactly 65,536 UTF-8 bytes including JSON framing.
    expect(decryptCrmSnapshot(encryptCrmSnapshot(bounded, context, env), context, env)).toEqual(bounded);
    expect(() => encryptCrmSnapshot({ value: 'a'.repeat(65_525) }, context, env)).toThrow();
    expect(() => encryptCrmSnapshot({ value: '₹'.repeat(30_000) }, context, env)).toThrow();
    expect(() => encryptCrmSnapshot([] as unknown as Record<string, unknown>, context, env)).toThrow();
    const cyclic: Record<string, unknown> = {}; cyclic.value = cyclic;
    expect(() => encryptCrmSnapshot(cyclic, context, env)).toThrow();
  });
});
