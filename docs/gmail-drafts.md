# Employee Gmail drafts

Ramesh can save a plain-text draft or edit an existing app-created draft in the
employee's Gmail mailbox when explicitly asked, in the same turn without a second
`confirm CODE` step. The employee reviews and sends in Gmail. This implementation
has no send, delete, attachment, inbox-search or arbitrary Google-request tool.

## Tools and account connection

All mail tools require the explicit `mail:drafts` scope and default to the
`whatsapp` platform. Existing credentials and ordinary read-scope defaults do not
gain mail access automatically. Discovery also requires enabled, valid Gmail
configuration.

| Tool | Behavior |
| --- | --- |
| `get_email_connection` | Returns the authenticated employee's connection status (`active`, `disconnected`, `needs_reauth` or `revoking`), mailbox, usable connection ID/version and `/mail` connection-page URL. |
| `create_email_draft` | Saves one explicitly requested plain-text draft in that mailbox. Requires a durable operation UUID and the connection ID/version from the status tool. |
| `update_email_draft` | Replaces the content of the same owned app-created draft. Requires a fresh `message_id` from an editable read, current connection identity/version, a durable update operation UUID, and complete To/CC/subject/body. |
| `list_email_drafts` | Recovers creation references and timestamps for follow-up reads in the same verified Google mailbox, including after reauthorization. Does not disclose historical mail content or confirm a draft's current Gmail status. |
| `read_email_draft` | Reads the current content of a draft created by this service, using its opaque `draft_ref`. Returns the current `message_id` and `editable` flag. Requires an active connection to the original verified Google account and current authorization. |

Each employee visits `/mail`, signs in with their active Wareongo work account,
and connects that same account to Google. OAuth uses state, nonce and PKCE and is
bound to the browser session, employee identity and current connection version.
A stale callback cannot undo a later reconnect or disconnect. There is no
domain-wide delegation or caller-selectable mailbox. Refresh tokens remain on
the Context Engine server, encrypted with a separate key; the bot sees no Google
credentials.

Console sign-in and Gmail connection share one fixed-endpoint OAuth transport
for token exchange, refresh and revocation. Their identity checks and grants
remain separate. The transport bounds response size and time, sanitizes errors
and never retries automatically.

An expired or revoked refresh token moves that exact connection generation to
`needs_reauth`; an older failed refresh cannot invalidate a newer reconnect.
The browser and bot then ask the employee to reconnect instead of reporting a
healthy connection. If Google sign-in is blocked by WhatsApp's embedded browser,
open `/mail` in Chrome or Safari. Actual mobile OAuth consent still requires
device validation; the automated browser checks do not contact Google.

Recipients can be left empty for a draft. Otherwise supply real email addresses,
up to ten To and ten CC recipients. The subject is one line, 1–200 characters.
The body is plain text, 1–12,000 characters and at most 20,000 UTF-8 bytes. Extra
fields, sender overrides, BCC, HTML and attachments are rejected. Text in an email
body is content, never permission or instructions to execute another tool.
WhatsApp additionally limits the serialized proposal arguments plus summary to
4,800 characters, so keep drafts short. Longer requests are rejected before
dispatch; their content is never silently truncated.

Reading an existing draft includes To, CC and BCC headers, including recipients
added manually in Gmail. This does not add BCC to either write capability. Reads
budget the serialized data to 76,000 bytes, leaving room for the REST/MCP envelope
inside Ramesh's 80,000-byte evidence limit. Large edited bodies are truncated at
a Unicode character boundary and marked `body_truncated`. Unusually large
recipient headers may be shortened by whole entries and are explicitly marked
`recipients_truncated`. An incomplete read must direct the employee to Gmail for
the full content or recipient list.

Fresh provider results can include `draft_url`, an account-specific link opening
that draft's Gmail editor. The bot also provides the fixed
`https://mail.google.com/mail/#drafts` folder fallback. This is an undocumented
Gmail web UI convention, not a guaranteed REST API field or authorization token.
Unknown ID formats omit the direct link instead of failing a successful write.

