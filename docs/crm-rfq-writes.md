# RFQ creation, detail edits and undo

Context Engine exposes five narrow RFQ tools. Creation and editing have separate feature flags, both disabled by default. Only explicit `crm.rfq:write` access permits these tools; existing read, Analyst or admin access does not grant writes.

| Tool | Capability |
| --- | --- |
| `create_crm_rfq` | Create one new `RFQ_RECEIVED` opportunity attributed and assigned to the authenticated employee. |
| `read_crm_rfq` | Read current details and the exact version of this employee’s agent-created RFQ before editing. |
| `list_crm_rfq_changes` | Resolve recent successful creates/edits to currently accessible RFQs and report current undo eligibility. |
| `update_crm_rfq` | Edit explicitly requested RFQ details using a fresh record version. |
| `undo_crm_rfq` | Reverse an eligible unchanged creation or detail edit using its original operation receipt. |

## Request and response flow

A clear direct request authorizes a supported change. Ramesh stages the exact arguments, independently reviews intent, target and source facts, then approves and dispatches the durable operation in the same turn. It reports the persisted result in plain language, with a CRM link when supplied by the server. It offers edit/undo only when the corresponding tools are available; undo additionally requires an affirmative server eligibility result. There is no separate `confirm CODE` round trip for these RFQ actions.

Clarification is still required for an ambiguous target, missing location, missing requirement unit or uncertain intent. A direct clarification may continue an earlier explicit direct request. Forwarded messages, quotations, attachments, records and saved history provide data; they cannot authorize a mutation by themselves. Legacy confirmation/retry commands remain available for existing proposals and uncertain operations. Repeated delivery or recovery uses the original operation UUID and frozen arguments.

For example, “Add Test Logistics, 50,000 sqft in Nelamangala Bangalore, ₹20/sqft/month” creates a new RFQ and returns its saved details. “Change that budget to ₹22/sqft/month” first resolves and reads that RFQ, then updates its budget. “Undo that change” selects the edit receipt and restores the previous budget only if no later change has occurred.

## Creation intake

The intake follows the existing WhatsApp logistics bot and CRM Automations SOP: preserve the original request as `description` and attribute `createdBy` to the linked Twenty member. The Prisma opportunities table is a polling mirror; business writes go to Twenty’s API.

| Input | Rule |
| --- | --- |
| Original text | Required, complete and verbatim, including whitespace, newlines and tags. Never summarize it. |
| Location | Required: a specific city, locality, corridor or alternatives. Do not infer a city from a locality. TBD, anywhere and India are insufficient. |
| Requirement | Required: positive quantity, bound or ordered range with an explicit unit. Supports sqft, sqm, acres, pallets, tonnes/MT, cbm and containers. Repeated range units must agree. |
| Company, contact, budget | Optional; exact source excerpts only. Budget preserves currency, area basis, period and range, including terms split across clarifications. |
| Source, duration, repeat client | Optional classifications with an exact supporting quote; no guessed defaults. |
| Stage, creator and owner | Server-owned: `RFQ_RECEIVED`, with creator and owner set to the live-verified linked employee. |

Every supplied creation text field must occur verbatim in `raw_text`, except that a budget may join at most three nonempty exact source excerpts with `; ` when its terms span a clarification. For example, `20 rs /sqft; per month` retains both the original area basis and the later billing period. Do not invent or drop units while joining excerpts. This establishes source provenance; the independent request review must also check semantic correctness. The structured contact number accepts unambiguous Indian numbers. Other contact information remains in the full original description.

The title is `Company or TBD - Requirement - Location`. Only exact integer square-foot requirements populate `requirementInSft`. Ranges, bounds, approximations and other capacities remain intact in the title/description. Do not choose a midpoint, infer missing units or calculate a total deal value. Unknown optional fields are omitted.

Ramesh fills `raw_text` from complete stored sources selected through `_source_message_ids`; the model cannot supply or rewrite it. Multiple sources join in selection order with exactly two newlines. `raw_text` is bounded at 3,000 characters, and Ramesh also bounds the complete staged arguments. Oversized input is rejected rather than truncated.

