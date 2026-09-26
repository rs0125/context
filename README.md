# Wareongo Context

A read-only REST, Markdown, and remote MCP context service for employee AI tools. It combines reviewed company guides with permitted warehouse facts and CRM opportunities. Employees see leads they created or are assigned to; verified Twenty admins see all mirrored leads. The same Next.js deployment hosts the `/mcp` endpoint and an employee console for agent setup, with Markdown editing for roster admins.

The API uses the dashboard and CRM Automations' existing shared Supabase data, with live Twenty CRM reads to verify identity, admin role, creation, and assignment. Organisational Markdown and its metadata live in the private PostgreSQL table `context_engine_private.knowledge_pages`; no company wiki content is bundled with the source or deployment. Employee context keys are separate credentials with narrower permissions. Source-system tokens stay on the server and are never forwarded to agents.

## Local setup

Use Node.js 22.

```sh
npm install
node scripts/import-local-env.mjs \
  --dashboard-env ../Backend_Repository/.env \
  --crm-env ../../CRM-Automations/.env
node scripts/setup-ca.mjs
node scripts/create-key.mjs \
  --email employee@wareongo.com \
  --label local-trial \
  --days 30
npm run dev
```

Run these commands from this directory. Adjust the source environment paths to the files used by your local applications. The import script requires matching Supabase pooler credentials in the two source applications, selects transaction port `6543`, and creates `.env.local` with a one-connection pool. It also copies `TWENTY_CRM_BASE_URL` and `TWENTY_CRM_API_KEY` from CRM Automations for server-side reads. The source key needs permission to read members, opportunities and role metadata for authorization, plus notes, tasks, their target relationships and companies for related context. R2, OpenAI, and messaging credentials are not imported. It does not edit the source files or overwrite a different existing database configuration. Use `.env.example` as a reference for optional settings; do not copy its placeholder database URL over your imported configuration.

The employee email must match an active employee in the dashboard's roster. Key issuance writes the hashed registration to the ignored `.env.local` file and the raw key to `.local/keys/<label>.json`, also ignored by Git. For the command above, the credential file is `.local/keys/local-trial.json`. Use that file to configure the test client's credential store. The script does not print the raw key to the terminal.

The example email is a placeholder; supply the intended employee's actual roster email privately. Initialise the private knowledge table once using the administrative import described below before testing knowledge reads. An already configured database does not need its knowledge reimported for a new checkout or deployment.

