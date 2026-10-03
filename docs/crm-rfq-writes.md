# New RFQs through Context Engine

Implemented on `feat/crm-rfq-write`, disabled by default and not deployed. No production records were created during development. The only new business action is `create_crm_rfq`.

## Intake SOP

References: `whatsapp-logistics-bot/src/routes/whatsapp.js` and CRM Automations' `rfq.controller.js`, `rfq.service.js`, `twenty.service.js`. The reference forwards the original `#twenty` text, stores it as `description`, and attributes `createdBy` to the employee's linked Twenty member.

On 4 October 2026, a read-only mirror inspection found 1,898 undeleted opportunities, including 235 at `RFQ_RECEIVED`. The 18 newest RFQs centered on a location and space requirement. Company, contact, budget and the city field could be absent; named localities/corridors and alternatives were common. Across the full mirror only 250 entries had budget text, 517 had duration and 522 had `requirementInSft`. These are historical completeness observations, not mandatory-field rules; the new intake minimum deliberately improves on incomplete legacy records.

The deployed `/open-api/core` and `/rest/metadata/objects` confirmed that `description` is text, `requirementInSft` is an integer, `repeatClient` uses `OPTION1`/`NO`, and POST `/rest/opportunities` returns `data.createOpportunity` with HTTP 201. The Prisma `opportunities` table in CRM Automations is a polling mirror, not the write destination.

| Input | Rule |
| --- | --- |
| Original text | Required, complete and verbatim, including whitespace, newlines and tags. Never summarize it. |
| Location | Required: specific city, locality, corridor or alternatives. Do not infer a city from a locality. TBD, anywhere and India are insufficient. |
| Requirement | Required: positive quantity, bound or ordered range with an explicit unit. Supports sqft, sqm, acres, pallets, tonnes/MT, cbm and containers. Repeated range units must agree (e.g. `5,000 sqft to 10,000 sqft`). Ask if the unit is missing. |
| Company, contact, budget | Optional; exact source excerpts only. Budget preserves currency, period, range and units. |
| Source, duration, repeat client | Optional classifications with an exact supporting quote. No guessed defaults. |
| Stage and creator | Server-owned: `RFQ_RECEIVED` and the authenticated live-verified CRM member. The owner is the same member. |

Every supplied text field must occur verbatim in `raw_text`. This establishes source provenance, not semantic correctness; the agent must extract faithfully and the user reviews the exact proposal. The structured phone convenience field accepts unambiguous Indian numbers; other contacts remain in the full raw description.

The title is `Company or TBD - Requirement - Location`. Only exact integer square-foot requirements populate `requirementInSft`. Ranges, bounds, approximations and other capacities remain intact in the title/description. Never select a midpoint or convert pallet capacity to area. Unknown optional CRM fields are omitted, including total deal value and assignments.

Raw text is bounded at 3,000 characters; Ramesh additionally limits the complete review proposal. Oversized input is rejected without truncation or summarization.

## Tool and permissions

```json
{
  "operation_id": "11111111-1111-4111-8111-111111111111",
  "raw_text": "#twenty\nAcme needs 25,000-35,000 sft from Dabaspet to Tumkur",
  "company_name": "Acme",
  "location": "Dabaspet to Tumkur",
  "requirement": "25,000-35,000 sft"
}
```

The explicit permission is `crm.rfq:write`. Read credentials, console key rotation, OAuth defaults, Analyst/admin status and warehouse access do not grant it. The employee must be active and linked to exactly one live Twenty member by email and member ID. The grant and roster are rechecked before dispatch and before releasing the result. No general `crm:write` permission is introduced.

The closed MCP contract declares `sourceFamily: crm`, `effect: create`, `idempotencyArgument: operation_id`, and `sourceTextArgument: raw_text`. Platform controls and descriptions use the existing prompt console. REST `/api/v1` stays read-only. Arguments cannot supply stage, IDs to update, assignments, URLs, headers, arbitrary fields, notes or an upsert flag.

