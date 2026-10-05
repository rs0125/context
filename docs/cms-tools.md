# CMS tools

The Context Engine advertises seven website CMS tools. Page schemas, validation,
private drafts and final editorial approval live in `wareongo-cms`. The Context
Engine handles employee authentication, explicit scopes, client policy and signed
transport. Ramesh consumes the existing registry metadata; it needs no CMS tool
name list or schema copy. Claude receives ordinary MCP definitions.

| Tool                    | Purpose                                                                 | Execution policy              |
| ----------------------- | ----------------------------------------------------------------------- | ----------------------------- |
| `cms_schema`            | Discover seven page types; fetch a current JSON schema and CSV header   | Read                          |
| `cms_list_pages`        | Browse canonical targets, native publication states and pending imports | Read                          |
| `cms_read_page`         | Read current draft, approved content and deployment snapshot            | Read                          |
| `cms_prepare_import`    | Validate CSV and persist an immutable, expiring diff preview            | Preview; requires `cms:write` |
| `cms_read_import`       | Recover your preview, diff and workflow state                           | Read                          |
| `cms_fill_empty_drafts` | Save a batch containing only entirely empty targets                     | Explicit direct request       |
| `cms_edit_drafts`       | Save existing-page edits or mixed batches                               | Separate confirmation         |

All tools need `cms:read`. Both saves also need `cms:write`. An eligible employee
must be active and have `analystAccess=true` or `adminAccess=true` in the current
Context Engine roster, and be allowed by the CMS's existing `CMS_ALLOWED_EMAILS`.
Dashboard or CRM access alone does not qualify. A credential's explicit scopes
narrow that access; old credentials do not gain new scopes automatically. Removing
both analyst and admin access immediately removes CMS eligibility at the next
authorization check, even if a credential still contains CMS scopes. No separate
Context Engine email allowlist is needed.
The bridge rechecks current identity and scope before dispatch and after receiving
a response. The CMS verifies an Ed25519 signature over the entire request body,
its 60-second lifetime, audience, action, and editor email. Browsers cannot call
this signed integration with a CMS session cookie.

## Workflow

1. Discover the page type and current `schema_version`; read relevant existing
   pages. Types are blog, city, state, micromarket, service, legal and ad.
2. Read the attached CSV as UTF-8 text using the client's file support. Send at
   most 20 **parsed** data rows and 24,000 UTF-8 bytes per batch. The tools accept
   text, never local paths or remote file URLs. Split at CSV row boundaries, keeping
   headers and quoted multiline cells intact. Each batch is atomic; a large file
   split into batches is not a single transaction.
   Ramesh also limits serialized tool arguments to 16 KiB; keep its batches below
   that transport limit, including JSON escaping. Use the CMS editor if a single
   page cannot fit the client's limit. File attachment extraction remains the
   connected client's responsibility.
3. Call `cms_prepare_import`. Any invalid row rejects the entire batch. A valid
   preview returns exact before/after field diffs, `mode`, hash, ID, expiry and a
   CMS review URL. Preview creation changes no page or draft. Missing columns or
   empty cells preserve existing values; JSON `null`, `""`, and `[]` explicitly
   clear nullable text, empty text, and arrays where their schemas permit it.
   All fields required by a new page must be supplied. Arrays and objects are
   whole-field replacements, not nested patches. Server-side validation also
   enforces refinements and canonical targets not expressible in JSON Schema.
4. For an `empty` preview, a direct save request may use `cms_fill_empty_drafts`.
   A native title alone, approved or deployed copy, or any pending import makes a
   target nonempty. For `edit`, show the exact diffs and authenticated review link
   and get confirmation before `cms_edit_drafts`. Ramesh enforces its existing
   confirmation flow; the compact proposal includes the immutable CMS review URL.
   Ordinary MCP clients control their own approval UX: metadata and instructions
   are not a server-verifiable proof that a person saw a confirmation dialog.
5. Copy the preview ID, hash and review URL exactly. Retain one `operation_id`
   and unchanged arguments for all retries. A timeout is `outcome_unknown`, never
   evidence of no write. `cms_read_import` recovers workflow state; retrying the
   same operation returns its original receipt. Do not generate a replacement ID.
6. An editor opens **Content imports** in the CMS, reviews the same diff, and
   approves for the next build or discards. Only the authenticated CMS server
   action can copy imports into native approved content. It revalidates publication
   rules and current versions and does not trigger a build.

Native publication state and pending imports are separate. `no_content` means no
native row; it can still have an import draft. `draft`, `staged`, and `published`
follow the CMS's existing snapshot semantics. `published` records a triggered
deployment, not a verified successful live build. No tool publishes, unpublishes,
deletes, uploads images, or triggers deployment. Content writing can later reuse
this same schema → CSV → preview → draft workflow in a skill.

Drafts are shared per page: one pending import draft can exist for each canonical
page reference. Import previews and receipts are owned by their author; CMS
editors can review all saved imports. Private means excluded from native approved
content and website builds, not a separate draft workspace for every employee.

## Production activation — 6 October 2026 (India time)

The backend-owned CMS migration and both Context Engine credential-scope
migrations are applied. The CMS and Context Engine signing configuration and
feature flags are active. Ramesh's issuer registration and running worker now
include `cms:read` and `cms:write`; its existing deferred loading setting and
other permissions were preserved. Eligibility still requires current Analyst or
Admin access and the existing CMS editor allowlist.

