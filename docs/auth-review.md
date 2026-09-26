# Employee authentication review

Reviewed 2026-09-26 against `09c1abf`, with follow-up fixes described below. This is a code and bounded test review, not a penetration-test certification. Reproductions use synthetic employees and credentials; no source records or deployed keys were changed.

## Remaining issues before wider rollout

1. **Server-side logout revocation (P2).** `src/app/api/auth/logout/route.ts` deletes cookies, but `src/lib/console-auth.ts` accepts a previously copied, correctly signed cookie until its eight-hour expiry while the roster entry remains active. Reproduction: create a synthetic session, call logout, then reuse the original cookie with `getConsoleIdentity`; it still succeeds. Persist session state or a bounded revocation record in private storage and check it alongside the roster. An in-memory denylist is insufficient across Vercel instances. Disabling the roster employee already blocks requests, but is broader than ending one session. [OWASP recommends server-side invalidation on logout](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#logout-button).

2. **Legacy environment keys are bound only to email (P2).** `CONTEXT_API_KEYS_JSON` registrations do not contain an immutable employee ID. A still-valid key can resolve to a different active roster row after the email is reused. A synthetic test reproduced this without database access. Console-issued keys bind employee ID and email and reject this change. Prefer retiring environment registrations once employees have connected using console-issued keys; otherwise migrate them to immutable employee IDs. Console key replacement does not revoke environment keys or their connector grants.

3. **Production setup is still required; local sign-in is confirmed.** Google accepted `http://localhost:3000/api/auth/google/callback` using the existing client, and the user confirmed completing Google sign-in and reaching the employee key page. The latest production probe rejected `https://context-wareongo.vercel.app/api/auth/google/callback` with `redirect_uri_mismatch`. Authorize that exact URI, configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Vercel, and preserve existing encryption/session secrets. Automated tests validate real RSA signatures with synthetic tokens and mocked browser flows; the user confirmation covers the live local flow, not production. [Google requires an exact registered callback URI](https://developers.google.com/identity/openid-connect/openid-connect#sendauthrequest).

## Operational capabilities not yet implemented

- **Attributable console audit events.** REST and MCP requests have safe structured logs. Google sign-in outcomes, key replacement, and knowledge publication do not yet emit equivalent actor/action/outcome events. Add those without logging keys, cookies, OAuth codes, tokens, page bodies, or source records. [OWASP audit guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html#audit-logs).
- **Context-only suspension.** Every active work-domain roster employee can obtain company-guide access and issue a key. There is no separate Context access switch or admin UI for suspending Context access while retaining dashboard access. That is a product-policy choice, not a failure of the current roster checks.
- **Knowledge publication is a privacy boundary.** Reviewed Markdown, titles, summaries, and search snippets are returned as authored. Warehouse/CRM contact filtering does not redact arbitrary wiki content. Page access is based on the three service scopes, not employee- or team-specific document permissions; ordinary active employees all have `knowledge:read`. Keep restricted contacts and admin-only material out of pages published for that audience, or add explicit document audiences before publishing it.
- **Deployment-wide abuse limits.** Application rate limits and pool socket limits are per instance. The transaction pooler remains on port 6543 with one socket per instance by default; a larger deployment needs edge limits or an explicit global budget. No extra pool was introduced for Google sign-in.

## Legacy-key retirement procedure

1. Have the employee sign in with Google and create or retrieve their console key.
2. Reconnect each existing client using that key and verify an authorized read.
3. Remove the employee's legacy entries from the deployed `CONTEXT_API_KEYS_JSON` registry and redeploy. Changing the local environment does not change production.
4. Confirm the old key is denied and its old MCP connection cannot read records. Do not reuse an employee email while an unbound legacy key remains active.

No key has been retired automatically during this review, because that could disconnect an existing client.

## Follow-up fixes in this review

The accompanying changes address stale employee/key/editor state across browser tabs, key expiry and narrower-key guidance, overlapping Google login attempts, and misclassified Google client-configuration errors. See the associated regression tests for exact behavior. These browser improvements do not provide server-side session revocation or invalidate data already copied outside the application.

Validation: 908 unit tests pass (28 opt-in integration tests skipped); all 17 console browser cases were verified, including the previously reproduced failures; the production build and TypeScript checks pass. Browser fixtures are synthetic. Session refresh is event-driven and deduplicated; key expiry checks do not poll the database. These fixes add no database pools, change no socket limits or schemas, and revoke no live keys.

## Checks that held

- Google signature, issuer, audience, authorized party, expiry, nonce, verified email, and Workspace domain checks precede roster access.
- Login uses browser-bound state and PKCE; Google HTTP calls do not hold a database socket.
- Admin access comes only from an active, unique `public."VerifiedNumber"` row with `adminAccess = true`.
- Console key retrieval and replacement cannot select another employee, including when performed by an admin.
- Database-issued keys and MCP grants recheck current roster permissions and key/grant validity; WAG admin status does not confer Twenty admin status.
- Agent-facing business-data endpoints remain read-only and retain the existing field allowlists.
