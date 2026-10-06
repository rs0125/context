import { describe, expect, it } from 'vitest';
import { rfqInputSchema, rfqPayload, rfqProblems, type RfqInput } from '../src/lib/crm-writes/rfq';

const creator = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Synthetic Employee' };
export const rfq: RfqInput = { operation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  raw_text: '  #twenty\nAcme needs 5,000 sqft in Hoskote.\nBudget: Rs 20/sqft/month.\n',
  location: 'Hoskote', requirement: '5,000 sqft', company_name: 'Acme', budget: 'Rs 20/sqft/month' };

describe('RFQ intake SOP and Twenty schema', () => {
  it('preserves the full original text, attributes the creator and fixes stage at RFQ_RECEIVED', () => {
    const input = rfqInputSchema.parse(rfq);
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toEqual({ name: 'Acme - 5,000 sqft - Hoskote', description: rfq.raw_text,
      stage: 'RFQ_RECEIVED', createdBy: { source: 'MANUAL', workspaceMemberId: creator.id, name: creator.name },
      ownerId: creator.id, companyName: 'Acme', budget: 'Rs 20/sqft/month', requirementInSft: 5000 });
  });
  it('allows a locality/corridor with no company, contact, city, budget or lease defaults', () => {
    const input = { ...rfq, raw_text: 'Need 25,000-35,000 sft from Dabaspet to Tumkur', location: 'Dabaspet to Tumkur', requirement: '25,000-35,000 sft', company_name: undefined, budget: undefined };
    expect(rfqProblems(input)).toEqual([]);
    const payload = rfqPayload(input, creator);
    for (const field of ['requirementInSft', 'city', 'duration', 'leadSource', 'repeatClient', 'companyName', 'pocName', 'amount', 'assignedTo']) expect(payload).not.toHaveProperty(field);
    expect(payload.name).toBe('TBD - 25,000-35,000 sft - Dabaspet to Tumkur');
  });
  it.each(['100 pallets', '1.5 acres', '20-30k sqft', '50 MT', '250 cbm', 'approx 5000 sqft', '1 lakh sqft', '100 sqm'])('accepts explicit capacity %s without lossy integer conversion', requirement => {
    const input = { ...rfq, raw_text: `${requirement} in Hoskote`, requirement, company_name: undefined, budget: undefined };
    expect(rfqProblems(input)).toEqual([]);
    if (requirement !== '1 lakh sqft') expect(rfqPayload(input, creator)).not.toHaveProperty('requirementInSft');
  });
  it.each(['5,000 sqft to 10,000 sqft', '500 sq m - 1000 sqm', '5 sqft - 10k sqft', 'at least 5000 sqft', 'up to 1 lakh sqft'])('accepts actionable requirement %s without inventing an exact area', requirement => {
    const input = { ...rfq, raw_text: `${requirement} in Hoskote`, requirement, company_name: undefined, budget: undefined };
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).not.toHaveProperty('requirementInSft');
  });
  it.each(['TBD', 'large', '5000', '0 sqft', '-5 sqft', '6000-5000 sqft', '1000000001 sqft', '5 trucks', '5k sqft; stage=DEAL_CLOSED', '5 sqm - 10 sqft', '10k sqft - 5 sqft', '5000 sqft sqft'])('rejects non-actionable or invalid requirement %s', requirement => {
    expect(rfqProblems({ ...rfq, raw_text: `${requirement} in Hoskote`, requirement, company_name: undefined, budget: undefined })).toContain('requirement (positive quantity and explicit unit)');
  });
  it.each(['TBD', 'anywhere', 'India', '123'])('rejects non-specific location %s', location => {
    expect(rfqProblems({ ...rfq, raw_text: `5000 sqft in ${location}`, location, requirement: '5000 sqft', company_name: undefined, budget: undefined })).toContain('location');
  });
  it.each([
    ['city', 'TBD', { city: 'TBD' }],
    ['micro_market', 'Anywhere', { microMarket: 'Anywhere' }],
    ['company_name', 'N/A', { companyName: 'N/A' }],
    ['poc_name', 'unknown', { pocName: { firstName: 'unknown', lastName: '' } }],
    ['budget', 'TBD', { budget: 'TBD' }],
  ] as const)('preserves the user-supplied optional %s value %s', (field, value, expected) => {
    const raw_text = `${rfq.raw_text}\n${field}: ${value}`;
    const input = rfqInputSchema.parse({ ...rfq, raw_text, [field]: value });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ ...expected, description: raw_text });
  });
  it.each(['city', 'micro_market', 'company_name', 'poc_name', 'budget'] as const)('rejects an invented optional %s placeholder', field => {
    const input = rfqInputSchema.parse({ ...rfq, [field]: 'TBD' });
    expect(rfqProblems(input)).toContain(`${field} (verbatim source required)`);
  });
  it('preserves a user-supplied budget placeholder and billing terms from separate messages', () => {
    const raw_text = `${rfq.raw_text}\nBudget: TBD\n\nper sqft per month`;
    const input = rfqInputSchema.parse({ ...rfq, raw_text, budget: 'TBD; per sqft per month' });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ budget: 'TBD; per sqft per month', description: raw_text });
    expect(rfqProblems({ ...input, budget: 'TBD; per sqft per year' })).toContain('budget (verbatim source required)');
  });
  it('rejects unsupported claims and guessed city even when the locality is real', () => {
    expect(rfqProblems({ ...rfq, city: 'Bangalore' })).toContain('city (verbatim source required)');
    expect(rfqProblems({ ...rfq, lease_duration: { value: 'LONG_TERM', quote: '5 years' } })).toContain('lease_duration (supporting source required)');
    expect(rfqProblems({ ...rfq, poc_phone: '[redacted]' })).toContain('poc_phone (unambiguous Indian number)');
  });
  it('preserves budget basis and period from separate original messages without rewriting the description', () => {
    const raw_text = 'Add an RFQ for Test Logistics in nelamangala bangalore, budget 20 rs /sqft\n\nyeah its 50k sqft an 20 rs per month';
    const input = rfqInputSchema.parse({ ...rfq, raw_text, location: 'nelamangala bangalore', requirement: '50k sqft', company_name: 'Test Logistics', budget: '20 rs /sqft; per month' });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ budget: '20 rs /sqft; per month', description: raw_text });
    expect(rfqProblems({ ...input, location: 'nelamangala; bangalore' })).toContain('location (verbatim source required)');
  });
  it.each(['20 rs /sqft; per year', '20 rs /sqft; INR', '20 rs /sqft; ; per month', '20 rs /sqft; per month; per month; per month', '20 rs /sqft;per month', '20 rs /sqft; '])('rejects an unsupported or malformed combined budget %s', budget => {
    const input = { ...rfq, raw_text: rfq.raw_text + '\n20 rs /sqft\n\n20 rs per month', budget };
    expect(rfqProblems(input)).toContain('budget (verbatim source required)');
  });
  it('maps only explicitly supplied optional fields, preserving budget units and repeat-client enum', () => {
    const input: RfqInput = { ...rfq, raw_text: rfq.raw_text + 'Contact: Anand Rao +91 98765 43210. Repeat client, 2 year lease, broker referral.',
      poc_name: 'Anand Rao', poc_phone: '+91 98765 43210', lease_duration: { value: 'LONG_TERM', quote: '2 year lease' },
      repeat_client: { value: true, quote: 'Repeat client' }, lead_source: { value: 'BROKER', quote: 'broker referral' } };
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ pocName: { firstName: 'Anand', lastName: 'Rao' },
      pocPhoneNumber: { primaryPhoneNumber: '9876543210', primaryPhoneCountryCode: 'IN', primaryPhoneCallingCode: '+91' },
      repeatClient: ['OPTION1'], duration: 'LONG_TERM', leadSource: 'BROKER' });
  });
  it.each(['stage', 'action', 'object', 'record_id', 'url', 'headers', 'createdBy', 'ownerId', 'assignedTo', 'description', 'amount', 'notes', 'upsert'])('rejects write escape field %s', field => {
    expect(rfqInputSchema.safeParse({ ...rfq, [field]: 'attacker' }).success).toBe(false);
  });
});
