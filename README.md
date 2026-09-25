# Wareongo Context

A read-only REST, Markdown, and remote MCP context service for employee AI tools. It combines reviewed company guides with permitted warehouse facts and CRM opportunities. Employees see leads they created or are assigned to; verified Twenty admins see all mirrored leads. The same Next.js deployment hosts the `/mcp` endpoint and an administrator console for agent setup and Markdown editing.

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

Run these commands from this directory. Adjust the source environment paths to the files used by your local applications. The import script requires matching Supabase pooler credentials in the two source applications, selects transaction port `6543`, and creates `.env.local` with a one-connection pool. It also copies `TWENTY_CRM_BASE_URL` and `TWENTY_CRM_API_KEY` from CRM Automations for server-side, read-only authorization checks. The source key needs permission to read members, opportunities, and role metadata. R2, OpenAI, and messaging credentials are not imported. It does not edit the source files or overwrite a different existing database configuration. Use `.env.example` as a reference for optional settings; do not copy its placeholder database URL over your imported configuration.

The employee email must match an active employee in the dashboard's roster. Key issuance writes the hashed registration to the ignored `.env.local` file and the raw key to `.local/keys/<label>.json`, also ignored by Git. For the command above, the credential file is `.local/keys/local-trial.json`. Use that file to configure the test client's credential store. The script does not print the raw key to the terminal.

The example email is a placeholder; supply the intended employee's actual roster email privately. Initialise the private knowledge table once using the administrative import described below before testing knowledge reads. An already configured database does not need its knowledge reimported for a new checkout or deployment.

