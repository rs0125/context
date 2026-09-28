import type { Ga4Query, SearchConsoleQuery } from './analytics-query';

type EventDefinition = {
  event_name: string;
  meaning: string;
  definition_basis: 'google_definition' | 'website_source_review';
  limitations: string[];
};

// These describe collection semantics, not a verification of deployed tracking
// or its behavior throughout the requested historical window.
export const ANALYTICS_EVENT_DEFINITIONS: EventDefinition[] = [
  { event_name: 'first_visit', definition_basis: 'google_definition',
    meaning: 'The first website visit recognized by GA4 with Analytics enabled.',
    limitations: ['Browser/device identity and tracking availability affect recognition; this is not a lifetime count of real people.',
      'These counts do not follow the same visitors through later sessions or into CRM.'] },
  { event_name: 'form_submit', definition_basis: 'google_definition',
    meaning: 'Enhanced Measurement can record a browser form submission when enabled.',
    limitations: ['Property settings and historical collection have not been verified by this report.',
      'This does not prove server acceptance, a saved enquiry or a unique CRM lead.'] },
  { event_name: 'generate_lead', definition_basis: 'website_source_review',
    meaning: 'Audited website form handlers emit this after the intake API returns success.',
    limitations: ['This source-code definition does not verify deployed or historical tracking, completeness or deduplication.',
      'The emitted enquiry ID identifies website intake, not a Twenty opportunity; this report does not expose or join those IDs.',
      'The form hook snapshots page context on opening; the recorded page can differ from the page at submission time.'] },
  { event_name: 'form_attempt', definition_basis: 'website_source_review',
    meaning: 'A tracked form attempt, including attempts that fail browser or custom validation.',
    limitations: ['Not a successful submission, unique person or exactly one event per button click.',
      'Historical tracking and an ordered relationship to success events have not been verified.'] },
  { event_name: 'contact_click', definition_basis: 'website_source_review',
    meaning: 'A tracked click on a phone, email or WhatsApp link.',
    limitations: ['Not evidence of an answered call, sent message, conversation or CRM lead.',
      'Source code describes intended collection; this report does not verify deployed or historical coverage.'] },
];

export const ANALYTICS_DIMENSION_DEFINITIONS: Record<string, string> = {
  landingPage: 'First pageview path of a session, not necessarily the first page this person ever visited.',
  pagePath: 'Path recorded with the event. Form tracking can preserve the page where the form opened; not necessarily the submit-time URL.',
  eventName: 'Recorded event type; similarly named or related events are not necessarily distinct enquiries.',
  sessionDefaultChannelGroup: 'Channel assigned to this session, not lifetime first-touch attribution.',
  sessionSourceMedium: 'Source and medium for this session, not lifetime first-touch attribution.',
  'customEvent:lead_type': 'Recorded form category, not a marketing acquisition channel or qualified CRM lead type.',
  'customEvent:origin_placement': 'Recorded CTA placement where supplied, not a visitor first-touch source.',
};

export function ga4EventNames(query: Ga4Query): string[] {
  if (query.report === 'first_visits') return ['first_visit'];
  if (query.report === 'form_performance') return ['form_submit', 'generate_lead'];
  if (query.report === 'form_submissions') return query.event_name ? [query.event_name] : ['form_submit', 'generate_lead'];
  if (query.report === 'lead_sources') return ['generate_lead'];
  if (query.report === 'warehouse_interest') return [query.event_name ?? 'view_listing'];
  return query.event_name ? [query.event_name] : [];
}

export function analyticsInterpretation(query: Ga4Query | SearchConsoleQuery,
  items: { dimensions: Record<string, string | null> }[]) {
  const ga = 'report' in query;
  const eventNames = ga ? [...new Set([...ga4EventNames(query), ...items.map(x => x.dimensions.eventName).filter((x): x is string => !!x)])] : [];
  const firstVisits = ga && (query.report === 'first_visits' || query.event_name === 'first_visit');
  const pageBasis = ga && (['pages', 'form_submissions'].includes(query.report) || query.page_path_contains)
    ? 'recorded_event_page' as const : ga && (['landing_pages', 'first_visits', 'form_performance'].includes(query.report) || query.landing_page_contains)
      ? 'session_entry' as const : 'none' as const;
  const acquisitionBasis = firstVisits ? 'first_visit_events_only' as const
    : ga && (['acquisition', 'landing_pages', 'form_performance'].includes(query.report) || query.landing_page_contains || query.channel || query.source)
      ? 'session' as const : 'not_reported' as const;
  const limits = [
    'No individual user journeys or verified website-to-CRM linkage are available. Missing fields here do not prove they are absent upstream.',
    'Explanations of intent, causes or lead quality are hypotheses unless separate evidence establishes them. City/query similarity is not lead attribution.',
  ];
  if (ga) limits.push(
    'Never divide recorded-event-page counts by session-entry counts just because the path labels match: these are different populations. Use form_performance for server-calculated form events per 100 matching entry sessions; its component dates and session filters are identical.',
    'Event count divided by sessions is events per session, not the fraction of visitors or sessions that converted. A conversion rate needs a matching deduplicated numerator and denominator.',
    'Do not sum users across rows. Do not add form_submit and generate_lead as distinct submissions or treat their mismatch as proof of broken tracking.',
    'Zero key events does not prove zero enquiries. Key-event configuration and tracking history may differ across dates.',
  );
  if (firstVisits) limits.push('First-visit counts describe recorded acquisition only; later engagement, submissions and pipeline for that same group are not linked.');
  if (ga && query.report === 'form_performance') limits.push('The two form event counts are separate, potentially overlapping actions during matching sessions. Events per 100 entry sessions can exceed 100 and are not a percentage of visitors or sessions that converted. Independent component reads can have different fetch/cache times; null ratios must not be reconstructed from quality-limited counts.');
  if (ga && query.landing_page_contains && query.page_path_contains) limits.push('Both page filters apply: session entry must match landing_page_contains and recorded event page must match page_path_contains.');
  return {
    aggregation: 'aggregate' as const, page_basis: pageBasis, acquisition_basis: acquisitionBasis,
    individual_journeys_available: false as const, crm_linkage_available: false as const,
    event_counts_are_unique_leads: false as const,
    event_definitions: ANALYTICS_EVENT_DEFINITIONS.filter(x => eventNames.includes(x.event_name)), limits,
  };
}
