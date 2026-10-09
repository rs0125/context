/** Challenge model-extracted arguments rather than trusting a well-behaved extractor. */
import { describe, expect, it } from 'vitest';
import { rfqInputSchema, rfqPayload, rfqProblems } from '../src/lib/crm-writes/rfq';
import { capacityValid } from '../src/lib/crm-writes/capacity';

const operation_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const creator = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Fixture Employee' };
const intake = (source: string, requirement: string, extras: object = {}) => rfqInputSchema.parse({
  operation_id, raw_text: `${source} in Hoskote`, location: 'Hoskote', requirement, ...extras,
});

describe('adversarial RFQ extraction', () => {
  it.each([
    ['25,000 sqft', '5,000 sqft'],
    ['25000 sqft', '5000 sqft'],
    ['5000 sqft minimum', '5000 sqft'],
    ['minimum 5000 sqft', '5000 sqft'],
    ['about 5000 sqft', '5000 sqft'],
    ['3000-5000 sqft', '5000 sqft'],
    ['between 3000 and 5000 sqft', '5000 sqft'],
    ['5000 sqft - 6000 sqft', '5000 sqft'],
    ['5000 sqft+', '5000 sqft'],
    ['5000 sqft or more', '5000 sqft'],
    ['5000 sqft or less', '5000 sqft'],
    ['5000 sqft at least', '5000 sqft'],
    ['5000 sqft at most', '5000 sqft'],
    ['-5000 sqft', '5000 sqft'],
  ])('captures %s without populating the clipped exact area %s', (source, requirement) => {
    const input = intake(source, requirement);
    expect(rfqProblems(input)).toEqual([]);
    const payload = rfqPayload(input, creator);
    expect(payload).not.toHaveProperty('requirementInSft');
    expect(payload.name).not.toContain(requirement);
    expect(payload.description).toBe(input.raw_text);
  });

  it.each(['5000 sqft minimum', '5000 sqft min.', '5000 sqft maximum', '5000 sqft max',
    '5000 sqft approx.', '5000 sqft+', '100 pallets+', '5000+ ft²',
    '5000 sqft or more', '5000 sqft or less', '5000 sqft at least', '5000 sqft at most'])('accepts ordinary complete wording: %s', requirement => {
    const input = intake(requirement, requirement);
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).not.toHaveProperty('requirementInSft');
    expect(rfqPayload(input, creator).description).toBe(input.raw_text);
  });

  it.each(['at least 3000-5000 sqft', 'max 3000-5000 sqft', 'between 3000 to 4000 and 5000 sqft',
    '5000.000000000000001-5000 sqft', '1000000000.0000000001 sqft'])('does not accept conflicting or out-of-bounds quantity expressions: %s', requirement => {
    expect(capacityValid(requirement)).toBe(false);
  });

  it('does not turn a partial company word into source provenance', () => {
    const input = intake('Need 5000 sqft for MegaAcme', '5000 sqft', { company_name: 'Acme' });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).not.toHaveProperty('companyName');
    expect(rfqPayload(input, creator).description).toBe(input.raw_text);
  });

  it.each(['+1 9876543210', '+44 9876543210', '0097 9876543210',
    '+44 (0) 9876543210', '0044 (0) 9876543210', '+4 4 9876543210'])('does not drop the explicit country prefix from %s', phone => {
    const input = intake(`Need 5000 sqft. Contact ${phone}`, '5000 sqft', { poc_phone: '9876543210' });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).not.toHaveProperty('pocPhoneNumber');
    expect(rfqPayload(input, creator).description).toBe(input.raw_text);
  });

  it('can use an explicitly corrected full value without inheriting earlier qualifiers', () => {
    const raw_text = 'Need at least 5000 sqft in Hoskote.\n\nActually make that exactly 5000 sqft.';
    const input = rfqInputSchema.parse({ operation_id, raw_text, location: 'Hoskote', requirement: '5000 sqft' });
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator).requirementInSft).toBe(5000);
  });

  it.each(['Need 5000 sqft - 2 truck parking spaces', 'Need 5000 sqft + parking for 2 trucks',
    'Need 5000 sqft+parking for 2 trucks', 'Need 5000 sqft+ parking for 2 trucks',
    'Area-5000 sqft, parking for 2 trucks',
    'Need 5000 sqft, minimum 20 ft clear height', 'Need 5000 sqft minimum 20 ft clear height'])('keeps separate human constraints without treating them as area bounds: %s', source => {
    const input = intake(source, '5000 sqft');
    expect(rfqProblems(input)).toEqual([]);
    expect(rfqPayload(input, creator)).toMatchObject({ description: input.raw_text, requirementInSft: 5000 });
  });
});
