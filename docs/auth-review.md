# Employee authentication and access review

Reviewed 2026-09-30. The original incident baseline was `9f17fac`; Analyst access subsequently shipped in Context Engine `bd02d79`, dashboard backend `9c58587` and frontend `d3c340c`. This follow-up reviews and hardens browser authentication, console authorization, API keys, MCP OAuth, CRM/analytics boundaries and the dashboard's employee capability flow. The hardening changes below ship with the parallel signed Ramesh auth path; the explicit security rollout is required before deployment. Audit reads were bounded and read-only; adversarial database tests used a disposable local PostgreSQL instance and synthetic identities. Account-specific observations remain outside tracked documentation.

## Incident diagnosis

The reported ten-tool connector had an active roster admin flag, but no `twenty_user_id`. Under the baseline policy, admin status gave warehouse and analytics access while CRM required a separate linked Twenty identity. Its current employee key and current Claude grants consequently contained only `knowledge:read`, `warehouses:read` and `analytics:read`: exactly ten tools. The seven missing tools were all CRM tools. An active matching Twenty account existed, so a missing source account was not the explanation. Prompt-editor visibility was resolved separately; the prompts commit had a successful deployment.

A roster permission, a key scope, an OAuth grant and a CRM record decision are distinct checks. Changing one does not automatically rewrite the others. Key replacement invalidates grants tied to the old key even when their database revocation timestamp is empty. An expired short-lived access token is also normal when a valid rotating refresh token remains.

## Requested policy change

`VerifiedNumber.analystAccess` is managed in the **main Wareongo dashboard Admin Panel**, alongside existing employee access controls. It defaults to false. Current active roster admins inherit Analyst access without storing a duplicate grant. Standard employee knowledge, warehouse, and created/assigned CRM access stay unchanged.

Analysts can read all non-deleted mirrored CRM leads and GA4/Search Console reports, subject to the credential's respective `crm:read` and `analytics:read` scopes. An Analyst does not require a linked Twenty identity for the all-leads view. Personal `created`/`assigned` views still require a unique live Twenty identity. Twenty admin membership alone no longer grants all-leads access in Context Engine; the shared Analyst permission is authoritative. Analyst access grants no dashboard, reviewer, knowledge-editing or prompt-editing privileges.

The shared roster query and Analyst predicate are centralized in `src/lib/employee-access.ts`. REST, console key issuance, MCP discovery/consent and token revalidation use the same current permission decision. CRM data builders and related context validate all-leads access against the current Analyst flag. The final transaction also detects a permission change across an upstream read. The existing mirror freshness guard, field allowlists, source deletion checks, masking, bounded pagination, and read-only operations remain enforced.

