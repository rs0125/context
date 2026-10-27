/** Fixed Google Ads reads. Employee authorization is rechecked by the shared
 * analytics API boundary before and after every source/cache read. */
import { z } from 'zod';
import { GOOGLE_ADS_DETAILS as DETAIL, ASSET_FIELDS, SHARED_KEYWORD_FIELDS, GOOGLE_ADS_DETAIL_LIST_LIMITS, type DetailField } from './google-ads-sections';
import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import { safeAnalyticsLabel } from './analytics-label';
import { analyticsCredentials, analyticsSourceError, googleAdsCustomerId, googleAnalyticsRead, withAnalyticsDeadline } from './analytics-google';
import { ANALYTICS_MAX_ROWS, analyticsCalendar, analyticsLocalDate, analyticsPagination, invalidAnalyticsQuery, resolveAnalyticsDates } from './analytics-query';
import { buildAnalyticsComparison, previousAnalyticsDates } from './analytics-comparison';
import { adsField, GOOGLE_ADS_BASE_METRICS, GOOGLE_ADS_DEVICES, GOOGLE_ADS_METRICS, GOOGLE_ADS_NETWORKS, GOOGLE_ADS_PRESETS, GOOGLE_ADS_RATES, GOOGLE_ADS_REPORTS, GOOGLE_ADS_SECTIONS, GOOGLE_ADS_SECTION_FILTERS, GOOGLE_ADS_ACCOUNT_SECTIONS, type AdsDimension, type AdsReport } from './google-ads-catalog';
import { adsContains, adsId, adsString, validateGoogleAdsCampaign, validateGoogleAdsFilters, validateGoogleAdsReport, type GoogleAdsReportQuery } from './google-ads-query';

type Row = Record<string, unknown>;
const RESPONSE = z.object({ results: z.array(z.record(z.string(), z.unknown())).max(501).optional().default([]), fieldMask: z.string().max(10000), nextPageToken: z.string().optional() });
const camel = (field: string) => field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
async function readAds<T>(fields: readonly string[], resource: string, clauses: string[], order: string[], limit: number, project: (rows: Row[]) => T, signal: AbortSignal) {
  const customer = googleAdsCustomerId();
  const query = `SELECT ${fields.join(', ')} FROM ${resource}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}${order.length ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT ${limit}`;
  return googleAnalyticsRead({ kind: 'google_ads', customer }, { query }, raw => {
    const checked = RESPONSE.safeParse(raw);
    if (!checked.success || checked.data.results.length > limit || checked.data.nextPageToken) analyticsSourceError();
    const selected = new Set(checked.data.fieldMask.split(','));
    if (fields.some(field => !selected.has(camel(field)))) analyticsSourceError();
    return project(checked.data.results);
  }, signal);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !adsId.safeParse(value).success) analyticsSourceError();
  return value;
}
function label(value: unknown, field = '') {
  return value === undefined || value === null ? { value: null, redacted: false }
    : typeof value === 'string' && value.length <= 4096 ? safeAnalyticsLabel(value, field)
      : typeof value === 'number' && Number.isFinite(value) ? safeAnalyticsLabel(String(value))
        : typeof value === 'boolean' ? { value: String(value), redacted: false } : { value: null, redacted: true };
}
function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
async function account(signal: AbortSignal) {
  const customer = googleAdsCustomerId();
  const result = await readAds(['customer.id', 'customer.descriptive_name', 'customer.currency_code', 'customer.time_zone', 'customer.manager', 'customer.test_account'],
    'customer', [], [], 1, rows => {
      const row = rows[0]?.customer as Row | undefined;
      if (rows.length !== 1 || !row || id(row.id) !== customer || typeof row.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(row.currencyCode)
        || typeof row.timeZone !== 'string' || row.manager !== false || row.testAccount !== false) analyticsSourceError();
      analyticsLocalDate(row.timeZone);
      return { id: customer, name: label(row.descriptiveName).value, currency: row.currencyCode, timezone: row.timeZone };
    }, signal);
  return { ...result.data, source_fetched_at: result.source_fetched_at };
}
type Account = Awaited<ReturnType<typeof account>>;
function source(config: Account) { return { system: 'google_ads' as const, property: config.id, account_name: config.name, currency: config.currency, timezone: config.timezone }; }
function cache(result: { cache_hit: boolean; source_fetched_at: string }) {
  return { hit: result.cache_hit, max_age_seconds: 300 as const, age_seconds: Math.max(0, Math.floor((Date.now() - Date.parse(result.source_fetched_at)) / 1000)) };
}
function pageInfo(page: ReturnType<typeof analyticsPagination>, total: number, count: number) {
  const next = page.offset + count;
  const more = next < total;
  const cap = more && next >= ANALYTICS_MAX_ROWS;
  const cursor = more && !cap && count > 0 ? page.cursorFor(next) : null;
  return { nextCursor: cursor, pagination: { limit: page.limit, returned_count: count, has_more: cursor !== null, next_cursor: cursor,
    offset: page.offset, source_row_count: total <= ANALYTICS_MAX_ROWS ? total : null, cap_reached: cap, max_rows: ANALYTICS_MAX_ROWS, snapshot: false as const } };
}

