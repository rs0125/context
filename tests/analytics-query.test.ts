import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsPagination, resolveAnalyticsDates, validateGa4Query, validateSearchConsoleQuery, validateSearchConsolePageScope } from '../src/lib/analytics-query';
import { safeAnalyticsLabel } from '../src/lib/analytics';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-26T02:00:00Z')); });
afterEach(() => vi.useRealTimers());
describe('analytics query calendar and schema', () => {
  it('uses completed periods and source timezone rather than the host date', () => {
    const query = validateGa4Query(new URLSearchParams());
    expect(resolveAnalyticsDates(query, 'Asia/Kolkata')).toMatchObject({ date_from: '2026-08-29', date_to: '2026-09-25', local_date: '2026-09-26' });
    expect(resolveAnalyticsDates(query, 'America/Los_Angeles')).toMatchObject({ date_from: '2026-08-28', date_to: '2026-09-24', local_date: '2026-09-25' });
  });
  it.each([
    ['today', '2026-09-26', '2026-09-26'], ['yesterday', '2026-09-25', '2026-09-25'],
    ['last_7_days', '2026-09-19', '2026-09-25'], ['this_month', '2026-09-01', '2026-09-26'],
    ['last_month', '2026-08-01', '2026-08-31'],
  ])('resolves %s calendar dates', (period, from, to) => {
    expect(resolveAnalyticsDates(validateGa4Query(new URLSearchParams({ period })), 'Asia/Kolkata')).toMatchObject({ date_from: from, date_to: to });
  });
  it('uses calendar arithmetic across leap days and DST', () => {
    const q = validateGa4Query(new URLSearchParams('period=last_month'));
    expect(resolveAnalyticsDates(q, 'America/Los_Angeles', new Date('2024-03-15T12:00:00Z'))).toMatchObject({ date_from: '2024-02-01', date_to: '2024-02-29' });
    expect(resolveAnalyticsDates(validateGa4Query(new URLSearchParams('period=last_7_days')), 'America/Los_Angeles', new Date('2026-03-10T12:00:00Z')))
      .toMatchObject({ date_from: '2026-03-03', date_to: '2026-03-09' });
  });
  it.each(['report=unknown', 'report=devices&report=events', 'dimension=userId', 'limit=0', 'limit=26', 'limit=1e1', 'limit=01',
    'period=next_month', 'date_from=2026-09-01', 'date_to=2026-09-02', 'date_from=2026-02-30&date_to=2026-03-01',
    'date_from=2026-09-10&date_to=2026-09-01', 'date_from=2026-01-01&date_to=2026-09-01',
    'date_from=2026-09-01&date_to=2026-09-02&period=today', 'date_from=2027-01-01&date_to=2027-01-02',
    'report=overview&event_name=generate_lead', 'report=events&event_name=hello%40test.com', 'report=events&event_name=event9876543210',
    'report=events&event_name=bad%20name', 'cursor=', 'report=overview&cursor=abcd',
  ])('refuses unsafe or ambiguous query %s', input => {
    expect(() => validateGa4Query(new URLSearchParams(input))).toThrowError();
  });
  it('accepts an exact success event for a warehouse or events report', () => {
    expect(validateGa4Query(new URLSearchParams('report=events&event_name=generate_lead')).event_name).toBe('generate_lead');
    expect(validateGa4Query(new URLSearchParams({ report: 'warehouse_interest', event_name: 'a'.repeat(80) })).event_name).toHaveLength(80);
  });
  it('accepts bounded GA4 segments, source domains and aggregate comparisons', () => {
    expect(validateGa4Query(new URLSearchParams({ landing_page_contains: '/warehouses/', device: 'mobile', country: 'India',
      channel: 'Organic Search', source: 'google.com', compare_to: 'previous_period' })))
      .toMatchObject({ landing_page_contains: '/warehouses/', device: 'mobile', country: 'India', channel: 'Organic Search', source: 'google.com', compare_to: 'previous_period' });
    expect(validateGa4Query(new URLSearchParams('report=pages')).report).toBe('pages');
  });
  it.each(['device=DESKTOP', 'device=smart%20tv', 'country=private%40example.com', 'channel=9876543210', 'source=https://google.com',
    'source=private%40example.com', 'source=987.654.3210.example', 'landing_page_contains=/foo%3Ftoken=secret',
    'report=pages&compare_to=previous_period', 'compare_to=last_year', 'group=query&compare_to=previous_period',
    'query_contains=warehouse&query_equals=warehouse', 'page_contains=/foo&page_equals=https://wareongo.com/foo',
  ])('rejects unsafe segments or ambiguous comparisons %s', input => {
    const validate = /^(?:group|query_|page_)/.test(input) ? validateSearchConsoleQuery : validateGa4Query;
    expect(() => validate(new URLSearchParams(input))).toThrowError();
  });
  it.each(['group=person', 'group=summary&cursor=abcd', 'data_state=draft', 'period=today',
    'query_contains=private%40example.com', 'query_contains=9876543210', 'page_contains=https%3A%2F%2Fwareongo.com',
    'query_contains=%2539%2538%2537%2536%2535%2534%2533%2532%2531%2530',
    'page_contains=%2Ffoo%3Ftoken%3Dvalue', `query_contains=${'x'.repeat(121)}`,
  ])('rejects unsupported Search Console query %s', input => {
    expect(() => validateSearchConsoleQuery(new URLSearchParams(input))).toThrowError();
  });
  it('allows literal, non-regex search text and a public path fragment', () => {
    expect(validateSearchConsoleQuery(new URLSearchParams('group=query&query_contains=warehouse.*&page_contains=/listings/&period=today&data_state=all')))
      .toMatchObject({ query_contains: 'warehouse.*', page_contains: '/listings/', data_state: 'all' });
  });
  it('normalizes scoped Search Console exact page and country filters', () => {
    const query = validateSearchConsoleQuery(new URLSearchParams({ group: 'query_page', query_equals: 'warehouse bangalore',
      query_not_contains: 'wareongo', page_equals: 'https://WWW.wareongo.com/listings/', country: 'IND', device: 'mobile' }));
    expect(query).toMatchObject({ query_equals: 'warehouse bangalore', query_not_contains: 'wareongo', page_equals: 'https://www.wareongo.com/listings/', country: 'ind', device: 'mobile' });
    expect(() => validateSearchConsolePageScope(query.page_equals, 'sc-domain:wareongo.com')).not.toThrow();
    expect(() => validateSearchConsolePageScope('http://wareongo.com/listings/', 'sc-domain:wareongo.com')).not.toThrow();
    expect(() => validateSearchConsolePageScope('https://wareongo.com/listings/', 'https://wareongo.com/')).not.toThrow();
  });
  it.each(['https://evilwareongo.com/foo', 'https://wareongo.com.evil.test/foo'])('rejects unrelated hosts from a domain property: %s', page => {
    expect(() => validateSearchConsolePageScope(page, 'sc-domain:wareongo.com')).toThrow('configured Search Console property');
  });
  it.each(['http://wareongo.com/foo', 'https://www.wareongo.com/foo'])('enforces the URL-prefix property origin: %s', page => {
    expect(() => validateSearchConsolePageScope(page, 'https://wareongo.com/')).toThrow('configured Search Console property');
  });
  it.each(['country=IN', 'country=India', 'query_not_contains=private%40example.com', 'query_equals=9876543210',
    'page_equals=javascript:alert(1)', 'page_equals=/foo', 'page_equals=https://name:secret@wareongo.com/foo',
    'page_equals=https://wareongo.com/foo?token=secret', 'page_equals=https://wareongo.com/foo#secret',
    'page_equals=https://wareongo.com/private%2540example.com', 'page_equals=https://wareongo.com/foo%253Fsecret=value',
    'page_equals=https://wareongo.com/foo%0Abar',
  ])('rejects unsafe exact Search Console filters %s', input => {
    expect(() => validateSearchConsoleQuery(new URLSearchParams(input))).toThrowError();
  });
  it('rejects a date later than the source local day', () => {
    const q = validateGa4Query(new URLSearchParams('date_from=2026-09-26&date_to=2026-09-26'));
    expect(() => resolveAnalyticsDates(q, 'America/Los_Angeles')).toThrow('Future dates');
  });
  it('binds cursors to source, report, filters and resolved dates, with bounded offsets', () => {
    const q = validateGa4Query(new URLSearchParams('report=events&period=last_7_days'));
    const dates = resolveAnalyticsDates(q, 'Asia/Kolkata');
    const first = analyticsPagination(q, dates, 'property-a');
    const cursor = first.cursorFor(10);
    expect(analyticsPagination({ ...q, cursor, limit: 25 }, dates, 'property-a').offset).toBe(10);
    expect(() => analyticsPagination({ ...q, cursor }, dates, 'property-b')).toThrow('Cursor');
    expect(() => analyticsPagination({ ...q, cursor, event_name: 'generate_lead' }, dates, 'property-a')).toThrow('Cursor');
    expect(() => analyticsPagination({ ...q, cursor }, { ...dates, date_to: '2026-09-24' }, 'property-a')).toThrow('Cursor');
    expect(() => analyticsPagination({ ...q, cursor: first.cursorFor(500) }, dates, 'property-a')).toThrow('Cursor');
    expect(analyticsPagination({ ...q, cursor: first.cursorFor(499), limit: 25 }, dates, 'property-a').limit).toBe(1);
  });
  it('binds every added segment to its report cursor', () => {
    const ga = validateGa4Query(new URLSearchParams('report=pages'));
    const dates = resolveAnalyticsDates(ga, 'Asia/Kolkata');
    const cursor = analyticsPagination(ga, dates, 'ga').cursorFor(10);
    for (const field of ['device', 'country', 'channel', 'source', 'landing_page_contains']) {
      expect(() => analyticsPagination({ ...ga, cursor, [field]: 'different' }, dates, 'ga')).toThrow('Cursor');
    }
    const sc = validateSearchConsoleQuery(new URLSearchParams('group=query_page'));
    const scCursor = analyticsPagination(sc, dates, 'sc').cursorFor(10);
    for (const field of ['device', 'country', 'query_equals', 'query_not_contains', 'page_equals']) {
      expect(() => analyticsPagination({ ...sc, cursor: scCursor, [field]: 'different' }, dates, 'sc')).toThrow('Cursor');
    }
  });
});

