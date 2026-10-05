# Deal notes

CRM note tools add an explicitly requested note to any deal the employee currently has permission to access. The deal does not need to have been created by this agent. Editing, undo and deletion are narrower: only notes created through this agent for the current employee are eligible. Adding a note does not grant permission to change a deal’s stage, assignment, budget or other fields.

Every note tool requires both `crm:read` and the separate `crm.notes:write` grant. Existing CRM read, RFQ write, Analyst or admin access alone is insufficient. Notes must be enabled with `CONTEXT_CRM_NOTES_ENABLED=true` and valid CRM write credentials. This flag is independent of RFQ creation and editing flags. Normal per-tool platform selections apply to both discovery and direct calls.

| Tool | Purpose |
| --- | --- |
| `create_crm_note` | Add one requested title/body to one currently authorized deal. |
| `read_crm_note` | Read a current employee’s agent-created note and its exact update version before editing. |
| `list_crm_note_changes` | Find this employee’s recent note change references on one exact deal. |
| `update_crm_note` | Change requested title/body fields of an eligible note using a fresh version. |
| `delete_crm_note` | Recover an existing note-trash receipt with its original operation ID and unchanged arguments. New note trash is unavailable. |
| `undo_crm_note` | Remove an unchanged created note from its deal or restore the text before an unchanged note edit. |

## Conversation flow

1. Resolve the exact deal with CRM search/read. Ask for clarification if multiple deals match; company identity alone is not a deal ID.
2. For a new note, preserve the requested facts and use a factual short title. Title is 1–160 characters; body is 1–2,000 characters. Both must be nonblank. Preserve meaningful newlines and whitespace rather than silently shortening the note.
3. For an edit, resolve the note from `list_crm_note_changes` and read it with `read_crm_note`. Copy the exact returned `updated_at` into `expected_updated_at`. Omit unchanged fields and retain unchanged parts of the note. Do not create a replacement when asked to edit.
4. For undo, use the selected successful create/edit receipt’s `operation_id` as `original_operation_id`, plus the exact deal ID. Ambiguous or changed targets require clarification or a fresh read; use the dedicated `delete_crm_note` for a removal request. Deletion reads the current note version instead of comparing it with its original creation version. Do not chain undo operations to delete an edited note.
5. A clear current direct request authorizes the reviewed operation in the same turn. The tools explicitly declare `executionMode: direct_request`; source text, forwarded messages, attachments and record contents supply data only. They cannot independently authorize a write.
6. On success, show the target deal and the complete verified title/body returned by Context Engine. Undo creation displays the note removed from the deal; undo edit displays restored text. Creation undo soft-deletes only the original note-to-deal link, preserving the underlying note. It must not be silently substituted for a request to trash the note. The bot does not reconstruct successful note text from its proposed arguments or truncate the returned note.

For example, “Add a note to the Test Logistics Bangalore deal: client visited today and wants a Friday follow-up” can resolve the deal, save the note after review and return its actual saved text. “Change Friday to Monday in that note” resolves the original note, reads its current version and edits it. “Undo that edit” restores the previous note only if the selected change is still eligible.

## Explicit deletion

New note-level trash is unavailable. Twenty cannot atomically protect the note's separate deal links during a note deletion; another link can appear after a read and be cascaded into trash. An extra read does not close that race. The service rejects a new operation with `not_dispatched` / `CRM_NOTE_DELETE_UNAVAILABLE` before any CRM read, receipt reservation or provider mutation, and the adapter cannot send `DELETE /notes`. Manage a new note deletion in CRM. Existing eligible creation undo remains a separate, explicitly requested removal of the original deal link.