export async function googleAdsCapabilities(signal?: AbortSignal) {
  let config: Account | null = null;
  let error_code: string | null = null;
  try { config = await (signal ? account(signal) : withAnalyticsDeadline(account)); }
  catch (error) { error_code = error instanceof HttpError ? error.code : 'ANALYTICS_SOURCE_UNAVAILABLE'; }
  return { status: config ? 'available' as const : error_code === 'ANALYTICS_CONFIGURATION' ? 'not_configured' as const : 'unavailable' as const,
    account: config ? { id: config.id, name: config.name, currency: config.currency, timezone: config.timezone } : null,
    source_fetched_at: config?.source_fetched_at ?? null, error_code,
    reports: GOOGLE_ADS_REPORTS.map(name => ({ name, available: config !== null, filters: [...GOOGLE_ADS_PRESETS[name].filters],
      dimensions: GOOGLE_ADS_PRESETS[name].dimensions.map(field => field.name), metrics: metricNames(name) })),
    campaign_sections: GOOGLE_ADS_SECTIONS.filter(section => !['asset_inventory', 'audiences'].includes(section)),
    account_sections: [...GOOGLE_ADS_ACCOUNT_SECTIONS],
    campaign_section_filters: GOOGLE_ADS_SECTIONS.map(section => ({ section, filters: [...GOOGLE_ADS_SECTION_FILTERS[section]] })),
    guidance: 'Use google_ads_filters for names and string IDs, google_ads_report for dated performance, and read_google_ads_campaign for current settings or bounded context. Overview is a full aggregate; paged reports are not totals. Names are labels; filter by IDs. Ads conversions, all_conversions and GA4 key events are distinct. Change history covers only the last 30 days and may omit changes. The configured account is fixed by the server.' };
}

export async function googleAdsFilters(params: URLSearchParams) {
  const query = validateGoogleAdsFilters(params);
  return withAnalyticsDeadline(async signal => {
    const config = await account(signal);
    const fingerprint = createHash('sha256').update(JSON.stringify([analyticsCredentials().identity, config.id, query.campaign_id ?? null, query.limit])).digest('hex');
    let after: string[] = [];
    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64url');
        const value = z.object({ v: z.literal(1), f: z.literal(fingerprint), after: z.array(z.union([adsId, z.literal('done')])).length(3) }).strict().parse(JSON.parse(decoded.toString('utf8')));
        if (decoded.toString('base64url') !== query.cursor) throw new Error();
        after = value.after;
      } catch { invalidAnalyticsQuery('Discovery cursor does not match this account, campaign and page size. Keep the same arguments.'); }
    }
    const list = <T>(index: number, fields: string[], resource: string, clauses: string[], project: (rows: Row[]) => T[]) => {
      if (after[index] === 'done') return Promise.resolve({ data: [] as T[], source_fetched_at: config.source_fetched_at, cache_hit: true });
      return readAds(fields, resource, [...clauses, ...(after[index] ? [`${resource}.id > ${after[index]}`] : [])], [`${resource}.id`], query.limit + 1, project, signal);
    };
    const [campaigns, conversions, groups] = await Promise.all([
      list(0, ['campaign.id', 'campaign.name', 'campaign.status'], 'campaign', query.campaign_id ? [`campaign.id = ${query.campaign_id}`] : [],
        rows => rows.map(row => ({ id: id(adsField(row, 'campaign.id')), name: label(adsField(row, 'campaign.name')).value, status: label(adsField(row, 'campaign.status')).value }))),
      list(1, ['conversion_action.id', 'conversion_action.name', 'conversion_action.category', 'conversion_action.primary_for_goal', 'conversion_action.status'], 'conversion_action', [],
        rows => rows.map(row => ({ id: id(adsField(row, 'conversion_action.id')), name: label(adsField(row, 'conversion_action.name')).value,
          category: label(adsField(row, 'conversion_action.category')).value, status: label(adsField(row, 'conversion_action.status')).value,
          primary_for_goal: boolean(adsField(row, 'conversion_action.primary_for_goal')) }))),
      query.campaign_id ? list(2, ['ad_group.id', 'ad_group.name', 'ad_group.status'], 'ad_group', [`campaign.id = ${query.campaign_id}`],
        rows => rows.map(row => ({ id: id(adsField(row, 'ad_group.id')), name: label(adsField(row, 'ad_group.name')).value, status: label(adsField(row, 'ad_group.status')).value }))) : null,
    ]);
    const next = [campaigns, conversions, groups].map(result => result && result.data.length > query.limit ? result.data[query.limit - 1].id : 'done');
    const nextCursor = next.some(value => value !== 'done') ? Buffer.from(JSON.stringify({ v: 1, f: fingerprint, after: next })).toString('base64url') : null;
    return { source: source(config), read_only: true as const, campaign_id: query.campaign_id ?? null,
      campaigns: campaigns.data.slice(0, query.limit), campaigns_truncated: campaigns.data.length > query.limit,
      conversion_actions: conversions.data.slice(0, query.limit), conversion_actions_truncated: conversions.data.length > query.limit,
      ad_groups: groups?.data.slice(0, query.limit) ?? [], ad_groups_truncated: (groups?.data.length ?? 0) > query.limit, ad_groups_loaded: groups !== null,
      nextCursor, pagination: { limit: query.limit, has_more: nextCursor !== null, snapshot: false as const },
      devices: [...GOOGLE_ADS_DEVICES], networks: [...GOOGLE_ADS_NETWORKS], campaign_statuses: ['ENABLED', 'PAUSED', 'REMOVED'],
      source_fetched_at: [campaigns.source_fetched_at, conversions.source_fetched_at, groups?.source_fetched_at].filter((x): x is string => !!x).sort()[0],
      served_at: new Date().toISOString(),
      guidance: 'Copy IDs, not names, into filters. Supply campaign_id to discover its ad groups. Follow nextCursor with the same campaign_id and limit until null; exhausted lists are empty on later pages. Discovery uses ID order without a total row cap, but pages are not a frozen snapshot. Conversion actions are account-wide, not proof that every campaign optimizes for them; null primary_for_goal means unknown. Lists are current configuration, not limited to recent activity. Contact-masked names may collide; distinct IDs remain distinct.' };
  });
}