describe('analytics output privacy', () => {
  it.each(['Call +91 98765 43210', 'private@example.com', 'private%2540example.com', '９８７６５４３２１０', 'phone 98765\u200b43210',
    'nine eight seven six five four three two one zero', 'private&#64;example.com',
  ])('redacts contact-like labels %s', input => {
    const out = safeAnalyticsLabel(input);
    expect(out.redacted).toBe(true);
    expect(out.value).not.toMatch(/98765|example\.com|９８７６５/);
  });
  it('retains a useful normal attribution domain', () => {
    expect(safeAnalyticsLabel('google.com / referral', 'sessionSourceMedium')).toEqual({ value: 'google.com / referral', redacted: false });
    expect(safeAnalyticsLabel('Google Search / organic', 'sessionSourceMedium').value).toBe('Google Search / organic');
    expect(safeAnalyticsLabel('987.654.3210.example / referral', 'sessionSourceMedium').value).not.toContain('987.654.3210');
  });
  it('removes URL credentials, queries/fragments and encoded path contacts', () => {
    const out = safeAnalyticsLabel('https://username:password@wareongo.com/contact/private%2540example.com?email=secret#phone', 'page');
    expect(out.value).toBe('https://wareongo.com/contact/[email omitted]');
    expect(out.redacted).toBe(true);
    expect(safeAnalyticsLabel('/warehouse/42?secret=123#x', 'landingPage').value).toBe('/warehouse/42');
    expect(safeAnalyticsLabel('/warehouse/42?secret=123#x', 'pagePath').value).toBe('/warehouse/42');
    expect(safeAnalyticsLabel('/warehouse/42%2525253Fsecret=hidden', 'landingPage').value).not.toContain('hidden');
  });
  it('handles dates separately from phone-like numeric values', () => {
    expect(safeAnalyticsLabel('20260925', 'date')).toEqual({ value: '2026-09-25', redacted: false });
    expect(safeAnalyticsLabel('20260230', 'date')).toEqual({ value: null, redacted: true });
  });
  it('withholds non-web URL schemes', () => {
    expect(safeAnalyticsLabel('javascript:alert(1)', 'page').value).toBe('[URL omitted]');
  });
});
