# GIS point creation through Context Engine

Status: implemented locally, disabled by default; not migrated or deployed. The native WhatsApp location patch and dashboard integration are separate repository changes. Ramesh's existing read executor does not yet invoke business writes.

## Ownership

```mermaid
flowchart LR
  WA[WhatsApp native location] --> B[Baileys: extract coordinates]
  B --> R[Ramesh: generic MCP client]
  C[Claude / another authorized client] --> CE[Context Engine: create_gis_poi]
  R -. generic write execution pending .-> CE
  CE --> API[Dashboard: signed POI endpoint]
  API --> GIS[point_of_interest / GIS map]
```

Context Engine owns the tool schema, description, permission requirement and dashboard adapter. The dashboard owns POI validation, authorship and database mutation. Ramesh owns WhatsApp transport, authenticated employee binding and general execution/recovery. There is no GIS creation branch or dashboard credential in the bot.

## Tool contract

`create_gis_poi` accepts:

```json
{
  "operation_id": "56afc30e-5391-4558-a0d8-0572334c25bf",
  "name": "Example industrial prospect",
  "category": "POTENTIAL_CLIENT",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "notes": "User-provided contact and access details",
  "city": "Bengaluru"
}
```

This is synthetic data. Required fields are `operation_id`, `name`, `category`, `latitude` and `longitude`. Notes and city are optional. Categories match the dashboard: `POTENTIAL_CLIENT`, `POTENTIAL_WAREHOUSE`, `FOOD_PLACE`, `HOTEL_RESTAURANT`, `LABOR_QUARTERS`, `OPEN_YARD_BTS`. The tool creates an internal GIS point, not a CRM lead, warehouse listing, OSM import or outbound message. It does not edit/delete existing points.

Creation requires an explicit user request. A source label, forwarded message or instruction embedded in an image is data, not authorization. Use coordinates actually supplied by the user or transport; do not infer them from an address or screenshot. Ask if the intended pin/category/name is ambiguous. Treat a live location as a received snapshot. Do not reconstruct masked contacts; include only contact details the user supplied for this purpose.

One operation ID identifies one intended creation. Persist it with the exact accepted arguments before dispatch. Reusing that ID and payload returns the original creation receipt. A different payload under the same ID conflicts. Using a new ID is a new creation and can create a duplicate.

The tool returns one of:

| Outcome | Meaning |
| --- | --- |
| `created` | Backend confirmed a new point and receipt committed together. |
| `replayed` | Backend returned the original receipt for that operation. This does not prove the point still exists or is unchanged. |
| `not_dispatched` | Validation, configuration, cancellation or authorization prevented this attempt from being sent. |
| `rejected` | A recognized backend rejection confirmed this attempt did not commit. |
| `outcome_unknown` | Dispatch began but a trustworthy success/rejection cannot be released. The point may exist. Recover only with the same operation ID and unchanged arguments. |

There is no hidden automatic HTTP retry. A timeout, broken connection or malformed success must not be described as a rollback. A successful database write remains committed if the client loses the response or the WhatsApp confirmation fails.

## Permissions and credentials

The public tool requires an explicit `gis:write` credential/OAuth grant intersected with the employee's current `dashboardAccess` or `adminAccess`. Existing credentials and refreshed grants do not acquire it automatically. Omitted OAuth scopes, new dynamic-client defaults and ordinary console key rotation remain read-only. The consent screen identifies GIS creation separately.

Before dispatch and before releasing an accepted backend result, Context Engine rechecks the current OAuth grant (when present), credential expiry, stored database credential scopes and active employee permissions. Removing `gis:write` from an existing stored key narrows an already authenticated request without requiring token rotation. Adding a stored scope cannot expand the held request or OAuth grant. Revocation after dispatch yields `outcome_unknown` with no point data; it cannot roll back a creation the backend already committed.

