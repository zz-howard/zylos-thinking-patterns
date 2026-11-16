# Extraction Output

Commands emit JSON except text templates. Errors use
`{status:"error",error:"message"}` and exit 1; do not commit on errors.

## Checkpoint Fetch

`fetch --task daily [--policy name] [--lookback 24h]` returns `status:ready`
and the schema in [materials.md](materials.md), plus `artifact_file`,
`policy_file`, `patterns`, `methodology_file` and `state_file`.
`--lookback` is accepted for old prompts but affects fallback only. New groups
always start from the latest day.

`ranges` gives each group's exclusive previous cursor and inclusive checkpoint
end. `begin_time`/`end_time` are C4 UTC timestamps. `time_zone` selects daily
session paths. Read `session_files`, relevant changed `reference_files`, then
the complete `inbound` net. `report` measures inbound count/bytes/characters,
session/reference path counts and file bytes, and reused range count. Normal
mode does not cap conversations.

`patterns` retains target introspection, entry index and unchanged lint.
`policy_placeholders` retains incomplete policy sections. `completed_groups`
lists committed groups within this active run; do not process them again.
Skip reasons are `no_checkpoint_progress`, `disabled` and `unconfigured`.
The last includes the owner's required action.

## Trace And Commit

`trace --run UUID --clues file.json --task daily` reads an agent-selected array
with `session_group`, `c4_id`, and `kind` (`decision` or `correction`). Output
contains accumulated traces, `trace_complete`, artifact path and cumulative report
with message count, characters, bytes, processed and deferred clues. Only the
source group and allowed channels appear; context includes both directions.
Commit processed ranges after clue selection. Deferred clues are processed first
in the next run, together with new checkpoint material; run limits do not reset
between trace calls.

`commit --run UUID --result updated|no_change --task daily [--groups G,H]`
requires finished clue selection and advances selected groups only. Deferred
traces remain queued independently. Stale or
unfinished ranges are rejected. `skip` never advances progress.

## Legacy Time Window

Unsupported checkpoint/group metadata or failed queries produce
`mode:legacy_time_window` and explicit `fallback_reason`. Legacy output retains
`window` (owner zone, explicit offset), `conversations`, `count`,
`filtered_out`, `truncated`, `truncated_out`, `window_complete`, and limits.
CLI `recent N` pages grow until reaching the start or byte limit, then channel
filters and the newest-row conversation cap apply. Report incomplete reads and
truncation; `truncated_out:null` means the omitted count is unknown.

Legacy skips include `below_threshold` and `incomplete_read`. Commit retains
`--lookback`/`--window-end` and never moves group cursors. Legacy artifacts are
not shared as checkpoint-complete material.
