# Requirement checks and shortlist assessment

`assess_shortlist` combines a lead's structured requirements, comparisons with selected warehouse records, and questions to resolve before a recommendation. It reads existing data and computes the checks in the application. It does not search inventory, edit a lead, rank the market, quote a cost, or confirm a property's availability.

All IDs and quantities in the examples below are fictional. Obtain real IDs through the employee's permitted searches. Credentials belong in the client's secure settings, never in tool arguments or URLs.

## Choose the operation

| Employee question | Input | Result |
| --- | --- | --- |
| “What do I still need to clarify with this client?” | One `lead_id`; omit `warehouse_ids` | Requirement checklist, recorded values and specific follow-up questions. |
| “Compare these properties for this requirement.” | The same lead ID and one to five distinct warehouse IDs | The checklist plus recorded matches, conflicts, uncertain comparisons and verification questions for each selected property. |

Checklist-only MCP call:

```json
{
  "lead_id": "00000000-0000-4000-8000-000000000001"
}
```

Comparison using criteria explicitly supplied by the employee:

```json
{
  "lead_id": "00000000-0000-4000-8000-000000000001",
  "warehouse_ids": [18, 19],
  "area_min_sqft": 30000,
  "area_max_sqft": 50000,
  "docks_min": 4,
  "clear_height_min_ft": 28,
  "move_in_by": "2027-01-15"
}
```

Equivalent REST routes:

```text
GET /api/v1/crm/opportunities/00000000-0000-4000-8000-000000000001/assessment
GET /api/v1/crm/opportunities/00000000-0000-4000-8000-000000000001/assessment?warehouse_ids=18,19&area_min_sqft=30000&area_max_sqft=50000&docks_min=4&clear_height_min_ft=28&move_in_by=2027-01-15
```

REST uses a comma-separated `warehouse_ids` parameter; MCP uses an integer array. IDs must be distinct. Unsupported or duplicate query parameters, invalid dates and inverted area bounds are rejected. There is no pagination because a comparison covers only the selected one to five properties. Use `search_warehouses` to discover more candidates separately.

## Requirements and overrides

The checklist considers city, micromarket, area, budget, lease duration, move-in timing, dock count, clear height and power. These are questions to clarify, not a policy that every client must require every specification. States distinguish `present`, `missing`, `unsupported` and `needs_confirmation`; “present” means recorded, not confirmed by the client.

Only these employee overrides are accepted: `city`, `micromarket`, `area_min_sqft`, `area_max_sqft`, `docks_min`, `clear_height_min_ft`, `power_min_kva` and `move_in_by`. Never infer them from industry, company name, descriptions or notes. Dock, height and power requirements have no structured CRM source in this implementation, so they are compared only when the employee supplies them.

Each checklist item includes `recorded_value`, `effective_value`, `source`, `override_differs_from_record`, an explanation and a follow-up question. An override applies to this assessment only. It does not write to CRM. Supplying either area bound replaces the whole recorded area requirement: an omitted opposite bound stays open instead of inheriting an old value.

City comparisons use exact normalized labels, comma-separated CRM city alternatives and the documented Bangalore/Bengaluru and Gurgaon/Gurugram aliases. Geographic proximity is not inferred. A recorded micromarket containing commas needs clarification; it is not automatically split into alternatives. An explicit micromarket override is matched as one complete label against the property's recorded tags.

## How to read a comparison

| Check state | Meaning | Fictional example |
| --- | --- | --- |
| `meets_recorded_requirement` | Recorded facts satisfy the stated check. This is not independent verification. | Four recorded docks against an explicit minimum of four. |
| `conflict` | The recorded facts do not satisfy the stated check. Recheck the source before excluding a property. | Three recorded docks against a minimum of four. |
| `possible` | An estimate, range or unconfirmed tolerance prevents a firm conclusion. | “2–4 docks” against a minimum of four; a 50,000 sqft option against a recorded 40,000 sqft target. |
| `unknown` | A requirement or comparable property fact is missing, unsupported or ambiguous. | A 100 kVA requirement with no usable recorded power figure. |

Offered areas are alternative space options, never a sum. Both explicit area bounds must fit the same option. Two 20,000 sqft options do not establish a 40,000 sqft option. A larger property may be possible for a recorded target, but the client's tolerance and subdivision terms remain unknown. Recorded area ranges and approximations remain provisional.

Relative CRM occupancy categories are not converted into deadlines using today's date or the lead's update timestamp. An employee-supplied `move_in_by` can be compared with a valid recorded handover date. Availability labels such as “Immediate” are not turned into calendar dates or commitments.