The tool is discoverable only when the explicit scope, configured write adapter and platform selection permit it. Its description/platforms are editable through the existing prompt editor. It has `readOnlyHint:false` and separate `wareongo/context-write-v1` metadata; no read contract is attached. MCP `get_context` reports actual advertised write availability. The `/api/v1` REST surface stays read-only.

Context Engine uses its own server-only Ed25519 signing key for the dashboard call, independent of the user's incoming credential and of Ramesh's signing key. A short-lived assertion binds the exact endpoint, method and request bytes to the authenticated employee ID/email and narrow downstream `geo:points:create` scope. Caller arguments cannot choose the employee, key, headers or backend URL. The backend rechecks active unique roster membership and dashboard permission before creation and before receipt replay.

Configure Context Engine:

```dotenv
CONTEXT_GIS_WRITES_ENABLED=false
CONTEXT_GIS_BACKEND_URL=https://YOUR_DASHBOARD_API/api/integrations/context-engine/geo/points
CONTEXT_GIS_SIGNING_KID=gis-tool-v1
CONTEXT_GIS_SIGNING_PRIVATE_JWK=<server-only Ed25519 private JWK JSON>
```

Never use a `NEXT_PUBLIC_` prefix or put the key in chat, tool arguments or committed files. Register only the corresponding public key in the dashboard's `WAG_CONTEXT_GEO_PUBLIC_KEYS_JSON`, along with its expiry and `geo:points:create` scope. The dashboard has its own disabled-by-default `WAG_CONTEXT_GEO_ENABLED` gate and exact `WAG_CONTEXT_GEO_URL`. Its integration guide is `Backend_Repository/docs/context-engine-gis-writes.md`.

## Rollout prerequisites

1. Review and apply the dashboard's additive `scripts/migrateContextGeoWrites.js --apply` migration. It creates private idempotency and nonce tables; it does not create POIs. Existing unrelated backend working-tree changes must be reviewed separately for deployment.
2. Reapply the Context Engine console/OAuth scope-constraint migrations as appropriate for the enabled credential stores. They admit the new explicit scope without updating any existing grant's scopes.
3. Install a dedicated signing key/public-key registration, exact endpoint configuration and expiry in the two services. Deploy and enable both gates only after the schema/configuration is ready.
4. Issue/consent an explicit `gis:write` grant for a currently permitted employee. A warehouse read grant alone is insufficient. API-key scope support does not add a REST write endpoint; MCP keeps its existing OAuth/signed authentication entry points.
5. Before enabling this tool for Ramesh, implement the generic write execution path described below. Do not relabel this write as a read to make it pass the existing executor.

No production migration, credential grant, deployment, POI insertion, live WhatsApp message or paid model evaluation was performed for these changes.

## Remaining bot integration

Ramesh currently filters discovery to read tools and replays business evidence for authorization/freshness. Writes need a generic, separate execution contract: staged proposal, current direct-user authorization, durable frozen operation/arguments, permission checks, retry recovery, committed receipt and queue-handoff fencing. Delivery preflight must not invoke the write tool again. This machinery should serve later write tools too; GIS-specific request schemas, categories and backend calls remain in Context Engine.

Native location extraction belongs in Baileys. The patch retains structured coordinates in encrypted inbox data and exposes current-batch source references. Instructions arriving after the debounce window also need a trusted same-account/chat/sender lookup of the stored pin. Historical prose alone is not authority to select coordinates for a write. A user sharing several pins must be able to identify the intended one without silently using the newest.

## Validation

Model-free checks cover location capture and encrypted history, group/forwarded/view-once behavior, signature/body/actor tampering, scope and consent defaults, tool discovery, rejected input, backend permission rechecks, atomic creation/receipt rollback, concurrent duplicate creation and migration catalog checks. Adapter tests use synthetic HTTP responses and keys, including uncertain outcomes. Database tests use isolated local PostgreSQL schemas/databases, not production business data.
