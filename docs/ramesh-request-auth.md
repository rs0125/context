# Ramesh request authentication

Ramesh uses `POST /mcp/ramesh` alongside the Claude connector's OAuth-only `/mcp`. Both entry points use the existing MCP tools, current employee permissions, record restrictions, response projections and evidence envelopes. No employee OAuth enrollment, access-token table or refresh-token table is needed for this first-party path. Claude's OAuth grants remain independent.

## Trust and request flow

1. The gateway derives a phone from the actual WhatsApp sender or reciprocal, encrypted Baileys LID mappings. Message text, contact cards, quoted messages and model arguments cannot select an employee.
2. Ramesh resolves exactly one active `VerifiedNumber` employee. Unknown users can still chat; they receive no business credential. Business reads are DM-only.
3. Ramesh signs each individual MCP POST using its private Ed25519 key. Context Engine has only the registered public key. The private key is never transmitted.
4. Context Engine verifies the signature, exact endpoint, HTTP method, body digest, time window and unique nonce, then independently checks the current employee ID/phone and permissions.
5. Each business transaction rechecks the employee binding, registration and expiry. Existing tool authorization intersects requested scopes with the live roster. The worker verifies `get_context.employee_id` before reading business data.

This is a first-party JOSE request-signature profile, not an OAuth grant or a claim of full HTTP Message Signatures compliance. It follows [JWT algorithm, audience and type validation guidance](https://www.rfc-editor.org/rfc/rfc8725.html). Service authentication and employee authorization are separate; [OWASP recommends checking permissions on every request](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#validate-the-permissions-on-every-request).

An attacker knowing a phone number cannot sign requests. A stolen signature cannot change employee, endpoint or body, and cannot be reused after its nonce is consumed. **A compromised Ramesh host/private key can assert employees.** This design therefore trusts that gateway as an identity broker; it does not prove employee presence independently of the gateway. Limit host access and scopes, use HTTPS, rotate keys, and keep trusted sender resolution outside the model.

## Wire contract

`Authorization: Ramesh <compact JWS>` with protected header `alg=EdDSA`, `typ=ramesh-request+jwt`, and an allowlisted `kid`. Embedded keys, key URLs, additional header fields and other algorithms are rejected.

| Claim | Value |
| --- | --- |
| `iss` | `wareongo:ramesh` |
| `aud`, `htu` | Exact configured Context Engine origin plus `/mcp/ramesh` |
| `sub` | Immutable positive employee ID, as a string |
| `phone` | Canonical E.164 sender phone |
| `chat_type`, `htm` | `dm`, `POST` |
| `body_sha256` | Base64url SHA-256 of the exact transmitted body bytes |
| `iat`, `exp` | Unix seconds, positive lifetime at most 60 seconds; up to 5 seconds of verification skew |
| `jti` | New UUID per HTTP request, including initialization and notifications |
| `scopes` | Unique subset of `knowledge:read`, `warehouses:read`, `crm:read`, `analytics:read` |

The server also caps scopes by key registration and current employee permissions. Analytics requires the registered service scope and the employee's current Analyst access (including roster administrators). Writes and group reads are excluded. Requests must use JSON, have no `Origin`, query or alternate URL, and remain within 32 KiB. The SDK's background GET receives 405. No sessions or redirects are used.

`context_ramesh_private.request_nonces` in Supabase stores only a hashed issuer/key/nonce and expiry. A primary key and atomic insert reject simultaneous replays across instances. Expired rows are removed in bounded batches during later authenticated requests. The runtime has SELECT/INSERT/DELETE, not UPDATE; anonymous, authenticated and service-role API access is revoked. A storage failure denies access. This limited shared state is necessary for one-use replay protection; there is no per-user credential state.

## Configuration and deployment

Apply the [full security rollout](../README.md#security-rollout) first, including the restricted `context_engine_runtime` connection. Preserve the deployed session/encryption secrets and actual legacy key registry. The runtime's roster column allowlist now includes `phone_number`; no employee data is modified.

The database credential is separate from Ramesh's request-signing key. The approved Supabase provisioning mode uses `--allow-reviewed-platform-access`: application tables retain strict explicit grants, while nine reviewed platform objects retain their inherited PUBLIC access. This does not authorize additional MCP tools or employee data. It also does not protect those platform objects from a stolen database credential. See the security rollout for the exact residual HTTP-queue/header exposure and the required application checks.

Generate a separate key for each environment using a new private directory:

```sh
node scripts/create-ramesh-key.mjs --directory /PRIVATE/new-ramesh-key --kid ramesh-2026-10
node scripts/migrate-ramesh-auth.mjs --env-file /PRIVATE/operator.env
node scripts/migrate-ramesh-auth.mjs --env-file /PRIVATE/operator.env --apply
```

The first migration invocation validates and rolls back. The second commits. It requires the restricted runtime role to exist, checks table constraints/indexes/policies on rerun, and adds only nonce storage and the required phone-column read grant. It does not enroll users or write business records. Key generation refuses existing directories, writes files with mode 0600, and prints no private key. Generated registrations expire after 90 days; rotate before that date.

| Application | Setting | Value/source |
| --- | --- | --- |
| Context Engine | `CONTEXT_RAMESH_AUTH_ENABLED` | `true` after storage and keys are ready |
| Context Engine | `CONTEXT_RAMESH_PUBLIC_KEYS_JSON` | Contents of `context-public-keys.json`; one to three public key registrations |
| Context Engine | `CONTEXT_CONSOLE_ORIGIN` | Existing canonical HTTPS origin |
| Context Engine | `CONTEXT_DATABASE_URL` | Restricted Supabase transaction-pooler credential |
| Ramesh | `CONTEXT_MCP_URL` | Canonical HTTPS origin plus `/mcp/ramesh` |
| Ramesh | `CONTEXT_RAMESH_SIGNING_KEY_JSON` | Contents of `worker-signing.json`, stored only in the protected worker environment/secret store |

The public registry is a strict array of `{kid, publicKey: {kty: "OKP", crv: "Ed25519", x}, scopes, expiresAt}`. Worker configuration contains `{kid, privateKey: {kty: "OKP", crv: "Ed25519", x, d}, scopes}`. Keep these settings out of prompts, chat, source control and client bundles. Ramesh composes this adapter into its conversational graph when `BUSINESS_READS_ENABLED=true`. Discovery and each read resolve live employee authorization; adding a service scope does not grant that permission to every employee.

For rotation, deploy the new public key alongside the old one, switch the worker's private key, verify signed reads, then remove the old registration and redeploy Context Engine. Disabling `CONTEXT_RAMESH_AUTH_ENABLED` or removing a key denies subsequent requests **on deployments using that configuration**. Vercel environment edits require deployment; old deployment URLs must also be protected or retired. Employee deactivation uses the live roster and does not need a deployment. Keep machines' clocks synchronized.

Keep credentials and backing databases isolated for previews. Signature validation does not replace edge abuse controls or deployment-wide connection limits. Rate limits and pool budgets described in the main README still apply. Audit events contain request/key/employee IDs and status, not phones, tokens, private keys or message bodies.

## Verification

`tests/ramesh-auth.test.ts` exercises the real MCP SDK and shared API authorization with synthetic keys/employees, including forged signatures, algorithm confusion, tampering, endpoint/scope restrictions, expiry, replay, offboarding and parallel OAuth rejection. The opt-in `test:security:postgres` suite uses a fresh local PostgreSQL instance to verify restricted role access, logout revocation, legacy key binding, replay races across connections, cleanup and migration drift. It must never target Supabase production.

The corresponding worker tests verify actual request signatures, original sender/LID mapping, live roster rechecks, cancellation, endpoint restrictions and absence of OAuth writes. Neither suite opens a WhatsApp connection. Deployment checks should verify unauthenticated rejection, unchanged Claude OAuth metadata/challenge, and a bounded authenticated context read. Google sign-in/logout and consent UI require a real browser session for final acceptance.

## Full employee-authorized catalogue

Ramesh uses the same scope vocabulary as the OAuth/REST clients: knowledge, warehouses, CRM and analytics. New service keys register all four read scopes; existing registrations must explicitly include `analytics:read` on both the server public registration and worker signer before Google tools appear. The engine intersects them with the current active roster permissions on every request. Admins inherit Analyst access; an ordinary employee does not gain analytics from Ramesh, and demotion removes the tools. Claude's OAuth path is unchanged.

Local capture tests use the real engine with Supabase and Google connections, without any WhatsApp transport. Production verification uses the model-free capability probe against the actual worker credentials; it does not send WhatsApp messages.

## Dynamic read-tool contract

Context Engine owns each tool's discovery metadata, description, input/output
schemas and guidance. The request-scoped catalogue reflects current employee
permissions and the tool's configured platform visibility. Ramesh reads that
catalogue and the authenticated `get_context` response at runtime; it must not
treat a previous employee's catalogue or a saved role as current authorization.

Every read tool advertises `readOnlyHint: true` and
`_meta["wareongo/context-read-v1"] = { requiredScopes, sourceFamily }`.
`requiredScopes` states the minimum needed for discovery. Individual arguments
may need additional permissions: a CRM-only shortlist checklist is allowed,
while reading selected warehouses also needs warehouse access. The source API
still authorizes every read against current permissions.

Successful results retain the existing `source_path`, `status`, `data` and `meta`
envelope. `meta.toolName` and `meta.argumentsSha256` bind the result to the actual
MCP request. The hash is SHA-256 over JSON with object keys recursively sorted
in ordinal order and arrays unchanged, captured before schema trimming or
defaults. These fields are owned by the connector, not source data or the model.
They describe a request binding over authenticated transport, not a standalone
signature or authorization grant.

New read tools that follow this contract can be added on the engine without
extending a Ramesh tool-name list. New permission domains still require deliberate
service-scope configuration; writes require a separate execution and approval
contract. Existing Claude OAuth behavior and employee permissions remain the
same.
