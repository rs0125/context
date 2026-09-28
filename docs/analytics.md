# Website analytics

The engine provides read-only Google Analytics 4 and Google Search Console reports through the existing REST API and MCP connection. These reports are restricted to active Wareongo admins with `analytics:read`. They do not grant access to additional CRM records; Twenty still determines CRM access.

## Configure the sources

1. Enable **Google Analytics Data API** and **Google Search Console API** in the service account's Google Cloud project.
2. Give the service account read access to the intended GA4 property and Search Console property. The account's Google Cloud role alone does not grant access to those properties. See Google's [Data API setup guide](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart) and [Search Console property permissions](https://support.google.com/webmasters/answer/7687615).
3. Set these server environment variables. Use `.env.local` locally and the intended environment in Vercel for deployment. Restart or redeploy after changing them.

| Variable | Value |
| --- | --- |
| `GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON` | Complete service-account JSON as one inline JSON value, including its private key. This is a secret, not a file path. |
| `GA4_PROPERTY_ID` | Numeric GA4 property ID, such as `<NUMERIC_PROPERTY_ID>`. This is different from a `G-…` measurement ID. |
| `SEARCH_CONSOLE_SITE_URL` | Exact configured property, such as `sc-domain:example.com` or `https://www.example.com/`. URL-prefix configuration currently supports an HTTPS root URL with its trailing slash. |

Keep the JSON's private-key newline escapes intact when storing it as an environment value. An ignored file such as `.local/ga4-service-account.json` can hold a private local copy, but the runtime reads the environment variable; it does not load that file automatically. Do not put the JSON in a tracked file, a `NEXT_PUBLIC_` variable, a chat message, or a browser credential field. Existing Google sign-in credentials are separate and remain unchanged.

No analytics timezone variable is needed. The Data API supplies the GA4 property timezone. The Google Analytics Admin API is optional and not used by these reports; reporting works without enabling it. Callers cannot supply another property ID, site, API URL, or service-account credential through a report request.

## Enable admin access

For an existing deployment, a trusted operator must apply the updated credential-scope constraints before issuing a four-scope key:

```sh
npm run console:migrate -- --apply
npm run mcp:migrate -- --apply
```

These migrations allow the new scope; they do not expand existing keys or grants. Without `--apply`, the scripts only stage their work for review.

The current active employee's `VerifiedNumber.adminAccess` must be `true`, and their credential must include `analytics:read`. Authorization is checked on report requests, including cached results. Adding a scope string to a request does not grant permission.

Existing employee keys and OAuth grants keep their existing scopes. An eligible admin should:

1. Sign in to the console and replace their employee key in **Connect Claude → Key settings**. Replacing the key invalidates connections using the old key.
2. Remove and re-add the Claude connector so it registers a new OAuth client, then approve a consent request that includes **Website analytics (admins only)** using the new employee key. An older client's registered scopes stay fixed; refreshing its token or reconnecting with that same client cannot add the permission.
3. Check **Your read access** for Website analytics, then ask the connector to run `analytics_capabilities`.

For another MCP client, its requested OAuth scopes must include `analytics:read`. For a REST client, replace its stored employee bearer key securely. Never paste a key into chat. Analytics access does not create a new knowledge-page restriction: knowledge pages retain their existing three reader permissions.

## Available reads

| MCP tool | REST endpoint | Purpose |
| --- | --- | --- |
| `analytics_capabilities` | `GET /api/v1/analytics/capabilities` | Discover reports, returned metrics, metric definitions, available custom dimensions and event interpretation. |
| `ga4_report` | `GET /api/v1/analytics/ga4` | Traffic, engagement, acquisition, audience, recorded first visits and form/event reports. |
| `search_console_report` | `GET /api/v1/analytics/search-console` | Google organic Search clicks, impressions, CTR and position. |

All REST requests require the employee bearer key. The server uses its service account only for upstream Google reads. The analytics console addition displays permission status; it is not a separate reporting dashboard.

GA4 `report` presets are `overview` (default), `daily`, `acquisition`, `landing_pages`, `pages`, `devices`, `countries`, `events`, `first_visits`, `form_submissions`, `form_performance`, `warehouse_interest`, and `lead_sources`. `landing_pages` describes the entry path of a session; `pages` ranks viewed paths by page views. `event_name` is an optional exact event name, up to 80 characters, for `events` or `warehouse_interest`; `form_submissions` accepts only `form_submit` or `generate_lead`. Warehouse interest defaults to `view_listing`; lead sources use recorded `generate_lead` events. Custom-dimension reports require those dimensions to be available in the configured property; check capabilities before assuming they exist.

GA4 filters combine with AND and are case-sensitive: `landing_page_contains` is a literal entry-path fragment; `page_path_contains`, available only for `pages`, `events` and `form_submissions`, filters the recorded event's built-in `pagePath`; `device` is `desktop`, `mobile`, or `tablet`; `country` is an exact country label such as `India`; `channel` is an exact session channel label such as `Organic Search`; and `source` is an exact session source such as `google`. Path fragments, country, channel and source labels are limited to 120 characters. Page fragments exclude query strings, fragments, credentials and contact details. Acquisition reports show the combined source/medium, but the source filter accepts the source alone. Entry-path and acquisition filters describe session context; they do not isolate only events occurring on that page or establish a person's original acquisition source. Supplying both path filters requires both the session entry path and recorded event path to match their respective fragments.

Search Console `group` values are `summary` (default), `date`, `query`, `page`, `query_page`, `country`, and `device`. `query_page` returns search terms together with their pages. Supported filters combine with AND:

| Filter | Meaning |
| --- | --- |
| `query_contains` / `query_equals` | Literal query substring / exact search query, up to 120 characters. Use one of these. |
| `query_not_contains` | Exclude queries containing a literal substring, for example a brand name; up to 120 characters. |
| `page_contains` / `page_equals` | Path substring up to 120 characters / exact full public HTTP(S) URL up to 512 characters. Use one of these. |
| `device` | `desktop`, `mobile`, or `tablet`. |
| `country` | Three-letter ISO 3166-1 alpha-3 code, such as `ind` for India; normalized to lowercase. This differs from GA4 country labels. |

Filters are literal, not regular expressions. Search Console substring filters ignore case; exact queries and URL paths are case-sensitive. Contact-bearing filters are rejected. Page filters exclude URL queries, fragments and credentials. `page_equals` must belong to the configured Search Console property; it cannot select another property. Query filters exclude anonymized queries, and page filtering can change Google's aggregation basis; inspect `quality.aggregation_type`.

Example tool arguments, without credentials:

```json
{"report":"acquisition","period":"last_28_days","limit":10}
```

```json
{"group":"query","period":"last_month","data_state":"final","limit":10}
```

```json
{"report":"overview","period":"last_28_days","channel":"Organic Search","device":"mobile","compare_to":"previous_period"}
```

```json
{"report":"first_visits","period":"last_28_days","landing_page_contains":"/listings","limit":10}
```

```json
{"report":"form_submissions","period":"last_month","event_name":"generate_lead","page_path_contains":"/request-warehouse","limit":10}
```

```json
{"group":"query_page","period":"last_28_days","page_contains":"/warehouses/bengaluru","query_not_contains":"wareongo","country":"ind","limit":10}
```

## GA4 engagement and timing

`overview`, `daily`, `acquisition`, `landing_pages`, `devices` and `countries` include engagement and timing by default. Use the usual report/date/filter arguments; no metric selector is needed. `analytics_capabilities.ga4.reports[].metrics` lists each report's returned metrics, and `ga4.metric_definitions` describes the added metrics and calculations. Report columns carry the same definitions and, for computed values, a `calculation` formula.

These six reports request ten native GA4 metrics: `activeUsers`, `totalUsers`, `sessions`, `engagedSessions`, `screenPageViews`, `eventCount`, `keyEvents`, `engagementRate`, `userEngagementDuration` and `averageSessionDuration`. Engagement rate is a fraction; total engagement duration and average session duration are seconds. Total engagement duration measures recorded foreground engagement across users, whereas average session duration is GA4's distinct session-duration metric. [Google metric definitions](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)

The server also returns five calculations from the same source row:

| Returned metric | Calculation | Unit |
| --- | --- | --- |
| `averageEngagementTimePerSession` | `userEngagementDuration / sessions` | seconds |
| `averageEngagementTimePerActiveUser` | `userEngagementDuration / activeUsers` | seconds |
| `bounceRate` | `1 - engagementRate` | fraction |
| `screenPageViewsPerSession` | `screenPageViews / sessions` | views per session |
| `eventsPerSession` | `eventCount / sessions` | events per session |

The two engagement-time averages use different denominators and should be named explicitly. They follow Google's [engagement overview definitions](https://support.google.com/analytics/answer/13391283?hl=en). Calculations never combine rows or fetch a separate denominator; a missing or zero denominator makes a ratio unavailable. Missing, restricted or invalid source values are not replaced with zero. For example, 4,800 engagement seconds across 120 sessions and 80 active users means 40 seconds per session and 60 seconds per active user; neither is the total engagement time or average session duration.

`pages` includes total engagement seconds and average engagement seconds per active user alongside its existing views, users, events and key events. This describes activity associated with each viewed path. It does not add session-duration metrics or label engagement per active user as time per page view. Use `landing_pages` for session metrics by entry path, or filtered `overview` for an aggregate. `events`, `first_visits`, `form_submissions`, `warehouse_interest` and `lead_sources` return event-count reports; filtering to an event would not establish overall session engagement.

There are still intentional coverage limits: `newUsers`, revenue, ad costs, funnel reports, retention/cohort analysis and broader attribution dimensions are not exposed. Returned measurements reflect what the property collected and Google's processing, configuration and privacy limits; the connector cannot reconstruct missing tracking. The available engagement metrics do not establish CRM conversions or verified commercial outcomes.

## Recorded first visits and form activity

These are presets of the existing `ga4_report` tool and endpoint. They require no new environment variables, consent scopes or tool names. Both use standard GA4 dimensions and the existing bounded, sanitized report envelope; they do not require custom-dimension registration.

| Preset | Returned dimensions | Returned metrics | Event restriction |
| --- | --- | --- | --- |
| `first_visits` | `landingPage` | `eventCount`, `totalUsers` | Fixed `first_visit`; `event_name` is not accepted. |
| `form_submissions` | `eventName`, `pagePath` | `eventCount`, `totalUsers` | `form_submit` and `generate_lead`, or the one selected by `event_name`. |

The default form report keeps the two event types in separate rows. `query_context.event_names` records the fixed two-event list when both are selected; a null singular `event_name` does not mean all events were requested. Do not add these event types together as successful submissions: a single interaction can produce both. `totalUsers` is GA's distinct-user count within each filtered group and is not additive across rows. Google's [Data API schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema) defines the standard dimensions and metrics; property-specific dimension/metric compatibility can be checked using [checkCompatibility](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/checkCompatibility). A supported preset or registered metadata field does not establish that its production tracking has been verified.

`first_visits` groups recorded `first_visit` events by the first pageview path of their session. It does not return the `newUsers` metric or reconstruct a visitor's later pages. Google describes `first_visit` as an [automatically collected event](https://support.google.com/analytics/answer/9234069?hl=en); the result reflects Analytics' recorded recognition of first visits, not verified first-ever visits by unique people.

The event dictionary records `definition_basis` as `website_source_review` or `google_definition`. Its textual `limitations` explain that these definitions do not verify deployed code, property settings, historical coverage or delivery of every event.

| Event | Source-reviewed meaning | Interpretation limit |
| --- | --- | --- |
| `contact_click` | A tracked click on a phone, email or WhatsApp link. | Does not prove a connected call, sent message, conversation or lead. |
| `form_attempt` | A form submission attempt recorded by the form hook, including native or custom validation failures; repeated attempts can be recorded after validation or server failure. | Does not establish valid input, successful submission, a unique person or one event per button click. |
| `generate_lead` | The frontend emits this after its form API service reports success; the hook suppresses repeats within that form-open lifecycle. | A recorded frontend success signal does not establish a unique CRM record, qualified lead, sale or revenue. |
| `form_submit` | Google Enhanced Measurement can record a browser form submission; the inspected website does not emit it explicitly. | Collection depends on property settings and runtime behavior; a browser submission does not prove backend acceptance. |

Google documents the automatic form events and their parameters in [Enhanced Measurement](https://support.google.com/analytics/answer/9216061?hl=en). The inspected website evidence is `src/hooks/useLeadAnalytics.ts`, `src/lib/analytics.ts`, `src/components/AnalyticsInteractions.tsx`, `src/services/formSubmission.ts` and `src/services/warehouseRequest.ts` in the sibling `website_combined/wareongo-website` repository. That source review does not constitute a live tracking test.

`pagePath` is Google's built-in path without a query string. It is distinct from a registered `customEvent:page_path`: the website's `page_path` parameter can include allowlisted query values. Neither should silently replace the other. The lead form hook snapshots page context when the form opens, and later events reuse it. Therefore `generate_lead` can carry the opening page rather than the current submit-time page. Describe `form_submissions.pagePath` and `page_path_contains` as recorded event page context. The remembered CTA's `origin_page_path` and a session's `landingPage` are separate concepts.

## Dates, pages and freshness

Use one `period`, or both inclusive `date_from` and `date_to` in `YYYY-MM-DD` format. Explicit ranges can span up to 93 days and cannot end in the future. Supported periods are `today`, `yesterday`, `last_7_days`, `last_28_days`, `this_month`, and `last_month`. The default `last_28_days`, like `last_7_days`, covers completed days and excludes today. `this_month` includes today.

GA4 uses its property's timezone; Search Console uses `America/Los_Angeles`. These dates do not use the warehouse/CRM India calendar. For source comparisons, request matching explicit dates and state the timezone difference. Recently reported values can change. Search Console defaults to `data_state=final`; `all` includes provisional results. Any range ending today requires `data_state=all`, including `today`, `this_month`, and explicit dates; otherwise the engine rejects the request. Final data can lag the requested end date. Google's [Search Analytics reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) describes the source's data states and reporting limits.

`limit` is 1–25, default 10. Follow `nextCursor` unchanged with the same report, filters and resolved dates. Each report exposes at most 500 rows, and pages are not a frozen snapshot. Use the report's coverage and truncation fields; a returned page is not a full total. GA4 overview and Search Console summary return aggregate rows rather than paginated groups.

Daily reports are chronological and still paginated. A 28-day trend needs all returned pages, even if the first page contains only ten dates. Missing dates are not fabricated as zero activity. Grouped Search Console paging cannot recover queries that Google omits.

## Forms per matching entry session

Use `ga4_report(report="form_performance")` for questions such as “Do warehouse-entry sessions produce more form activity than listing-entry sessions?” The server reads three dimensionless aggregates for one selected group: all entry sessions, `form_submit` events in those sessions, and `generate_lead` events in those sessions. Dates, property, device, country, channel, source and entry-path filters match across all three reads. The event reads add only their fixed event filter. No custom dimension is required.

For a relative window such as the last 28 complete days, send `period=last_28_days` on the first group. Reuse its returned `query_context.date_from` and `date_to` as explicit dates on subsequent groups, keeping other filters identical. Let the server resolve the property calendar; do not calculate it from the chat's UTC date. For a specified calendar window, both calls can use explicit dates from the start:

```json
{"report":"form_performance","date_from":"2026-08-01","date_to":"2026-08-28","landing_page_contains":"/warehouse/"}
```

```json
{"report":"form_performance","date_from":"2026-08-01","date_to":"2026-08-28","landing_page_contains":"/listings/"}
```

Each call returns one aggregate row with `sessions`, `formSubmitEventCount`, `generateLeadEventCount`, `formSubmitEventsPer100EntrySessions` and `generateLeadEventsPer100EntrySessions`. Each ratio is its event count divided by matching entry sessions, multiplied by 100. For example, 11 submissions and 100 entry sessions means 11 submission events per 100 entry sessions. It does not mean 11% of visitors or sessions converted: one session can contain repeated events. The two event types can overlap and must remain separate. They do not establish CRM leads or a person's first-touch journey.

`form_performance.components` preserves each component's filters, dates, timestamps, cache state, quota and source quality. Google reads are independent, with a shared deadline; this is not a frozen snapshot. The top-level fetch timestamp is the oldest component fetch. Recently reported values remain provisional. Any failed source read fails the whole report. Missing event rows stay null; only an explicit recorded zero becomes zero. Ratios remain null when the denominator is zero, values are missing, or relevant source quality is limited by sampling, thresholding, truncation, restrictions or an empty-data reason. Read each ratio's `status` and do not reconstruct withheld calculations.

This preset rejects `event_name`, `page_path_contains`, `cursor` and `compare_to`. These restrictions preserve the matching session-entry population and keep the operation bounded. It adds no MCP tool name, environment variable, consent scope or pipeline. Analytics remains restricted to current administrators.

## Period comparisons

Use `compare_to=previous_period` only with GA4 `report=overview` or Search Console `group=summary`, without a cursor. It compares the selected dates with the immediately preceding equal number of calendar days using the same filters. A 28-day window compares with the prior 28 days; a partial month compares with the preceding same-length window, not necessarily the previous calendar month or matched weekdays. Each window stays within the normal 93-day bound.

The current report remains the top-level result. `comparison.baseline` preserves the previous period's resolved dates, source fetch time, cache age and quality; `comparison.metrics` contains current and previous values plus changes. These are independent source reads, not a frozen snapshot. If either read fails, the comparison fails rather than substituting zero or returning a misleading partial comparison.

`absolute_change` is current minus previous. Counts, durations and per-session measurements include `relative_change_percent` when the previous value is nonzero. Engagement rate, bounce rate and CTR use `percentage_point_change`, so a change from `0.04` to `0.05` is one percentage point. Average position uses only the absolute change; a lower numeric position is not evidence that every search query improved. A zero baseline has no defined percentage change. Missing rows or null metrics remain unavailable, with `status=missing_data`; neither is converted to zero. Read the quality warnings for both periods before interpreting a difference.

Reports can use a bounded five-minute in-memory cache. `source_fetched_at` records the Google fetch; `served_at` records this response. `cache.hit`, `cache.age_seconds`, and `cache.max_age_seconds` describe reuse. A later served timestamp does not make the underlying Google data newer. There is no stale-cache fallback after source errors.

## Interpret the results carefully

Structured interpretation metadata accompanies the reports and discovery guidance. `individual_journeys_available`, `crm_linkage_available` and `event_counts_are_unique_leads` are explicitly false. `aggregation`, `page_basis` and `acquisition_basis` describe the report's scope; `interpretation.limits` explains that proposed causes and lead quality remain hypotheses without separate evidence. Read these fields and the event dictionary together with `quality.warnings`; returning a report does not turn unsupported interpretations into verified facts.

- GA4 event counts, key events and form activity are recorded website signals, not unique CRM leads, completed deals, revenue, or proof of a sequential conversion funnel. Warehouse interest is recorded browsing activity, not verified demand. These reports do not join analytics users or events to CRM identities.
- A form event grouped by a session landing page or acquisition source retains that session context; it does not reconstruct the order of page visits or demonstrate that a page caused a submission. Treat explanations for changes, high or low engagement, and differences between pages as hypotheses requiring further evidence. No CRM links or individual journeys are exposed by these aggregate reports.
- Do not divide `form_submissions` counts by `landing_pages` sessions just because their path labels match: events on a page and sessions starting on a page describe different populations. Use `form_performance` for server-calculated events per matching entry session, with the same explicit dates and segment filters across comparison groups. Do not reconstruct ratios that the server withheld. Events per session is not a visitor conversion rate or a count of unique CRM leads.
- Search Console clicks and GA4 sessions measure different things. Grouped Search Console results are top rows and may omit anonymized or unavailable queries. Do not treat their sum as a complete property total; use the unfiltered summary for an aggregate.
- Read each metric's `columns.unit`, `definition` and `calculation`. Rates are fractions (`0.05` means 5%); engagement and session times are seconds; Search Console position is an average search position. Do not sum users across groups or average row-level rates, durations or position. Request an aggregate report for the overall metric. Preserve the returned metric meanings, quality flags and coverage limits.
- Exposed labels and paths are sanitized. Masked values can collide; do not infer hidden text or merge masked rows as though they were one original label.
- Failed or denied reads mean unavailable data, not zero traffic or zero leads.

An engine permission denial requires checking active admin status and the employee key or OAuth scopes. `ANALYTICS_CONFIGURATION` means source environment setup is incomplete or invalid. `ANALYTICS_SOURCE_DENIED` means Google denied the read; check API enablement and property access. An unavailable custom report can return `ANALYTICS_REPORT_UNAVAILABLE`; use capabilities to choose a supported report.

MCP tool failures returned by the API boundary include `error.recovery` with `retryable`, a stable `action`, and short guidance. Transient timeout, quota, busy and unavailable errors permit a later retry and retain `retry_after_seconds` when supplied. Configuration, access, unsupported-report and invalid-query errors require correcting the cause; they omit the generic retry delay. Unverified or inconsistent source responses require investigation. None establishes zero activity. Tool citations retain safe report/date parameters while omitting free-text filters and page URLs; `meta.requestId` identifies the returned evidence.

See [Analytics MCP design review](analytics-mcp-review.md) for the research, scope decisions and natural-language evaluation cases.
