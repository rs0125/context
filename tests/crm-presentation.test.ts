import { describe, expect, it } from 'vitest';
import { crmLabel, crmText, withCrmTextPolicy } from '../src/lib/crm-presentation';
import { crmNarrative, crmOwnership } from '../src/lib/crm-detail';
import { richCrmFields } from '../src/lib/crm-fields';
import { redactWarehouseRecordedSource } from '../src/lib/warehouse-recorded-context';
import { safeAnalyticsLabel } from '../src/lib/analytics';

const contact = 'Call 9876543210 or alex@example.test';

describe('request-scoped CRM presentation', () => {
  it('isolates concurrent requests and restores the default policy after errors', async () => {
    const render = () => crmText(contact);
    const [unredacted, redacted, ordinary] = await Promise.all([
      withCrmTextPolicy('unredacted', async () => { await Promise.resolve(); return render(); }),
      withCrmTextPolicy('redacted', async () => { await Promise.resolve(); return render(); }),
      Promise.resolve().then(render),
    ]);
    expect(unredacted).toMatchObject({ text: contact, redacted: false });
    for (const result of [redacted, ordinary]) {
      expect(result.redacted).toBe(true);
      expect(result.text).not.toMatch(/9876543210|alex@example/);
    }
    await expect(withCrmTextPolicy('unredacted', async () => { throw new Error('failed read'); })).rejects.toThrow('failed read');
    expect(render()).toEqual(ordinary);
  });

  it('uses the same policy for narratives, ownership, labels and unparsed field evidence', () => {
    withCrmTextPolicy('unredacted', () => {
      expect(crmNarrative({ description: contact, loss_reason: contact })).toMatchObject({
        description: { text: contact, redacted: false }, loss_reason: { text: contact, redacted: false },
      });
      expect(crmOwnership({ assigned_to: ['alex@example.test'] }).assigned_to)
        .toEqual({ state: 'present', values: ['alex@example.test'], redacted: false });
      expect(crmLabel('Alex 9876543210')).toBe('Alex 9876543210');
      expect(richCrmFields({ lead_source: contact }).field_evidence.lead_source.source)
        .toMatchObject({ text: contact, redacted: false });
    });
  });

  it('keeps warehouse and analytics masking independent of CRM presentation', () => {
    withCrmTextPolicy('unredacted', () => {
      const warehouse = redactWarehouseRecordedSource(contact);
      const analytics = safeAnalyticsLabel(contact);
      expect(warehouse.redacted).toBe(true);
      expect(analytics.redacted).toBe(true);
      expect(JSON.stringify([warehouse, analytics])).not.toMatch(/9876543210|alex@example/);
    });
  });
});
