# Caller assignment performance

Four read-only tools expose current CallOnGo assignment workload, aging, recorded outcomes and structured change history. Active WAG admins and analysts are eligible; their key or OAuth grant must explicitly contain `calls.performance:read`. Ordinary call-dashboard access does not grant team reporting access. Existing credentials are not expanded automatically.

| Tool | GET endpoint |
| --- | --- |
| `call_performance_capabilities` | `/api/v1/calls/capabilities` |
| `call_performance_summary` | `/api/v1/calls/summary` |
| `search_call_assignments` | `/api/v1/calls/assignments` |
| `read_call_assignment` | `/api/v1/calls/assignments/{id}` |

Start with capabilities for exact caller work emails, supported filters and metric definitions. Summary and assignment search accept the same filters: `caller`, `entity_type`, `state`, `outcome`, paired `date_from`/`date_to`, `min_open_age_days`, and `gap`. Gaps are `missing_outcome`, `added_without_reference`, `done_available_without_numeric_reference`, and `without_audit`.

Use summary for totals and search for the requested records or examples, stopping once enough are returned. Read a user-supplied assignment ID directly. Capabilities establish that period completions, time to first call, follow-up compliance and actual-call rankings are unsupported; scanning assignments cannot supply those metrics. Keep separate subquestions' date scopes separate. Clarify ambiguous warehouse-reference timing or provide an explicitly labeled current all-date total.

Omit `entity_type` for general call-dashboard workload and team warehouse-reference totals. Both listing assignments (`record`) and AI execution reviews (`call`) can carry warehouse references. Select a target type only when the user asks for that subset; `call` does not count calls made. History timestamps include their UTC offset; convert them to IST for local dates or explicitly label UTC.

Examples:

```text
/api/v1/calls/summary?state=open&min_open_age_days=7
/api/v1/calls/summary?date_from=2026-10-01&date_to=2026-10-31
/api/v1/calls/assignments?gap=done_available_without_numeric_reference&limit=25
/api/v1/calls/assignments/123?limit=25
```

Dates select assignments by `assigned_at`, with inclusive IST dates translated to half-open UTC bounds. A dated report shows those assignments' **current** state and outcomes. It is not historical state or a report of completions/calls during that period. Omit dates for all retained assignments; dated windows are limited to 366 days. Minimum age applies only to current open work, measured in elapsed 24-hour days since assignment. Age does not measure effort or enforce a follow-up SLA.

Search and history pages contain at most 25 rows in ascending ID order. Copy `nextCursor` unchanged with the same filters or assignment ID. IDs remain strings, including PostgreSQL bigints beyond JavaScript's safe integer range. Each page has its own source snapshot; concurrent edits can change membership. Summary caller breakdowns and discovery are capped at 100 callers and report truncation explicitly. The summary total covers every matching assignment; `assignments_outside_caller_breakdown` accounts for omitted groups.

Done, Available and Added are staff-recorded states. Distinct numeric warehouse references count references currently marked Added, not verified warehouses or first onboarding credit. A reference can occur under multiple callers; use the overall distinct total instead of summing caller totals. Free-text warehouse references are represented by a presence flag; their contents are not returned. Customer numbers, transcripts, notes and raw audit JSON are excluded. Retained history can include note-only edits with unchanged projected fields; an audit row is not a call attempt. `history_has_creation_event` indicates whether the retained history includes creation, not a guarantee that every historical event was captured.

## Source and access configuration

1. Review `scripts/sql/call-performance.sql` and apply it to the **CallOnGo database** using its schema owner. It creates four explicit projection views and a dedicated, initially non-login `call_performance_reader` role. It does not alter operational records or triggers. Provision its login and password through the existing secret-management workflow. Do not share this database credential with report users.
2. Set server-only `CONTEXT_CALLS_DATABASE_URL` to that reader's Supabase transaction-pooler URL on port 6543. Set `CONTEXT_CALLS_SSL_CA` when the endpoint needs the Supabase CA. TLS verification is always enabled. No fallback to the WAG connection or an administrator login is allowed.
3. Run the existing console and OAuth credential-scope migrations with `--apply` after reviewing their staged changes: `npm run console:migrate -- --apply` and `npm run mcp:migrate -- --apply`. These update allowed scope vocabulary, not existing grants. Renew the eligible employee key and OAuth consent to include `calls.performance:read`; previously registered clients may need reconnecting with a new registration.
4. Deploy the application and read capabilities with an eligible credential. Check source coverage before interpreting metrics.

For Ramesh, the trusted signer/public-key registration must also allow `calls.performance:read`. Its existing dynamic read-tool contract supports the new tools; metadata does not expand a deployed service grant automatically.

Include the delivery fingerprint correction recorded in the [local review](call-performance-plan.md#local-ramesh-review-on-2026-11-05): a refreshed `snapshot_at` alone must not invalidate an unchanged report. Counts, coverage, query filters and history changes must still invalidate it. The reviewed fix is currently in an isolated local Ramesh worktree, pending integration and rollout.

The source pool has one connection per process, verified reader identity, short statement timeouts and read-only repeatable-read transactions. The WAG roster is checked before and after the separate call-source transaction; no WAG connection is held while reading CallOnGo. The two databases are not one atomic snapshot.

The views are the reader's explicit source projection. Keep their ownership with the trusted schema owner, not the reader. The SQL grants no base-table access and no future-object default privileges. Review pre-existing or inherited PUBLIC privileges as part of normal database-role provisioning; this migration does not change other applications' grants.

## Coverage and errors

Every response has `snapshot_at`, `coverage` and interpretation guidance. Coverage describes the **whole source**, not just the selected caller or cohort. It includes effective manual-log count, first retained audit timestamp, assignments without audit, caller-link coverage and last completed Callyzer import. A recent import is not proof of device completeness. Stale imports do not prevent current assignment reporting, but are labeled explicitly. No call-volume or inferred call-attribution metric is returned by this first slice.

`CALLS_CONFIGURATION` means the dedicated source settings or role are invalid; `CALLS_SOURCE_UNAVAILABLE` means the read could not be completed; `CALLS_BUSY` means the bounded pool is saturated. None is converted to empty results. Queries are fixed and parameterized. No call dispatch, assignment editing, caller administration, scheduler changes or arbitrary SQL are exposed.

Source failures emit a `call_reporting_error` diagnostic with the phase and a fixed error category. PostgreSQL SQLSTATE and selected transport codes are retained when available. Driver messages, SQL, source rows, connection details and stacks are excluded; public error responses stay unchanged.
