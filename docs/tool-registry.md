# Shared tool registry and loading

## Implementation plan and boundary

1. Consolidate the existing tool descriptions, default platforms, read scopes and
   write execution contracts into `src/lib/tools/catalog.ts`, preserving current
   prompt overrides and authorization.
2. Bind schemas and handlers through `toolRegistrar` in `src/lib/tools/registry.ts`.
   Publish ordinary MCP definitions plus optional, versioned discovery hints.
3. Extend Ramesh's existing provider adapter with eager and deferred modes. Carry
   discovered metadata through planning and write staging; never copy this registry
   into Ramesh or bypass its current execution/replay boundaries.
4. Verify ordinary MCP clients, scope/platform filtering, runtime revocation,
   unfamiliar capabilities, hosted search continuation and restart replay.
5. Compare three Luna scenarios: eager baseline, the same task deferred, and a
   deferred unfamiliar tool. Preserve all results and share one approved $5 cap.

This change implements loading infrastructure for the current tools. CMS schema,
CSV preparation and draft-only import tools are a subsequent capability using
this contract; publication remains a CMS concern.

## Ownership

`catalog.ts` is browser-safe metadata shared by the prompt editor and MCP server.
It owns each tool's description, category, supported platforms, default loading
hint and read/write policy. The compatibility exports in `prompt-definitions.ts`
and `mcp-read-contract.ts` are generated from it.

`registry.ts` supplies capability summaries and wraps MCP registration. It checks
the registered name, duplicate registrations, current scopes and platform, then
attaches canonical policy and discovery metadata. The existing schemas and
handlers in `mcp.ts` bind through this registrar. Domain API authorization still
runs on every execution; discovery is never a durable permission grant.

There is no provider SDK, vector database or public MCP registry dependency here.
The server returns full standard MCP schemas. Claude chat owns its internal
loading and catalogue refresh behaviour. Standard clients can ignore the hints.

## Discovery contract

```json
{
  "_meta": {
    "wareongo/tool-discovery-v1": {
      "capability": "knowledge",
      "description": "Find and read Wareongo company knowledge, guidance and policies.",
      "loading": "deferred"
    }
  }
}
```

The capability identifier is a lowercase letter followed by up to 31 lowercase
letters, digits or underscores. Summary length is 1–512 characters. The loading
hint is `eager` or `deferred`. It is independent of read/write authorization and
`executionMode`. Clients must retain scope and confirmation checks in either mode.

## Adding a capability

Add a catalogue entry with explicit platform availability and the existing
read/write contract, add its summary to `CAPABILITIES` if needed, and bind its
schema and handler through the registrar. New business tools normally use the
deferred hint; `get_context` remains eager. Deploy Context Engine and refresh
discovery. Existing console overrides remain keyed by the same tool names.

Compatible tools in established permission domains require no tool-specific
Ramesh adapter code. New scopes, output/effect contracts or approval interactions
can require a deliberate runtime rollout. Tool additions enter subsequent run
snapshots; removed tools and revoked permissions are checked at execution time.

## Verification

Run `npm run typecheck` and `npm test`. The registry tests use real MCP clients
with synthetic authentication and data. The temporary HTTP smoke harness also
checks both platform profiles, argument validation and revocation; it does not
exercise production OAuth or the Claude chat UI.

## CMS capability follow-up

Build on the CMS API and its existing draft/review lifecycle. First discover its
actual page types, editable fields, version identifiers and status model. Keep
live publication and pending drafts separate: a published page can also have
unpublished edits. Generate versioned CSV templates from those schemas.

The proposed tool surface is schema/template discovery, page listing/status,
page reading, CSV validation/preview, direct filling of empty drafts, and
confirmed editing of existing content. Start with those six operations; keep
each one's input and output contract focused. CSV validation should produce a
bounded, immutable change set with row errors, target page IDs, source versions
and before/after diffs. Never use an AI model as the CSV/schema validator.

Use separate mutation tools because `executionMode` is a tool contract. The
direct tool must check atomically that the target has no existing editable
content, including published content; a missing draft alone does not make a page
empty. The edit tool requires review of the exact diff and expected version.
Both require an explicit user request, operate only on drafts, use idempotent
operation IDs and retain per-row receipts. Stale versions or changed content
invalidate the proposal. Publication and final editorial approval remain in the
CMS; expose no publish tool. Cross-client diff display and confirmation need
client-specific verification: an MCP metadata hint alone cannot enforce a chat
UI's approval behavior.

A later content-authoring skill can discover schemas, draft copy, validate and
prepare these changes through the same tools. It must not become a second schema
registry or bypass the draft and approval rules.

## Local validation record — 2026-10-05

- Context Engine: type checking and production build passed. The full suite
  passed 2,943 tests with 98 skipped; two subprocess tests blocked by the sandbox
  passed when their five-test file was rerun with the required access.
- Ramesh: `npm run check` passed (743 tests passed, 20 skipped, plus schema
  validation, type checking, build and formatting). The subsequent evaluator-only
  correction has its own focused regression test and type check.
- The temporary HTTP MCP harness passed discovery, direct calls and invalid
  argument rejection for both `claude` and `whatsapp`, plus permission filtering
  and revocation. Synthetic authentication and business data were used.
- Five authorized Luna scenario executions were retained: three original runs
  plus two approved follow-ups. The first two deferred attempts exposed a usage
  meter integration failure, now fixed and regression-tested. Both follow-ups
  executed native search. The unfamiliar Studio tool was found and called without
  adding its name to Ramesh runtime code.
- Offline regrading verifies the eager CRM answer, deferred CRM answer and
  unfamiliar-tool answer against their saved evidence. The evaluator initially
  used the wrong parameter name, then overconstrained CRM selection to
  `crm_summary`; `crm_briefing` also returns the requested exact stage counts.
  Original failed reports remain unchanged, with the corrections recorded in a
  separate report. These are compatibility checks, not a retrieval-accuracy study.
- Conservative accounted cost across all five executions: **$0.048206**, using
  reviewed long-context Luna rates for every request. All 19 requests settled;
  none has unknown or held usage. This is accounting under that price profile,
  not an invoice reconciliation.

Temporary artifacts: `/tmp/wareongo-tool-loading-harness/` contains `raw-mcp.ts`,
`report.json`, the captured catalogues, original `luna/` and `luna-followup/`
campaigns, and `offline-verification.json`. Runtime loading defaults to eager;
set `AGENT_TOOL_LOADING=deferred` in Ramesh to opt in. No production deployment
or live CMS mutation was part of this validation.
