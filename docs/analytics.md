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
| `analytics_capabilities` | `GET /api/v1/analytics/capabilities` | Discover supported reports and available custom dimensions. |
| `ga4_report` | `GET /api/v1/analytics/ga4` | Traffic, acquisition, audience and recorded event reports. |
| `search_console_report` | `GET /api/v1/analytics/search-console` | Google organic Search clicks, impressions, CTR and position. |

All REST requests require the employee bearer key. The server uses its service account only for upstream Google reads. The analytics console addition displays permission status; it is not a separate reporting dashboard.

GA4 `report` presets are `overview` (default), `daily`, `acquisition`, `landing_pages`, `devices`, `countries`, `events`, `warehouse_interest`, and `lead_sources`. `event_name` is an optional exact event name, up to 80 characters, for `events` or `warehouse_interest`. Warehouse interest defaults to `view_listing`; lead sources use recorded `generate_lead` events. Custom-dimension reports require those dimensions to be available in the configured property; check capabilities before assuming they exist.

Search Console `group` values are `summary` (default), `date`, `query`, `page`, `country`, and `device`. Optional `query_contains` and `page_contains` are literal substring filters of up to 120 characters, not regular expressions. Use a path fragment for `page_contains`, without a URL query string or fragment. Contact-bearing filters are rejected.

Example tool arguments, without credentials:

```json
{"report":"acquisition","period":"last_28_days","limit":10}
```

```json
{"group":"query","period":"last_month","data_state":"final","limit":10}
```

## Dates, pages and freshness

Use one `period`, or both inclusive `date_from` and `date_to` in `YYYY-MM-DD` format. Explicit ranges can span up to 93 days and cannot end in the future. Supported periods are `today`, `yesterday`, `last_7_days`, `last_28_days`, `this_month`, and `last_month`. The default `last_28_days`, like `last_7_days`, covers completed days and excludes today. `this_month` includes today.

GA4 uses its property's timezone; Search Console uses `America/Los_Angeles`. These dates do not use the warehouse/CRM India calendar. For source comparisons, request matching explicit dates and state the timezone difference. Recently reported values can change. Search Console defaults to `data_state=final`; `all` includes provisional results. Any range ending today requires `data_state=all`, including `today`, `this_month`, and explicit dates; otherwise the engine rejects the request. Final data can lag the requested end date. Google's [Search Analytics reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) describes the source's data states and reporting limits.

`limit` is 1–25, default 10. Follow `nextCursor` unchanged with the same report, filters and resolved dates. Each report exposes at most 500 rows, and pages are not a frozen snapshot. Use the report's coverage and truncation fields; a returned page is not a full total. GA4 overview and Search Console summary return aggregate rows rather than paginated groups.

Reports can use a bounded five-minute in-memory cache. `source_fetched_at` records the Google fetch; `served_at` records this response. `cache.hit`, `cache.age_seconds`, and `cache.max_age_seconds` describe reuse. A later served timestamp does not make the underlying Google data newer. There is no stale-cache fallback after source errors.

## Interpret the results carefully

- GA4 event counts, key events and form activity are recorded website signals, not unique CRM leads, completed deals, revenue, or proof of a sequential conversion funnel. Warehouse interest is recorded browsing activity, not verified demand. These reports do not join analytics users or events to CRM identities.
- Search Console clicks and GA4 sessions measure different things. Grouped Search Console results are top rows and may omit anonymized or unavailable queries. Do not treat their sum as a complete property total; use the unfiltered summary for an aggregate.
- Read each metric's `columns.unit`. Search Console CTR is a fraction (`0.05` means 5%), and position is an average search position. Do not sum users across groups or average row-level CTR or position. Preserve the returned metric meanings, quality flags and coverage limits.
- Exposed labels and paths are sanitized. Masked values can collide; do not infer hidden text or merge masked rows as though they were one original label.
- Failed or denied reads mean unavailable data, not zero traffic or zero leads.

An engine permission denial requires checking active admin status and the employee key or OAuth scopes. `ANALYTICS_CONFIGURATION` means source environment setup is incomplete or invalid. `ANALYTICS_SOURCE_DENIED` means Google denied the read; check API enablement and property access. Rate-limit, timeout, or invalid-response errors require a later retry or source investigation, not invented results. An unavailable custom report can return `ANALYTICS_REPORT_UNAVAILABLE`; use capabilities to choose a supported report.
