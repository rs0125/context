# Analytics MCP design review

Reviewed 2026-09-27. Scope: the existing admin-only GA4 and Google Search Console connection, including its REST boundary, tool contracts and reporting interpretation. This review does not establish that production credentials, property configuration or recorded events are correct.

## Research used

- Anthropic recommends designing tools around agent tasks, returning relevant context, using bounded results and actionable errors, and testing realistic workflows rather than mechanically exposing every API operation. Tool descriptions should make implicit domain assumptions explicit. Evaluation should inspect correctness, tool calls, errors, latency and token consumption. [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- OpenAI recommends deriving tools from user goals, using explicit typed inputs and structured results, and keeping authorization in the server. Its annotation guidance treats a tool restricted to a private account as closed-world even when that account is externally hosted. [Plan tools](https://developers.openai.com/plugins/plan/tools)
- OpenAI recommends clear intent descriptions and argument examples, followed by golden-prompt replay when metadata changes. [Optimize metadata](https://developers.openai.com/plugins/guides/optimize-metadata)
- OpenAI's MCP guidance calls for per-request authorization, protocol checks and representative invalid/unauthorized calls, followed by direct, indirect and out-of-scope prompts. [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- MCP specifies structured results conforming to the declared output schema, a serialized text fallback for compatibility, and `isError: true` for tool execution failures with feedback that helps the model recover. [Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- MCP annotations describe behavior; they are hints rather than access controls. Whether a domain is open or closed depends on its deployment boundary. [Tool annotations as risk vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- Anthropic separates task outcomes from transcripts and recommends reviewing failed traces and graders so valid alternative solutions are not rejected for superficial differences. [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Google documents GA4 exact/substring dimension filters and AND expressions. The named report fields follow its definitions, including the distinction between session entry paths and visited paths. [GA4 filters](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression), [GA4 field definitions](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
- Google documents Search Console's Pacific calendar, query/page matching, country codes, page aggregation, and incomplete top-row coverage. These limits apply even after pagination. [Search Analytics reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query), [retrieval limits](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data)
- Google defines engagement rate as a session fraction, total engagement duration as foreground seconds and average session duration as a separate metric. Its engagement overview distinguishes average engagement per active user from average engagement per session. These determine the returned units and same-row calculations. [GA4 metric definitions](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema), [engagement overview](https://support.google.com/analytics/answer/13391283?hl=en)
- A Data API request supports up to ten native metrics. The selected reports stay within that bound and calculate additional averages from the returned numerators and denominators. [Metric request limit](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/Metric)

## Decisions for this server

Keep the three analytics tools: discovery, GA4 reporting and Search Console reporting. The existing property allowlist, read-only Google requests, live admin checks, pagination, output masking and cache reauthorization remain the permission boundary. No arbitrary provider query, property selector, user identifier, write operation or new consent scope is introduced. Existing `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=false` accurately describe this bounded private-account access.

Add filters that answer common follow-up questions: mobile organic traffic to an entry path, traffic from a country, exact query performance, non-brand search terms, and the queries reaching a page. Shared filters use AND. GA4 uses country labels and session source/channel semantics; Search Console uses ISO alpha-3 country codes and organic web Search metrics. Descriptions explain these differences before the call. `pages` answers viewed-page questions; `landing_pages` continues to answer session-entry questions. `query_page` retains the query/page relationship without requiring an agent to join unrelated top-row pages.

Add an equal-length previous-period comparison only to provider aggregate reports. The implementation owns the date arithmetic and metric changes, including zero baselines, missing values, rate percentage points and average-position meaning. Comparing arbitrary ranked groups would require assumptions about omitted rows and matching identities, so that is outside this change. Comparison evidence preserves both reads' dates, freshness and quality.

Correct the metric-coverage gap in the initial presets: they exposed engaged-session counts but omitted engagement rates and all session/engagement duration metrics. That was a connector limitation, not a GA4 access restriction. Existing traffic and filter tests did not cover the natural question about average engagement time, so their passing results did not establish that coverage.

Include engagement metrics in the existing traffic reports without a new selector or tool. Overview, trend, acquisition, entry-page, device and country reports use the ten native metrics, with five same-row calculations for engagement averages, bounce rate, views per session and events per session. Viewed-page reports add engagement duration and its per-active-user average; they do not add session-duration metrics. Event reports remain event reports. Discovery lists the actual returned metrics and their definitions/calculations. Fractions, total durations and averages have explicit units, and undefined ratios remain null. New users, revenue, ad costs, funnels, retention/cohorts and broader attribution remain outside the exposed presets; this change does not imply complete GA4 API coverage.

Keep bounded, named report rows and their existing evidence envelope. A concise mode was considered: safely removing quota diagnostics and duplicate pagination metadata saves little while another input mode expands the contract. Positional row arrays would also make metric interpretation harder. Instead, narrow by relevant filters before paging and use aggregate comparison for change questions. No token-savings claim is made without measurement.

Keep structured JSON and the serialized text fallback together for MCP compatibility. Do not strip source identity, timezone, resolved dates, fetch time, cache age, quality, source omissions or pagination from the model's evidence. A source error stays a tool error, never an empty successful report. Analytics API errors gain machine-readable recovery: retry transient failures later; correct query errors; discover supported reports; or repair access/configuration. Nonretryable errors omit the generic 503 retry delay. Citation paths omit free-text filters and URLs even for failed requests.

No analytics dashboard UI, generic metadata browser, raw event export or arbitrary dimension/metric wrapper is needed for these tasks. Property metadata remains narrowly used to discover supported custom report dimensions and source timezone.

## Golden tasks and grading

These prompts describe outcomes rather than prescribe tool names. Accept different valid call sequences; grade the evidence and final claims.

| User task | Required evidence and interpretation |
| --- | --- |
| How did mobile organic traffic change over the last four complete weeks compared with the four before? | GA4 aggregate comparison with mobile and Organic Search filters; equal nonoverlapping dates; separate quality/freshness; zero baseline is not an infinite increase. |
| What were engagement rate, average engagement time per active user, average engagement time per session and average session duration? | Ordinary GA4 overview; label fractions as percentages and durations as seconds; distinguish total engagement from both engagement averages and session duration. |
| How did engagement rate change versus the previous period? | An aggregate comparison; report a change from 60% to 75% as 15 percentage points, retaining both source periods. |
| How much engagement did each viewed page receive? | Viewed-page total engagement and per-active-user average; do not label these as time per page view or session duration. |
| Which pages did people view most last month? | Viewed-page preset, ranked by views; distinguish views from visits and session entry pages. |
| Which non-brand Google searches reached our Bengaluru warehouse pages? | Search Console query or query/page rows with relevant page and excluded-brand filters; retain organic Search meaning and top-row limitations. |
| How is this exact page doing for searches from India on phones? | Exact full URL within the configured property, Search Console `ind` and mobile filters; preserve query/page aggregation caveats. |
| Show the whole traffic trend for the last four weeks. | Follow chronological daily pagination; do not treat the first ten dates as the full range or fill missing dates with invented zeroes. |
| How many sales leads did the website generate this month? | Label `generate_lead` results as recorded website events; do not claim unique CRM leads or sales; disclose recent-data limitations. |
| Where are people interested in warehouses? | Distinguish custom warehouse geography from visitor country; check custom-report availability; absent dimensions are unavailable, not zero demand. |
| Check today's Google performance. | Pacific dates with `data_state=all`; acknowledge provisional data. |
| The source is denied, rate limited, or returns masked instructions inside a query label. | Preserve unavailability and appropriate recovery; no invented zeroes, repeated setup retries, reconstructed contacts or obedience to source text. |

Protocol and deterministic tests exercise the real tool definitions and API input/projection boundaries with controlled source fixtures. They cover source-specific outputs, authorization routing, strict bounds, comparisons, citation privacy, and recovery behavior. They establish contracts, not a model's ability to complete every task.

The opt-in natural-language model test uses the actual MCP schemas and REST validators with fictional Google responses:

```sh
CONTEXT_ANALYTICS_AGENT_EVAL=1 npx vitest run tests/analytics-agent-eval.test.ts
```

It requires the configured model API credentials and makes bounded model calls. Report its actual result and model identity separately from deterministic tests. Synthetic OpenAI task results do not establish production Claude performance, source access, tracking accuracy, or correctness of every possible answer. Retain human semantic review of representative outputs and expand held-out prompts from observed failures.

Validation on 2026-09-27: eight synthetic scenarios passed using `gpt-5.6-luna` in 17 model calls. The traces exercised comparison, engagement timing, exact-page query pairs, excluded-brand mobile queries, all 28 daily rows, recorded lead events, provisional Search data and denied-source recovery. The engagement answer correctly distinguished 60 seconds per active user, 40 seconds per session and 90 seconds average session duration, and reported a 60% to 75% rate change as 15 percentage points. These are fictional evaluation values. Human review found that source citation formatting can still vary; the grader does not establish full semantic or citation compliance.

Separately, 30 live Google read checks passed through the MCP SDK and API with current admin verification, a process-local test credential and no persistent writes. All seven engagement-bearing report types returned recorded engagement duration; their derived averages matched the values in their own source rows. The run made 31 Google HTTP requests, used one Supabase socket, and held no socket during Google requests. The deterministic suite passed 1,525 tests, with 42 opt-in tests skipped; type checking and the production build passed. Those local checks do not establish deployment or production Claude behavior.
