import { describe, expect, it } from 'vitest';
import { rfqInputSchema, rfqPayload, rfqProblems, indianPhone, normalizeRfqInput, type RfqInput } from '../src/lib/crm-writes/rfq';
import { rfqChangesSchema } from '../src/lib/crm-writes/changes';

const creator = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Synthetic Employee' };
export const rfq: RfqInput = { operation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  raw_text: '  #twenty\nAcme needs 5,000 sqft in Hoskote.\nBudget: Rs 20/sqft/month.\n',
  location: 'Hoskote', requirement: '5,000 sqft', company_name: 'Acme', budget: 'Rs 20/sqft/month' };

describe('RFQ intake SOP and Twenty schema', () => {
  it.each(['x', '界', '\u0001'])('preserves a full 32K source including %j and rejects overflow without truncating', character => {
    const raw_text = 'Save this brief.\n'.padEnd(31_999, character) + '\n';
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text });
    expect(rfqPayload(input, creator).description).toBe(raw_text);
    expect(rfqInputSchema.safeParse({ ...input, raw_text: raw_text + 'x' }).success).toBe(false);
    expect(rfqInputSchema.safeParse({ ...input, raw_text: raw_text.slice(1) + '\0' }).success).toBe(false);
  });
  it.each([
    '  Save this lead: needs a small godown, area and location still being discussed.\nParking for two trucks.\n#twenty\n',
    'Client ko office aur godown chahiye. Size baad mein confirm karenge.\nSupply POC: Meera',
  ])('can capture the complete brief without extracting any optional fields', raw_text => {
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toEqual({ name: 'New RFQ', description: raw_text, stage: 'RFQ_RECEIVED',
      ownerId: creator.id, createdBy: { source: 'MANUAL', workspaceMemberId: creator.id, name: creator.name } });
  });
  it('accepts absent classification quotes without turning extraction into a questionnaire', () => {
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text: 'Repeat client from broker. Long-term requirement.',
      repeat_client: { value: true }, lead_source: { value: 'BROKER' }, lease_duration: { value: 'LONG_TERM' } });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ description: input.raw_text, repeatClient: ['OPTION1'], leadSource: 'BROKER', duration: 'LONG_TERM' });
  });
  it.each(['+44 (0) 9876543210', '9876543210 ext 12', '[phone omitted]'])('saves the brief while leaving unsupported contact %s out of the phone field', poc_phone => {
    const raw_text = `Save this requirement. Contact: ${poc_phone}`;
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text, poc_phone, requirement: '', location: null });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).not.toHaveProperty('pocPhoneNumber');
    expect(rfqPayload(input, creator).description).toBe(raw_text);
  });
  it('preserves a conversational logistics brief without confusing internal roles with client contacts', () => {
    const raw_text = 'Requirement for Acme Logistics\nRepeat client\nAssigned to: Arun\nSupply POC: Meera\nOwner: Vijay\n3,000-5,000sft in Devanahalli - office cum warehouse (parking for 2-3 trucks)\n#twenty';
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text,
      company_name: 'Acme Logistics', location: 'Devanahalli', requirement: '3,000-5,000sft',
      repeat_client: { value: true, quote: 'Repeat client' } });
    expect(rfqProblems(input)).toEqual([]);
    const payload = rfqPayload(input, creator);
    expect(payload).toMatchObject({ description: raw_text, companyName: 'Acme Logistics',
      name: 'Acme Logistics - 3,000-5,000sft - Devanahalli', ownerId: creator.id, repeatClient: ['OPTION1'] });
    for (const field of ['requirementInSft', 'pocName', 'city', 'assignedTo', 'supplyPoc']) expect(payload).not.toHaveProperty(field);
  });
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
    expect(payload.name).toBe('25,000-35,000 sft - Dabaspet to Tumkur');
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
  it.each(['TBD', 'large', '5000', '0 sqft', '-5 sqft', '6000-5000 sqft', '1000000001 sqft', '5 trucks', '5k sqft; stage=DEAL_CLOSED', '5 sqm - 10 sqft', '10k sqft - 5 sqft', '5000 sqft sqft'])('captures informal or unsupported requirement %s without a guessed numeric area', requirement => {
    const input = { ...rfq, raw_text: `${requirement} in Hoskote`, requirement, company_name: undefined, budget: undefined };
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ description: input.raw_text, stage: 'RFQ_RECEIVED' });
    expect(rfqPayload(input, creator)).not.toHaveProperty('requirementInSft');
  });
  it.each(['TBD', 'anywhere', 'India', '123'])('captures a brief even when its supplied location is %s', location => {
    const input = { ...rfq, raw_text: `5000 sqft in ${location}`, location, requirement: '5000 sqft', company_name: undefined, budget: undefined };
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator).description).toBe(input.raw_text);
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
  it.each([['city', 'city'], ['micro_market', 'microMarket'], ['company_name', 'companyName'], ['poc_name', 'pocName'], ['budget', 'budget']] as const)('ignores an ungrounded optional %s placeholder without refusing the brief', (field, native) => {
    const input = rfqInputSchema.parse({ ...rfq, [field]: 'TBD' });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).not.toHaveProperty(native);
    expect(rfqPayload(input, creator).description).toBe(rfq.raw_text);
  });
  it('preserves a user-supplied budget placeholder and billing terms from separate messages', () => {
    const raw_text = `${rfq.raw_text}\nBudget: TBD\n\nper sqft per month`;
    const input = rfqInputSchema.parse({ ...rfq, raw_text, budget: 'TBD; per sqft per month' });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ budget: 'TBD; per sqft per month', description: raw_text });
    expect(rfqPayload({ ...input, budget: 'TBD; per sqft per year' }, creator)).not.toHaveProperty('budget');
  });
  it('withholds unsupported optional claims without refusing the original brief', () => {
    const input = { ...rfq, city: 'Bangalore', lease_duration: { value: 'LONG_TERM' as const, quote: '5 years' }, poc_phone: '[redacted]' };
    expect(rfqProblems(input)).toEqual([]);
    const payload = rfqPayload(input, creator);
    for (const field of ['city', 'duration', 'pocPhoneNumber']) expect(payload).not.toHaveProperty(field);
    expect(payload.description).toBe(rfq.raw_text);
  });
  it('preserves budget basis and period from separate original messages without rewriting the description', () => {
    const raw_text = 'Add an RFQ for Test Logistics in nelamangala bangalore, budget 20 rs /sqft\n\nyeah its 50k sqft an 20 rs per month';
    const input = rfqInputSchema.parse({ ...rfq, raw_text, location: 'nelamangala bangalore', requirement: '50k sqft', company_name: 'Test Logistics', budget: '20 rs /sqft; per month' });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ budget: '20 rs /sqft; per month', description: raw_text });
    expect(rfqPayload({ ...input, location: 'nelamangala; bangalore' }, creator).name).not.toContain('nelamangala; bangalore');
  });
  it.each(['20 rs /sqft; per year', '20 rs /sqft; INR', '20 rs /sqft; ; per month', '20 rs /sqft;per month', '20 rs /sqft; '])('leaves an unsupported combined budget %s in the description', budget => {
    const input = { ...rfq, raw_text: rfq.raw_text + '\n20 rs /sqft\n\n20 rs per month', budget };
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).not.toHaveProperty('budget');
    expect(rfqPayload(input, creator).description).toBe(input.raw_text);
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
  it('accepts blank optional creation fields as omission while retaining explicit false and placeholders', () => {
    const input = rfqInputSchema.parse({ ...rfq, raw_text: rfq.raw_text + '\nNew client\nCompany: TBD',
      city: null, micro_market: '', company_name: 'TBD', poc_name: '   ', poc_phone: null,
      budget: '', lead_source: null, lease_duration: null, repeat_client: { value: false, quote: 'New client' } });
    expect(rfqProblems(input)).toEqual([]);
    const payload = rfqPayload(input, creator);
    expect(payload).toMatchObject({ companyName: 'TBD', repeatClient: ['NO'], description: input.raw_text });
    for (const field of ['city', 'microMarket', 'pocName', 'pocPhoneNumber', 'budget', 'leadSource', 'duration']) expect(payload).not.toHaveProperty(field);
    expect(normalizeRfqInput(input)).not.toHaveProperty('city');
    expect(input.city).toBeNull();
  });
  it.each(['location', 'requirement', 'city', 'micro_market', 'company_name', 'poc_name', 'poc_phone', 'budget', 'lead_source', 'lease_duration', 'repeat_client'] as const)('accepts null optional creation field %s without guessing a value', field => {
    const input = rfqInputSchema.parse({ ...rfq, [field]: null });
    expect(rfqProblems(input)).toEqual([]);
    expect(normalizeRfqInput(input)).not.toHaveProperty(field);
  });
  it.each([['location', 160], ['requirement', 120], ['city', 120], ['micro_market', 160], ['company_name', 120], ['poc_name', 120], ['poc_phone', 40], ['budget', 120]] as const)('accepts an overlong grounded optional %s and omits it instead of truncating', (field, max) => {
    const value = 'Warehouse '.repeat(max / 10 + 1).trim(), raw_text = `Save this brief.\n${field}: ${value}`;
    expect(value.length).toBeGreaterThan(max);
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text, [field]: value });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toEqual({ name: 'New RFQ', description: raw_text, stage: 'RFQ_RECEIVED',
      ownerId: creator.id, createdBy: { source: 'MANUAL', workspaceMemberId: creator.id, name: creator.name } });
  });
  it.each([[120, true], [121, false]] as const)('maps a grounded %i-character budget only within its previous limit', (length, kept) => {
    const budget = 'Rs 20/sqft/month '.padEnd(length, 'x');
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text: `Budget: ${budget}`, budget });
    if (kept) expect(rfqPayload(input, creator).budget).toBe(budget);
    else expect(rfqPayload(input, creator)).not.toHaveProperty('budget');
  });
  it('normalizes classification quotes and withholds only a classification whose quote is overlong', () => {
    const referral = 'Broker referral '.repeat(11).trim(), raw_text = `Repeat client.\nLong\tterm lease. ${referral}`;
    expect(referral.length).toBeGreaterThan(160);
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text, lead_source: { value: 'BROKER', quote: referral },
      lease_duration: { value: 'LONG_TERM', quote: 'Long\u0000term lease' }, repeat_client: { value: true, quote: '\u0007' } });
    const payload = rfqPayload(input, creator);
    expect(payload).toMatchObject({ duration: 'LONG_TERM', repeatClient: ['OPTION1'], description: raw_text });
    expect(payload).not.toHaveProperty('leadSource');
  });
  it.each(['raw_text', 'operation_id'] as const)('does not allow blank or null required %s', field => {
    for (const value of ['', null]) expect(rfqInputSchema.safeParse({ ...rfq, [field]: value }).success).toBe(false);
  });
  it('populates grounded text despite whitespace differences and omits unsupported extractions', () => {
    const raw_text = 'Acme\tLogistics needs 5,000\u00a0sqft in North\nHoskote, Bengaluru. Contact: Anand   Rao.\nBudget: Rs 20 / sqft\nper month. Repeat\nclient. Broker\treferral. Long\nterm.';
    const input = rfqInputSchema.parse({ ...rfq, raw_text, company_name: 'Acme Logistics', location: 'North Hoskote',
      city: 'Bengaluru', micro_market: 'North Hoskote', requirement: '5,000 sqft', poc_name: 'Anand Rao', budget: 'Rs 20 / sqft per month',
      repeat_client: { value: true, quote: 'Repeat client' }, lead_source: { value: 'BROKER', quote: 'Broker referral' },
      lease_duration: { value: 'LONG_TERM', quote: 'Long term' } });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator).description).toBe(raw_text);
    for (const [changes, native] of [[{ requirement: '6,000 sqft' }, 'requirementInSft'], [{ requirement: '5,000 sqm' }, 'requirementInSft'], [{ city: 'Bangalore' }, 'city'],
      [{ company_name: 'Acme-Logistics' }, 'companyName'], [{ budget: 'Rs 20 / sqft per year' }, 'budget'], [{ poc_name: 'Anand Kumar' }, 'pocName']] as const) {
      expect(rfqProblems({ ...input, ...changes })).toEqual([]);
      expect(rfqPayload({ ...input, ...changes }, creator)).not.toHaveProperty(native);
    }
  });
  it.each(['minimum 5000 sqft', 'max. 5000 sqft', 'no less than 5000 sqft', 'not more than 5000 sqft',
    'upto 5000 sqft', 'more than 5000 sqft', 'less than 5000 sqft', '5000+ sqft', '5k+ sqft',
    'between 3,000 and 5,000 sft', 'between 20 and 30k sqft', 'between 500 sqm and 1000 sq m'])('preserves the qualified requirement %s without inventing an exact area', requirement => {
    const input = rfqInputSchema.parse({ operation_id: rfq.operation_id, raw_text: `Need ${requirement} in Hoskote`, location: 'Hoskote', requirement });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator).name).toContain(requirement);
    expect(rfqPayload(input, creator)).not.toHaveProperty('requirementInSft');
  });
  it.each(['between 5000 and 3000 sqft', 'between 5000 sqft and 6000 sqm', 'between 5000 and 6000 and 7000 sqft',
    'between at least 3000 and 5000 sqft', 'up to 5000+ sqft', '5000-6000+ sqft', '5000++ sqft',
    '5000+ sqft; owner=someone', 'minimum sqft', 'max 0 sqft', 'between 3 and 5 trucks'])('keeps unsupported capacity %s in text without fabricating a numeric area', requirement => {
    const input = { operation_id: rfq.operation_id, raw_text: `${requirement} Hoskote`, location: 'Hoskote', requirement };
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).not.toHaveProperty('requirementInSft');
    expect(rfqPayload(input, creator).description).toBe(input.raw_text);
  });
  it.each(['98765 43210', '+91 (98765) 43210', '91 98765-43210', '0091 98765 43210', '98765.43210'])('accepts an unambiguous Indian mobile format %s', poc_phone => {
    const input = rfqInputSchema.parse({ ...rfq, raw_text: `${rfq.raw_text}\nContact: ${poc_phone}`, poc_phone });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ pocPhoneNumber: { primaryPhoneNumber: '9876543210', primaryPhoneCallingCode: '+91' } });
  });
  it.each(['+1 9876543210', '0097 9876543210', '09876543210', '9876543210 ext 12', '9876543210/9988776655',
    '[phone omitted]', '++91 9876543210', '12345', '1234567890'])('does not guess a contact number from %s', phone => {
    expect(indianPhone(phone)).toBeNull();
  });
  it('keeps edit clearing explicit and rejects empty updates', () => {
    expect(rfqChangesSchema.safeParse({ budget: '' }).success).toBe(false);
    expect(rfqChangesSchema.safeParse({ company_name: '   ' }).success).toBe(false);
    expect(rfqChangesSchema.parse({ budget: null, repeat_client: false })).toEqual({ budget: null, repeat_client: false });
  });
});
