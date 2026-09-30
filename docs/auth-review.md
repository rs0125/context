# Employee authentication and access review

Reviewed 2026-09-30. Baseline deployment: `9f17fac`. This review accompanies the Analyst implementation across the main dashboard backend, frontend and Context Engine. The shared Analyst column migration has been applied and verified; application rollout follows the sequence documented in the README. Review covered Context Engine browser authentication, console authorization, API keys, MCP OAuth, CRM record checks, analytics, and the main dashboard's employee capability flow. Audit reads were bounded and read-only; synthetic tests used no live employee credentials. Account-specific observations remain outside tracked documentation.

## Incident diagnosis

The reported ten-tool connector had an active roster admin flag, but no `twenty_user_id`. Under the baseline policy, admin status gave warehouse and analytics access while CRM required a separate linked Twenty identity. Its current employee key and current Claude grants consequently contained only `knowledge:read`, `warehouses:read` and `analytics:read`: exactly ten tools. The seven missing tools were all CRM tools. An active matching Twenty account existed, so a missing source account was not the explanation. Prompt-editor visibility was resolved separately; the prompts commit had a successful deployment.

A roster permission, a key scope, an OAuth grant and a CRM record decision are distinct checks. Changing one does not automatically rewrite the others. Key replacement invalidates grants tied to the old key even when their database revocation timestamp is empty. An expired short-lived access token is also normal when a valid rotating refresh token remains.

## Requested policy change

`VerifiedNumber.analystAccess` is managed in the **main Wareongo dashboard Admin Panel**, alongside existing employee access controls. It defaults to false. Current active roster admins inherit Analyst access without storing a duplicate grant. Standard employee knowledge, warehouse, and created/assigned CRM access stay unchanged.

Analysts can read all non-deleted mirrored CRM leads and GA4/Search Console reports, subject to the credential's respective `crm:read` and `analytics:read` scopes. An Analyst does not require a linked Twenty identity for the all-leads view. Personal `created`/`assigned` views still require a unique live Twenty identity. Twenty admin membership alone no longer grants all-leads access in Context Engine; the shared Analyst permission is authoritative. Analyst access grants no dashboard, reviewer, knowledge-editing or prompt-editing privileges.

The shared roster query and Analyst predicate are centralized in `src/lib/employee-access.ts`. REST, console key issuance, MCP discovery/consent and token revalidation use the same current permission decision. CRM data builders and related context validate all-leads access against the current Analyst flag. The final transaction also detects a permission change across an upstream read. The existing mirror freshness guard, field allowlists, source deletion checks, masking, bounded pagination, and read-only operations remain enforced.

The dashboard's existing admin route gate, strict boolean validation, capability cache invalidation, and attributable roster audit events handle grants and removals. The UI shows admin inheritance and the required reconnection guidance. Existing keys and OAuth grants retain their original resource scopes; refresh cannot expand consent. A credential already holding `crm:read` follows the employee's current CRM record permission. This separation follows [OWASP's per-request authorization and least-privilege guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and [OAuth refresh scope restrictions](https://www.rfc-editor.org/rfc/rfc6749.html#section-6).

Rollout order and the role matrix are in [Access and data handling](../README.md#access-and-data-handling). No individual Analyst grants, key rotations, or Twenty role changes are performed by the schema migration.

## Remaining findings

### P1: Runtime database credential has excessive privileges

The database role reached through the audited local `DATABASE_URL` reported `BYPASSRLS`, `CREATEROLE` and `CREATEDB` (not superuser). `src/lib/db.ts` uses that same credential for source reads and console writes. Read-only transactions constrain individual reads but do not reduce the credential's privileges if application code or a secret is compromised. This finding does not demonstrate an exploitable SQL-injection route, and the deployed Vercel environment was not independently inspected for credential equivalence.

Use a dedicated runtime role with SELECT on required source projections and narrowly scoped access to private application tables; separate the migration owner. The existing private-schema migrations require an owner with RLS bypass, so this needs an explicit runtime/migration-role design and validation rather than changing a single environment variable. [OWASP database guidance](https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html) recommends minimum application privileges.

### P2: Console logout cannot revoke a copied session

`src/app/api/auth/logout/route.ts` clears the browser cookies. `src/lib/console-auth.ts` verifies an HMAC signature, current roster identity and the eight-hour expiry, but does not persist or revoke the session's random `sid`. A synthetic reproduction logged out, then replayed the original signed cookie successfully while its employee remained active. This requires possession of a previously valid cookie; ordinary logout still removes the browser's copy.

Persist session state or a bounded shared revocation record and validate it with the roster. An instance-local denylist is insufficient on Vercel. Employee deactivation already blocks Context Engine requests but is broader than ending one session. [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#logout-button) recommends invalidating the server-side session on logout.

### P2: Legacy environment credentials bind only to email

`CONTEXT_API_KEYS_JSON` entries in `src/lib/auth.ts` have no immutable employee ID. A synthetic reproduction confirmed that a still-valid legacy key can resolve to a replacement roster row when the same email is reused. Console-issued database keys bind employee ID and email and reject that replacement. The audited local configuration still contained a legacy registration; deployed registry contents were not independently retrieved.

Retire legacy registrations after clients reconnect with console-issued keys, or migrate their identity binding. Rotating a console key does not remove a separate environment registration. Remove the deployed environment entry and redeploy, then verify the old key and its connector can no longer read. Do not silently disconnect existing clients during retirement.

### P2: Main dashboard and Context Engine have different admin authorities

The main dashboard's `Backend_Repository/src/utils/access.js` treats `ADMIN_EMAILS` as a master override before its roster lookup. Such an account retains dashboard capabilities even if its roster row is disabled. Context Engine intentionally requires a unique active roster row and ignores that environment allowlist. The difference can explain confusing cross-application admin behavior, although it was not the cause of this incident.

Decide whether the environment override is an intentional break-glass mechanism. If retained, document and audit its separate removal during offboarding. Prefer a consistent active-identity requirement. The dashboard's capability cache is per process with a 30-second TTL; a panel update invalidates the local instance, while other instances may retain a result until expiry. Context Engine does not cache roster permissions between requests.

### P2: Context console mutation audit coverage is incomplete

Business REST/MCP reads have safe structured events. The main dashboard already records roster changes, including the new Analyst flag. Context console sign-in outcomes, logout, key replacement and knowledge publication lack a consistent actor/action/outcome trail. Prompt overrides retain the latest editor/time/revision, not immutable history. Add attributable events and retained revision history without logging keys, cookies, OAuth codes, source records, or page bodies.

### P3: Deployment-wide abuse controls and script CSP need verification

`src/lib/rate-limit.ts` uses bounded per-instance state; OAuth storage also enforces database-backed limits. These do not establish a single deployment-wide rate budget. Verify edge/WAF controls and global connection limits; the review did not inspect deployed firewall policy. `next.config.ts` supplies anti-framing, nosniff and referrer protections, but its CSP does not restrict scripts with nonces/hashes. A fuller script policy would add defense in depth; no XSS exploit was demonstrated here.

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
- The additive migration verified a non-null boolean `analystAccess` column with default false. No employee permission values, credentials or source roles were changed. Live connector behavior under the new policy still requires application deployment and client reconnection where existing grants lack scopes.