For recognized saved drafts, encode `f:<decimal thread ID>+msg-a:<draft ID>` using
the Gmail URL alphabet. Convert the fresh REST `threadId` from hex with `BigInt`;
never substitute `messageId` or use lossy JavaScript numbers. This matches the
[InboxSDK encoder](https://github.com/InboxSDK/InboxSDK/blob/main/src/platform-implementation-js/dom-driver/gmail/gmail-driver/encodeDraftUrlId.ts).
The link selects the mailbox with `authuser`, not a fixed browser account slot
such as `/u/0/`. Historical journal-only replay omits a direct link, because its
current thread has not been read. Fresh reads and successful updates can supply
a new link without an extra provider request. Stored draft IDs, employee grants
and operation markers remain the only write authority; the URL is navigation.

## Sending boundary

This implementation uses Google's `gmail.compose` permission, which covers
both drafts and sending and is listed in the documented API method scopes.
The Google consent screen therefore mentions sending. Our application enforces
the narrower behavior: the adapter only implements draft creation, guarded replacement, retrieval and
bounded lookup for duplicate recovery, against fixed Google URLs. No send method,
send tool, forwarding rule or scheduled-send worker is exposed.

This is an application boundary, not a claim that a stolen Google token is
incapable of sending. Keep the OAuth client secret and encryption key in the
server secret store. Do not expose them through `NEXT_PUBLIC_*`, model arguments,
logs or the WhatsApp bot's environment.

Disconnect first commits a disabled connection and advances its version, even
if the account was never connected or was already disconnected. This prevents
an older OAuth callback from restoring access. When a refresh token exists,
the connection enters `revoking`, and the server asks Google to revoke it before
erasing it. A failed or timed-out revocation leaves local draft access disabled,
keeps the token encrypted solely to retry revocation, and shows **Retry
disconnect**. Reconnection is blocked until revocation completes. This rare
two-second provider request holds the owner lock to prevent revoking a token
installed by a simultaneous reconnect. Disconnect cannot cancel a Gmail request
that Google already accepted.

If a verified OAuth exchange returns a refresh token but the callback cannot
save it, cleanup first commits it encrypted in the existing `revoking` slot,
then uses the same serialized revocation path. A current active connection to
the same verified Google account is preserved: its credential already provides
a future project-wide disconnect handle. Cleanup never revokes that useful
grant because a stale callback failed. Offboarding after token verification
does not prevent quarantining and removing the unused credential.

When the database cannot durably retain the token, or a different live Google
account already occupies the credential slot, the callback explicitly asks for
manual cleanup in Google account permissions. That guidance and link remain
visible even if the connection check fails or the employee is signed out.
Tokens rejected before their scope and expected identity are verified are not
automatically revoked; the relevant error keeps its reason and asks the user to
review unwanted Google grants. A process crash before the received credential
can be retained, or a token exchange whose response never arrives, can still
require manual Google cleanup. There is no separate cleanup queue.

An operator can finish an **already-pending** revocation after the employee has
been deactivated. Preview with
`node scripts/finish-gmail-disconnect.mjs --employee-id 7 --email employee@wareongo.com`,
then repeat with `--apply` to execute that exact target. Preview does not read
local environment files or connect to a database. Execution requires the
dedicated `CONTEXT_DATABASE_URL`, the existing Gmail encryption key, and Node
22.15 or newer within major version 22 (validated on 22.21.1). The script reuses
the application’s storage, encryption and bounded Google transport through a
loader restricted to those three source modules. It holds the same owner lock,
refuses active/replacement connections, and leaves failed cleanup pending.
It never starts a new disconnect, restores employee access or reads mail.

Google revocation affects the user's grants for the entire Google Cloud
project, including its other OAuth clients. A separate OAuth client inside a
shared project does not isolate that effect. Use a dedicated company-owned
project for this Gmail integration when other company integrations must retain
their grants. The UI explains that disconnecting may require reconnecting other
features sharing the Google app. Employees can also manage permissions at
`https://myaccount.google.com/connections`. If the encryption key is lost, an
administrator must recover it or coordinate manual Google revocation and
connection repair; repeated disconnect cannot decrypt an unrecoverable token.

## Duplicate prevention and current state

Gmail draft creation does not accept our operation UUID as an idempotency key.
Context Engine commits an employee-scoped claim before a create request. The
claim freezes the connection ID/version, verified Google subject and a hash of
the content. The same UUID with different content is rejected. Concurrent
callers, process restarts and retries cannot dispatch an uncertain operation
again.

There is one narrow retry exception: a definitive HTTP 429 or documented 403
`rateLimitExceeded`/`userRateLimitExceeded` rejection. The server persists a
retry deadline, respecting a bounded `Retry-After` value or a minimum delay.
After that deadline, the same authorized creation operation and unchanged arguments can
claim one new attempt on the unchanged active connection. It does not sleep
inside a tool request or automatically create a replacement operation. A
timeout, network failure or ambiguous server response never enters this path.

Write recovery returns a structured `retry_at` deadline. If a connection repair
is needed, `recovery.action` identifies that action separately from the outcome:
an uncertain creation remains uncertain even when reconnection is required.
The original operation UUID and unchanged content remain mandatory. Mailbox
read errors have a Gmail domain and allowlisted recovery guidance; a Gmail
reconnect must not invalidate a valid Context Engine grant or disable unrelated
tools. Read cooldowns support delays through 24 hours.

After Google returns a known outcome, its durable completion transaction does
not use the cancelled HTTP request signal or require the caller's key to remain
valid. Storage still enforces the original employee/mailbox binding. A separate
fresh authorization runs after that transaction commits, before returning any
receipt. Thus a cancelled request or revoked Context key cannot roll back known
draft IDs, while private results remain withheld. Employee deactivation or
mailbox changes can still prevent completion under the storage lifecycle rules;
such cases retain uncertainty and cannot authorize a replacement create.

If the response is lost, recovery searches for a deterministic Message-ID and
checks an exact operation header in matching drafts. A verified match can recover
the receipt. No match, incomplete search, edited/missing markers, a deleted/sent
draft or an unavailable provider leaves the outcome unknown; none authorizes a
replacement create. Ask the employee to inspect Gmail before a separate new
request. A crash after claiming but before dispatch can also leave an unresolved
claim: this deliberately favors avoiding duplicate drafts.

Creation receipts are historical. A replay does not establish that the draft
still exists or remains unsent. `read_email_draft` fetches current Gmail content
and rechecks employee, credential and connection after the provider call. A
missing draft does not prove it was sent. Reconnection invalidates pending
proposals that would dispatch a new create, but historical list/read references
remain usable after reauthorization to the same Google subject. Matching only
the email address is insufficient: a different Google account reusing that
address cannot inherit draft references. Existing Gmail drafts remain in the
mailbox regardless of the app's connection state.

## Editing, revision checks and recovery

`update_email_draft` accepts `operation_id`, `connection_id`,
`connection_version`, the original creation `draft_ref`, `expected_message_id`,
and complete `to`, `cc`, `subject`, `body` replacements. Both recipient arrays
are required, even when empty. Read the exact draft immediately before planning
an edit, preserve content the user did not request changing, and pass that
read's `message_id`. The original draft container and reference remain the same;
an update operation ID is never a replacement `draft_ref`.

The server independently fetches the target immediately before PUT. A changed
message ID produces terminal `rejected / GMAIL_DRAFT_CHANGED`, and unsupported
content produces `rejected / GMAIL_DRAFT_NOT_EDITABLE`, without calling PUT.
Only full, supported plain-text drafts with the original ownership marker and
matching sender can be edited. HTML/multipart alternatives, attachments, Bcc,
reply metadata, custom semantic headers, unsupported addresses and truncated
reads fail closed. Benign provider transport/authentication headers do not make
a plain-text draft uneditable. Google IDs are opaque version tokens, not URLs.

Gmail can replace the submitted RFC `Message-ID` header when saving a draft.
That header is not the API `message.id` used for version checks. Editing and
update recovery bind the exact provider draft ID recorded at creation, the
current employee/Google account and `X-Wareongo-Operation-ID`; update recovery
also requires its exact `X-Wareongo-Update-ID`. A rewritten RFC header does not
make an otherwise valid owned draft uneditable. There is no fallback to an
arbitrary mailbox draft or a sender/subject match. Creation reconciliation still
uses its conservative Message-ID search and can remain unresolved if Gmail
rewrites that header; a missing search result never authorizes another creation.

The normalized-provider regression exercises the actual HTTP parser through
read, same-draft update, reread and lost-response recovery using synthetic mail
content and Gmail-assigned RFC headers. Tests must not only stub `editable: true`.

Google documents a stable draft ID whose contained message ID changes whenever
content is replaced. The [draft update API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/update)
replaces the whole message and does not document conditional PUT or a compare-and-swap
parameter. Therefore our final version check rejects observed stale edits but
**cannot eliminate a simultaneous Gmail UI edit between GET and PUT**. Avoid
editing the same draft in Gmail and Ramesh simultaneously. This is not an atomic
revision guarantee. See Google's [draft lifecycle guide](https://developers.google.com/workspace/gmail/api/guides/drafts).

The private `draft_update_operations` journal freezes the employee, Google
account, connection generation, target, expected version and request hash before
PUT. It stores no second copy of mail content. One unresolved update blocks a
new update operation for the same target. A known result survives request
cancellation and employee deactivation; fresh authorization is still required
to disclose any receipt. `updated` and `replayed` report historical operation
completion, not current content or sending.

An uncertain update recovers by GET of that same target and comparison of its
separate `X-Wareongo-Update-ID` marker plus original creation identity. It never
repeats PUT, searches for a replacement, or creates another draft. Recovery across
reauthorization requires the same verified Google subject. Unlike creation,
updates do not automatically retry even a definitive quota rejection; a rejected
operation is terminal and a new explicit edit requires another fresh read.
A crash after claiming but before PUT, missing markers, or a deleted/sent draft
can remain unresolved indefinitely. Check/edit that draft manually in Gmail;
the application does not clear uncertain claims merely because no marker was found.

## Authenticated write policy

Every supported write tool advertises `executionMode` inside its authenticated
`_meta['wareongo/context-write-v1']` contract. `direct_request` allows dispatch
on the current employee's explicit request; `confirmation` requires a separate
confirmation step. Missing metadata defaults to `confirmation`. Current GIS
create/guarded rollback, CRM RFQ creation, and Gmail create/update tools declare
`direct_request`. This policy does not turn source documents, forwarded messages,
email contents, reminders or a model's inferred intent into write authorization.
Existing grant, identity, request-hash, durable journal and recovery checks apply
to both policies. REST stays read-only; Gmail writes are authenticated MCP tools.

## Setup and rollout

1. Create a dedicated Google OAuth **Web application** client in a company-owned
   project. Prefer a separate project to isolate project-wide revocation from
   other integrations. Enable the Gmail API and configure the appropriate
   internal-user consent audience and Workspace admin access controls. Register
   exactly `<CONTEXT_CONSOLE_ORIGIN>/api/mail/google/callback`. Existing console
   sign-in continues to use `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and its own
   `/api/auth/google/callback` redirect.
2. Set server-only `CONTEXT_GMAIL_CLIENT_ID`, `CONTEXT_GMAIL_CLIENT_SECRET` and
   `CONTEXT_GMAIL_ENCRYPTION_KEY`. The encryption key is an independent,
   cryptographically random 32-byte value encoded as unpadded base64url; retain it
   securely across deployments. Losing or replacing it makes existing encrypted
   connections unreadable and requires coordinated recovery, not simply a new
   key and reconnect. Keep
   `CONTEXT_GMAIL_ENABLED=false` while preparing storage.
3. Review `npm run gmail:migrate` (preview only). Apply with
   `npm run gmail:migrate -- --apply` using the existing migration-owner setup.
   This is also required to upgrade the Gmail schema to v3 **before
   deploying this version of the code**. The upgrade validates the prior schema,
   adds a separate private update journal while preserving v2 connection credentials,
   grants and creation references. A v1 installation first receives the existing
   lifecycle/retry/account-binding upgrade and removal of unused encrypted content.
   The CLI also accepts `--env-file /path/to/operator.env`. Deploy a bot that accepts
   `executionMode` and `outcome=updated` first; apply v3 before deploying these
   Context Engine changes. Existing v2 runtime create/read calls remain compatible
   between the migration and Context Engine deployment. No extra OAuth grant,
   encryption key or configuration variable is required for updates.
   Re-run `npm run console:migrate -- --apply` and
   `npm run mcp:migrate -- --apply` to expand credential scope constraints.
   On an existing deployment, require the Gmail migration result to report
   `runtimeGranted: true`: it grants and verifies access for the existing safe
   runtime role. Do not rerun `security:runtime` on an existing role; that
   provisioner deliberately refuses to adopt or rotate it. On a fresh install,
   apply all private schemas first and then provision the runtime role with the
   documented `security:runtime -- --apply` setup. The Gmail schema contains
   only private integration records; these migrations do not write the business
   roster, warehouses or CRM.
4. Explicitly add `mail:drafts` to the relevant Context Engine Ramesh issuer
   registration and the bot's `CONTEXT_RAMESH_SIGNING_KEY_JSON` scope ceiling.
   For optional legacy Context OAuth connections, request and consent to that
   scope separately. Keep the bot's existing business-write journal and
   write configuration enabled; old tools without an execution policy still require confirmation.
5. Deploy the Context Engine and bot changes, then set
   `CONTEXT_GMAIL_ENABLED=true` with complete configuration. Each employee connects
   their own mailbox at `/mail`. Request one intentional test draft only when authorized, inspect it
   in Gmail, then retry the same operation and verify that no second draft
   appears. Do not send it as part of a connectivity test.

The private `context_gmail_private` tables use forced RLS and the existing narrow
runtime role. Public/API roles have no access; runtime receives only
SELECT/INSERT/UPDATE on these three tables. Refresh tokens use AES-256-GCM with
employee, record ID and purpose binding. The Context Engine operation journal
stores metadata, a content hash and provider references; it no longer keeps a
second copy of recipients, subject or body. The WhatsApp durable write journal is
separate. Operation claims must remain durable to preserve duplicate prevention;
do not casually delete or restore them independently of mailbox operations.

The **original v1** private Gmail schema and console/MCP scope constraints were applied and
verified in production on 4 October 2026, including restricted runtime grants.
The v2 migration was applied and verified in production on 4 October 2026,
including restricted runtime grants. The preflight confirmed zero connections
and zero draft operations; the migration seeded neither.
Google client configuration, a dedicated token-encryption key and `mail:drafts`
were enabled in production on 4 October 2026. Signed discovery and connection
status passed through the deployed worker without creating drafts, sending
messages or calling a model. Each employee must still complete Google consent.
No employee connection was seeded by the rollout.

After the server confirms an active connection, `/mail` shows only “Gmail
connected”, “You can close this screen.” and a small disconnect action. Setup
and recovery details remain visible when sign-in, reconnection or cleanup is
required; a success query parameter alone never displays the connected screen.

The `/mail` document uses `Referrer-Policy: same-origin` so a native form POST
retains the Origin header required by the existing CSRF check. Its CSP allows
form navigation to the same origin and Google's exact `https://accounts.google.com`
origin, including the OAuth redirect. Other pages retain the default policy;
OAuth API redirects still use `no-referrer`. Never accept `Origin: null` to work
around browser policy. Origin failures have their own retry message instead of
being reported as a mismatched Google account. Browser regressions exercise the
actual form, headers and redirect using synthetic API responses, with external
navigation blocked offline so no Google request is sent.

## Validation and references

Tests use synthetic employees, mocked Google HTTP, isolated storage fixtures,
and an isolated PostgreSQL database for schema and concurrency validation.
They cover fixed draft endpoints, header injection, encryption binding, OAuth
session/state checks, scope/platform discovery, confirmation, ownership,
revocation, in-flight callbacks racing disconnect, reauthorization history,
quota retry deadlines, duplicate recovery and sanitized receipts. Live
Google/WhatsApp/model calls are not needed for these checks.

`tests/gmail-storage-live.test.ts` verifies fresh setup, the signed v1/v2-to-v3
upgrades, reruns, runtime permissions and concurrent operation claims against
PostgreSQL. Set `CONTEXT_GMAIL_TEST_DATABASE_URL` to a disposable local database
named `context_gmail_test` and run
`npx vitest run tests/gmail-storage-live.test.ts`. The suite creates its synthetic
roster/runtime role and additional `context_gmail_upgrade_test` and
`context_gmail_v2_upgrade_test` databases;
never use a shared or production database. The upgrade preserves credentials and
operation receipts, removes the unused encrypted-content column, and backfills
Google account identity only when the original connection version still matches.
Older v1 records without provable identity remain inaccessible through the bot.

- [Google Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google draft lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts)
- [Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth token handling policy](https://developers.google.com/identity/protocols/oauth2/policies)
- [Google Gmail error handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Ramesh draft wiring](../../baileys-ramesh/docs/mail-drafts.md)