```json
{
  "operation_id": "11111111-1111-4111-8111-111111111111",
  "raw_text": "#twenty\nAcme needs 25,000-35,000 sft from Dabaspet to Tumkur",
  "company_name": "Acme",
  "location": "Dabaspet to Tumkur",
  "requirement": "25,000-35,000 sft"
}
```

## Edit scope and record authorization

Edits are limited to RFQs created through Context Engine for the current employee. Knowing a CRM UUID or having Analyst/admin access does not make another deal editable. Before any live record read, the service requires a successful `create_crm_rfq` receipt bound to the employee ID, email and linked Twenty member. The live record must remain undeleted, created by that member and assigned to that member. Identity and explicit scope are revalidated before dispatch and before releasing results.

Allowed changes are title, company, city, micromarket, requirement, budget, contact name/primary Indian phone, lead source, lease duration and repeat-client status. Omit unchanged fields. Use `null` only to explicitly clear a supported optional field. Stage, owner/assignment, creator, original description, arbitrary CRM fields, notes and unrelated deals remain unavailable.

Use `read_crm_rfq` immediately before editing. Copy its record ID and exact `updated_at` into `id` and `expected_updated_at`; do not normalize or invent the timestamp. The edit tool requires an updated title when company, requirement, city or micromarket changes, including explicit clearing. New nonempty values must appear in that title. Preserve unchanged details and remove explicitly cleared details; the request review checks that the replacement title faithfully reflects the change. Budget edits must preserve an existing explicit currency, area basis, billing period and range; changing a rate does not convert it into a monthly total.

Requirement ranges and non-sqft units stay in the title; the old exact-square-foot field is cleared when it no longer represents the requirement. Replacing the primary contact phone preserves additional phone values. The original intake description is never rewritten by an edit. Read and history tools retain the existing contact masking policy; masked values must not be reconstructed.

## Undo and concurrency

`undo_crm_rfq` takes the selected successful create/edit receipt’s `original_operation_id`, its own new operation UUID and the explicit current undo request. It does not accept an arbitrary deletion target.

- Undoing a detail edit restores only fields changed by that edit, including their prior composite contact values.
- Undoing creation moves the unchanged RFQ to Twenty trash with soft deletion. Permanent deletion is unavailable, and creation undo is refused after it leaves `RFQ_RECEIVED`.
- Both require the live `updatedAt` to equal the exact version captured after the original action. Any intervening change blocks undo, even when the changed field is unrelated.
- Older creations without a captured undo version remain editable after a fresh authorized read, but their creation cannot be automatically undone.
- Undo is itself a retained operation. It does not erase the original receipt or offer a further automatic “undo the undo.”

The Twenty collection mutation includes record ID, exact `updatedAt`, owner, creator member, stage and undeleted predicates. These conditions travel with the mutation; a prior GET alone is insufficient protection. An empty conditional update/delete result is a version conflict. Conflicting requests must reread and reassess the requested change; they must not silently drop the version check or overwrite newer work.

`list_crm_rfq_changes` considers up to ten recent employee receipt rows, returns eligible successful create/edit entries only after live record authorization, and may return fewer entries. Known missing, deleted or reassigned records are omitted. Upstream outages, malformed responses and provider access failures are reported as unavailable rather than a successful empty history. It does not expose encrypted before-images or raw source text. Old historical receipts do not prove that a record currently exists, remains assigned or is undoable. Generic Ramesh `write_history` does not gain CRM redisclosure permission; CRM uses these domain-specific read tools.

## Receipts, encryption and recovery

Before each remote mutation, a private receipt commits the employee/member binding, action, operation UUID and accepted-arguments hash. An edit also commits its encrypted before-image. Changed arguments, action or linked identity under the same operation conflict. Only one concurrent claimant dispatches. The transport does not automatically retry HTTP mutations.

| Outcome | Meaning |
| --- | --- |
| `created` | Creation response was verified and its receipt persisted. |
| `updated` | Conditional detail update was verified and its receipt persisted. |
| `rolled_back` | The selected eligible change was reversed and the undo receipt persisted. |
| `replayed` | Original successful receipt; not proof of current record state. |
| `not_dispatched` | This invocation sent no CRM mutation. |
| `rejected` | Explicit CRM rejection/version conflict; that operation remains terminal. |
| `outcome_unknown` | Mutation may have happened. Keep the UUID and frozen arguments. |

