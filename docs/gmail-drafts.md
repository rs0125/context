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
| `get_email_connection` | Returns the authenticated employee's connection status, mailbox, connection ID/version and `/mail` connection-page URL. |
| `create_email_draft` | Saves one confirmed plain-text draft in that mailbox. Requires a durable operation UUID and the connection ID/version from the status tool. |
| `list_email_drafts` | Recovers creation references and timestamps for follow-up reads on the current connection. Does not disclose historical mail content or confirm a draft's current Gmail status. |
| `read_email_draft` | Reads the current content of a draft created by this service, using its opaque `draft_ref`. Requires the same active connection and current authorization. |

Each employee visits `/mail`, signs in with their active Wareongo work account,
and connects that same account to Google. OAuth uses state, nonce and PKCE and is
bound to the browser session, employee identity and current connection version.
A stale callback cannot undo a later reconnect or disconnect. There is no
domain-wide delegation or caller-selectable mailbox. Refresh tokens remain on
the Context Engine server, encrypted with a separate key; the bot sees no Google
credentials.

Recipients can be left empty for a draft. Otherwise supply real email addresses,
up to ten To and ten CC recipients. The subject is one line, 1–200 characters.
The body is plain text, 1–12,000 characters and at most 20,000 UTF-8 bytes. Extra
fields, sender overrides, BCC, HTML and attachments are rejected. Text in an email
body is content, never permission or instructions to execute another tool.
WhatsApp additionally limits the serialized proposal arguments plus summary to
4,800 characters, so keep drafts short. Longer proposals are rejected before
confirmation; their content is never silently truncated.

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
logs or the WhatsApp bot's environment. Disconnect removes the stored refresh
token and invalidates the connection version; it cannot cancel an HTTP request
that Google has already accepted. Employees can also revoke the app in their
Google account's connected-app settings.

## Duplicate prevention and current state

Gmail draft creation does not accept our operation UUID as an idempotency key.
Context Engine commits an employee-scoped claim before the one permitted create
request. The claim freezes the connection ID/version and a hash of the content.
The same UUID with different content is rejected. Concurrent callers, process
restarts and retries never issue another create for an existing claim.

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
proposals and access through older connection references; existing Gmail drafts
remain in the mailbox and can still be reviewed there.

## Setup and rollout

1. Create a dedicated Google OAuth **Web application** client in the company
   Workspace project, enable the Gmail API, and configure the appropriate
   internal-user consent audience and Workspace admin access controls. Register
   exactly `<CONTEXT_CONSOLE_ORIGIN>/api/mail/google/callback`. Existing console
   sign-in continues to use `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and its own
   `/api/auth/google/callback` redirect.
2. Set server-only `CONTEXT_GMAIL_CLIENT_ID`, `CONTEXT_GMAIL_CLIENT_SECRET` and
   `CONTEXT_GMAIL_ENCRYPTION_KEY`. The encryption key is an independent,
   cryptographically random 32-byte value encoded as unpadded base64url; retain it
   securely across deployments. Losing or replacing it makes existing encrypted
   connections unreadable and requires reconnecting. Keep
   `CONTEXT_GMAIL_ENABLED=false` while preparing storage.
3. Review `npm run gmail:migrate` (preview only). Apply with
   `npm run gmail:migrate -- --apply` using the existing migration-owner setup.
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
SELECT/INSERT/UPDATE on these two tables. Refresh tokens and stored operation
content use AES-256-GCM with employee, record ID and purpose binding. Operation
claims must remain durable to preserve duplicate prevention; do not casually
delete or restore them independently of mailbox operations.

The private Gmail schema and console/MCP scope constraints were applied and
verified in production on 4 October 2026, including restricted runtime grants.
No connections, keys or credentials were seeded. Gmail remains disabled:
configuring Google, setting the dedicated server secrets, granting the scope
and connecting an employee are required before the tools can work. No live
Google draft or send was used for release validation.

## Validation and references

Tests use synthetic employees, mocked Google HTTP, and isolated storage fixtures.
They cover fixed draft endpoints, header injection, encryption binding, OAuth
session/state checks, scope/platform discovery, confirmation, ownership,
revocation, reconnect races, duplicate recovery and sanitized receipts. Live
Google/WhatsApp/model calls are not needed for these checks.

- [Google Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google draft lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts)
- [Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Ramesh draft wiring](../../baileys-ramesh/docs/mail-drafts.md)