The companion Ramesh change fills `raw_text` directly from complete stored sources selected through `_source_message_ids`; the model cannot supply or rewrite it. Multiple messages join in selection order with exactly two newlines. Source constraints are checked before saving the proposal. Forwarded messages supply data; a separate direct request authorizes the proposal. The existing independent verifier and later exact `confirm CODE` authorize dispatch. Older Ramesh versions reject the new metadata and require the companion update.

## Recovery and deferred work

Before POST, a private receipt commits the employee/member identity, action, operation UUID and accepted-arguments hash. Changed arguments or a changed linked member under that UUID conflict. Concurrent or repeated calls cannot issue another POST. The adapter never calls PATCH, DELETE or upsert and never retries HTTP automatically.

| Outcome | Meaning |
| --- | --- |
| `created` | Verified 201 result matches every requested field and its receipt was persisted. |
| `replayed` | Original creation receipt; not proof of current existence, stage or ownership. |
| `not_dispatched` | This invocation sent no CRM mutation. |
| `rejected` | Explicit CRM validation/access rejection; the UUID stays terminal. |
| `outcome_unknown` | Creation may have happened. Preserve the UUID and frozen arguments. |

Recovery checks receipts only, revalidating the employee, scope and linked member against the roster. An existing receipt is returned without a live Twenty lookup or a receipt write, so CRM outages do not block recovery. A crash after reservation, lost/malformed response or failed receipt commit can remain uncertain even if no RFQ was actually created. It requires administrator reconciliation in Twenty; there is no automatic redispatch. A new UUID means a new intended RFQ, not a retry or semantic duplicate check. Existing downstream CRM automations still apply to new opportunities.

**CRM audit/history and transaction reversal implementation are deferred as requested.** The existing Ramesh encrypted write journal continues recording proposals and outcomes. The new service receipt stores hashes, IDs, state and timestamps, never raw RFQ text or credentials; it is deduplication state, not a comprehensive business audit. No `auditHistory` grant or compensation tool is advertised. Future history disclosure needs fresh per-record authorization, and undo needs unchanged-record/version checks with preservation of original history.

## Setup and future actions

1. Provision the existing Context Engine runtime role as usual. Inspect `npm run crm-writes:migrate`, then apply with `npm run crm-writes:migrate -- --apply --env-file <admin-env>`. This adds only `context_crm_private.write_operations`. If it ran before runtime-role provisioning, rerun afterward to install narrow grants.
2. Reapply existing console and MCP OAuth scope migrations for enabled credential stores. They expand allowed syntax without changing any stored grant.
3. Set server-only `CONTEXT_CRM_WRITE_API_KEY` to a dedicated Twenty credential permitted to read workspace members and create opportunities. There is no fallback to the read key. `TWENTY_CRM_BASE_URL` must be an HTTPS origin.
4. Deploy both branches, then enable `CONTEXT_CRM_RFQ_WRITES_ENABLED=true`. Explicitly issue/consent `crm.rfq:write` to intended employees. For signed Ramesh requests, explicitly add it to both the bot signing ceiling and Context Engine issuer registration. Enable the intended tool platforms.

Files are separated into policy/schema/mapping (`rfq.ts`), fixed transport (`client.ts`), receipts (`storage.ts`) and execution (`execute.ts`) under `src/lib/crm-writes/`. Future deal creation, updates and notes should get separate named tools, narrow scopes, schemas, action handlers and deliberate database action-allowlist changes. Updates require record-level access and expected versions. Keep this RFQ tool closed instead of adding an arbitrary object/action/payload API.

The independent mail branch touches scope lists, credential migrations, MCP registration, consent labels and Ramesh OAuth vocabulary. Merge by retaining the union of both capabilities and updating the scope-count constraint; preserve mail defaults and tests. This branch starts from the committed GIS foundation, without copying another agent's uncommitted work.

Deterministic tests cover intake, source preservation, mapping, permissions, MCP binding, identity checks, uncertainty and replay. `tests/crm-rfq-storage.test.ts` additionally requires a fresh local `context_crm_rfq_test` database through `CONTEXT_CRM_TEST_DATABASE_URL`; it tests real rollback, competing claims, terminal receipts, migration reruns/drift and denied privileges. Validation used disposable Podman PostgreSQL 17. No paid model evaluation or live CRM write was used.