The dashboard's existing admin route gate, strict boolean validation, capability cache invalidation, and attributable roster audit events handle grants and removals. The UI shows admin inheritance and the required reconnection guidance. Existing keys and OAuth grants retain their original resource scopes; refresh cannot expand consent. A credential already holding `crm:read` follows the employee's current CRM record permission. This separation follows [OWASP's per-request authorization and least-privilege guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and [OAuth refresh scope restrictions](https://www.rfc-editor.org/rfc/rfc6749.html#section-6).

Rollout order and the role matrix are in [Access and data handling](../README.md#access-and-data-handling). No individual Analyst grants, key rotations, or Twenty role changes are performed by the schema migration.

## Adversarial findings and fixes

### P1: Runtime database credential has excessive privileges

The role reached through the audited local `DATABASE_URL` reported `BYPASSRLS`, `CREATEROLE` and `CREATEDB` (not superuser). Previously, `src/lib/db.ts` used that credential for source reads and console writes. Read-only transactions do not reduce a stolen credential's privileges. This did not demonstrate an SQL-injection exploit, and the deployed Vercel credential was not independently inspected for equivalence.

**Implemented:** `scripts/provision-runtime-role.mjs` provisions a new, unprivileged `context_engine_runtime` login with explicit source reads and private-table operations. Roster reads grant only the nine columns needed for identity/access, including `phone_number` for the parallel [signed Ramesh endpoint](ramesh-request-auth.md); unrelated application columns and tables are inaccessible. Provisioning rejects inherited public grants that permit extra application access, schema creation or unreviewed security-definer functions. The explicitly approved Supabase mode retains nine reviewed platform exceptions, described below; it is not complete platform isolation. Provisioning does not modify grants used by other applications or adopt/reset an existing login. `--check` rolls back its transaction. Private migrations accept only the exact named, role-specific RLS policy.

Production now requires `CONTEXT_DATABASE_URL`. Each transaction rejects the wrong role, elevated role attributes or any role membership before performing application work. Real PostgreSQL tests verified permitted operations and denied source writes, unrelated reads, DDL, role escalation and unexpected private-table operations. **Rollout requirements:** provision the role, configure the new URL and remove the owner secret from deployed environments. An unused owner secret still available to the app would defeat the separation. See [security rollout](../README.md#security-rollout) and [OWASP database guidance](https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html).

### P2: Console logout left copied sessions usable

Previously, logout cleared browser cookies without revoking their random `sid`. A synthetic reproduction replayed a copied signed cookie after logout while the employee remained active.

**Implemented:** logout commits a hash and expiry to shared private revocation storage before clearing cookies. Every authenticated console request checks that storage alongside the current roster. A copied cookie is rejected across clients/instances, a new session still works, and repeated logout is idempotent. Database failure returns 503 without discarding the cookie required to retry. Logout remains available when console editing/key issuance is disabled. Expired entries are cleaned in bounded batches. `security:migrate --apply` is required before deployment. This follows [OWASP server-side logout guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#logout-button).

### P2: Legacy environment credentials could follow a reused email

A synthetic reproduction confirmed that an environment registration bound only to email could resolve to a replacement roster row. Console-issued keys already bound both ID and email. The audited local registry contained a legacy registration; deployed registry contents were not independently retrieved.

**Implemented:** new CLI registrations require the immutable employee ID. Existing registrations without an ID require a stored binding created by the security migration using the actual deployment registry. Requests never create or change bindings. Missing/ambiguous bindings fail closed; email reassignment fails even when the replacement employee has access. Migration reruns cannot transfer a pinned key to another ID. Keys and existing OAuth scopes remain unchanged. Rotation of a console key still does not revoke a separate environment registration; remove obsolete deployed registry entries explicitly.

### P2: Dashboard environment admins bypassed active-identity checks

The main dashboard previously honored `ADMIN_EMAILS` before querying the roster, so an allowlisted account retained capabilities despite deactivation or deletion. Case-insensitive lookup also selected the first match if duplicate identities existed. Context Engine already required a unique active identity.

**Implemented in the main dashboard backend:** capability resolution requires exactly one active matching roster row before granting any capability, including environment-admin access. Database failure denies all capabilities. Boolean permissions must be literal `true`. JWT authentication no longer assigns admin authority; both admin middleware paths use current capability resolution. Admin gates and all mutations bypass the per-process cache, closing the stale-cache window on these operations. Environment admins cannot deactivate themselves through a crafted roster request.

The environment allowlist remains a dashboard-only admin source for unique active employees. Context Engine intentionally requires the roster `adminAccess` flag; this authority difference is documented rather than silently granting extra Context privileges. Ordinary non-admin dashboard reads may still use the existing 30-second cache. Context Engine checks roster permissions on every request.

### P2: Concurrent roster edits could remove the last administrator

The editor checked the number of active admins separately from its update. Two admins could pass that check concurrently while demoting each other. A source comment incorrectly treated avoiding transactions as necessary for the transaction pooler.

**Implemented:** roster updates use a short transaction with a transaction-scoped advisory lock. All identity, uniqueness, last-admin and write checks use the same transaction client. The editor's unique active admin identity is checked again after acquiring the lock, so a request that passed middleware before revocation cannot change the roster afterward. A competing edit returns 409 for retry; cache invalidation happens only after commit. No network work is performed inside the transaction. This uses Prisma's documented [bounded interactive transactions](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions), compatible with its [transaction-pooling requirement](https://docs.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer).

Four checks using real PostgreSQL and the installed Prisma client verified concurrent mutual demotion, lock contention, actor revocation and rollback after a failed write. The guard covers this dashboard's roster update path; direct administrative SQL must enforce the same invariants separately.

### P2: Context console audit coverage was incomplete

**Implemented:** consistent allowlisted events for console sign-in, logout, key retrieval/replacement and knowledge/prompt saves. Successful mutation events occur after the transaction returns successfully. Records include action/outcome and verified actor/resource/revision IDs where available. Tests check that arbitrary exception text and credentials cannot enter the log fields. The dashboard's existing roster audit remains intact.

**Remaining:** configure retained log storage; stdout alone is not an immutable audit archive. Prompt storage still retains only the latest body/editor/revision. Full revision history and restore workflows need a separate storage/UI change and were deliberately left outside this authorization hardening.

## Remaining infrastructure work

- Apply and verify the security migration/runtime credential rollout before calling the production findings resolved. The code intentionally fails closed if required storage or the restricted connection is missing.
- `src/lib/rate-limit.ts` bounds abuse per instance; OAuth also has database-backed limits. Edge/WAF controls and global connection limits were not verified. A deployment-wide rate budget needs shared infrastructure.
- CSP now also blocks object embeds, base-URL changes and off-origin form submissions. Script nonces/hashes remain a separate Next.js rendering change; no XSS exploit was demonstrated. Existing anti-framing, nosniff and referrer protections remain.
- Prefer dedicated read-only Twenty/Google source credentials where supported. These changes do not rotate source credentials or alter their upstream privileges.

## Checks that held

- Google ID tokens undergo signature, fixed issuer/audience, authorized-party, nonce, expiry, verified-email and Workspace-domain checks before roster access. State and PKCE bind login attempts to the browser.
- Console cookies are signed, HttpOnly, SameSite=Lax, and Secure with a host-only prefix on HTTPS. Console mutations check the configured origin. Authenticated responses are not cacheable.
- Admin knowledge/prompt routes enforce current admin status on the server. Analysts cannot acquire edit permissions through their role, a body field, or UI visibility.
- Console keys use random tokens, hash lookup, authenticated encryption for recopy, employee-ID/email binding and expiry. An admin cannot retrieve or rotate a colleague's key through Context Engine.
- MCP checks resource audience, PKCE, exact registered redirects, client/grant/key binding, one-time codes, rotating refresh tokens, replay handling and current employee access. Refresh scopes cannot exceed prior consent.
- CRM and analytics revalidate credentials and current permissions after upstream work. Google/Twenty requests hold no pooled database socket. Cached source reports never authorize their caller.
- Source reads use bound queries and explicit projections, with no caller-supplied SQL or source credentials. Standard employee CRM access still fails closed on ambiguous identity, missing assignments or incomplete source responses.
- Built-in prompts, tool schemas, REST guidance, OpenAPI descriptions, consent labels and connection UI now describe Analyst access. Saved custom prompt overrides remain administrator-authored text; authorization stays enforced in code.

## Verification

The baseline full Context Engine suite passed 1,790 tests, with 43 opt-in tests skipped. Four additional private synthetic reproductions confirmed the tool-count cause, lack of scope expansion, copied-cookie logout behavior and legacy-key identity reuse. `npm audit --omit=dev` reported no known production dependency advisories for Context Engine; this is not a certification of application security.

Analyst regression checks cover the employee/Analyst/admin matrix, key issuance, unchanged narrow grants, current-role revocation, revocation during reads, standard personal CRM boundaries, and denial of admin edits. Dashboard UI tests cover desktop/mobile grant and revoke, inherited access, rejected updates and non-admin denial.

- Context Engine: full suite passed 1,808 tests with 43 opt-in tests skipped. All 35 browser cases passed across the full run and targeted rechecks after correcting a stale copy assertion and narrow-screen navigation overflow. Production build and TypeScript validation passed.
- Main dashboard backend: the isolated Analyst changes passed the CI coverage gate with 59 suites and 1,165 tests, including capability inheritance, admin-only permission updates, strict input validation, audit changes and migration safety. Access resolution retained 100% line coverage and 92.85% branch coverage. Jest reported an existing open-handle warning in the unrelated PPT audit route fixture; the test process exited successfully. Prisma client generation passed.
- Main dashboard frontend: the isolated Analyst changes passed lint, all 37 suites and 356 tests, the configured coverage thresholds, and the production build. This includes all five Analyst editor tests. The build retains its existing large-chunk warning.
- The additive migration verified a non-null boolean `analystAccess` column with default false. No employee permission values, credentials or source roles were changed. The Analyst applications subsequently deployed successfully; clients whose grants lack scopes still need key replacement and reconnection.

### Follow-up hardening verification

- Full Context Engine suite: 1,828 passed; 61 opt-in checks skipped, including the isolated database suite when no test connection is supplied.
- Disposable PostgreSQL 17 instance: all 18 security checks passed separately. These include real restricted-role connections, public-grant rejection, migration rollback/rerun, key issuance/recopy, prompt saving, logout replay rejection and immutable legacy bindings.
- Main dashboard backend current workspace: CI coverage gate passed all 63 suites / 1,222 tests. This includes unrelated existing workspace work; only the authorization files/tests belong to this hardening change. The existing unrelated PPT audit open-handle warning remains; the process exited successfully.
- Four additional backend roster-concurrency integration checks passed against a separate disposable PostgreSQL 17 instance. Run `npm run test:integration -- tests/integration/verifiedNumberConcurrency.test.js` with the backend's validated local `TEST_DATABASE_URL`; the test creates and removes its own synthetic schema.
- All 35 Context Engine desktop/mobile browser cases passed. TypeScript validation and the production build passed.

The hardening changes preserve all 17 tool names, schemas and data-query behavior, including standard employee access and Analyst/admin inheritance. The original follow-up ended before production changes; the subsequent rollout attempt is recorded below.

### Signed Ramesh auth rollout status, 2026-10-01

The combined implementation passed the full Context Engine suite (1,849 tests), TypeScript validation and the production build. All 23 isolated PostgreSQL security checks passed separately, including nonce replay races and a regression proving that a warning-only, ineffective `REVOKE` must fail provisioning. The worker passed its full check (109 tests). These checks do not establish that the new production endpoint is deployed.

During the first rollout attempt, the additive security migration created shared logout-revocation storage and immutable bindings for the verified deployed legacy registration. No business records were modified. At the end of that attempt, the restricted runtime role and Ramesh nonce store had not been provisioned and production deployments/settings were unchanged.

The initial rollout was blocked by inherited `PUBLIC` privileges on managed PostGIS objects and `pg_net` request/response tables. Local dashboard and Context Engine configuration use the same PostgreSQL login and password, verified without logging either secret. This is an object-ownership restriction, not a connection failure or a missing copy of the dashboard credential. Supabase's customer `postgres` role is not a superuser; the affected managed objects belong to `supabase_admin`. See [Supabase role restrictions](https://supabase.com/docs/guides/database/postgres/roles-superuser) and [the documented pg_net PUBLIC grants](https://supabase.com/docs/guides/database/extensions/pg_net#permissions).

An attempted privilege migration could change only the customer-owned helper function; that effective change was restored and existing role access was preserved. Managed extension grants were not changed. The optional privilege-removal script now verifies that PUBLIC grants actually disappear before reporting success.

The signed phone/employee authentication protocol itself does not require managing PostGIS or pg_net. This dependency comes from the pending database-hardening changes included in the requested full working-tree rollout.

The deployment owner subsequently approved a dedicated runtime user with application-layer authorization and the existing platform grants retained. Provisioning now has an explicit `--allow-reviewed-platform-access` mode. Its allowlist checks the exact object, extension membership/ownership, kind and allowed privileges; it still rejects all unexpected application access. Its permission report distinguishes application restrictions from platform isolation. This mode passed the production dry run and created the dedicated runtime user. The full suite passed 1,858 tests plus all 23 isolated PostgreSQL checks, including unexpected PUBLIC grants under both modes and a spoofed platform object.

Release preparation then provisioned the nonce store and verified the actual runtime login against Supabase without reading business records. Vercel's production configuration now uses the dedicated connection and public signing registry; the owner connection has been removed. Ramesh's private signing configuration was added to its AWS SecureString and protected EC2 environment, preserving every existing value. These configuration checks are separate from the post-deployment endpoint checks; no WhatsApp test message is sent.

Residual risk: if the runtime credential or host is compromised, application authorization can be bypassed and inherited `pg_net` access can expose or modify HTTP queue/response data, including any stored authorization headers. No raw SQL or extension tools are exposed to the model, and business reads retain fixed parameterized queries, read-only transactions and live employee/record checks. Removing the inherited platform access remains separate infrastructure work; it is no longer a prerequisite for this explicitly approved rollout.
