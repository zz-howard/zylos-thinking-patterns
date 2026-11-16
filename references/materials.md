# Shared Material Artifacts

Both components ship the same dependency-free `scripts/materials.js`; neither
imports the other's installed code. Thinking-patterns writes mode-0600 JSON to
its data directory's `materials/<run UUID>.json`.

## Format (schema_version 1)

| Field | Contract |
| --- | --- |
| `run_id`, `created_at`, `mode`, `time_zone` | UUID, ISO instant, `checkpoints`, owner's timezone |
| `ranges` | `{session_group,after,end,checkpoint_id,begin_time,end_time}`; interval `(after,end]`; C4 times are UTC |
| `filters` | `{channels:null or array,exclude_channels:array}`; reuse requires equal filters |
| `session_files`, `reference_files` | Paths only; no copied memory body |
| `inbound` | Allowed-channel inbound C4 rows with adapter wrappers stripped; signatures preserved |
| `clues` | `{session_group,c4_id,kind:"decision" or "correction"}` plus optional prose |
| `traces` | `{clue,rows,report}`; same-group allowed-channel context including replies |
| `trace_complete` | True after clue selection and all queued traces finish; empty selection still requires trace |
| `report`, `trace_report` | Source counts/bytes/characters; trace counts/bytes/characters/deferred clues |

Default retention is seven days (`artifact_retention_days`). Only completed
expired artifacts marked `committed` are removed. Incomplete/uncommitted runs and deferred clues remain
until processed. Artifacts require local access and are never published.

Identity-reflection reuses correction clues/traces only for exact matching
completed group ranges and filters. Unmatched ranges are collected independently.
Reuse reads checkpoints but skips raw rows/memory for covered ranges; reporting
distinguishes reuse. Callers must select the intended policy/task artifacts.

## Progress

`state.material_scopes[policy:task]` holds `groups`, `active_run`,
`pending_clues`, and `last_material_at`. Groups store `checkpoint_id` and
`end_conversation_id`. Fetch resumes an active artifact; trace handles deferred
clues first. Commit accepts only finished groups. `skip` advances nothing.

## Wrapper Evidence

Telegram `src/lib/context.js` emits `group-context` or `thread-context`,
optional `replying-to` and `smart-mode`, then `current-message` with escaped
sender/text and optional trailing ` ---- file:`. Installed Lark `src/index.js`
and OpenMax `src/lib/message.js` use the same tags. The collector recognizes
an anchored complete envelope, returns its current-message and trailing media,
and decodes the five XML entities once. Plain text including literal tags
outside that envelope is unchanged. No signature or keyword classification.
