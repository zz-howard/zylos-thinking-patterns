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
| `clues` | `{session_group,c4_id,kind:"decision" or "correction",source_range}` plus optional prose; queued clues retain their original range |
| `traces` | `{clue,rows,report}`; same-group allowed-channel context including replies |
| `trace_complete` | True after clue selection and all queued traces finish; empty selection still requires trace |
| `report`, `trace_report` | Source counts/bytes/characters and `reuse_misses`; cumulative run trace counts/bytes/characters/deferred clues |

Default retention is seven days (`artifact_retention_days`). Only completed
expired artifacts marked `committed` or `closed` are removed. Active runs and deferred clues remain
until processed. Artifacts require local access and are never published.

Identity-reflection reuses correction clues/traces only for exact matching
completed group ranges and filters. Unmatched ranges are collected independently.
Reuse reads checkpoints but skips raw rows/memory for covered ranges; reporting
distinguishes reuse. Callers must select the intended policy/task artifacts.

## Progress

`state.material_scopes[policy:task]` holds `groups`, `active_run`,
`pending_clues`, and `last_material_at`. Groups store `checkpoint_id` and
`end_conversation_id`. Fetch resumes an active artifact; trace handles deferred
clues first. Commit advances selected ranges after trace selection, even when
some clues were deferred. Deferred clues live in state and in the artifact's
`deferred_clues`, independently of the original run. The next fetch collects
new checkpoint ranges normally. `skip` advances nothing and releases the run.

Trace clue and byte limits apply cumulatively to one run. Further calls cannot
reset them. The first trace is accepted even when it exceeds the byte limit,
so an oversized source cannot block the queue forever. Sparse-thread expansion
stops within 2,000 global C4 IDs of the clue and no earlier than 1,000 IDs
before its original range; fewer context rows may be returned at that boundary.

Global content checkpoints identify a single-session instance unless the current
Core configuration explicitly selects multi-session mode: its range uses
`*`, rows retain their actual component session groups without filtering,
and logs come from `memory/sessions/`. Clues selected from those rows normalize
to the logical `*` thread. Core's global checkpoint CLI query
omits `--group` because current Core rejects an explicit wildcard.

## Wrapper Evidence

Telegram `src/lib/context.js:205-241` emits the `[TG DM]` or
`[TG GROUP:...]` header and sender signature before `group-context` or
`thread-context`, optional `replying-to` and `smart-mode`, then
`current-message` and optional trailing ` ---- file:`.
OpenMax `src/lib/message.js:218-254,302-366` instead emits its header,
self-closing `org-context`, `message-context`, and `sender-context`,
an `openmax-instruction` block, optional conversation context, and the
sender signature inside `current-message`. Its activity marker may prefix
the header. Optional connector, workflow, quote and work-reference context
are structural too. The collector preserves the header, sender, current body
and trailing media, removes those structural blocks, and decodes the five XML
entities once. Plain text outside a complete envelope is unchanged.
