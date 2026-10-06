import { AsyncLocalStorage } from 'node:async_hooks';
import { redactCrmText, unredactedCrmText, type CrmTextOptions } from './crm-redaction';
import { sanitizeLabel } from './privacy';

export type CrmTextPolicy = 'redacted' | 'unredacted';
const policy = new AsyncLocalStorage<CrmTextPolicy>();

/** Server-owned request policy; never selected by tool arguments or source data.
 * Keep this boundary for future role scoping without changing CRM projections.
 */
export function withCrmTextPolicy<T>(value: CrmTextPolicy, work: () => T): T {
  return policy.run(value, work);
}

export function crmContactsRedacted(): boolean {
  return policy.getStore() !== 'unredacted';
}

export function crmText(value: unknown, options: CrmTextOptions = {}) {
  return crmContactsRedacted() ? redactCrmText(value, options) : unredactedCrmText(value, options);
}

export function crmLabel(value: unknown, maxLength = 100): string | null {
  if (crmContactsRedacted()) return sanitizeLabel(value, maxLength);
  const rendered = crmText(value, { maxCharacters: maxLength });
  return rendered.truncated ? null : rendered.text;
}

export function crmTextGuidance(): string {
  return crmContactsRedacted()
    ? 'CRM contacts and links in narrative text are redacted; never reconstruct omitted values.'
    : 'CRM contact masking is disabled for this Ramesh request. Preserve returned phone numbers, emails and links when relevant to the reply; do not add redaction placeholders. Raw contact fields outside the permitted projection remain excluded.';
}