Production checks verified all seven schemas and page inventories, ordinary MCP
discovery, the deployed Ramesh adapter in both loading modes, and rejection of
ineligible employees and credentials without CMS scopes. One synthetic blog was
saved, replayed, edited through an immutable diff, and discarded. Its audit
receipts remain; no native content row, publication or build was created. The
checks made no model calls and sent no WhatsApp messages. Discovery now ignores
legacy geography identities that cannot be addressed by the import protocol,
without rewriting their slugs or blocking valid pages.

Existing personal keys and OAuth grants retain their prior scopes. Claude CMS
reads need `cms:read`; preparing or saving content also needs an explicitly
provisioned `cms:write` employee key and OAuth consent. **Replacing a key in the
console issues read scopes only**, so key replacement and reconnection alone do
not enable CMS writes. The connector must request both scopes; remove and re-add
an older connector whose registered scope ceiling excludes them. Its consent
screen explains draft editing and the separate CMS approval requirement.

The CMS signing key `cms-2026-10` expires on 3 January 2027 at 18:56 UTC. Rotate it
using the overlapping-public-key procedure below before expiry. The existing
Ramesh signing registration has its separate 30 December 2026 expiry. Private
operator backups and detailed verification receipts are outside version control.

## Provisioning and rollout

Keep both feature flags false until these steps are complete. No live migration,
credential changes or deployment are part of the implementation tests.

1. Apply backend-owned `scripts/sql/20261005_cms_agent_imports.sql` deliberately to
   the CMS database using its schema owner. **Never run Prisma schema migration,
   push or pull from the CMS**, whose schema is a partial mirror. The private
   `cms_agent_private` schema is not a website content source or a PostgREST
   exposed schema. Tables use RLS and revoke PUBLIC and API-role privileges. The
   CMS DB connection must own these tables (as the existing CMS owner setup does),
   or be deliberately provisioned with table grants and narrowly targeted RLS
   policies by the database owner. Grant no CMS database privileges to the Context
   Engine connection. Do not use Supabase API roles for the integration.
2. Generate an Ed25519 signing key in your secret manager. In the Context Engine
   set `CONTEXT_CMS_SIGNING_KID` and `CONTEXT_CMS_SIGNING_PRIVATE_JWK` with only
   `kty`, `crv`, `x`, `d`. In CMS set `CMS_CONTEXT_PUBLIC_KEYS_JSON` to an array of
   `{kid, expiresAt, publicKey:{kty:"OKP",crv:"Ed25519",x}}`. `expiresAt` is a UTC ISO
   timestamp. Up to three unexpired public keys allow rotation; install the new
   public key before switching the signer, then remove the old key after its
   outstanding requests expire. Never copy the private key to CMS or an AI client.
3. Set the exact HTTPS CMS endpoint `CONTEXT_CMS_URL` ending in
   `/api/integrations/context-engine` and `CMS_PUBLIC_ORIGIN` to the canonical CMS
   login origin. Configure `CMS_ALLOWED_EMAILS` in the CMS and grant analyst or
   admin access in the employee roster. No secrets use `NEXT_PUBLIC_`.
4. Apply the existing Context Engine `console:migrate -- --apply` and
   `mcp:migrate -- --apply` workflows to widen their **verified** credential scope
   constraints. These scripts do not grant CMS scopes to existing keys. Explicitly
   grant `cms:read cms:write` to selected employee credentials/OAuth consent. Update
   the deployed Ramesh credential/requested scope configuration and reconnect the
   Claude connector as needed. No Ramesh tool registry change is required.
5. Deploy the CMS and Context Engine changes, then enable `CMS_CONTEXT_ENABLED`
   and `CONTEXT_CMS_ENABLED`. Start with a synthetic empty page and a confirmed edit;
   check the CMS review queue before approving any real content. Disabling either
   flag stops integration writes. Keep the CMS flag enabled if editors still need
   to review queued imports after the Context Engine flag is disabled.

Previews expire after 24 hours. Every save locks targets in a stable order, checks
the complete native row fingerprint and private draft revision, and commits the
whole batch in one transaction. Approval checks those versions again. Superseded
imports cannot be approved; discarding one deletes only its remaining drafts.
Content and receipts remain private audit records; operators should establish a
retention policy before large-volume use. Retain committed receipts for the entire
retry/audit window. Only expired PREPARED records without draft references can be
pruned without losing committed operation receipts.

## Validation

Context Engine: `npm run typecheck` and `npm test` cover signed requests, current
scopes, ordinary MCP on both platforms, write bindings, schema policy, timeouts,
and revoked access. Read-only REST citation routes are `/api/v1/cms/schema`,
`list_pages`, `read_page`, and `read_import` with the same query arguments.

CMS: `npm run test:agent-cms` covers all seven schemas, CSV grammar and bounds,
draft isolation, approval, stale versions, replay and signature authorization.
`npm run test:agent-cms:postgres` additionally exercises real Prisma transactions,
advisory/native row locks, rollback, RLS configuration and every approval mapping.
It requires explicit `CMS_TEST_DATABASE_URL` pointing to a **disposable local**
`cms_agent_test` database owned by `cms_test`, plus `CMS_TEST_MIGRATION` pointing to
the backend SQL above. It resets the synthetic content tables in that test DB.
It never reads the application's `DATABASE_URL` or loads `.env`.
