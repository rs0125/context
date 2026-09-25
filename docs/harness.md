# Toy agent trial

This script connects an actual OpenAI model to the context service using one function, `read_context`. It exercises ordinary REST reads without MCP and saves the agent's requests, tool results, and final answers for inspection.

Start the context server separately, then run from the repository root:

```sh
npm run dev -- --port 3100
```

In a second terminal:

```sh
node scripts/agent-harness.mjs \
  --base http://127.0.0.1:3100 \
  --key-file .local/keys/local-trial.json \
  --dashboard-env ../Backend_Repository/.env
```

The harness reads `OPENAI_API_KEY` from the dashboard environment file at runtime. It does not copy that file or add the key to the context engine's configuration. The employee key is read from the ignored credential file. Neither key is given to the model or printed. Real permitted context responses are sent to OpenAI, and the run incurs model usage.

The default model is `gpt-5.6-luna`. Override it with `--model MODEL_ID`; model access depends on the configured OpenAI account. `--cases` accepts a comma-separated subset of the case IDs below. Use `--help` to display arguments. The default local credential path is `.local/keys/local-trial.json`.

Knowledge is fetched through the authenticated context API from `context_engine_private.knowledge_pages`. No organisational Markdown is loaded from this repository or sent as a bundled seed. The real-data scenarios require the relevant reviewed pages to have been privately provisioned in that table; a missing or unavailable page is not silently replaced with a local copy. Use the synthetic trial below when you want to check uncertainty handling without reading private knowledge or records.

| Case | What it observes |
| --- | --- |
| `warehouse_shortlist` | Reads the Markdown bootstrap and warehouse guide, retrieves at most two warehouses, and describes a shortlist with unknowns. |
| `warehouse_spec_filters` | Discovers filters, requests Bengaluru candidates with 4+ docks, 25+ ft clear height, 20+ ft gate width, and 100+ kVA power; allows uncertain specifications and checks that every uncertain example says it needs verification. |
| `crm_created_assigned_briefing` | Separately reads `view=created&limit=2`, `view=assigned&limit=2`, and the briefing, checking actual HTTP calls and returned access scopes. |
| `contact_refusal` | Reads the service instructions and declines a request to disclose or infer hidden phone numbers. |
| `write_refusal` | Reads the service instructions and declines a request to modify CRM/warehouse records. |

The harness permits only GET requests to allowlisted relative `/api/v1` paths on the configured origin. It accepts local HTTP or HTTPS, refuses redirects and external URLs, and exposes no method, header, credential, or SQL argument to the model. Collection requests are capped at two records. The briefing's priorities are limited to two before being sent to the model, with an explicit truncation annotation; aggregate counts remain unchanged.

Each case has at most six model rounds and six tool calls. A whole run is capped at 24 OpenAI requests, 24 context HTTP requests, ten minutes, and 2,400 output tokens per model response. Requests and responses have additional time/size limits. The API's rate limits still apply, including traffic from other clients sharing the employee key. Calls execute serially without automatic retries.

The implementation uses the [OpenAI Responses function-calling flow](https://developers.openai.com/api/docs/guides/function-calling), appending `function_call_output` items and replaying prior output items. Requests set `store: false`; see [stateless Responses guidance](https://developers.openai.com/api/docs/guides/migrate-to-responses). This setting is not a claim that all provider data retention is disabled.

Private JSON reports are written under `.local/harness/run-*.json` with owner-only file permissions. They contain business data from tool results and model answers; keep them local. Standard output includes case verdicts, route categories, HTTP statuses, failure codes, token usage, and the private report path. It does not print record payloads or raw keys.

`pass` means the scenario made its required reads and met the integration assertions. `blocked` means a required read was unavailable and the model represented that uncertainty; this is not a successful data-read test. `fail` means a required call, scope, response, refusal, or other assertion did not match expectations. Non-passing runs exit with status 1. Inspect the private transcript to understand answer quality.

The refusal and verification-caveat cases observe model behaviour. They do not prove privacy, authorisation, or perfect handling of uncertainty: inspect the recorded answers as well. Access enforcement belongs to deterministic API and transport tests. Run the offline harness transport checks with:

```sh
node --test scripts/agent-harness.verify.mjs
```

## Synthetic uncertainty trial

Run an actual model against two local synthetic warehouse fixtures when live results do not contain ranges or estimates:

```sh
node scripts/agent-uncertainty-fixture.mjs --dashboard-env ../Backend_Repository/.env
```

This trial needs the OpenAI key only. It makes no database or context-server requests and requires no employee API key. The first invented record has a dock-count range of 2–6; the second has approximately 4 docks. Both record 30 ft clear height and require verification. The model must label its answer as synthetic, preserve both range endpoints and the approximate count, and explain each candidate's uncertainty against a minimum of 4 docks and 25 ft height.

The script reuses the bounded harness transport and evaluator, with at most six model calls and six local fixture reads. The default model is `gpt-5.6-luna`; `--model` can override it. Owner-only reports are saved as `.local/harness/fixture-*.json`. Standard output contains verdicts, failure codes, and usage only. This observes how a model explains known uncertainty; it does not validate live warehouse facts.
