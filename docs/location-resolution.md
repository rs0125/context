# Origin-independent location resolution

`resolve_location` is a read-only Context Engine tool. It normalizes a supplied location before a later explanation, search or explicitly authorized GIS creation. It does not create a POI, update a warehouse, enqueue enrichment or grant write access.

## Inputs and results

Use exactly one input form:

```json
{"latitude": 12.9, "longitude": 77.6}
```

```json
{"location": "12.9, 77.6"}
```

```json
{"location": "https://www.google.com/maps/search/?api=1&query=12.9,77.6"}
```

The text form also accepts supported decimal labels, DMS coordinates, `geo:` URIs and Google Maps share links. Latitude comes before longitude for unlabelled pairs; the tool never silently swaps axes to make a number valid. Native WhatsApp pins can use the numeric form without giving this tool WhatsApp-specific schemas or credentials.

Results contain `status`, bounded `candidates`, `source` and `reason`. Each candidate has latitude, longitude, extraction method and `requiresConfirmation`. A resolved coordinate is an interpretation of the supplied source, not verification of the site's ownership, boundaries, suitability or address.

- `resolved`: one explicit coordinate pair.
- `ambiguous`: the caller must select or confirm the intended location. Examples include multiple pins, directions, conflicting targets or a map viewport with no explicit pin.
- `unresolved`: no supported, trustworthy coordinate extraction. Ask for an explicit dropped pin or coordinate pair; do not invent a point or claim the place does not exist.

Explicit place pins take precedence over map viewport coordinates. A link can contain both: `@latitude,longitude` can be the camera centre, while an adjacent `!3d...!4d...` identifies a place pin. Plain addresses, place-ID/CID-only links and HTML/JavaScript-only landing pages are not geocoded by this implementation. They need an explicit coordinate source or a future geocoding provider with candidate/precision metadata.

## Access and transport

An active, authenticated employee may resolve their supplied input. The tool does not read business records and requires no extra CRM, warehouse or GIS scope. Unknown WhatsApp users still cannot call Context Engine. Live identity, credential expiry and revocation are checked before resolution and again before returning its result.

The MCP descriptor uses `wareongo/context-read-v1`, source family `context`, and no additional scopes. Descriptions and Claude/WhatsApp visibility use the existing editable prompt/platform registry. MCP binds the exact input arguments to the response. The REST equivalent is `GET /api/v1/locations/resolve` with the same flat input fields.

Parsing explicit coordinates and full pin URLs needs no network request. Shortlink expansion follows only bounded, individually validated Google redirects with a total deadline, cancels response bodies and never sends Wareongo credentials to Google. Arbitrary hosts, private addresses, URL credentials, unsupported ports and redirects outside the allowlist are refused. No database connection is held during network work.

Response data has no volatile timestamps; normal request timestamps remain in `meta`. This lets Ramesh's generic delivery verification re-read the tool and compare stable evidence. No named-tool branch or Google credentials are needed in the bot. Precise inputs are omitted from citation URLs and application audit logs. They remain in the tool arguments and result for the authorized conversation, so callers must treat those as private data.

## What is stored today

| Storage | Existing content |
| --- | --- |
| `point_of_interest` | Point ID, name, category/type, latitude, longitude, notes, city, creator email, created/updated timestamps and generated spatial geography. |
| `ContextGeoWrite` | Issuer, authenticated employee ID, operation UUID, canonical accepted-payload hash, point ID, original creation result and receipt timestamp. |
| `ContextGeoNonce` | Request nonce hash and expiry for replay protection. |
| Ramesh encrypted inbox | Native location coordinates and static/live-snapshot type, associated with the existing trusted message/sender identity. A native snapshot is not continuous tracking. Maps links and textual coordinates remain ordinary message content. |

The resolver itself does not persist a new database record. Its result exposes source input and extraction method as tool evidence. **GIS points and creation receipts do not currently persist that source link, extraction method, provider/place ID, WhatsApp message ID or source author.** Do not describe `createdBy` as the original forwarder's identity: it identifies the employee whose authorized creation was executed. There is also no `updatedBy` column or complete edit history.

If durable GIS provenance is required, extend the creation/storage contract explicitly and carry bounded source evidence into its immutable receipt. An input claiming to be a WhatsApp pin cannot authenticate that origin: the future bot write executor must bind the actual trusted transport reference to the proposed coordinates.

## Existing geocoder reuse decision

The warehouse enricher's `/enrichment/geocode` and `/cron/geocode-recent` routes update or queue warehouse data. They are not location lookup endpoints, and `dryRun` does not return resolved coordinates. This tool must not call them or receive their broad `CRON_SECRET`.

The new resolver follows the existing dashboard's pin-first extraction rule and the enricher's bounded HTTP/redirect approach. It does not reuse the older unrestricted fetch helper or the enricher's viewport-first precedence. A future address geocoder should return multiple candidates and precision/partial-match information instead of silently selecting the first or falling back to a city/country centre.

Google's [Maps URL documentation](https://developers.google.com/maps/documentation/urls/guide) distinguishes query locations, directions and map centres. Its [geocoding guidance](https://developers.google.com/maps/architecture/geocoding-address-validation) explains why geocoded precision or partial matches do not prove a real address. These distinctions inform the ambiguity policy.

## Verification and rollout

Use synthetic, model-free cases for coordinate boundaries, labelled/DMS input, conflicting pins, viewport precedence, unsafe links and redirect cancellation. API/MCP checks cover live identity before/after resolution, dynamic discovery, argument binding, private citations and the absence of writes. Ramesh's compatibility test covers delivery replay and rejection after coordinates or authorization change.

No database migration, new secret or existing grant expansion is required. Deploy Context Engine to publish the tool; existing bots discover it dynamically. This change does not enable Ramesh's pending generic write executor or provide historical native-pin authorization.