function metricNames(report: AdsReport) {
  const preset = GOOGLE_ADS_PRESETS[report];
  const names = preset.metrics ?? GOOGLE_ADS_BASE_METRICS;
  return [...names, ...(preset.rates === false ? [] : Object.keys(GOOGLE_ADS_RATES))];
}
function metricColumns(config: Account, report: AdsReport) {
  return metricNames(report).map(name => {
    const definition = { ...GOOGLE_ADS_METRICS, ...GOOGLE_ADS_RATES }[name as keyof typeof GOOGLE_ADS_METRICS | keyof typeof GOOGLE_ADS_RATES]!;
    return { name, kind: 'metric' as const, unit: definition.unit === 'currency' ? config.currency : definition.unit, definition: definition.definition };
  });
}
function dimensionValue(raw: unknown, field: AdsDimension, customer: string) {
  if (raw === undefined || raw === null || raw === '') return { value: null, redacted: false };
  if (field.kind === 'category_id') return { value: raw === '0' ? '0' : id(raw), redacted: false };
  if (field.kind === 'id') return { value: id(raw), redacted: false };
  if (field.kind === 'boolean') {
    if (typeof raw !== 'boolean') analyticsSourceError();
    return { value: String(raw), redacted: false };
  }
  if (field.kind === 'conversion_action') {
    if (typeof raw !== 'string' || !raw.startsWith(`customers/${customer}/conversionActions/`)) analyticsSourceError();
    return { value: id(raw.split('/').at(-1)), redacted: false };
  }
  if (field.kind === 'criterion_ref') {
    if (typeof raw !== 'string' || !new RegExp(`^customers/${customer}/adGroupCriteria/[1-9]\\d*~[1-9]\\d*$`).test(raw)) analyticsSourceError();
    return { value: id(raw.split('~').at(-1)), redacted: false };
  }
  if (field.kind === 'geo') {
    if (raw === '0' || raw === 'geoTargetConstants/0') return { value: null, redacted: false };
    if (typeof raw !== 'string' || !/^(?:geoTargetConstants\/)?[1-9]\d{0,18}$/.test(raw)) analyticsSourceError();
    return { value: id(raw.split('/').at(-1)), redacted: false };
  }
  return label(raw, field.kind === 'url' ? 'page' : field.kind === 'date' ? 'date' : field.name);
}
function number(raw: unknown, name: string): number | null {
  // Ads optional metrics preserve field presence. A selected but absent value
  // is unknown; only an explicit numeric zero establishes zero activity.
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(raw))) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER || (!name.startsWith('conversion_value') && !name.startsWith('all_conversion_value') && n < 0)
    || (['clicks', 'impressions', 'cost'].includes(name) && !Number.isSafeInteger(n))) return null;
  return name === 'cost' ? n / 1_000_000 : n;
}
function reportRows(rows: Row[], dimensions: AdsDimension[], report: AdsReport, customer: string) {
  const preset = GOOGLE_ADS_PRESETS[report];
  const metrics = (preset.metrics ?? GOOGLE_ADS_BASE_METRICS).map(name => [name, GOOGLE_ADS_METRICS[name]] as const);
  return rows.map(row => {
    const item = { dimensions: {} as Record<string, string | null>, metrics: {} as Record<string, number | null>,
      metric_bounds: {} as Record<string, { operator: 'lt' | 'gt'; value: number }>, redacted: false, verification_required: false };
    for (const field of dimensions) {
      const value = dimensionValue(adsField(row, field.field), field, customer);
      item.dimensions[field.name] = value.value; item.redacted ||= value.redacted;
    }
    for (const [name, field] of metrics) {
      let value = number(adsField(row, field.field), field.kind === 'money' ? 'cost' : name);
      if (value !== null && (field.unit === 'fraction' && value > 1 || field.kind === 'score' && (!Number.isInteger(value) || value < 1 || value > 10))) value = null;
      if (field.bound === 'lower' && value === 0.0999 || field.bound === 'upper' && value === 0.9001) {
        item.metric_bounds[name] = { operator: field.bound === 'lower' ? 'lt' : 'gt', value: field.bound === 'lower' ? 0.1 : 0.9 };
        item.metrics[name] = null;
        continue;
      }
      item.metrics[name] = value;
      item.verification_required ||= item.metrics[name] === null;
    }
    if (preset.rates !== false) for (const [name, ratio] of Object.entries(GOOGLE_ADS_RATES)) {
      const top = item.metrics[ratio.numerator]; const bottom = item.metrics[ratio.denominator];
      const value = top !== null && bottom !== null && bottom > 0 ? top / bottom : null;
      item.metrics[name] = value !== null && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
      item.verification_required ||= value !== null && item.metrics[name] === null;
    }
    return item;
  });
}
function conditions(query: GoogleAdsReportQuery, dates: ReturnType<typeof resolveAnalyticsDates>, customer: string) {
  const where = [`segments.date BETWEEN ${adsString(dates.date_from)} AND ${adsString(dates.date_to)}`];
  if (query.campaign_id) where.push(`campaign.id = ${query.campaign_id}`);
  if (query.ad_group_id) where.push(`ad_group.id = ${query.ad_group_id}`);
  if (query.ad_id) where.push(`ad_group_ad.ad.id = ${query.ad_id}`);
  if (query.category_id !== undefined) where.push(`campaign_search_term_insight.id = ${query.category_id}`);
  if (query.asset_id) where.push(`asset.id = ${query.asset_id}`);
  if (query.asset_group_id) where.push(`asset_group.id = ${query.asset_group_id}`);
  if (query.device) where.push(`segments.device = ${adsString(query.device.toUpperCase())}`);
  if (query.network) where.push(`segments.ad_network_type = ${adsString(query.network)}`);
  if (query.campaign_status) where.push(`campaign.status = ${adsString(query.campaign_status)}`);
  if (query.country_id) where.push(`user_location_view.country_criterion_id = ${query.country_id}`);
  if (query.conversion_action_id) where.push(`segments.conversion_action = ${adsString(`customers/${customer}/conversionActions/${query.conversion_action_id}`)}`);
  if (query.keyword_contains) where.push(adsContains('ad_group_criterion.keyword.text', query.keyword_contains));
  if (query.match_type) where.push(`ad_group_criterion.keyword.match_type = ${adsString(query.match_type)}`);
  const searchField = query.report === 'campaign_search_terms' ? 'campaign_search_term_view.search_term' : 'search_term_view.search_term';
  if (query.query_equals) where.push(`${searchField} = ${adsString(query.query_equals)}`);
  if (query.query_contains) where.push(adsContains(searchField, query.query_contains));
  return where;
}
async function readReport(query: GoogleAdsReportQuery, config: Account, dates: ReturnType<typeof resolveAnalyticsDates>, signal: AbortSignal) {
  const preset = GOOGLE_ADS_PRESETS[query.report];
  const page = analyticsPagination(query, dates, `${analyticsCredentials().identity}:google_ads:${config.id}:v1`);
  // GAQL requires filtered non-date segments in SELECT. Each is constrained to
  // one exact value, so selecting it does not split the requested aggregate.
  const fields = [...new Set([...preset.dimensions.map(x => x.field), ...(preset.metrics ?? GOOGLE_ADS_BASE_METRICS).map(name => GOOGLE_ADS_METRICS[name].field),
    ...(query.device ? ['segments.device'] : []), ...(query.network ? ['segments.ad_network_type'] : [])])];
  // An aggregate at customer scope is one provider row. A selected campaign or
  // ad group uses its own resource with one exact ID, never sums a top-N page.
  const resource = preset.resource === 'customer' ? query.ad_group_id ? 'ad_group' : query.campaign_id ? 'campaign' : 'customer' : preset.resource;
  const order = query.report === 'overview' ? [] : query.report === 'daily' ? ['segments.date ASC']
    : [...(preset.chronological ? [] : [`${GOOGLE_ADS_METRICS[preset.rankBy ?? 'cost'].field} DESC`]), ...preset.order.map(field => `${field} ASC`)];
  const result = await readAds(fields, resource, conditions(query, dates, config.id), order, query.report === 'overview' ? 1 : ANALYTICS_MAX_ROWS + 1,
    rows => reportRows(rows, preset.dimensions, query.report, config.id), signal);
  const items = result.data.slice(page.offset, page.offset + page.limit);
  const columns = [...preset.dimensions.map(field => ({ name: field.name, kind: 'dimension' as const,
    unit: ['id', 'geo', 'conversion_action', 'criterion_ref', 'category_id'].includes(field.kind) ? 'identifier' : field.kind === 'date' ? 'date' : 'label',
    ...(field.definition ? { definition: field.definition } : {}) })), ...metricColumns(config, query.report)];
  if (query.report === 'locations') {
    const ids = [...new Set(items.flatMap(item => ['country_id', 'region_id', 'city_id'].map(key => item.dimensions[key]).filter((x): x is string => x !== null)))];
    const names = ids.length ? (await readAds(['geo_target_constant.id', 'geo_target_constant.name'], 'geo_target_constant', [`geo_target_constant.id IN (${ids.join(', ')})`], [], ids.length,
      rows => Object.fromEntries(rows.map(row => [id(adsField(row, 'geo_target_constant.id')), label(adsField(row, 'geo_target_constant.name'))])), signal)).data : {};
    for (const name of ['country', 'region', 'city']) {
      columns.push({ name, kind: 'dimension', unit: 'label' });
      for (const item of items) {
        const value = names[item.dimensions[`${name}_id`] ?? ''];
        item.dimensions[name] = value?.value ?? null; item.redacted ||= value?.redacted ?? false;
      }
    }
  }
  const paging = pageInfo(page, result.data.length, items.length);
  const warnings = ['Google Ads conversions and all_conversions are attributed actions, not unique CRM leads. Conversion value is not verified closed revenue.',
    `Conversions can arrive late or be revised even for older periods; provisional=false is a recency flag, not a finality guarantee. Report dates use ${preset.dateBasis === 'conversion' ? 'conversion occurrence' : 'ad interaction'} and the account timezone; source_fetched_at and served_at use UTC (Z). GA4 key events have a different definition.`,
    'Use overview with the same supported filters for a full aggregate. Do not average row rates or treat a page as a total.'];
  if (query.report === 'search_terms') warnings.push('Google omits some low-volume search terms. This ad-group search-term view does not include Performance Max search terms.');
  if (query.report === 'keywords') warnings.push('current_quality_score describes current keyword configuration at retrieval, not a historical quality score for the requested dates.');
  if (query.report === 'locations') warnings.push('Google Ads inferred user geography is a coarse reporting classification, not a warehouse location or exact visitor address.');
  warnings.push(...(preset.warnings ?? []));
  if (paging.pagination.cap_reached) warnings.push('The 500-row limit was reached. Narrow the dates or filters.');
  if (items.some(item => item.redacted)) warnings.push('Source labels or URL details were masked; distinct rows can have identical displayed labels.');
  if (items.some(item => item.verification_required)) warnings.push('Missing or invalid source metrics remain null, not zero; dependent rates are unavailable.');
  const quality = { provisional: dates.includes_recent_days, warnings, data_truncated: result.data.length > ANALYTICS_MAX_ROWS,
    privacy_redactions: items.some(item => item.redacted), totals_included: query.report === 'overview',
    aggregation_type: preset.dateBasis === 'conversion' ? 'google_ads_conversion_date' as const : 'google_ads_interaction_date' as const,
    empty_reason: items.length ? null : 'No report rows returned; missing rows do not establish zero underlying activity.' };
  const { cursor: _cursor, limit: _limit, ...context } = query;
  return { source: source(config), source_status: { status: 'available' as const, read_only: true as const }, report: query.report,
    query_context: { ...context, ...dates }, columns, items, ...paging,
    source_fetched_at: result.source_fetched_at, served_at: new Date().toISOString(), cache: cache(result), quality,
    interpretation: { aggregation: 'aggregate', conversion_basis: 'google_ads_campaign_goals', date_basis: preset.dateBasis === 'conversion' ? 'conversion' : 'ad_interaction',
      event_counts_are_unique_leads: false, crm_linkage_available: false, guidance: 'Conversions, all_conversions, conversion value and GA4 key events must remain distinct. Null rates have a zero or unavailable denominator. Recommendations and inferred causes require separate review.' } };
}
export async function googleAdsReport(params: URLSearchParams) {
  const query = validateGoogleAdsReport(params);
  return withAnalyticsDeadline(async signal => {
    const config = await account(signal);
    const dates = resolveAnalyticsDates(query, config.timezone);
    const current = await readReport(query, config, dates, signal);
    if (!query.compare_to) return { ...current, comparison: null };
    const previous = previousAnalyticsDates(dates);
    const baseline = await readReport({ ...query, compare_to: null, period: null, date_from: previous.date_from, date_to: previous.date_to }, config, previous, signal);
    return { ...current, comparison: buildAnalyticsComparison(current, baseline) };
  });
}

function changeTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(value)) analyticsSourceError();
  try { analyticsCalendar(value.slice(0, 10)); } catch { analyticsSourceError(); }
  return value;
}
function fieldMask(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const paths = typeof value === 'string' ? value.split(',') : typeof value === 'object' ? (value as Row).paths : null;
  if (!Array.isArray(paths) || paths.length > 256 || paths.some(path => typeof path !== 'string'
    || path.length > 256 || !/^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(path))) analyticsSourceError();
  return paths.join(',');
}
function resource(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512 || !/^customers\/[1-9]\d*\/[A-Za-z][A-Za-z0-9]*\/[A-Za-z0-9_~+=.-]+$/.test(value)) analyticsSourceError();
  return value;
}
function assetImageUrl(value: unknown) {
  // This provider-generated CDN path is an image identifier, not a phone number.
  // Other URL shapes retain the normal contact/credential/query sanitization.
  if (typeof value === 'string' && value.length <= 512 && /^https:\/\/tpc\.googlesyndication\.com\/simgad\/[0-9]+(?:[?#].*)?$/.test(value)) {
    const url = value.split(/[?#]/, 1)[0];
    return { value: url, redacted: url !== value };
  }
  return label(value, 'page');
}
type Price = { header: string | null; description: string | null; amount: number | null; currency: string | null; unit: string | null; final_url: string | null };
type DetailValue = string | number | boolean | string[] | Price[] | null;
function detailRows(rows: Row[], fields: DetailField[]) {
  return rows.map(row => {
    const values: Record<string, DetailValue> = {};
    let redacted = false;
    let verification_required = false;
    const truncated_fields: string[] = [];
    for (const field of fields) {
      const raw = adsField(row, field.field);
      if (field.kind === 'id') values[field.name] = raw === undefined || raw === null ? null : id(raw);
      else if (field.kind === 'resource' || field.kind === 'resource_id') {
        const ref = resource(raw);
        values[field.name] = ref === null ? null : field.kind === 'resource_id' ? id(ref.split('/').at(-1)) : ref;
      }
      else if (field.kind === 'timestamp') values[field.name] = changeTimestamp(raw);
      else if (field.kind === 'field_mask') values[field.name] = fieldMask(raw);
      else if (field.kind === 'constant') {
        if (raw !== undefined && (typeof raw !== 'string' || !/^(?:geoTargetConstants|languageConstants)\/[1-9]\d{0,18}$/.test(raw))) analyticsSourceError();
        values[field.name] = raw === undefined ? null : id((raw as string).split('/').at(-1));
      }
      else if (field.kind === 'money') values[field.name] = number(raw, 'cost');
      else if (field.kind === 'number') values[field.name] = number(raw, field.name);
      else if (field.kind === 'image_url') {
        const safe = assetImageUrl(raw); values[field.name] = safe.value; redacted ||= safe.redacted;
      }
      else if (field.kind === 'boolean' || field.kind === 'proto_boolean') {
        values[field.name] = field.kind === 'proto_boolean' && raw === undefined ? false : boolean(raw);
        verification_required ||= values[field.name] === null;
      }
      else if (field.kind === 'prices') {
        if (raw !== undefined && !Array.isArray(raw)) analyticsSourceError();
        const all = (raw ?? []) as Row[];
        if (all.length > GOOGLE_ADS_DETAIL_LIST_LIMITS.prices) truncated_fields.push(field.name);
        values[field.name] = all.slice(0, GOOGLE_ADS_DETAIL_LIST_LIMITS.prices).map(offer => {
          if (!offer || typeof offer !== 'object' || Array.isArray(offer)) analyticsSourceError();
          const safe = (value: unknown, kind = '') => { const result = label(value, kind); redacted ||= result.redacted; return result.value; };
          const currency = adsField(offer, 'price.currency_code');
          if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) analyticsSourceError();
          return { header: safe(offer.header), description: safe(offer.description), amount: number(adsField(offer, 'price.amount_micros'), 'cost'),
            currency: typeof currency === 'string' ? currency : null, unit: safe(offer.unit), final_url: safe(offer.finalUrl, 'page') };
        });
      }
      else if (['texts', 'strings', 'urls', 'resources'].includes(field.kind ?? '')) {
        if (raw !== undefined && !Array.isArray(raw)) analyticsSourceError();
        const all = raw as unknown[] | undefined;
        const limit = GOOGLE_ADS_DETAIL_LIST_LIMITS[field.kind as 'texts' | 'strings' | 'urls' | 'resources'];
        if ((all?.length ?? 0) > limit) truncated_fields.push(field.name);
        values[field.name] = (all ?? []).slice(0, limit).flatMap(item => {
          if (field.kind === 'resources') { const ref = resource(item); return ref === null ? [] : [ref]; }
          const safe = field.kind === 'urls' ? label(item, 'page') : field.kind === 'strings' ? label(item) : label(item && typeof item === 'object' ? (item as Row).text : undefined);
          redacted ||= safe.redacted; return safe.value === null ? [] : [safe.value];
        });
      } else {
        const safe = label(raw, field.kind === 'url' ? 'page' : field.name);
        values[field.name] = safe.value; redacted ||= safe.redacted;
      }
    }
    return { values, redacted, verification_required, truncated_fields };
  });
}
export async function readGoogleAdsCampaign(campaignId: string | null, params: URLSearchParams) {
  const query = validateGoogleAdsCampaign(campaignId, params);
  return withAnalyticsDeadline(async signal => {
    const config = await account(signal);
    const definition = DETAIL[query.section];
    const dates = query.section === 'changes' ? resolveAnalyticsDates(query, config.timezone) : null;
    if (dates && analyticsCalendar(dates.date_from) < analyticsCalendar(dates.local_date) - 29 * 86_400_000) invalidAnalyticsQuery('Change history must start within the last 30 days.');
    const page = analyticsPagination({ ...query, ...(dates ? {} : { period: null, date_from: null, date_to: null }) }, dates,
      `${analyticsCredentials().identity}:google_ads:${config.id}:${query.scope}:${campaignId ?? 'account'}:v3`);
    const exists = campaignId === null ? null : await readAds(['campaign.id', 'campaign.name', 'campaign.status'], 'campaign', [`campaign.id = ${campaignId}`], [], 1,
      rows => rows.map(row => ({ id: id(adsField(row, 'campaign.id')), name: label(adsField(row, 'campaign.name')).value, status: label(adsField(row, 'campaign.status')).value })), signal);
    if (exists && !exists.data.length) throw new HttpError(404, 'NOT_FOUND', 'Campaign is unavailable in the configured Google Ads account.');
    const reference = adsString(`customers/${config.id}/campaigns/${campaignId}`);
    type Part = { name: string; include: boolean; data: ReturnType<typeof detailRows>; source_fetched_at: string; cache_hit: boolean };
    const parts: Part[] = [];
    const unavailable: string[] = [];
    const part = async (name: string, def: typeof definition, where: string[], origin?: string, include = true, limit = ANALYTICS_MAX_ROWS + 1) => {
      const tie = ['recommendation', 'change_event'].includes(def.resource) ? `${def.resource}.resource_name` : null;
      const result = await readAds([...new Set([...def.fields.map(field => field.select ?? field.field), ...(tie ? [tie] : [])])], def.resource, where, def.order, limit, rows => {
        if (tie) rows.sort((a, b) => {
          const primary = def.resource === 'change_event' ? 'change_event.change_date_time' : 'recommendation.type';
          const compared = String(adsField(a, primary)).localeCompare(String(adsField(b, primary)));
          return (def.resource === 'change_event' ? -compared : compared) || String(adsField(a, tie)).localeCompare(String(adsField(b, tie)));
        });
        return detailRows(rows, def.fields);
      }, signal);
      if (origin) for (const item of result.data) item.values.origin = origin;
      const value = { ...result, name, include }; parts.push(value); return value;
    };
    const wanted = query.scope === 'account' ? 'account' : query.origin ?? (query.ad_group_id ? 'ad_group' : undefined);
    const use = (origin: string) => !wanted || wanted === origin;
    const refsInAccount = (items: ReturnType<typeof detailRows>) => items.flatMap(item => {
      const ref = item.values.resource;
      if (typeof ref !== 'string') analyticsSourceError();
      if (!ref.startsWith(`customers/${config.id}/sharedSets/`)) { unavailable.push(ref); return []; }
      return [ref];
    });
    if (query.section === 'negative_keywords' || query.section === 'negative_lists') {
      if (query.section === 'negative_keywords' && !query.shared_set_id) {
        await Promise.all([
          use('campaign') ? part('campaign_keywords', DETAIL.negative_keywords,
            [`campaign.id = ${campaignId}`, "campaign_criterion.type = 'KEYWORD'", 'campaign_criterion.negative = TRUE', "campaign_criterion.status != 'REMOVED'"], 'campaign') : null,
          use('ad_group') ? part('ad_group_keywords', { resource: 'ad_group_criterion', order: ['ad_group.id', 'ad_group_criterion.criterion_id'],
            fields: [{ name: 'ad_group_id', field: 'ad_group.id', kind: 'id' }, ...DETAIL.negative_keywords.fields.map(field => ({ ...field, field: field.field.replace('campaign_criterion.', 'ad_group_criterion.') }))] },
            [`campaign.id = ${campaignId}`, "ad_group_criterion.type = 'KEYWORD'", 'ad_group_criterion.negative = TRUE', "ad_group_criterion.status != 'REMOVED'",
              ...(query.ad_group_id ? [`ad_group.id = ${query.ad_group_id}`] : [])], 'ad_group') : null,
        ]);
      }
      const lists = async (origin: 'shared' | 'account') => {
        let found: Part;
        const filter = query.shared_set_id ? [`shared_set.id = ${query.shared_set_id}`] : [];
        if (origin === 'shared') found = await part('shared_lists', DETAIL.negative_lists,
          [`campaign_shared_set.campaign = ${reference}`, "campaign_shared_set.status = 'ENABLED'", "shared_set.status = 'ENABLED'", "shared_set.type = 'NEGATIVE_KEYWORDS'", ...filter], origin, query.section === 'negative_lists');
        else {
          const links = await part('account_list_links', { resource: 'customer_negative_criterion', order: ['customer_negative_criterion.id'], fields: [
            { name: 'id', field: 'customer_negative_criterion.id', kind: 'id' },
            { name: 'resource', field: 'customer_negative_criterion.negative_keyword_list.shared_set', kind: 'resource' }] },
            ["customer_negative_criterion.type = 'NEGATIVE_KEYWORD_LIST'"], origin, false);
          const refs = refsInAccount(links.data.slice(0, ANALYTICS_MAX_ROWS));
          if (!refs.length) return;
          found = await part('account_lists', { resource: 'shared_set', order: ['shared_set.id'],
            fields: DETAIL.negative_lists.fields.filter(field => field.name !== 'link_status').map(field => field.name === 'resource' ? { ...field, field: 'shared_set.resource_name' } : field) },
            [`shared_set.resource_name IN (${refs.map(adsString).join(', ')})`, "shared_set.status = 'ENABLED'", ...filter], origin, query.section === 'negative_lists');
        }
        const refs = refsInAccount(found.data.slice(0, ANALYTICS_MAX_ROWS));
        if (query.section === 'negative_keywords' && refs.length) await part(`${origin}_keywords`, { resource: 'shared_criterion', order: ['shared_criterion.criterion_id'], fields: SHARED_KEYWORD_FIELDS },
          [`shared_criterion.shared_set IN (${refs.map(adsString).join(', ')})`, "shared_criterion.type = 'KEYWORD'"], origin);
      };
      await Promise.all([use('shared') ? lists('shared') : null, use('account') ? lists('account') : null]);
    } else if (query.section === 'assets') {
      await Promise.all((['campaign', 'ad_group', 'account'] as const).filter(use).map(origin => {
        const resource = origin === 'account' ? 'customer_asset' : `${origin}_asset`;
        return part(`${origin}_assets`, { resource, order: [...(origin === 'ad_group' ? ['ad_group.id'] : []), 'asset.id', `${resource}.field_type`], fields: [
          ...(origin !== 'account' ? [{ name: 'campaign_id', field: 'campaign.id', kind: 'id' as const }] : []),
          ...(origin === 'ad_group' ? [{ name: 'ad_group_id', field: 'ad_group.id', kind: 'id' as const }] : []),
          { name: 'field_type', field: `${resource}.field_type` }, { name: 'status', field: `${resource}.status` }, ...ASSET_FIELDS] },
          [...(origin !== 'account' ? [`campaign.id = ${campaignId}`] : []), `${resource}.status != 'REMOVED'`,
            ...(query.ad_group_id ? [`ad_group.id = ${query.ad_group_id}`] : []), ...(query.asset_id ? [`asset.id = ${query.asset_id}`] : [])], origin);
      }));
    } else if (query.section === 'recommendations') {
      await Promise.all([use('campaign') ? part('campaign_recommendations', definition, [`recommendation.campaign = ${reference}`], 'campaign') : null,
        use('account') ? part('account_recommendations', definition, ['recommendation.campaign IS NULL'], 'account') : null]);
    } else if (query.section === 'conversion_goals') {
      const [, , configuration] = await Promise.all([
        part('campaign_goals', definition, [`campaign_conversion_goal.campaign = ${reference}`], 'campaign'),
        part('account_goals', { resource: 'customer_conversion_goal', order: ['customer_conversion_goal.category', 'customer_conversion_goal.origin'],
          fields: definition.fields.map(field => ({ ...field, field: field.field.replace('campaign_conversion_goal.', 'customer_conversion_goal.') })) }, [], 'account'),
        part('configuration', { resource: 'conversion_goal_campaign_config', order: [], fields: [
          { name: 'goal_config_level', field: 'conversion_goal_campaign_config.goal_config_level' },
          { name: 'custom_goal', field: 'conversion_goal_campaign_config.custom_conversion_goal', kind: 'resource' }] }, [`campaign.id = ${campaignId}`], 'configuration', true, 1),
      ]);
      const custom = configuration.data[0]?.values.custom_goal;
      if (typeof custom === 'string') await part('custom_goal', { resource: 'custom_conversion_goal', order: [], fields: [
        { name: 'resource', field: 'custom_conversion_goal.resource_name', kind: 'resource' }, { name: 'name', field: 'custom_conversion_goal.name' },
        { name: 'status', field: 'custom_conversion_goal.status' }, { name: 'conversion_actions', field: 'custom_conversion_goal.conversion_actions', kind: 'resources' }] },
        [`custom_conversion_goal.resource_name = ${adsString(custom)}`], 'custom_goal', true, 1);
    } else {
      const where = ['conversion_actions', 'asset_inventory', 'audiences'].includes(query.section) ? []
        : [query.section === 'changes' ? `change_event.campaign = ${reference}` : `campaign.id = ${campaignId}`];
      if (query.conversion_action_id) where.push(`conversion_action.id = ${query.conversion_action_id}`);
      if (query.asset_id) where.push(`asset.id = ${query.asset_id}`);
      if (query.user_list_id) where.push(`user_list.id = ${query.user_list_id}`);
      if (query.ad_group_id) where.push(`ad_group.id = ${query.ad_group_id}`);
      if (query.section === 'targeting') where.push("campaign_criterion.type != 'KEYWORD'", "campaign_criterion.status != 'REMOVED'");
      if (query.asset_group_id) where.push(`asset_group.id = ${query.asset_group_id}`);
      if (dates) {
        const endBefore = new Date(analyticsCalendar(dates.date_to) + 86_400_000).toISOString().slice(0, 10);
        where.push(`change_event.change_date_time >= ${adsString(`${dates.date_from} 00:00:00`)}`, `change_event.change_date_time < ${adsString(`${endBefore} 00:00:00`)}`);
      }
      await part(query.section, definition, where, query.scope === 'account' || query.section === 'conversion_actions' ? 'account' : undefined, true, query.section === 'settings' ? 1 : ANALYTICS_MAX_ROWS + 1);
    }
    parts.sort((a, b) => a.name.localeCompare(b.name));
    const all = parts.filter(part => part.include).flatMap(part => part.data);
    const items = all.slice(page.offset, page.offset + page.limit);
    if (query.section === 'targeting') {
      await Promise.all([['location', 'geo_target_constant'], ['language', 'language_constant']].map(async ([name, resource]) => {
        const ids = [...new Set(items.map(item => item.values[`${name}_id`]).filter((x): x is string => typeof x === 'string'))];
        const names = ids.length ? (await readAds([`${resource}.id`, `${resource}.name`], resource, [`${resource}.id IN (${ids.join(', ')})`], [], ids.length,
          rows => Object.fromEntries(rows.map(row => [id(adsField(row, `${resource}.id`)), label(adsField(row, `${resource}.name`))])), signal)).data : {};
        for (const item of items) {
          const value = names[String(item.values[`${name}_id`] ?? '')];
          item.values[`${name}_name`] = value?.value ?? null; item.redacted ||= value?.redacted ?? false;
        }
      }));
    }
    const unavailableResources = [...new Set(unavailable)].sort();
    const rowTruncated = all.length > ANALYTICS_MAX_ROWS || parts.some(part => part.data.length > ANALYTICS_MAX_ROWS) || unavailableResources.length > ANALYTICS_MAX_ROWS;
    const nestedTruncated = parts.some(part => part.data.some(item => item.truncated_fields.length > 0));
    const truncated = rowTruncated || nestedTruncated;
    const fetchedAt = parts.map(part => part.source_fetched_at).sort()[0] ?? exists?.source_fetched_at ?? config.source_fetched_at;
    const result = { source_fetched_at: fetchedAt, cache_hit: parts.every(part => part.cache_hit) };
    const warnings = ['Current configuration is not a historical settings snapshot. Null optional flags are unknown, not false.'];
    if (query.section === 'ad_group_settings') warnings.push('Bids and targets are current configuration in account currency, not measured CPC or historical settings. Their applicability depends on the campaign bidding strategy.');
    if (query.section === 'audiences') warnings.push('Account-wide list metadata only; estimated/thresholded sizes do not identify members or prove campaign targeting or serving.');
    if (query.section === 'asset_inventory') warnings.push('Account inventory includes assets without active campaign, ad-group or account links. Presence is not proof of serving; use ad_asset_performance for reported ad-level activity. Lead forms describe configuration, never submitted leads.');
    if (query.section === 'settings') warnings.push('Money is in the account currency. Daily/shared budgets are not guaranteed spend or monthly caps. Bidding fields apply only to their strategy; absent values are unavailable.');
    if (query.section === 'targeting') warnings.push('Includes location, language, schedule, device and bid modifiers where applicable. Other criteria may expose only type and ID. Null bid modifiers are not asserted zero.');
    if (['negative_keywords', 'negative_lists'].includes(query.section)) warnings.push('Origins distinguish campaign, ad-group, shared-list and account exclusions. These are configured keyword exclusions, not proof that a campaign or ad group is serving. Rows are not deduplicated across origins. Other exclusion types are outside this section.');
    if (['creatives', 'assets', 'asset_groups', 'asset_inventory'].includes(query.section)) warnings.push('Configuration and policy/strength diagnostics are current. Asset origins identify association scope; account assets are not proof that this campaign served them. Empty format-specific fields do not mean the asset is missing. Prices carry their own currency and unit.');
    if (query.section === 'conversion_actions' || query.section === 'conversion_goals') warnings.push('Account-wide actions/default goals are included with explicit origin. Read campaign goal_config_level and custom_goal before inferring biddability. Primary flags alone do not establish campaign goals. Conversion actions are not unique CRM leads.');
    if (query.section === 'recommendations') warnings.push('Campaign and unattached account recommendations are labeled by origin. Base/potential metrics and suggested bids are Google estimates, not measured incremental results or approved actions. Some recommendation types have no impact/detail values.');
    if (query.section === 'changes') warnings.push('Google change events cover the last 30 days, can arrive late and may omit UI changes; this is not a complete audit log. Actor emails and old/new payloads are withheld. changed_at uses the account timezone and preserves fractional seconds; fetch timestamps ending Z are UTC.');
    if (nestedTruncated) warnings.push('Some repeated fields exceeded their list limit; inspect each item’s truncated_fields. Membership is incomplete even when nextCursor is null.');
    if (rowTruncated) warnings.push('The 500-row section/component limit was reached. Narrow origin, ad_group_id, shared_set_id or other supported filters; do not treat the page as exhaustive.');
    if (unavailable.length) warnings.push('Some linked lists belong to another account. Their members are unavailable through this configured-account reader; inspect unavailable_resources.');
    if (items.some(item => item.verification_required)) warnings.push('Some optional flags were absent or invalid; preserve null as unknown.');
    return { source: source(config), source_status: { status: 'available' as const, read_only: true as const }, campaign: exists?.data[0] ?? null, scope: query.scope, section: query.section,
      query_context: dates, items, ...pageInfo(page, all.length, items.length), source_fetched_at: fetchedAt,
      served_at: new Date().toISOString(), cache: cache(result),
      components: parts.map(part => ({ name: part.name, source_fetched_at: part.source_fetched_at, cache: cache(part), data_truncated: part.data.length > ANALYTICS_MAX_ROWS || part.data.some(item => item.truncated_fields.length > 0) })),
      quality: { data_truncated: truncated, coverage_complete: !truncated && unavailableResources.length === 0, unavailable_resources: unavailableResources.slice(0, ANALYTICS_MAX_ROWS),
        privacy_redactions: items.some(item => item.redacted), warnings } };
  });
}