The CA setup script downloads Supabase's public production CA from the URL used by its official dashboard, checks its pinned fingerprint and validity, and sets `PG_SSL_CA` without changing TLS verification. It saves the public certificate in `.local/supabase-ca.crt`. To use an already downloaded copy, run `node scripts/setup-ca.mjs --from-file .local/supabase-ca.crt`; the same validation applies. See [Supabase's SSL documentation](https://supabase.com/docs/guides/platform/ssl-enforcement). A future CA rotation requires reviewing and updating the pinned fingerprint.

Open `http://localhost:3000` for the console and `/api/v1/openapi.json` for the public OpenAPI description. Authenticated records and Markdown pages require a bearer key. Restart the development server after changing environment-based registrations.

## Browser console

Configure the console without changing the database:

```sh
npm run setup:console -- --origin http://localhost:3000
npm run dev -- --port 3000
```

The setup script imports `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the dashboard's environment (override the path with `--dashboard-env`), unless a complete Google credential pair is already configured here. It creates independent session and key-encryption secrets in ignored `.env.local`, preserves existing secrets, and never prints credentials. It removes obsolete password and environment-admin settings. Google sign-in is separate from the employee-key OAuth connection used by MCP clients.

In the Google Cloud OAuth client's **Authorized redirect URIs**, add `http://localhost:3000/api/auth/google/callback` for local development and `https://context-wareongo.vercel.app/api/auth/google/callback` for the current deployment. A different hostname needs its own exact callback URI. This cannot be set by the application. For production, set `CONTEXT_CONSOLE_ORIGIN=https://context-wareongo.vercel.app` and the same Google client ID/secret in Vercel, then redeploy. Preserve the existing session/key-encryption secrets. Reusing the dashboard client does not automatically authorize the Context callback; see [Google's server-side OAuth setup](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred).

Sign in with Google using a verified `@wareongo.com` Workspace account whose email matches exactly one active `public."VerifiedNumber"` row. The server verifies Google's ID-token signature, issuer, audience, nonce, expiry, verified email, and hosted domain. The authorization flow uses state and PKCE. Sessions use signed HttpOnly cookies with an eight-hour expiry, and mutations require the configured origin. Every authenticated request rechecks the roster: disabled or deleted employees lose access immediately; only `adminAccess = true` grants knowledge administration. No environment email list grants admin access, and old shared-password sessions are rejected.

Each employee can copy the MCP server URL, credential-free connection steps, REST instructions, and their own API key separately. All active employees receive company-guide access. Warehouse access requires current `dashboardAccess` or `adminAccess`; CRM access requires a valid Twenty user mapping and live CRM authorization. WAG admin access does not imply Twenty admin access. Admins cannot retrieve or rotate another employee's key through this console. Scope reductions take effect on the next read; newly granted scopes require rotating an older, narrower key.

The REST instructions work only with clients already equipped to make authenticated HTTP requests. Pasting a prompt, URL, or API key into ordinary chat does not install that capability. Never paste a raw API key into chat. Keys are masked by default, expire after 30 days, and can be rotated from the console. They are stored as an authentication hash plus an encrypted copy for retrieval after login. Keep the encryption secret backed up privately; losing or rotating it requires reissuing console keys. No credentials are saved in browser local storage. Google tokens are used only to complete sign-in and are not retained.

Admins can create pages, import `.md` text, edit metadata and required scopes, and publish reviewed material. New pages start as drafts; agent reads exclude drafts. Concurrent edits are rejected for review instead of silently overwriting another editor's changes. Publishing knowledge does not require a deployment.

The console follows the supplied [Linear style reference](docs/linear-style-reference.md): dark surfaces, fine borders, compact Inter type, and a single lime primary action per view. Sign-in, employee setup, the knowledge editor, and connector consent share this system. Inter is self-hosted under the [SIL Open Font License](src/app/fonts/OFL.txt); technical values use the system monospace family. Rendering requires no external font requests. Responsive layouts, keyboard focus, loading states, and long document titles are checked with synthetic browser fixtures. Desktop/mobile screenshots stay in the ignored `previews/` directory; open `previews/index.html` for the local gallery when available.

For a new database, run `npm run console:migrate -- --apply`, then set `CONTEXT_CONSOLE_WRITES_ENABLED=true` and restart or redeploy. This creates and verifies the private console credential store; it does not import or overwrite organisational pages. Without `--apply`, the command only prints its plan. Setup scripts never automatically apply migrations, and writes default to disabled for new checkouts. The agent-facing `/api/v1` API remains read-only regardless of this flag.

Console rotation replaces only the current console-issued key. Keys registered separately through `CONTEXT_API_KEYS_JSON` remain valid until explicitly revoked from that registry.

See the [employee authentication review](docs/auth-review.md) for remaining rollout work and the legacy-key retirement procedure. In particular, console logout currently clears browser cookies without server-side revocation of a copied session, and legacy environment keys must be retired or rebound before an employee email is reused.

## Connect an MCP client

The remote MCP URL is `https://YOUR_HOST/mcp`, on the same deployment as the REST API and console. It is a protocol adapter over the existing read-only context engine; employee identity, scopes, field allowlists, warehouse uncertainty, and CRM visibility/freshness checks still apply. Sign in with Google in the console to obtain your own employee API key first.

For Claude:

1. Add a custom connector using the public HTTPS MCP URL. A local development URL is not reachable by a hosted client.
2. When Wareongo Context opens its authorization page, review the requesting application's identity, redirect origin and complete redirect URI, and requested read permissions.
3. Enter the employee API key for the intended person on that authorization page and select **Connect**. The key belongs in this form, not in the conversation or connector URL.
4. Return to Claude and enable the connector for the conversation. If custom connectors are unavailable in that account or workspace, the console's REST instructions cannot add them.

The authorization page is independent of Google console sign-in. It submits the employee key only in a POST body, clears it after each attempt, and does not save it in browser storage. The page shows the actual requesting application; entering a name such as “Claude” is not proof of that application's identity. Confirm the displayed origins before authorizing. Source-system credentials are never supplied to the client.

Before enabling connections in a new database, inspect the OAuth storage plan with `node scripts/migrate-mcp-oauth.mjs`, then apply it deliberately with `node scripts/migrate-mcp-oauth.mjs --apply`. MCP uses the existing console origin, server secrets, and private-storage write flag; no additional mandatory secret is introduced. Set `CONTEXT_MCP_ENABLED=false` to disable MCP and its OAuth flow. Built-in Claude callback rules are configured by the service; `CONTEXT_MCP_ALLOWED_REDIRECT_ORIGINS` optionally adds exact HTTPS origins for other trusted clients. The registered redirect URI must still pass the server's validation. Local callback exceptions apply only to an explicitly configured local HTTP console.

The `/oauth/authorize` browser page obtains a short-lived, browser-bound consent request from `/api/oauth/authorize`. Approval requires an explicit POST with the employee key; denial submits no key. OAuth client registration, code exchange, and revocation are protocol endpoints, not permission to edit warehouse or CRM records. Their state is stored in the private `context_mcp_private` schema. Access tokens last up to 15 minutes; rotating refresh tokens and grants are bounded by 30 days and the underlying employee key’s expiry. Every read rechecks that key and current access. Revoking or rotating the underlying key invalidates its connector grants once the key change is active in the deployment; clients can also revoke a grant through `/oauth/revoke`. Keep tokens out of source control and browser application storage.

REST endpoints remain available to existing authenticated HTTP clients. Use `/api/v1/context` or `/api/v1/context.md` to discover context and `/api/v1/openapi.json` for the REST schema. A client should report missing tooling, denied reads, unavailable sources, and incomplete coverage instead of inventing records.

The thirteen MCP tools cover context discovery, knowledge search/read, warehouse filters/search/read/summary, and CRM filters/search/read/summary/briefing plus a bounded related-context read. Searches support India-calendar periods and explicit date bounds. CRM `view=created` means created **by** the employee; `period=this_month` filters native source creation time. Combine both when needed. `read_crm_lead_context` requires one exact lead ID and one section: `notes`, `tasks`, `company` or `stage_history`.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | The shared Supabase **transaction pooler** connection, on a `*.pooler.supabase.com:6543` host. Use the complete database URL, including the database name and credentials. |
| `PG_POOL_MAX` | Connections per running application instance. Default `1`; maximum `2`. |
| `PG_SSL_CA` | PEM CA certificate for verified TLS. The setup script configures Supabase's production CA using literal `\n` separators. Configure the same value on Vercel. |
| `TWENTY_CRM_BASE_URL` | HTTPS origin of the existing Twenty CRM service. Required for live authorization before CRM reads. |
| `TWENTY_CRM_API_KEY` | Existing server-side CRM credential. Used for REST GETs and a fixed GraphQL role query over POST. No mutations are sent. Never supply this credential to employee harnesses. |
| `CONTEXT_API_KEYS_JSON` | JSON array of employee key registrations. Only hashes belong in this variable. |
| `CONTEXT_ALLOWED_ORIGINS` | Optional comma-separated exact browser origins allowed to make authenticated requests. Wildcards are not supported. |
| `CONTEXT_REQUESTS_PER_MINUTE` | Request budget per employee key, per application process. Default `30`; permitted range `1`–`120`. This is not a deployment-wide quota. |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID. Authorize the exact console callback URI in Google Cloud. |
| `GOOGLE_CLIENT_SECRET` | Matching Google OAuth client secret, server-side only. |
| `CONTEXT_CONSOLE_ORIGIN` | Exact console HTTPS origin, or local HTTP origin for development. |
| `CONTEXT_SESSION_SECRET` | Independent 32-byte base64url secret for signed browser sessions. |
| `CONTEXT_KEY_ENCRYPTION_SECRET` | Independent 32-byte base64url secret for encrypted API-key retrieval. Preserve across deployments. |
| `CONTEXT_CONSOLE_WRITES_ENABLED` | Set to `true` only after the required private console/OAuth storage has been migrated. Business-data reads remain read-only. |
| `CONTEXT_MCP_ENABLED` | Optional MCP/OAuth kill switch. Set `false` to disable; unset is enabled when the required configuration and storage are ready. |
| `CONTEXT_MCP_ALLOWED_REDIRECT_ORIGINS` | Optional comma-separated additional exact HTTPS callback origins for trusted MCP clients. No wildcard. Built-in Claude rules apply by default. |

A key registration has this shape:

```json
[
  {
    "id": "employee-client-label",
    "hash": "SHA256_OF_THE_RAW_KEY",
    "employeeEmail": "employee@wareongo.com",
    "scopes": ["knowledge:read", "warehouses:read", "crm:read"],
    "expiresAt": "2026-12-31T23:59:59.000Z"
  }
]
```

Use the key script to generate a real key and matching registration. Keys default to all three read scopes and expire after 30 days. Set `--scopes knowledge:read,warehouses:read` for a smaller grant or `--days` for an expiry between 1 and 90 days. Create separate keys for employees and clients where practical.

Revoke a local registration with:

```sh
node scripts/revoke-key.mjs --label local-trial
```

Restart the local server for the registry change to take effect. For Vercel, replace the deployment's `CONTEXT_API_KEYS_JSON` value and redeploy; changing a local file does not revoke a deployed key. Revocation leaves the local credential file in place; use a new label when issuing a replacement. Never use `NEXT_PUBLIC_` variables for credentials, put keys in URLs, or commit real environment files.

## Private knowledge storage

Company pages are stored as Markdown bodies plus metadata in `context_engine_private.knowledge_pages`. The table contains `id`, `title`, `summary`, `body`, `updated_at`, `status`, and `scopes`. Runtime knowledge reads use the same employee-authenticated API and bounded read-only database transactions as other context reads. They return only `reviewed` pages whose required scopes are all present in the employee's effective access. Drafts remain unavailable to agents. There is no repository-content or filesystem fallback.

Keep import sources in the ignored `.local/knowledge-import` directory. Each source file is a regular Markdown file with YAML frontmatter containing `id`, `title`, `summary`, `updatedAt`, `status`, and `scopes`. IDs use lowercase hyphen-separated words, dates use `YYYY-MM-DD`, status is `draft` or `reviewed`, and scopes include `knowledge:read` plus any additional required service scopes. The import preserves draft status and page requirements; it does not approve the material for release. Do not add real page bodies, titles, internal reports, or employee details to public documentation, test fixtures, or example seeds.

A trusted database administrator can validate and import a prepared private batch:

```sh
node scripts/migrate-knowledge.mjs \
  --source .local/knowledge-import --expected-count N --validate-only
node scripts/migrate-knowledge.mjs \
  --source .local/knowledge-import --expected-count N
```

Replace `N` with the exact number of prepared files. The script reads database configuration from `.env.local` by default; `--env-file` selects another private administrative environment file. This is a one-off administrative write operation, separate from the agent-facing API. It creates and verifies the private schema/table, imports the batch in a bounded transaction, and checks the stored content against the source without printing document bodies. It requires the administrator privileges expected by the script, including RLS bypass. Identical imports are idempotent; conflicting existing content or incompatible database objects are rejected rather than overwritten.

The schema/table revoke access from `PUBLIC` and Supabase's standard API roles, and the table has row-level security enabled and forced. Keep this schema out of the Supabase Data API's exposed schemas. Employee context keys grant access through this application's checks; they are not Supabase credentials. Any replacement runtime database role needs deliberately configured private-table access, while employee endpoints continue to run read-only transactions.

Maintain pages through the authenticated admin console once console writes are enabled. Review content and scope requirements before marking a page `reviewed`. Set it to `draft` to withdraw it from agent access. Ordinary page edits take effect through database reads and do not require an application rebuild. Console write routes are separate from the read-only employee API and never update warehouse or CRM records.

Private import files and local harness reports stay outside Git. `.local/`, `content/`, and `knowledge-imports/` are ignored to prevent accidental inclusion. Public repository documentation describes API behaviour and setup only; it is not the organisation's wiki.

## API

Configure the harness to send this header over HTTPS:

```http
Authorization: Bearer YOUR_EMPLOYEE_CONTEXT_KEY
```

| Endpoint | Purpose | Required access |
| --- | --- | --- |
| `GET /api/v1/context` | Employee capabilities, server clock, and discovery links (no wiki query) | Valid employee key |
| `GET /api/v1/context.md` | Markdown starting context for an agent | `knowledge:read` |
| `GET /api/v1/wiki/pages?limit=10` | Browse reviewed metadata; follow `nextCursor` | `knowledge:read` |
| `GET /api/v1/wiki/search?q=shortlisting&limit=5` | Search reviewed knowledge; follow `nextCursor` with the same query | `knowledge:read` |
| `GET /api/v1/wiki/pages/{id}` | Read a page; add `?format=markdown` for Markdown text | `knowledge:read` |
| `GET /api/v1/warehouses` | Filter warehouse specifications | `warehouses:read` |
| `GET /api/v1/warehouses/filters` | Discover filter definitions and current category options; optionally narrow by city/state | `warehouses:read` |
| `GET /api/v1/warehouses/summary` | Count all matching visible warehouses and return bounded groups | `warehouses:read` |
| `GET /api/v1/warehouses/{id}` | Read one warehouse's permitted fields | `warehouses:read` |
| `GET /api/v1/crm/opportunities` | Search created/assigned leads, or all leads for Twenty admins | `crm:read` |
| `GET /api/v1/crm/filters` | Discover permitted cities, supported categories, temporal filters and sorts | `crm:read` |
| `GET /api/v1/crm/summary` | Count the full matching pipeline by stage, city, priority, source or duration | `crm:read` |
| `GET /api/v1/crm/opportunities/{id}` | Read an authorized opportunity | `crm:read` |
| `GET /api/v1/crm/opportunities/{id}/context` | Read one bounded notes, tasks, company or stage-history section | `crm:read` |
| `GET /api/v1/crm/my-briefing` | Get permitted facts for the employee's briefing | `crm:read` |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 description | Public |
| `GET /api/health` | Process liveness; does not query source data | Public |

CRM search accepts `q` (permitted lead/company labels), `city`, `requirement_sqft_min`, `requirement_sqft_max`, `micro_market`, `lead_source`, `lease_duration`, `industry`, `repeat_client`, `stage`, `view`, `assigned_to=me`, `active_only`, `priority_min`, `follow_up_status`, date filters, `sort`, `limit`, and `cursor`. All supplied filters combine with AND. Discover supported category enums and their meanings at `/api/v1/crm/filters`; enum lists describe supported vocabulary, not observed counts. Requirement bounds are inclusive positive integers up to one billion sqft. Parsed ranges match on overlap; approximations remain provisional candidates. Missing or unsupported areas do not match. The `requirement_sqft` scalar holds exact values only; explain ranges and approximations using `field_evidence.requirement_sqft` and the verification flag. `micro_market` matches the full recorded label, ignoring case and surrounding spaces; it does not split commas like `city`. `industry` matches membership in the recorded industry array. `repeat_client=true|false` excludes missing, malformed and contradictory source flags. No budget or monetary-value filters are provided.

The default `view=accessible` returns created-or-assigned leads for employees and all mirrored leads for verified Twenty admins. `view=created` and `view=assigned` narrow both roles to their own records. `assigned_to=me` aliases `view=assigned`; combining `view` with `assigned_to` is rejected.

Search, detail and briefing priorities include the same structured fields: `lead_source`, `lease_duration`, `industry_verticals`, `occupancy_timelines`, `preferred_languages`, `repeat_client`, `budget`, `recorded_value`, `last_note_at`, `last_task_at`, `recorded_follow_up_count`, `close_date` and `ownership`. They are projected from the same mirrored opportunity row as the lead's main fields, with bounded parsing in the application; list reads do not trigger per-lead enrichment requests or separately cached profiles. `field_evidence` distinguishes `missing`, `parsed` and `unsupported`: an unsupported recorded value is different from a missing source field and can include a bounded masked source view. Recorded source, duration and repeat-client values can be automation defaults, so they must not be represented as confirmed customer statements.

`budget` preserves an exact numeric value, range, lower bound, upper bound or unknown interpretation. Bound objects include `bound_inclusive`; currency, charging period and area basis appear only when explicit in the recorded text. `25` must not become “₹25 per sqft per month”. The evidence source is masked and bounded before it is exposed. `recorded_value` preserves validated nonnegative `amount_micros` and its decimal `amount` as strings to avoid rounding; explicit zero differs from missing, and currency can be null. This is not established revenue, agreed rent, client budget or brokerage income. Both non-null monetary objects carry `verification_required: true`. The service does not compare or sum them. Note/task timestamps describe recorded activity, not open tasks or complete history; `recorded_follow_up_count` is the source counter, not a computed task or contact count. Each CRM response includes `field_semantics` with these interpretation limits.

Recorded ownership separates creator/updater, demand-side assignees, supply-side owners and owner workspace-member ID. These fields do not grant permission; a close date does not prove closure. Lead detail adds the recorded description and loss reason as masked text. Use `/crm/opportunities/{id}/context?section=notes|tasks|company|stage_history` for one related section at a time, with a small `limit` and the returned cursor. Each read retains the lead's employee permissions; company or shared-activity relationships do not broaden access. Related source reads have their own fetch times and coverage limits. They are not atomic with the mirrored lead, and an observed stage timeline is not proof of complete history. Narrative fields include `state`, `text`, `redacted` and `truncated`; unsupported formats are labelled, and a truncated text is not the entire source.

Every lead includes `verification_required`. When true, the agent must explicitly say its recorded data needs verification. The flag covers recorded area, monetary values and unsupported fields; even an exact numeric parse is not independent confirmation of a customer's requirement. Notes/tasks use at most two bounded upstream reads for a page: lead targets, then a batch of related records and their relationship checks. They share an eight-second source-read deadline, make no per-item requests and hold no database connection while waiting. Company context uses one upstream read; authorization is rechecked before any related response is returned.

Warehouse and CRM searches accept `period` (including `today`, `this_month`, `tomorrow`) or inclusive India-calendar `date_from`/`date_to`. `date_field` defaults to `created`; CRM also supports follow-up and activity clocks. Responses echo resolved UTC bounds and server time. Source creation dates are warehouse `created_at` and CRM `source_created_at`; mirror poll/insertion dates never substitute for them. Every sort uses opaque cursors bound to the collection, filters and resolved dates. Legacy cursors require restarting without a cursor; a relative window crossing midnight requires a new search. Keep filters and sort unchanged between pages. Collections default to 10 records, maximum 25; their size is not a total. Wiki search requires a query of at most 120 characters; search and index pages permit at most 10 results and return `nextCursor`. They search the full permitted collection without a 500-document cutoff.

`/api/v1/warehouses/summary` and `/api/v1/crm/summary` apply the same search predicates and permissions, returning full `total`, bounded `groups`, `groups_truncated` and `other_count`. They accept `group_by`/`group_limit`, without pagination or sorting. CRM groups by `stage`, `city`, `priority`, `lead_source` or `lease_duration`, with exactly one group per matching lead. These are current recorded classifications, not historical conversion rates or verified attribution. Dates and warehouse uncertainty still apply to these counts. No endpoint exposes raw SQL, arbitrary field selection or writes.

### Warehouse discovery and matching

Start with `GET /api/v1/warehouses/filters?city=Bengaluru` when you need available filter names or category values. The response contains the filter `catalog`, current `options`, and a `truncated` flag. Options come only from visible records and are sanitised, with at most 100 values per category. The endpoint accepts only optional `city` and `state` filters. The OpenAPI search parameters are generated from the same catalog used by the implementation.

| Filter group | Parameters |
| --- | --- |
| Location and category | `city`, `state`, `zone`, `micromarket`, `type`, `availability`, `status`, `listing_type`, `flooring_type`, `land_type`, `pollution_zone`, `water_supply`, `suitable_for` |
| Recorded flags | `verified`, `fire_noc`, `lift_access`: each accepts `true`, `false`, or `unknown` |
| Total area | `area_min_sqft`, `area_max_sqft` |
| Offered area | `offered_area_min_sqft`, `offered_area_max_sqft` |
| Asking rate | `min_rate`, `max_rate` |
| Docks and washrooms | `docks_min`, `docks_max`, `washrooms_min`, `washrooms_max` |
| Dimensions | `clear_height_min_ft`, `clear_height_max_ft`, `gate_width_min_ft`, `gate_width_max_ft`, `plinth_height_min_ft`, `plinth_height_max_ft`, `dock_apron_min_ft`, `dock_apron_max_ft`, `approach_road_min_ft`, `approach_road_max_ft` |
| Power | `power_min_kva`, `power_max_kva` |
| Dates | `date_field`, `period`, `date_from`, `date_to` |
| Matching and pagination | `match_mode`, `include_unknown`, `sort`, `limit`, `cursor` |

All supplied filters are combined with AND. Category matching trims whitespace and ignores case; it is not a substring or semantic search. `Bangalore`/`Bengaluru` and `Gurgaon`/`Gurugram` are recognised city aliases. Area bounds must match a single entry among the first 100 entries in `total_space_sqft`, matching the response cap; entries are never added together. Offered area remains a separate field. Use the catalog for supported bounds and units; do not invent a missing category value or interpret `unknown` as `false`.

`zone` means the national operating region, not a direction within a city. Availability labels such as `Yes` and `Immediate` remain distinct. Water supply `NONE` records absence; it is different from a missing value.

The default `match_mode=permissive` includes recorded ranges and approximate values when they plausibly meet the numeric constraints. For example, a hypothetical dock count recorded as `2–4` can match `docks_min=3` because its range overlaps the requirement. The numeric `dock_count` remains `null`; `field_evidence.dock_count` records the range, and `verification_required` tells the agent to identify the candidate as needing verification. It must not claim that the property has three confirmed docks.

Use `match_mode=strict` to exclude approximate and ranged values for constrained measurements. `include_unknown=false` is the default; `include_unknown=true` independently admits candidates with missing or uninterpretable constrained numeric fields and flags them for verification, including in strict mode. Thus, `match_mode=strict&include_unknown=true` accepts exact or unknown constrained values but still excludes approximations and ranges. Unknown matching does not waive category, flag, visibility, or other access restrictions. Unconstrained fields can still be unknown under either mode.

Warehouse list responses include `data.matching_policy` with `mode`, `include_unknown`, `range_matching`, and guidance. Every warehouse result/detail includes `field_evidence` and `verification_required`. Evidence kinds are `exact`, `approximate`, `range`, and `unknown`, with an optional parsed `value`, range `lower`/`upper`, and sanitised measurement `source`. **An agent must explicitly state which flagged candidates require verification and why.** The evidence flag is separate from the stored `verified` indicator; neither guarantees current physical specifications or availability.

Supported measurement formats include recognised feet/metres and square-foot units, ordinary comma-separated numbers, approximations, and bounded ranges. Conversion applies only to recognised measurements in the relevant specification field. The parser does not extract arbitrary digits from notes, contacts, or descriptions. Unsupported text remains unknown. Parser support is not a full audit of every record or a guarantee that recorded fields are correct. Category options are bounded observations, and missing fields can exclude viable properties unless the appropriate unknown-matching option is chosen.

Example candidate search:

```http
GET /api/v1/warehouses?city=Bangalore&area_min_sqft=40000&area_max_sqft=80000&docks_min=3&clear_height_min_ft=28&match_mode=permissive&limit=10
```

For broader research, add `include_unknown=true` and clearly identify what needs checking. For a comparison restricted to exact recorded measurements, use `match_mode=strict&include_unknown=false`. In both cases, review the evidence rather than presenting a filter match as a completed property verification.

JSON success responses follow this shape:

```json
{
  "data": { "items": [], "nextCursor": null },
  "meta": {
    "requestId": "request-reference",
    "generatedAt": "2026-09-25T00:00:00.000Z"
  }
}
```

`data` contains the endpoint's payload; the `items` and `nextCursor` fields apply to paginated record collections. The context response returns the employee's internal ID, effective scopes, clock, discovery links, and access constraints. `knowledge_discovery.status=not_checked` means knowledge health is checked only when queried; a wiki failure does not prevent capability discovery. It does not return the employee's email.

Bootstrap constraints distinguish contact masking from omitted raw fields: `contacts: "masked_or_excluded"`, `narrative_context: "redacted_lead_context"` and `media: "excluded"`.

`generatedAt` is response time, not proof that a source record was recently checked. Use record-level timestamps and verification fields when present. Every successful CRM response includes `data.source_status` with the `opportunities`, `notes`, and `tasks` streams' source watermark, last run time, and status, plus `data.access_scope` (`all`, `created_or_assigned`, `created`, or `assigned`). Core lead facts and observed stage history come from the local CRM mirror and inherit its synchronisation delay. Related notes, tasks and linked company context are read from live Twenty with separate fetch and source clocks. `all` means all non-deleted mirrored records, not proof of complete real-time replication. Live Twenty establishes record visibility; the mirror alone cannot grant access.

CRM reads fail with `503` and error code `CRM_SOURCE_STALE` if the opportunity stream is missing, its latest run did not succeed, or its latest run is more than 30 minutes old. Restore CRM Automations' polling before retrying. This freshness check protects the quality of returned facts and runs in addition to live authorization. `activity_status` separately reports `current` or `degraded`, naming missing, failed or stale note/task streams in `unavailable_streams`; a fresh opportunity can still have incomplete activity coverage. Even `current` does not establish complete history or identical upstream poll times. The notes/tasks context sections expose bounded masked text; their live fetch clocks are separate from this mirror-stream health metadata.

Every CRM response includes `read_consistency`: `database_snapshot: "repeatable_read"`, `transaction_started_at`, `lead_fields: "same_row"` and `cross_request_snapshot: false`. The mirrored lead rows, aggregates and checkpoint markers within a response use one bounded, read-only repeatable-read database transaction. Related responses add related_sources_atomic: false; their live records are not part of that database snapshot. This prevents a poll arriving between statements from mixing newer stream metadata with older lead facts, or newer briefing counts with older priorities. It does not synchronise independently polled source streams, and live Twenty permission checks remain separate from that database snapshot. A subsequent detail read or pagination request takes a new snapshot and may observe newer records. Keep source timestamps with answers; do not treat response time as source freshness.

Relevant HTTP statuses are `400` or `422` for invalid inputs, `401` for invalid credentials, `403` for unavailable scope or inactive employees, `404` for unavailable records, `405` for unsupported methods, `414` for request URLs longer than 4,096 characters, `429` for request limits, and `503` for temporary service, freshness, or database failures. Errors return `{ "error": { "code": "ERROR_CODE", "message": "Explanation" }, "meta": { "requestId": "...", "generatedAt": "..." } }`. Authenticated responses use private, no-store cache controls.

The harness must support authenticated HTTP requests. Import the OpenAPI document when supported, or configure ordinary GET tools. Put the employee key in the harness's credential store and start the agent at `/api/v1/context.md`. Reading a URL in a plain chat does not automatically supply authentication.

## Access and data handling

The server validates the API key, its expiry, and the employee's active roster status for authenticated requests. Warehouse access additionally requires dashboard or administrator access in that roster; CRM access requires a linked CRM user. Effective scopes can therefore be narrower than a key's registration. An administrative dashboard role does not grant access to another employee's opportunities here.

Each CRM request checks the active roster and releases its database connection before querying Twenty. It matches the employee's email and linked workspace-member ID against the live member list, then reads live role membership. Admin access requires membership in Twenty's built-in Admin role with its immutable universal identifier and expected non-editable, full-settings, full-read flags. Role names, an API key's own privileges, the dashboard's `adminAccess`, and Twenty's `canReadAllObjectRecords` flag alone cannot grant admin access. The regular Twenty Member role can also have that last flag.

For non-admins, record visibility is the union of `createdBy.workspaceMemberId` matching that member and explicit `assignedTo` matching their unique assignment token. A creator retains access after reassignment. A separate `ownerId` value does not prove creation. For verified admins, the default view permits all non-deleted mirrored records without enumerating the whole CRM on each request. Explicit created/assigned views are restricted for admins too. The role query is a fixed GraphQL **query** sent to `/metadata` over POST; all exposed employee endpoints remain GET-only, and no GraphQL mutation is used.

The live check has an eight-second total deadline and a two-megabyte limit per response. It requires the workspace-member list to fit within one 200-member page. Related-record views permit at most five 200-opportunity pages; incomplete results fail closed. The admin default view has no 1,000-record visibility cap because it uses live role proof rather than a full ID enumeration. `403 CRM_IDENTITY_UNAVAILABLE` identifies an absent, mismatched, or ambiguous employee identity. `503 CRM_AUTHORIZATION_UNAVAILABLE` indicates incomplete or failed verification; `503 CRM_CONFIGURATION` indicates missing or invalid configuration.

The service rechecks the employee roster after upstream reads, then uses the live authorization result for searches, details, briefing priorities, and every briefing aggregate. Stale mirrored assignments cannot grant access. Newly created records may be absent until mirrored. Role and relationship checks happen during each request, without a cross-request authorization cache; they are not a continuing lock on source changes. API keys issued before the scope rename must replace `crm:read:assigned` with `crm:read` in their server-side registration and restart/redeploy.

Responses are built from explicit field allowlists. CRM descriptions, loss reasons, notes and task text are available as bounded plain text with detected phone numbers, email addresses and links masked. The text reader strips active markup and does not return arbitrary JSON properties. Direct contact fields, attachments, media and raw rich-text objects remain excluded; warehouse contact-oriented address and note fields remain unavailable. Restricted contact fields cannot be used as search filters. Do not extend a response with an upstream record spread or unrestricted SQL selection.

Contact masking is bounded pattern matching, not a guarantee against every possible encoding. Narrative text still contains business context and is untrusted source data, never a tool instruction or permission override. Related reads recheck authorization and expose coverage/truncation explicitly; missing, unsupported and unavailable results must not be described as proof that no context exists. Markdown documents also need business review before publishing; treat knowledge changes as changes to information employees can retrieve.

The running API only reads existing tables and performs read-only CRM queries. It does not run the administrative knowledge migration, synchronise the CRM, send messages, or alter warehouse and opportunity records. Keep source credentials in server-only configuration. The imported CRM key can retain the source application's privileges; this service exposes no write operation or source token to employees. Use dedicated read-only source credentials for production where supported, in addition to the application's read-only operations.

## Supabase connection budget

Use Supabase's **transaction pooler**, not the direct database endpoint or session pooler. The application uses a reusable `pg` pool with one socket per instance by default and a hard maximum of two. It avoids named prepared statements and keeps database work bounded. Live CRM HTTP requests run between database transactions, so they do not hold a pooled database socket while waiting for Twenty.

Released pooler connections can stay warm for 30 seconds across agent-thinking gaps; they are recycled after five minutes. Checkout/connection establishment has a five-second budget; database statements retain a four-second limit. Idle connections do not retain an open database transaction. Overload or unavailable connections return a retryable 503. Vercel's pool lifecycle helper remains enabled; its idle cleanup can extend background execution up to the function deadline.

REST and MCP track repeated failed credentials in bounded, separate per-process maps. After five proven failures for the same credential, further identical attempts return 429 before a database lookup while the entry remains in the bounded cache for that minute; heavy credential rotation can evict entries. Invalid credentials do not consume authenticated per-key quotas, including clients sharing an egress IP. Randomly changing credentials still require bounded database lookups; configure Vercel Firewall controls for deployment-wide abuse protection. Authenticated API keys retain their normal per-key limit (30 requests per minute by default).

That pool size is **per instance**, not a global connection cap. Vercel can start several instances, each with its own pool. Before a wider employee rollout, set an appropriate Supabase pool limit, configure Vercel Firewall/rate controls, and check database connection usage under the expected concurrency. Keep production and preview credentials separate; preview deployments should not silently inherit production access.

## Validation and deployment

```sh
npm run test
npm run typecheck
npm run build
```

The tests run with Vitest and do not require production database credentials. Review the sanitised responses with a test employee before distributing keys.

For the console's desktop and mobile browser checks:

```sh
npx playwright install chromium
npm run test:gui
```

These tests start a local server if needed and intercept every console request with synthetic fixtures. They cover Google sign-in navigation and callback errors, employee/admin views, credential-free MCP setup copying, separate key copying, rotation confirmation, Markdown import, revision conflicts, unsaved changes, and the deferred-storage state. OAuth consent checks use synthetic application metadata and keys. They do not use real credentials or write to Supabase. Browser artifacts stay under ignored `.local/browser-results/`.

After private storage is configured, `npm run test:console:live` checks its permissions and exercises admin knowledge creation, publishing, draft visibility, and revision conflicts inside an outer transaction that is always rolled back. It uses one database socket and retains no test pages. This opt-in check selects an existing active roster admin without printing their identity; it tests database authorization, not a real Google login.

`npm run test:mcp:live` explicitly tests the configured local server using the ignored `.local/keys/local-trial.json` employee key. Override with `-- --key-file PATH --origin https://YOUR_HOST` when needed. It registers a test connector, approves a browser-bound PKCE grant, calls read tools through the official MCP client, rotates tokens, checks replay revocation, and revokes its grant on completion. Registration and revoked-grant records remain private in OAuth storage; no source records are edited. Output contains only counts and status codes, never keys or returned business records. A CRM source failure is reported as a source error rather than an empty lead list.

The live MCP check also exercises warehouse additions today, matching totals, CRM leads created this month, scoped filter discovery and tomorrow's follow-ups. `npm run test:warehouse:live` verifies actual warehouse SQL and timestamp semantics with one read-only pooled socket. `npm run test:crm-query:live` runs real PostgreSQL query builders against synthetic VALUES fixtures only; it checks permissions, date boundaries, stable pagination, counts and private-label search exclusion without reading CRM rows.

`npm run test:tooling:agent` discovers the live MCP schemas through a temporary OAuth test grant, revokes that grant, then uses the dashboard's configured OpenAI key to evaluate thirteen ordinary employee questions against synthetic data. Credentials and business records are never supplied to the model. The run is bounded to 48 model calls and six tool calls per case. Reports stay under ignored `.local/tooling-eval/`; they contain synthetic evidence and grades, without raw model reasoning or credential values. Use `-- --origin http://localhost:3000` to target the canonical local server.

With the local server running, exercise the real API and database path from a second terminal:

```sh
npm run test:smoke -- \
  --base http://localhost:3000 \
  --key-file .local/keys/local-trial.json
```

Use the credential file created during setup, or supply an existing employee key file. The smoke script's defaults are `http://127.0.0.1:3000` and `.local/keys/local-trial.json`; the explicit arguments above match the generic local setup. The key must have all three scopes and the corresponding employee service access. An already configured checkout can reuse its key without rerunning the import or key-generation scripts.

This check makes bounded read requests for the knowledge index, warehouse search/detail, CRM default/created/assigned views, record detail, and briefing. It also verifies unauthenticated rejection, blocked contact filters, and selected excluded response fields. It reads the key from disk and prints route/status summaries without printing the key or record payloads. To check a deployed instance, pass its HTTPS origin as `--base`; the script sends the selected employee key to that origin and refuses redirects.

For an actual model-driven REST client, see [the toy OpenAI harness](docs/harness.md). It loads the OpenAI key directly from the dashboard environment at runtime and keeps it out of this application's deployment configuration.

Keep live verification reports and inventory analyses in private storage or appropriately restricted knowledge pages. Publish only synthetic fixtures and generic test procedures in this repository.

When CRM returns `503 CRM_SOURCE_STALE`, the smoke check reports that CRM access was safely blocked and continues. That result confirms the freshness guard; it does **not** confirm successful CRM data reads. Restore the opportunity stream's successful sync within the last 30 minutes and rerun to exercise those reads. Other unexpected errors fail the smoke check.

To deploy on Vercel, import this repository or select `Context_Engine` as the root directory when importing its parent. Use the Next.js preset and add the server-side environment variables in Vercel. Set a deployment region appropriate for the Supabase region. The public health route checks process liveness; use an authenticated context request to verify the configured employee and database path.

Deployments are not created automatically by this scaffold. Deploy application code and server-side configuration without copying private knowledge documents into the build. Knowledge changes are read from PostgreSQL; changing environment-based key registrations still requires updating the deployment configuration and redeploying.


### MCP hardening and remaining deployment checks

MCP uses thirteen focused tools. `get_context` supplies capabilities and the clock without loading company pages. `search_knowledge` accepts an optional `q`: omit it to browse, or supply it for ranked snippets. Both return a bounded page and `nextCursor`. `read_crm_lead_context` retrieves one related CRM section without making every search return all narrative history. Read full documents and related context only when relevant.

`search_warehouses` defaults to `response_format=concise`. It returns location, core measurements, measurements constrained by the query, source timestamps, verification flags and relevant evidence. Every recorded estimate/range that triggers verification remains present. Use `response_format=detailed` or `read_warehouse` for all permitted fields. Omitted fields are not evidence of absence. REST warehouse results retain their detailed format. MCP `warehouse_filters` returns recorded category options without repeating the catalog already present in the search schema.

Unused OAuth registrations expire after 30 minutes and are cleaned up during registration only when they have no grants. Clients with grants are preserved and do not count toward the 2,000 pending-registration cap. Anonymous DCR has a bounded per-source, per-process allowance using Vercel's trusted client-IP header; local deployments share an unattributed fallback. Active connections, PKCE, audience binding, token rotation and immediate key/grant checks remain intact. Sanitized OAuth lifecycle events omit credentials, IPs, identities and source payloads. No new environment variable or database migration is required for these changes.

Single-lead CRM reads verify only that requested ID against live Twenty permissions. Bulk created/assigned reads (including non-admin accessible reads) still require a complete authorization set and fail closed above the existing 1,000-record bound; they do not silently return a partial total. Larger bulk workloads require a separately designed authorization/query path. No permission cache was introduced.

Pool limits of 1–2 sockets and local request queues apply to each Node instance. Keep Supabase transaction mode on port 6543. Before increasing employee traffic, review the project's Supabase pooler capacity and Vercel instance/concurrency settings and configure deployment-wide WAF rules. This repository does not establish a fleet-wide connection budget. [Vercel pooling guidance](https://vercel.com/kb/guide/connection-pooling-with-functions), [WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).

After deployment, refresh the connector's tool definitions or reconnect if the harness caches schemas. Restart any in-progress query carrying an old cursor. Employee keys and connected OAuth grants remain valid. MCP citation paths retain the endpoint and filters but omit pagination cursors; record IDs and `meta.requestId` identify the returned evidence.