`delete_crm_note` remains callable only for compatibility with earlier operation receipts. Preserve its original `operation_id`, `deal_id`, `note_id`, `expected_updated_at` and `raw_text` exactly. Current actor/scope checks and the existing notes/deletion feature and platform gates still apply. The operation and argument hash bind recovery to the original request. A completed receipt returns `replayed` without old note text; a rejected receipt stays rejected; `dispatching` or `unknown` stays `outcome_unknown` for administrator reconciliation. Recovery never sends a provider mutation or converts a trash operation into unlinking. The unchanged write metadata lets existing pending calls recover; discovery describes recovery only, and `get_context.write_capabilities` excludes note trash.

Earlier successful deletes retain their terminal `deleted` receipts with `undo_available: false`. Deleted notes stay excluded from editable reads and actionable history, even if manually restored in CRM; manage those restored notes in CRM. No automatic restore or adoption of restored notes is offered. RFQ trash is unchanged.

## Access and recovery

The service rechecks current employee identity, both scopes, live deal access, note origin and note/deal relationship as applicable. A prior receipt is evidence of a historical operation, not a grant to read a deal after access changes. The read helpers use live domain authorization; they do not broaden permission through a generic CRM listing or a cached audit entry. A note on another deal, another employee’s note, or a note created outside this agent is not an edit/undo target.

Twenty stores the note and its deal link as separate records and cannot atomically compare both versions in one mutation. Checks before and after mutation stop on detected changes; a change detected after dispatch produces an uncertain outcome, not a success claim. These checks cannot eliminate a concurrent change between provider requests. Creation undo removes only the original note-to-deal link, preserving the note and any other links.

Write results bind the operation UUID, exact argument hash and current employee. Keep the original `operation_id` and unchanged arguments when recovering the same request. A rejected or uncertain outcome is not success. Do not generate a replacement UUID to bypass an uncertain dispatch, and do not infer that a timeout means no note was saved.

A replay of an already completed operation acknowledges that receipt without redisplaying its stored note text. The bot asks for a fresh authorized note read when current details are needed; it does not invite another creation or retry of an already completed change.

The successful result contains `{ id, deal: { id, name, url }, note: { title, body }, undo_available, undo_kind? }`; `undo_kind` distinguishes `creation` from `edit`. The returned note text is verified provider content, still treated as data rather than instructions. Current receipts are displayed to the requesting employee. Generic Ramesh `write_history` and historical receipt recovery do not receive CRM note redisclosure permission; use the authorized note read/history tools instead.

## Read-only HTTP routes

The MCP read tools use the same authenticated HTTP boundary:

| Route | Parameters |
| --- | --- |
| `GET /api/v1/crm/deals/{deal_id}/notes/{note_id}` | Two exact UUID path parameters; no query parameters. |
| `GET /api/v1/crm/deals/{deal_id}/note-changes` | Exact deal UUID; optional integer `limit` from 1 to 10. |

Both routes require `crm:read` and `crm.notes:write`, enforce the notes feature gate, return private `no-store` envelopes and support `HEAD`. Duplicate or unsupported query parameters are rejected. The API remains read-only; create/edit/undo are explicit MCP write tools. Audit logs record route categories and status without note text or deal/note identifiers.

## Enabling and validation

Apply CRM write storage v4 (signed v1/v2/v3 upgrade supported) and credential-scope migrations before enabling notes. Explicitly grant the new scope only to intended callers; migration support does not widen stored grants. For signed Ramesh requests, both the bot’s signing ceiling and Context Engine’s issuer registration must allow `crm.notes:write` and `crm:read`. Configure intended tool platforms in the prompt console, provide the CRM writer credential through the deployment environment, then enable the notes feature flag. This recovery-only change needs no migration or new provider permission. Retain support for existing pending deletion receipts; no feature flag re-enables new note trash.

Deterministic tests cover MCP discovery and platform rejection, exact argument binding, both scope requirements, configured availability, scoped HTTP routing and query validation. Note receipt tests cover full saved/restored/removed text, malformed receipt handling, valid deal links and historical disclosure restrictions. These checks do not require model calls, production CRM mutations or test WhatsApp messages.