The CA setup script downloads Supabase's public production CA from the URL used by its official dashboard, checks its pinned fingerprint and validity, and sets `PG_SSL_CA` without changing TLS verification. It saves the public certificate in `.local/supabase-ca.crt`. To use an already downloaded copy, run `node scripts/setup-ca.mjs --from-file .local/supabase-ca.crt`; the same validation applies. See [Supabase's SSL documentation](https://supabase.com/docs/guides/platform/ssl-enforcement). A future CA rotation requires reviewing and updating the pinned fingerprint.

Open `http://localhost:3000` for the console and `/api/v1/openapi.json` for the public OpenAPI description. Authenticated records and Markdown pages require a bearer key. Restart the development server after changing environment-based registrations.

## Browser console

Configure the console without changing the database:

```sh
npm run setup:console -- --email employee@wareongo.com --origin http://localhost:3100
npm run dev -- --port 3100
```

The setup script generates a single random administrator password in `CONTEXT_ADMIN_PASSWORD`, stores the owning employee in `CONTEXT_ADMIN_EMAIL`, and creates independent session and key-encryption secrets in ignored `.env.local`. It preserves existing passwords and key-encryption secrets on repeat runs and never prints them. It removes obsolete Google credentials from this application's environment. Use an exact HTTPS `CONTEXT_CONSOLE_ORIGIN` in production. This password sign-in is separate from the employee-key OAuth connection used by MCP clients.

The console accepts only the configured administrator password. Its configured employee must have a unique active dashboard roster entry, which is checked again on every request. Password comparison uses fixed-length cryptographic digests; a shared per-process login budget limits guessing before database access. Sessions use signed HttpOnly cookies with an eight-hour expiry, and mutations require the configured origin. Console administration grants knowledge editing; the agent key's warehouse and CRM scopes still follow the owning employee's source access. This version has no employee self-service sign-in.

The administrator can copy the MCP server URL, credential-free connection steps, REST instructions, and the owning employee's API key separately. The REST instructions work only with clients already equipped to make authenticated HTTP requests. Pasting a prompt, URL, or API key into ordinary chat does not install that capability. Never paste a raw API key or administrator password into chat. Keys are masked by default, expire after 30 days, and can be rotated from the console. They are stored as an authentication hash plus an encrypted copy for retrieval after login. Keep the encryption secret backed up privately; losing or rotating it requires reissuing console keys. No credentials are saved in browser local storage. The console password is not an agent API key.

Admins can create pages, import `.md` text, edit metadata and required scopes, and publish reviewed material. New pages start as drafts; agent reads exclude drafts. Concurrent edits are rejected for review instead of silently overwriting another editor's changes. Publishing knowledge does not require a deployment.

For a new database, run `npm run console:migrate -- --apply`, then set `CONTEXT_CONSOLE_WRITES_ENABLED=true` and restart or redeploy. This creates and verifies the private console credential store; it does not import or overwrite organisational pages. Without `--apply`, the command only prints its plan. Setup scripts never automatically apply migrations, and writes default to disabled for new checkouts. The agent-facing `/api/v1` API remains read-only regardless of this flag.

Console rotation replaces only the current console-issued key. Keys registered separately through `CONTEXT_API_KEYS_JSON` remain valid until explicitly revoked from that registry.

## Connect an MCP client

The remote MCP URL is `https://YOUR_HOST/mcp`, on the same deployment as the REST API and console. It is a protocol adapter over the existing read-only context engine; employee identity, scopes, field allowlists, warehouse uncertainty, and CRM visibility/freshness checks still apply. The browser administrator password does not authenticate an MCP client.

For Claude:

1. Add a custom connector using the public HTTPS MCP URL. A local development URL is not reachable by a hosted client.
2. When Wareongo Context opens its authorization page, review the requesting application's identity, redirect origin and complete redirect URI, and requested read permissions.
3. Enter the employee API key for the intended person on that authorization page and select **Connect**. The key belongs in this form, not in the conversation or connector URL.
4. Return to Claude and enable the connector for the conversation. If custom connectors are unavailable in that account or workspace, the console's REST instructions cannot add them.

The authorization page is independent of admin-console sign-in. It submits the employee key only in a POST body, clears it after each attempt, and does not save it in browser storage. The page shows the actual requesting application; entering a name such as “Claude” is not proof of that application's identity. Confirm the displayed origins before authorizing. Source-system credentials are never supplied to the client.

Before enabling connections in a new database, inspect the OAuth storage plan with `node scripts/migrate-mcp-oauth.mjs`, then apply it deliberately with `node scripts/migrate-mcp-oauth.mjs --apply`. MCP uses the existing console origin, server secrets, and private-storage write flag; no additional mandatory secret is introduced. Set `CONTEXT_MCP_ENABLED=false` to disable MCP and its OAuth flow. Built-in Claude callback rules are configured by the service; `CONTEXT_MCP_ALLOWED_REDIRECT_ORIGINS` optionally adds exact HTTPS origins for other trusted clients. The registered redirect URI must still pass the server's validation. Local callback exceptions apply only to an explicitly configured local HTTP console.

The `/oauth/authorize` browser page obtains a short-lived, browser-bound consent request from `/api/oauth/authorize`. Approval requires an explicit POST with the employee key; denial submits no key. OAuth client registration, code exchange, and revocation are protocol endpoints, not permission to edit warehouse or CRM records. Their state is stored in the private `context_mcp_private` schema. Access tokens last up to 15 minutes; rotating refresh tokens and grants are bounded by 30 days and the underlying employee key’s expiry. Every read rechecks that key and current access. Revoking or rotating the underlying key invalidates its connector grants once the key change is active in the deployment; clients can also revoke a grant through `/oauth/revoke`. Keep tokens out of source control and browser application storage.

REST endpoints remain available to existing authenticated HTTP clients. Use `/api/v1/context` or `/api/v1/context.md` to discover context and `/api/v1/openapi.json` for the REST schema. A client should report missing tooling, denied reads, unavailable sources, and incomplete coverage instead of inventing records.

The nine MCP tools cover context discovery, knowledge search/read, warehouse filters/search/read, and CRM search/read/briefing. CRM currently exposes no creation-date filter or source creation timestamp: `view=created` means created **by** the employee, not created this month. Tool instructions explicitly disclose that limitation.

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
| `CONTEXT_ADMIN_EMAIL` | Active employee whose identity owns console-issued agent keys. |
| `CONTEXT_ADMIN_PASSWORD` | Single console administrator password, 24–256 characters. Generate privately with `setup:console`. |
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
| `GET /api/v1/context` | Employee capabilities, wiki index, and API entry points | Valid employee key |
| `GET /api/v1/context.md` | Markdown starting context for an agent | `knowledge:read` |
| `GET /api/v1/wiki/search?q=shortlisting&limit=5` | Search reviewed knowledge pages | `knowledge:read` |
| `GET /api/v1/wiki/pages/{id}` | Read a page; add `?format=markdown` for Markdown text | `knowledge:read` |
| `GET /api/v1/warehouses` | Filter warehouse specifications | `warehouses:read` |
| `GET /api/v1/warehouses/filters` | Discover filter definitions and current category options; optionally narrow by city/state | `warehouses:read` |
| `GET /api/v1/warehouses/{id}` | Read one warehouse's permitted fields | `warehouses:read` |
| `GET /api/v1/crm/opportunities` | Search created/assigned leads, or all leads for Twenty admins | `crm:read` |
| `GET /api/v1/crm/opportunities/{id}` | Read an authorized opportunity | `crm:read` |
| `GET /api/v1/crm/my-briefing` | Get permitted facts for the employee's briefing | `crm:read` |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 description | Public |
| `GET /api/health` | Process liveness; does not query source data | Public |

CRM search accepts `city`, `stage`, `view`, `assigned_to=me`, `limit`, and `cursor`. The default `view=accessible` returns created-or-assigned leads for employees and all mirrored leads for verified Twenty admins. `view=created` and `view=assigned` narrow both roles to their own records. `assigned_to=me` aliases `view=assigned`; combining `view` with `assigned_to` is rejected. Record collections default to 10 results with a maximum of 25. Pass the returned `nextCursor` to request another page. Wiki search requires a query of at most 120 characters and permits at most 10 results.

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
| Matching and pagination | `match_mode`, `include_unknown`, `limit`, `cursor` |

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

`data` contains the endpoint's payload; the `items` and `nextCursor` fields apply to paginated record collections. The context index returns the employee's internal ID, effective scopes, permitted knowledge index, API links, and access constraints. It does not return the employee's email.

`generatedAt` is response time, not proof that a source record was recently checked. Use record-level timestamps and verification fields when present. Every successful CRM response includes `data.source_status` with the `opportunities`, `notes`, and `tasks` streams' source watermark, last run time, and status, plus `data.access_scope` (`all`, `created_or_assigned`, `created`, or `assigned`). CRM facts come from the local CRM mirror and inherit its synchronisation delay. `all` means all non-deleted mirrored records, not proof of complete real-time replication. Live Twenty establishes record visibility; the mirror alone cannot grant access.

CRM reads fail with `503` and error code `CRM_SOURCE_STALE` if the opportunity stream is missing, its latest run did not succeed, or its latest run is more than 30 minutes old. Restore CRM Automations' polling before retrying. This freshness check protects the quality of returned facts and runs in addition to live authorization. Notes and tasks are included as freshness metadata; their content is not exposed.

Relevant HTTP statuses are `400` or `422` for invalid inputs, `401` for invalid credentials, `403` for unavailable scope or inactive employees, `404` for unavailable records, `405` for unsupported methods, `414` for request URLs longer than 4,096 characters, `429` for request limits, and `503` for temporary service, freshness, or database failures. Errors return `{ "error": { "code": "ERROR_CODE", "message": "Explanation" }, "meta": { "requestId": "...", "generatedAt": "..." } }`. Authenticated responses use private, no-store cache controls.

The harness must support authenticated HTTP requests. Import the OpenAPI document when supported, or configure ordinary GET tools. Put the employee key in the harness's credential store and start the agent at `/api/v1/context.md`. Reading a URL in a plain chat does not automatically supply authentication.

## Access and data handling

The server validates the API key, its expiry, and the employee's active roster status for authenticated requests. Warehouse access additionally requires dashboard or administrator access in that roster; CRM access requires a linked CRM user. Effective scopes can therefore be narrower than a key's registration. An administrative dashboard role does not grant access to another employee's opportunities here.

Each CRM request checks the active roster and releases its database connection before querying Twenty. It matches the employee's email and linked workspace-member ID against the live member list, then reads live role membership. Admin access requires membership in Twenty's built-in Admin role with its immutable universal identifier and expected non-editable, full-settings, full-read flags. Role names, an API key's own privileges, the dashboard's `adminAccess`, and Twenty's `canReadAllObjectRecords` flag alone cannot grant admin access. The regular Twenty Member role can also have that last flag.

For non-admins, record visibility is the union of `createdBy.workspaceMemberId` matching that member and explicit `assignedTo` matching their unique assignment token. A creator retains access after reassignment. A separate `ownerId` value does not prove creation. For verified admins, the default view permits all non-deleted mirrored records without enumerating the whole CRM on each request. Explicit created/assigned views are restricted for admins too. The role query is a fixed GraphQL **query** sent to `/metadata` over POST; all exposed employee endpoints remain GET-only, and no GraphQL mutation is used.

The live check has an eight-second total deadline and a two-megabyte limit per response. It requires the workspace-member list to fit within one 200-member page. Related-record views permit at most five 200-opportunity pages; incomplete results fail closed. The admin default view has no 1,000-record visibility cap because it uses live role proof rather than a full ID enumeration. `403 CRM_IDENTITY_UNAVAILABLE` identifies an absent, mismatched, or ambiguous employee identity. `503 CRM_AUTHORIZATION_UNAVAILABLE` indicates incomplete or failed verification; `503 CRM_CONFIGURATION` indicates missing or invalid configuration.

The service rechecks the employee roster after upstream reads, then uses the live authorization result for searches, details, briefing priorities, and every briefing aggregate. Stale mirrored assignments cannot grant access. Newly created records may be absent until mirrored. Role and relationship checks happen during each request, without a cross-request authorization cache; they are not a continuing lock on source changes. API keys issued before the scope rename must replace `crm:read:assigned` with `crm:read` in their server-side registration and restart/redeploy.

Responses are built from explicit field allowlists. Phone numbers, alternate contacts, email addresses from source records, raw notes, arbitrary descriptions, exact contact-oriented address text, attachments, and media are excluded from the context surface. Restricted contact fields cannot be used as search filters. Do not extend a response with an upstream record spread or unrestricted SQL selection. Review both returned fields and filters before adding capabilities.

This first version deliberately omits narrative note history. Adding notes later requires a separate sanitisation and review policy: removing phone-shaped text is insufficient to make arbitrary notes or attachments safe. Markdown documents also need business review before publishing; treat knowledge changes as changes to information employees can retrieve.

The running API only reads existing tables and performs read-only CRM queries. It does not run the administrative knowledge migration, synchronise the CRM, send messages, or alter warehouse and opportunity records. Keep source credentials in server-only configuration. The imported CRM key can retain the source application's privileges; this service exposes no write operation or source token to employees. Use dedicated read-only source credentials for production where supported, in addition to the application's read-only operations.

## Supabase connection budget

Use Supabase's **transaction pooler**, not the direct database endpoint or session pooler. The application uses a reusable `pg` pool with one socket per instance by default and a hard maximum of two. It avoids named prepared statements and keeps database work bounded. Live CRM HTTP requests run between database transactions, so they do not hold a pooled database socket while waiting for Twenty.

Released pooler connections can stay warm for 30 seconds across agent-thinking gaps; they are recycled after five minutes. Checkout/connection establishment has a five-second budget; database statements retain a four-second limit. Idle connections do not retain an open database transaction. Overload or unavailable connections return a retryable 503. Vercel's pool lifecycle helper remains enabled; its idle cleanup can extend background execution up to the function deadline.

Before authentication, database-backed key lookups share a fixed budget of 120 attempts per minute per process, including invalid keys. Exhausted requests return 429 before database access. Environment-registered keys bypass this lookup budget; authenticated keys retain their normal per-key limit (30 requests per minute by default).

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

These tests start a local server if needed and intercept every console request with synthetic fixtures. They cover password login, credential-free MCP setup copying, separate key copying, rotation confirmation, Markdown import, revision conflicts, unsaved changes, and the deferred-storage state. OAuth consent checks use synthetic application metadata and keys. They do not use real credentials or write to Supabase. Browser artifacts stay under ignored `.local/browser-results/`.

After private storage is configured, `npm run test:console:live` checks its permissions and exercises admin knowledge creation, publishing, draft visibility, and revision conflicts inside an outer transaction that is always rolled back. It uses one database socket and retains no test pages. This opt-in check requires the configured administrator to have an active roster entry.

`npm run test:mcp:live` explicitly tests the configured local server using the ignored `.local/keys/local-trial.json` employee key. Override with `-- --key-file PATH --origin https://YOUR_HOST` when needed. It registers a test connector, approves a browser-bound PKCE grant, calls read tools through the official MCP client, rotates tokens, checks replay revocation, and revokes its grant on completion. Registration and revoked-grant records remain private in OAuth storage; no source records are edited. Output contains only counts and status codes, never keys or returned business records. A CRM source failure is reported as a source error rather than an empty lead list.

With the local server running, exercise the real API and database path from a second terminal:

```sh
npm run test:smoke -- \
  --base http://localhost:3000 \
  --key-file .local/keys/local-trial.json
```

Use the credential file created during setup, or supply an existing employee key file. The smoke script's defaults are `http://127.0.0.1:3100` and `.local/keys/local-trial.json`; the explicit arguments above match the generic local setup. The key must have all three scopes and the corresponding employee service access. An already configured checkout can reuse its key without rerunning the import or key-generation scripts.

This check makes bounded read requests for the knowledge index, warehouse search/detail, CRM default/created/assigned views, record detail, and briefing. It also verifies unauthenticated rejection, blocked contact filters, and selected excluded response fields. It reads the key from disk and prints route/status summaries without printing the key or record payloads. To check a deployed instance, pass its HTTPS origin as `--base`; the script sends the selected employee key to that origin and refuses redirects.

For an actual model-driven REST client, see [the toy OpenAI harness](docs/harness.md). It loads the OpenAI key directly from the dashboard environment at runtime and keeps it out of this application's deployment configuration.

Keep live verification reports and inventory analyses in private storage or appropriately restricted knowledge pages. Publish only synthetic fixtures and generic test procedures in this repository.

When CRM returns `503 CRM_SOURCE_STALE`, the smoke check reports that CRM access was safely blocked and continues. That result confirms the freshness guard; it does **not** confirm successful CRM data reads. Restore the opportunity stream's successful sync within the last 30 minutes and rerun to exercise those reads. Other unexpected errors fail the smoke check.

To deploy on Vercel, import this repository or select `Context_Engine` as the root directory when importing its parent. Use the Next.js preset and add the server-side environment variables in Vercel. Set a deployment region appropriate for the Supabase region. The public health route checks process liveness; use an authenticated context request to verify the configured employee and database path.

Deployments are not created automatically by this scaffold. Deploy application code and server-side configuration without copying private knowledge documents into the build. Knowledge changes are read from PostgreSQL; changing environment-based key registrations still requires updating the deployment configuration and redeploying.