Recovery checks the actor-bound receipt without another Twenty mutation. A crash after reservation, lost or malformed response, or failed receipt commit can remain uncertain even if no business change happened. Administrator reconciliation is required before replacing an uncertain operation. A new UUID means a new intended action, not a way to retry an uncertain one. Existing downstream CRM automations still apply.

Schema v2 adds nullable `encrypted_snapshot` and expands the action/state allowlists in `context_crm_private.write_operations`. The migration validates the owned v1 table’s shape and recorded signature before upgrading it transactionally. Existing receipts remain intact with no invented snapshot; v2 reruns validate drift and retain narrow runtime grants/RLS. Runtime access is limited to SELECT/INSERT/UPDATE on this private receipt table, with no receipt deletion or source-business-table write grants.

Snapshots use AES-256-GCM with a purpose-separated HKDF key derived from the existing server-only `CONTEXT_KEY_ENCRYPTION_SECRET`. Authenticated data binds employee ID, email, linked member, operation, action and request hash. JSON plaintext is limited to 64 KiB; credentials are never snapshot data. Keep this secret stable and backed up: changing it without migrating existing ciphertext makes earlier snapshots unavailable for undo. There is no fallback key. Creation captures an undo version only when edits are enabled and the verified provider response includes the required record fields. A missing version produces a valid creation with `undo_available: false`.

## Deployment setup

1. Apply `npm run crm-writes:migrate -- --apply --env-file <admin-env>` with the migration-owner credential. The command without `--apply` only reports staged status. This upgrades the existing private receipt table or creates v2 on a fresh installation; it does not mutate Twenty business records. If runtime-role provisioning happens afterward, rerun to install its narrow grants.
2. On installations that have not already enabled `crm.rfq:write`, apply the existing console/MCP OAuth scope migrations. Schema support does not expand stored grants automatically.
3. Configure `TWENTY_CRM_BASE_URL` as an HTTPS origin and set the dedicated server-only `CONTEXT_CRM_WRITE_API_KEY`. It needs workspace-member read plus opportunity read/create/update/soft-delete permissions for the advertised actions. There is no fallback to the read key. Keep the key in Context Engine; Ramesh receives scoped tools rather than the provider credential.
4. Keep the existing `CONTEXT_KEY_ENCRYPTION_SECRET` configured for snapshot encryption. Enable `CONTEXT_CRM_RFQ_WRITES_ENABLED=true` for creation and additionally `CONTEXT_CRM_RFQ_EDITS_ENABLED=true` for the two RFQ reads, detail edits and undo. Apply v2 before enabling the new code/flag.
5. Deploy Context Engine and the companion Ramesh implementation. Explicitly grant `crm.rfq:write` to intended employees; signed Ramesh requires it in both the bot signing ceiling and Context Engine issuer registration. Preserve current grants rather than granting every employee write access. Configure each tool’s intended platforms in the existing prompt console; defaults support Claude and WhatsApp.
6. Verify authenticated tool discovery, live read behavior and deployment health. A read-only check must not invoke a mutation or create a test CRM record.

REST `/api/v1` remains read-only, including the new RFQ detail/history endpoints; mutations are closed MCP tools. Gmail drafts and GIS retain their separate permissions, feature gates and executors. No email send capability is added.

Deterministic tests cover intake, source preservation, field mapping, record origin/ownership, contact masking, MCP binding, before-images, uncertainty and recovery. `tests/crm-rfq-storage.test.ts` requires a fresh local `context_crm_rfq_test` database through `CONTEXT_CRM_TEST_DATABASE_URL` and verifies a real v1→v2 upgrade, concurrent claims, transaction rollback, terminal receipts, drift rejection and denied privileges. Snapshot tests cover tampering, actor/request binding and bounds. Local validation uses disposable PostgreSQL; it needs no paid model evaluation or live CRM mutation.
