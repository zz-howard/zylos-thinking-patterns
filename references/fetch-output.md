# `extract.js fetch` — output reference

Field-by-field reference for the JSON printed by
`node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js fetch`.
The workflow in `SKILL.md` says what to do with these fields; this file says
what each one means.

## Contents

- [Top level](#top-level)
- [`window`](#window)
- [`conversations`](#conversations)
- [Filtering, capping and truncation](#filtering-capping-and-truncation)
- [`patterns`](#patterns)
- [Skip statuses](#skip-statuses)

## Top level

| Field | Meaning |
|-------|---------|
| `status` | `ready` (analyze) or `skip` (commit a skip and stop) |
| `reason` | Present when `status` is `skip` — see [Skip statuses](#skip-statuses) |
| `owner_action` | Present on some skips: text to relay to the owner verbatim |
| `policy_file` | Path of the policy that was read (`policy.md` or `policy-<name>.md`) |
| `methodology_file` | Path of the shipped methodology to read next |
| `policy_placeholders` | Policy sections that still contain the template's `(fill in` marker; the run proceeds, but treat those sections as unanswered and add one line to the run summary asking the owner to fill them in |
| `task`, `policy`, `lookback` | Echo of the arguments the run was called with |
| `count` | Number of messages in `conversations` (after the channel filter and the cap) |

## `window`

`begin` / `end` are the time range that was fetched, rendered in the owner's
time zone (`time_zone`, the `TZ` from the zylos `.env`) with the UTC offset
spelled out, e.g. `2026-09-05 19:20:14 +08:00`. Every message timestamp in
`conversations` uses the same form, so dates in a source-event line follow the
owner's day, not UTC. Pass `window.end` back to `commit --window-end`.

## `conversations`

The transcript: one object per message inside the window, oldest first, with
the C4 channel, direction, sender, timestamp (owner's zone, as above) and
content. Only messages that passed the policy's channel filter are included.

## Filtering, capping and truncation

| Field | Meaning |
|-------|---------|
| `filters` | The `Channels:` include list and `Exclude channels:` list that were applied (default exclude: `system`, `void`) |
| `filtered_out` | How many in-window messages the channel filter removed. On an incomplete read this counts only what was read |
| `window_complete` | `true`: the read reached the start of the window. `false`: the read stopped at `max_page_bytes` before reaching it — the transcript holds only the newest rows |
| `truncated` | `true` when the transcript is not the whole window, for either of the two reasons below |
| `truncated_out` | With `window_complete: true`: how many in-scope messages (after the filter) were left out because the window held more than `max_conversations` — the oldest are dropped, the newest kept. Mention both numbers in the run summary. With `window_complete: false`: `null` (unknown) |

Order of operations: window → policy channel filter → cap at
`max_conversations`. Excluded channels therefore never use up the cap.

When `window_complete` is `false`, say so in the run summary and relay the
situation to the owner: the remedies are to raise `max_page_bytes`, shorten the
lookback, or lower `max_conversations`.

## `patterns`

A summary of the target file so de-duplication starts from an index rather
than a full re-read:

| Field | Meaning |
|-------|---------|
| `patterns_file` | The policy's `Patterns file:` path (may not exist yet) |
| `exists` | Whether the file exists |
| `entry_count`, `max_number`, `next_number` | Entry count, highest number in use, and the number the next new entry must use |
| `reinforced_count` | Number of `**Reinforced (...)**` blocks in the file |
| `domains`, `types` | Distribution of the `[Domain: X | Type: Y]` tags over existing entries |
| `entries` | Index of every existing entry: `number`, `title`, `domain`, `type`, `reinforced` count. Screen candidates against titles and tags first; read in full only the entries that could match |

## Skip statuses

| `reason` | Meaning | What to do |
|----------|---------|------------|
| `disabled` | `enabled` is `false` in `config.json` | Commit a skip and stop |
| `unconfigured` | The policy still carries the `UNCONFIGURED` marker or has no `Patterns file:` line | Relay `owner_action` to the owner, commit a skip, stop |
| `below_threshold` | The window really held fewer than `min_conversations` in-scope messages | Commit a skip and stop — a quiet window is a normal outcome |
| `incomplete_read` | The part of the window that fit under `max_page_bytes` held too few messages; the rest is unread, so this is **not** a quiet window | Relay `owner_action` to the owner, commit a skip, stop |
