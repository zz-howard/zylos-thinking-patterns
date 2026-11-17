# Shared Material Artifacts

Both components ship compatible material contracts and `reference-deltas.js`; neither
imports the other's installed code. Thinking-patterns writes mode-0600 JSON to
its data directory's `materials/<run UUID>.json`.
Reference fragments use the installed Git executable's bounded-context diff,
with external diff/text conversion disabled and temporary private files removed
after every comparison.

## Format (schema_version 1)

| Field | Contract |
| --- | --- |
| `run_id`, `created_at`, `mode`, `time_zone` | UUID, ISO instant, `checkpoints`, owner's timezone |
| `ranges` | `{session_group,after,end,checkpoint_id,begin_time,end_time}`; interval `(after,end]`; C4 times are UTC |
| `filters` | `{channels:null or array,exclude_channels:array,exclude_scheduled_tasks:true}`; reuse requires equal filters |
| `session_files`, `reference_files` | Session paths and index of reference paths having emitted changes |
| `reference_changes` | `{file,kind,start_line,changed_lines?,section?,content}` fragments: new files whole; modified current lines with two context lines, `changed_lines` (1-based current line numbers that are new or edited; the rest is context) and the nearest section heading above the first change, ignoring fenced code blocks; deleted/unchanged files and in-file deletions omitted |
| `reference_baseline_note` | Initial baseline notice when no previous successful baseline exists; no reference content is emitted on that run |
| `inbound` | Allowed-channel inbound C4 rows with current-message bodies and bracket-prefixed first lines retained; no-pair messages unchanged |
| `clues` | `{session_group,c4_id,kind:"decision" or "correction",source_range}` plus optional prose; queued clues retain their original range |
| `traces` | `{clue,rows,report}`; same-group allowed-channel context including replies |
| `trace_complete` | True after clue selection and all queued traces finish; empty selection still requires trace |
| `report`, `trace_report` | Source counts/bytes/characters and `reuse_misses`; cumulative run trace counts/bytes/characters/deferred clues |

Default retention is seven days (`artifact_retention_days`). Only completed
expired artifacts marked `committed` or `closed` are removed. Active runs and deferred clues remain
until processed. Artifacts require local access and are never published.

Identity-reflection reuses correction clues/traces only for exact matching
completed group ranges and filters. Unmatched ranges are collected independently.
Inbound collection rejects only stored content starting with `[Scheduled Task:` before wrapper extraction, including in legacy time-window mode. The marker elsewhere is retained. Trace context is unchanged. Older artifacts without `filters.exclude_scheduled_tasks: true` fail filter matching and are recollected.
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

Each component independently saves `reference_baseline` contents in its data
directory's state (per policy/task for thinking-patterns). Fetch captures `reference_snapshot` in the private
artifact (never in fetch output); only the final successful non-skip commit of
all ranges advances the baseline to those captured bytes. Partial, failed and
skipped runs retain the previous baseline. Fully reused runs do not consume
reference changes. Content comparison ignores mtimes. `report.references`
counts emitted fragments and their content characters, rather than full files;
its `baseline_note` also preserves initialization in the run summary/log.
The state file is written owner-only (0600) because the baseline copies private
memory files; `status` reports each baseline's file and character counts only.

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

Use one channel-independent rule for inbound material and traced rows. If a
complete `<current-message>...</current-message>` pair exists anywhere in the
message, retain only its inner body. If the first line starts with `[`, retain
that first line before the body. Without a complete pair, return the message
unchanged. Do not recognize individual context tags or channel names. The body
keeps its stored text; context and media outside the pair are not retained.

Real adapter-shaped fixtures cover Telegram group, Telegram DM and OpenMax
OM-RUN headers, plus unchanged plain text and unknown surrounding wrappers.
This rule follows the approved observation that all 247 wrapped Telegram and
OpenMax messages in the reviewed day contained current-message; no fixed
wrapper vocabulary is needed.

## Pattern Writes

`extract.js write --file DRAFT --sha256 RAW_HASH --run RUN` publishes the policy's
pattern destination only. Use the same task/policy as fetch/trace/commit. Drafts
preserve all existing entry content, extending entries only with canonical
Reinforced blocks and appending consecutively numbered new entries. Existing
memory files use Core's replacement writer with a relative path, expected raw
hash and full draft bytes on stdin. The writer handles the memory lock and Sync
marker. Busy/timeout/conflict/error returns `write_deferred` and leaves commit
blocked within that run until successful retry; on conflict reread and merge before retrying.
Direct writing reports `file_missing`, `outside_memory`, or `writer_unavailable`.
A writer rejection never enables direct fallback. No-change/updated commits are
refused while a write is pending for that run. The guard stores its initiating
run ID (or `legacy` for time-window fallback). Skip that closes the run (`--run`) clears it without advancing.
Fetch resumes an active run with its guard, but clears abandoned guards when
starting a new run. Writing alone does not advance checkpoint ranges.
