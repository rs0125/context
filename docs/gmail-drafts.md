# Employee Gmail drafts

Ramesh can prepare an email, show the employee the proposed recipients, subject
and plain-text body, and save it in that employee's Gmail Drafts after the existing
`confirm CODE` step. The employee reviews and sends in Gmail. This implementation
has no send, update, delete, attachment, inbox-search or arbitrary Google-request
tool. It does not create a custom per-draft review page or deep link.

## Tools and account connection

All mail tools require the explicit `mail:drafts` scope and default to the
`whatsapp` platform. Existing credentials and ordinary read-scope defaults do not
gain mail access automatically. Discovery also requires enabled, valid Gmail
configuration.

| Tool | Behavior |
| --- | --- |
| `get_email_connection` | Returns the authenticated employee's connection status (`active`, `disconnected`, `needs_reauth` or `revoking`), mailbox, usable connection ID/version and `/mail` connection-page URL. |
| `create_email_draft` | Saves one confirmed plain-text draft in that mailbox. Requires a durable operation UUID and the connection ID/version from the status tool. |
| `list_email_drafts` | Recovers creation references and timestamps for follow-up reads in the same verified Google mailbox, including after reauthorization. Does not disclose historical mail content or confirm a draft's current Gmail status. |
| `read_email_draft` | Reads the current content of a draft created by this service, using its opaque `draft_ref`. Requires an active connection to the original verified Google account and current authorization. |

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
4,800 characters, so keep drafts short. Longer proposals are rejected before
confirmation; their content is never silently truncated.

Reading an existing draft includes To, CC and BCC headers, including recipients
added manually in Gmail. This does not add BCC to the create capability. Reads
budget the serialized data to 76,000 bytes, leaving room for the REST/MCP envelope
inside Ramesh's 80,000-byte evidence limit. Large edited bodies are truncated at
a Unicode character boundary and marked `body_truncated`. Unusually large
recipient headers may be shortened by whole entries and are explicitly marked
`recipients_truncated`. An incomplete read must direct the employee to Gmail for
the full content or recipient list.

The success reply supplies the mailbox, subject and the fixed
`https://mail.google.com/mail/#drafts` folder link. The employee must select the
right Gmail account. It does not promise to open an individual draft. Google
draft IDs are not treated as browser URLs.

## Sending boundary

Google's narrow server-side `gmail.compose` permission covers both drafts and
sending. There is no equivalent draft-only Gmail API permission for this flow.
The Google consent screen therefore mentions sending. Our application enforces
the narrower behavior: the adapter only implements draft creation, retrieval and
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
After that deadline, the same confirmed operation and unchanged arguments can
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
   This is also required to upgrade the original Gmail schema to v2 **before
   deploying this version of the code**. The upgrade validates the prior schema,
   adds connection lifecycle and retry/account-binding support, and removes
   the unused encrypted draft-content column.
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
   confirmation configuration enabled.
5. Deploy the Context Engine and bot changes, then set
   `CONTEXT_GMAIL_ENABLED=true` with complete configuration. Each employee connects
   their own mailbox at `/mail`. Confirm one intentional test draft, inspect it
   in Gmail, then retry the same operation and verify that no second draft
   appears. Do not send it as part of a connectivity test.

The private `context_gmail_private` tables use forced RLS and the existing narrow
runtime role. Public/API roles have no access; runtime receives only
SELECT/INSERT/UPDATE on these two tables. Refresh tokens use AES-256-GCM with
employee, record ID and purpose binding. The Context Engine operation journal
stores metadata, a content hash and provider references; it no longer keeps a
second copy of recipients, subject or body. The WhatsApp confirmation journal is
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

`tests/gmail-storage-live.test.ts` verifies fresh setup, the signed v1-to-v2
upgrade, reruns, runtime permissions and concurrent operation claims against
PostgreSQL. Set `CONTEXT_GMAIL_TEST_DATABASE_URL` to a disposable local database
named `context_gmail_test` and run
`npx vitest run tests/gmail-storage-live.test.ts`. The suite creates its synthetic
roster/runtime role and an additional `context_gmail_upgrade_test` database;
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