Budget values are retained for clarification. The assessment does not reconcile asking-rate periods, total-versus-per-area budgets, chargeable areas, additional charges or taxes, and produces no monetary ranking. Each comparison returns supporting values or measurement evidence, a reason, check counts and relevant verification questions. Check counts are not a suitability score.

Every candidate has `verification_required: true` because current availability and client acceptance still need confirmation. `source_verification_required` separately retains the warehouse projector's uncertainty flag. `source_uncertain_fields` preserves up to nine named numeric specifications with their recorded approximate or ranged evidence, including fields outside the client's comparison criteria. For example, a ranged dock count remains visible even when the employee has supplied only an area requirement; it does not create a dock requirement. Exact values and unused unknown fields do not inflate this list. Required unknown specifications remain in the comparison checks and verification questions. A successful check must not be presented as a verified specification, suitability approval or reservation.

## Permissions and consistency

Checklist-only calls require `crm:read` and current authorization for the exact lead. Calls with warehouse IDs additionally require `warehouses:read`, and every selected warehouse must be visible. A missing or inaccessible selected warehouse fails the whole comparison with a generic error; the response does not disclose which hidden record caused it. Source failures are not empty shortlists.

The server releases its initial database connection before the live Twenty permission read. It then rechecks the employee/key and reads the lead, selected warehouse batch and CRM freshness metadata in one final read-only, repeatable-read database transaction. The existing transaction pool and socket limits apply; there is no per-property pool or external network request inside that final transaction.

This shared database snapshot prevents the comparison from mixing different local read versions within the response. It does not make Twenty's live permission check atomic with the database, synchronize upstream systems, or verify real-world conditions. Preserve `access_scope`, `source_status`, `read_consistency`, the lead's update/poll times and each property's source timestamp. Related specification edits may not advance the Warehouse-row timestamp, and later requests observe new snapshots.

The result contains bounded projected values and evidence, not raw CRM narratives, contacts, coordinates or source credentials. No new database migration, environment variable or permission scope is needed.

## Why one additional tool

This adds one workflow tool to the existing sixteen, for a maximum of seventeen. Actual discovery remains limited by the employee's granted scopes. Checklist creation, selected-property comparison and verification questions share the same lead and evidence, so they remain one operation rather than three overlapping choices. Existing search and detail tools keep their distinct jobs; the new tool supplies deterministic comparisons over selected records.

Anthropic recommends a small set of distinct, useful workflows and combining frequently chained operations where that reduces agent work. Tool count alone is not the goal: overlapping purposes, unclear arguments and excessive output need evaluation. See [Anthropic's tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents).

The implementation provides explicit input/output schemas, bounded responses, read-only annotations and authorization-aware discovery through the existing MCP adapter. Annotations describe behavior; authorization remains enforced by the server. See the [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

## Validation

Validation on 2026-09-29 includes 91 assessment tests using the actual CRM and warehouse privacy projectors, plus 53 API integration checks covering live-access decisions, role/key changes, source freshness, shared database snapshots, batched warehouse reads and fail-closed behavior. MCP protocol tests check schema discovery, checklist-only calls, array serialization, bounded inputs and private citation parameters. The complete suite passed 1,762 tests with 42 opt-in checks skipped; type checking and the production build passed.

A private synthetic model run using `gpt-5.6-luna` at low reasoning passed three scenarios in seven model requests against the real 14-tool non-analytics catalogue and the actual API/builder. The model selected the assessment for requirement gaps, uncertain property comparisons and temporary area overrides. Human review caught that a source verification flag could omit the underlying uncertain field when it was outside the comparison criteria; `source_uncertain_fields` and dedicated regression tests address that gap. This is bounded synthetic evidence, not production Claude validation. Fictional traces remain under ignored `.local/shortlist-agent-review/`.

A targeted model rerun after that evidence addition passed during release validation on 2026-09-29, using four model requests. The answer identified the recorded 2–4 dock range and the need to verify it while applying only the employee's temporary area bounds. It retained the original 40,000 sqft CRM value and stated that CRM was unchanged. The earlier attempt had not completed because network execution was unconfirmed; the successful release run is preserved privately as `report-final.json`. The complete deterministic suite and production build also passed again with the evidence addition included.

Release checks also passed 28 browser flows, five live warehouse tests and 32 CRM query tests against synthetic SQL values. A live MCP smoke read one permitted lead and two visible warehouses, then exercised checklist-only and selected-property assessments. Both passed output-schema and final-snapshot assertions; the comparison used one bounded warehouse batch, preserved the selected order and made six live Twenty HTTP reads without holding a database socket. The smoke verified 16 read-only transaction snapshots using a one-socket Supabase pool on port 6543, with no persistent writes. Its counts-only report stays under ignored `.local/release-validation/`.
