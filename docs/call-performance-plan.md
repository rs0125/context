# Call performance API and tool plan

Status: implemented and validated locally on 2026-11-05; production activation completed on 2026-11-06. See the [production rollout record](#production-activation-on-2026-11-06) and [setup instructions](call-performance.md).

## Objective

Let active admins and analysts inspect caller assignment workload, aging and recorded outcomes through Context Engine's existing REST and MCP interfaces. Keep each reported number traceable to assignments and distinguish missing evidence from zero activity.

## Simplifications and pitfalls

- Do not build a generic analytics query language, new warehouse, background aggregation, scoring system or separate exceptions service. Fixed, parameterized PostgreSQL reports are sufficient at the observed volume.
- Keep one reporting implementation behind REST and MCP. Use a small, explicitly projected reporting schema only to restrict the database reader's access; do not duplicate business calculations in views and application code.
- Start with assignment snapshots and assignment-date cohorts. A cohort is selected by `assigned_at`; its reported states and outcomes are current. Do not describe this as historical state, completions during the selected period, or a conversion funnel.
- CallOnGo has a separate database and admin/employee roster. Authorize the requesting analyst using the current WAG roster and an explicit `calls.performance:read` credential scope. A caller filter selects report subjects and never grants access.
- Defer inferred call-to-assignment matching. Shared numbers, reassignment and reopening prevent reliable attribution from a phone join alone. Imported activity and manual attempts must never be summed as distinct calls.
- Defer first-touch SLA, scheduled follow-up compliance and caller rankings. These need source coverage and operational definitions that the current data does not supply.
- Preserve existing Team definitions. This slice reports current assignment outcomes and staff-recorded warehouse references, not first discovery or first onboarding credit. Warehouse-reference formatting is not proof that a warehouse exists.

## Evidence from the read-only audit on 2026-11-05

- 3,433 assignments: 1,060 open, 2,268 done and 105 dropped.
- 8,476 assignment audit events beginning 2026-10-11; 1,228 assignments have no audit events.
- Two explicit manual attempts, and no populated assignment follow-up dates.
- 3,286 imported Callyzer calls attributed to two of five employee accounts. The last successful import was 2026-10-27.
- These are dated observations, not configuration constants. Reports must read their own coverage metadata.

## First slice

### Reporting contract

- Shared filters: caller, assignment target type (`record` or `call`), current state, current outcome, paired inclusive IST assignment dates, minimum open age, and a small enum of evidence gaps.
- Summary: totals and a bounded caller breakdown covering open/done/dropped assignments, recorded outcomes, staff-marked-added assignments and age buckets. Rates, where returned, include their numerator and denominator; zero denominators return null.
- Assignment search: bounded cursor pagination, explicit current fields, stable assignment IDs and a link to the Context Engine assignment-detail endpoint.
- Assignment detail: current assignment and paginated structured change history. Do not export whole audit JSON, customer phone numbers, provider payloads or transcripts.
- Discovery: caller options, supported filters and metric meanings. Include inactive callers with retained history.
- Every business response includes a source snapshot timestamp, date basis, timezone and coverage information. Callyzer freshness and manual-log coverage explain limitations; they do not change assignment totals.
- Separate authenticated WAG reads from the call-source transaction. Recheck authorization before returning externally fetched results. Do not claim an atomic snapshot across the two databases.

### REST and tools

| REST endpoint | MCP tool |
| --- | --- |
| `GET /api/v1/calls/capabilities` | `call_performance_capabilities` |
| `GET /api/v1/calls/summary` | `call_performance_summary` |
| `GET /api/v1/calls/assignments` | `search_call_assignments` |
| `GET /api/v1/calls/assignments/{id}` | `read_call_assignment` |

Use the existing API envelope, tool registry, platform filtering, credential handling, OpenAPI documentation and error behavior. Keep the new tools read-only.

### Source access

- A dedicated `call_performance_reader` login reads explicit reporting views in the call database, with no business-table write privileges.
- A separate small connection pool uses verified TLS, bounded read-only transactions and statement timeouts. Never fall back to an administrator or the WAG database connection.
- Supply a reviewable SQL provisioning file and configuration instructions. Do not apply live DDL, rotate credentials or deploy as part of local implementation.
- Keep source identifiers and connection settings server-only. Missing configuration returns an unavailable error rather than empty results.

## Implementation order

1. Add the projected source schema, source connection and reporting schemas/queries.
2. Add the read scope to existing authorization, key/OAuth migrations, consent labels and platform contracts.
3. Connect REST, MCP discovery/execution and OpenAPI to the shared report functions.
4. Add focused tests for authorization, SQL/filter semantics, IST dates, pagination, missing coverage, deduplication and tool behavior.
5. Run type checking and relevant tests, then the repository's normal test/build checks. Document exact results and remaining rollout steps.

## Acceptance criteria

- Admins and analysts with the explicit credential scope can read; ordinary employees and revoked grants cannot.
- No API or tool creates calls, changes assignments, edits caller access or executes caller-supplied SQL.
- Summary counts use the same filters as assignment search and do not multiply assignments through joins.
- Historical assignment-date cohorts are labeled as current-state cohorts. Dropped assignments remain distinct from completed work.
- Pagination cannot silently change filters; partial history and unavailable activity stay explicit.
- No source credentials, customer phones, transcripts or complete audit payloads appear in tool output or errors.
- Existing callers, credentials and unrelated tools retain their current behavior.

## Later work

Restore and verify Callyzer ingestion; expand caller links; agree on explicit attempt and follow-up capture. Only then add source-specific activity trends, historical assignment intervals and carefully labeled call attribution. Reuse the established Team event definitions for first Available and first onboarding reports.

## Implementation and validation

- Implemented all four REST endpoints and MCP tools through shared reporting functions, with OpenAPI schemas, existing platform discovery, and current admin/analyst authorization plus the explicit credential scope.
- Added the dedicated reader provisioning SQL, source connection settings, projected views, shared filters, bounded pagination and source coverage metadata. No new runtime dependencies, background jobs or analytics service were introduced.
- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: 3,632 passed, 215 skipped. Environment-gated checks remain skipped in the default suite.
- PostgreSQL integration suite: all 15 tests passed separately against a disposable local PostgreSQL 17 database using synthetic records and the actual provisioning SQL. Verified aggregate counts, shared filters, IST boundaries, duplicate references, bigint pagination, projected history and reader privileges.
- `npm run build`: passed.
- `git diff --check`: passed.

At the local implementation checkpoint, live source schema changes, reader login/secret provisioning, credential-scope migrations, grant renewal and deployment had not been applied. The configuration and rollout order are documented in [Caller assignment performance](call-performance.md); production activation is recorded below.

## Local Ramesh review on 2026-11-05

The user authorized a local harness review with a total USD 1 budget, including real read-only API calls. Three scenarios used the actual Ramesh graph with `gpt-6-luna`, one trial each, and a shared enforced spending meter. All 22 model requests settled; conservative accounted cost was USD 0.069124, with no pending or unknown charges in the meter. Pricing used the reviewed long-context upper rates, including the higher cache-write rate, from [official pricing](https://developers.openai.com/api/docs/pricing); this is a conservative estimate, not an invoice reconciliation.

The local HTTP server exercised all four REST endpoints and all four signed WhatsApp MCP tools against synthetic PostgreSQL records and live CallOnGo data. Live roster checks remained enabled. Because the reporting schema is not provisioned, the review adapter inlined the exact four view SELECTs as CTEs inside read-only transactions. It applied no live DDL and changed no grants or records. Temporary signing credentials and nonce storage stayed in the review process. No WhatsApp delivery was constructed. This establishes query/handler compatibility, not a deployed production reader configuration.

The unpaid preflight found a delivery blocker: Ramesh included the report's changing `snapshot_at` in its replay fingerprint. A fix in the isolated Ramesh worktree ignores that retrieval clock while continuing to compare counts, coverage, filters, history timestamps, cursors and request binding. Synthetic and live delivery rechecks then passed. The worktree is `/tmp/ramesh-call-performance-review-20261105`; its two-file patch is retained in `.local/call-performance-review-20261105/ramesh-delivery-fix.patch`. This fix must be included in the Ramesh rollout; it has not been merged or deployed.

| Scenario | Answer review |
| --- | --- |
| October assignment cohort and current aged backlog | Passed. Correct caller/overall counts and current-state interpretation; no inference of calls or effort from Done. |
| Four old open assignments, cursor continuation and retained history | Needs correction. Cursor and history handling worked, but the model added an unrequested `entity_type=call` filter and displayed one UTC history date without labeling its timezone. |
| Call-volume/inactivity claims and team warehouse references | Needs correction. Correctly declined unsupported call/inactivity claims and preserved reference overlap, but selected `entity_type=record` without being asked. It reported 78 references for that subset; the all-target preflight total was 285. |

All three scenarios completed with successful delivery revalidation, but only one passed the full answer review. The original failed answers and their tool arguments are retained. Tool guidance now explicitly says to omit `entity_type` for general call-dashboard work and team reference totals, explains that both assignment types can carry references, and requires IST conversion or an explicit UTC label for displayed history dates. At the end of this first campaign those guidance edits had deterministic contract checks but no paid model retest. The separately authorized follow-up below preserves these original failures.

Private artifacts are under `.local/call-performance-review-20261105/`: the runner, preflight attempts, source hashes, fix patch, and `paid-campaign/` containing the scenario transcripts, manual review, usage policy, ledger and final summary. The paid campaign's report records 32 live source read-only transactions and unchanged source files during the run. Earlier preflight attempts are preserved separately.

Post-review validation passed: Context Engine type checking and 41 focused query/API/MCP tests; Ramesh type checking, build, and five targeted regression files covering dynamic contracts, dynamic execution, analytics evidence, sales-agent evidence and refresh behavior. Both diffs pass whitespace checks. Live rollout remains pending, including integration of the isolated Ramesh fix.

## Ten-answer follow-up on 2026-11-05

The user separately authorized ten answers with a shared USD 2 limit. Ten predefined scenarios ran once each on `gpt-6-luna` through the actual Ramesh graph, using the clarified tool guidance and the isolated delivery fix. Review criteria were saved before scoring. There were no paid retries or separate model-grading calls. Source hashes stayed unchanged throughout the run.

All four REST endpoints and all four signed MCP tools passed the live preflight. The campaign recorded 70 live source reads, each verified inside a read-only transaction. The local server used the same inline-view adapter described above, with live roster checks and temporary authentication. No live schema, grants, configuration, records or WhatsApp messages were changed. Data could change between requests through normal source activity; each answer was checked against its own returned evidence.

| Scenario | Answer review |
| --- | --- |
| October cohort and current aged backlog | Passed: correct date scopes, caller counts and interpretation. |
| Four assignments with two-row pagination and history | Passed: correct all-target IDs and history limitations; fetched one unnecessary extra page. |
| Call activity, inactivity and warehouse credit | Partial: correctly declined unsupported activity claims and removed the unwanted target-type filter. It carried the previous clause's last-week dates into the warehouse question, reporting 27 references for that explicitly labeled assignment cohort. The intended warehouse time scope still needs clarification; assignment dates do not establish when warehouses were added. |
| Current whole-team warehouse references | Passed: 285 overall, with caller overlap and verification limitations explained. |
| Named caller's backlog | Passed: current identity, total and age buckets matched the source. |
| Explicit AI-review assignments | Passed: correctly used `entity_type=call` only when requested. |
| Explicit listing assignments | Passed: correctly used `entity_type=record` only when requested. |
| Done/Available assignments without numeric references | Passed: summary count and three examples matched; fetched more examples than necessary. |
| History dates in IST | Passed: converted both dates correctly and preserved missing-history limitations; an initial search was unnecessary. |
| Completions last week, first call and follow-up compliance | Failed: returned the generic unavailable reply instead of an answer. The APIs succeeded and the current Done total was available, but the agent fetched eight assignment pages for unsupported period metrics, reached its research deadline, and the verifier then returned `INCOMPLETE_RESPONSE`. |

Result: eight passed, one partial answer, and one failed answer. Nine substantive answers were produced. The earlier unwanted target-type filters and unlabeled UTC date did not recur. Successful delivery revalidation is not an answer-quality pass: it also accepted the final scenario's safe fallback reply.

The failed scenario's verifier reported exactly 4,000 output tokens, including 3,561 reasoning tokens, at the configured output limit. This is consistent with truncation; the retained trace does not include the provider's detailed incomplete reason. A separate worker request was interrupted at the research deadline and has no reported usage. The remaining changes should focus on clarifying independent date scopes and using capabilities plus the summary for unsupported metrics, without exhaustive assignment pagination or substituting assignment dates for completion dates. No further behavior changes or paid trials were made during this campaign.

The meter recorded 79 model requests: 78 settled, one unknown, and none pending. Conservative accounted usage is USD 0.307937, with USD 0.528000 still reserved for the request with missing usage: USD 0.835937 accounted or reserved against the USD 2 cap. Actual billing is not fully reconciled, and the unknown reservation has not been released. This is separate from the first campaign's USD 0.069124.

Private artifacts are under `.local/call-performance-review-20261105-ten/`. The `paid-campaign/answers.txt` file contains all ten questions, replies and review notes; `manual-review.json` contains verdicts and accounting. The directory also retains the runner, criteria, preflight, original transcripts, source hashes, usage policy, ledger and final report. Live rollout remains pending.

## Context Engine cleanup and USD 3 review on 2026-11-06

The user authorized the Context Engine fixes and testing all current call-performance use cases with a total USD 3 cap. Replaced the existing guidance with explicit summary-versus-example selection, stopping after requested records, direct reads for supplied assignment IDs, unsupported-metric handling and independent date scopes. Added safe database diagnostics while preserving generic public errors. Coverage-query optimization remains deferred until profiling demonstrates a need; the reporting SQL and response shapes stay unchanged.

Validation scope: focused diagnostic/privacy and transport checks, type checking, the existing local regression suite and build, followed by the same ten Ramesh scenarios once each on `gpt-6-luna`. All graph stages share the enforced USD 3 meter. Preserve original failures and any new failures; no paid grader or retries. Exercise actual local REST and signed MCP requests against live read-only source data through the existing review adapter. Keep the Ramesh agent runtime unchanged, including its already reviewed isolated delivery fix; do not provision or deploy live services.

Local validation passed: 63 focused tests; type checking; the full default suite with 3,639 passed and 215 environment-gated tests skipped; build; and whitespace checks. Added checks cover safe SQLSTATE/transport codes, malformed or untrusted error fields, programming errors, acquisition failure and failed rollback. The reporting SQL did not change; the previously successful 15-case isolated PostgreSQL suite was not rerun for this cleanup.

The first unpaid preflight passed all four REST and four MCP reads, then failed during a WAG connection checkout in delivery revalidation (`DATABASE_UNAVAILABLE`, 5,005 ms). Its underlying cause is not established. Five subsequent read-only health checks, including three concurrent reads, passed. A second preflight passed under the same pool limits, timeouts and validation rules. The failed attempt is preserved and made no model requests.

| Scenario | Follow-up result |
| --- | --- |
| October cohort and current aged backlog | Passed; correct independent scopes and source counts. |
| Four assignments with two-row pagination and history | Passed; exactly two pages, correct history and IST conversion. |
| Call activity, inactivity and warehouse credit | Partial; correctly declines actual-call/inactivity conclusions and reports 285 current all-date references. Still adds an unrequested AI-review-only assignment comparison. The counts are grounded, but are unnecessary and the second bullet does not repeat the subset qualification. |
| Current whole-team warehouse references | Passed; correct overall/caller counts and overlap caveat. |
| Named caller's backlog | Passed; correct current caller and age buckets. |
| Explicit AI-review assignments | Passed; correct requested category and counts. |
| Explicit listing assignments | Passed; correct requested category and counts. |
| Done/Available assignments without numeric references | Passed; summary count 368 and exactly three requested examples. |
| History dates in IST | Passed; reads the supplied ID directly and correctly converts both events. |
| Completions last week, first call and follow-up compliance | Passed; capabilities plus a summary establish limitations and the current Done total of 2,271. No assignment scanning or fallback reply. |

All ten answers completed and passed delivery revalidation: nine passed semantic review and one remained partial. All 23 model tool executions returned HTTP 200, down from 34 in the preceding campaign. The campaign recorded 58 CallOnGo source reads in verified read-only transactions, including preflight and delivery replay. Questions and Ramesh source hashes match the preceding campaign; Context Engine source hashes remained unchanged throughout this run. The remaining partial answer is an agent response-quality issue, not an incorrect warehouse total or an API failure.

All 68 model requests settled. Conservative accounted cost is USD 0.210516 against the USD 3 cap, with zero pending requests, unknown usage or held reservations in this campaign. Rates were rechecked against [official Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna) on 2026-11-06; the meter retains conservative upper rates. This is model usage accounting, not invoice reconciliation, and is separate from previous campaigns.

Artifacts are retained under `.local/call-performance-review-20261106-fixes/`: `local-validation.json`, local test/build logs, the runner and criteria, `connection-health.json`, `preflight-review.json`, the failed unpaid attempt in `paid-campaign/`, and the completed campaign in `paid-campaign-2/`. The latter contains all ten replies in `answers.txt`, review notes in `manual-review.json`, and the original traces and usage ledger. No paid trials were repeated, no Ramesh runtime changes were made, and no live rollout was performed.

## Production activation on 2026-11-06

The user explicitly authorized applying the SQL and production permissions through Vercel and AWS. Applied `scripts/sql/call-performance.sql` to CallOnGo and provisioned the `call_performance_reader` login. Verified four readable reporting views, zero direct business-table access, zero reporting write privileges and no schema-creation privileges. The actual reader connection passed all four report functions with verified TLS and read-only transactions.

Applied the console and OAuth scope migrations. Configured production `CONTEXT_CALLS_DATABASE_URL` and `CONTEXT_CALLS_SSL_CA`, then added only `calls.performance:read` to the existing Ramesh public registration. Preserved its key, expiry, other scopes and other Vercel settings. Redeployed Context Engine commit `1cce6f8` as deployment `dpl_9gehze8DZ5d7PLMFDWv1s2SuK2Ui`. All four signed MCP reads passed; omitting the scope hid all four tools while preserving the existing tool catalogue.

Updated AWS runtime Parameter Store to version 19 and installed the matching signer scope on the EC2 host, preserving a private environment backup and every other setting. Ramesh release `c090ec1` restarted healthy and connected to WhatsApp. A model-free probe using the deployed worker's actual configuration and the previously selected operator identity passed all four tools and delivery revalidation: eight call-tool executions, including the four fresh delivery reads. Scheduler health also passed. No model calls, business-record writes or WhatsApp sends were made by the rollout probes.

Existing standalone employee API keys and OAuth grants were not widened or rotated. Those clients must opt in to the new scope through key rotation and renewed consent; Ramesh's current admin/analyst authorization applies immediately. The earlier answer-quality partial result remains separate from this successful configuration rollout.

Private configuration backups, operator scripts and sanitized verification results are retained under `.local/call-performance-rollout-20261106/`; `rollout.json` records the completed activation without credentials or source rows.

## Warehouse-match correction on 2026-11-06

The initial reporting projection omitted CallOnGo's existing warehouse-contact match view. Ramesh consequently answered the Available backlog question using the manual Added checkbox: 859 Available minus 325 manually marked Added = 534. A read-only source check instead found 317 matched and 542 unmatched Available assignment episodes. Ten matched assignments lacked the manual flag, while eighteen manually flagged assignments lacked a database contact match. These are source-snapshot counts, not unique physical warehouses.

Extend the existing assignment and coverage views with the source's warehouse matches and sync metadata. Add the shared `warehouse_match=yes/no` summary/search filter, matching totals, bounded distinct warehouse IDs and pending-review indicators. Keep manual flags and references independent. Reuse the existing reader, four tools and Ramesh dynamic contracts; no new service, sync job, direct WAG contact query or Ramesh runtime change is needed.

Validate duplicate contact matches, cross-entity ID collisions, disagreement with manual flags, bounded IDs, independent sync freshness, shared filter counts and reader privileges against isolated PostgreSQL. Then apply the appended reporting columns before deploying Context Engine, compare the real reader with independent source counts and verify live tool execution and delivery revalidation without model calls or WhatsApp sends. Retain the earlier evaluation results: they did not cover warehouse-contact matches.

Validation passed: 64 focused tests, 25 isolated PostgreSQL 17.7 tests, type checking, production build and whitespace checks. The default suite passed 3,638 tests with 225 environment-gated skips; two unrelated subprocess tests were blocked by sandbox `EPERM`. Their complete five-test file passed when rerun with subprocess permission. No test or application change was needed for that restriction.

Applied the appended reporting-view columns to production, preserving the reader credentials and privileges. Nine reads through the real restricted reader passed and agreed with independent source queries before and after verification. At 17:40 UTC, the Available counts remained 859 total, 317 matched and 542 unmatched; none of the Available matches required review. Warehouse sync last succeeded at 17:30 UTC, with four pending associations elsewhere in the whole source. Individual report transactions completed in 0.55–1.90 seconds under the existing timeouts. Source-view backups, SQL hash, test logs and rollout verification artifacts are retained privately under `.local/call-warehouse-match-fix-20261106/`.
