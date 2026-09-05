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
- [Errors](#errors)

## Top level

| Field | Meaning |
|-------|---------|
| `status` | `ready` (analyze), `skip` (commit a skip and stop) or `error` (see [Errors](#errors)) |
| `reason` | Present when `status` is `skip` — see [Skip statuses](#skip-statuses) |
| `owner_action` | Present on some skips: text to relay to the owner verbatim |
| `task` | The task name the run was called with (`default` when none was given) |
| `policy` | The policy name (`default` for `policy.md`, otherwise the `<name>` of `policy-<name>.md`) |
| `policy_file` | Path of the policy that was read |
| `policy_unconfigured` | `true` while the policy still carries the `UNCONFIGURED` marker (or does not exist) |
| `policy_placeholders` | Policy sections that still contain the template's `(fill in` marker; the run proceeds, but treat those sections as unanswered and add one line to the run summary asking the owner to fill them in |
| `methodology_file` | Path of the shipped methodology to read next |
| `state_file` | Path of the component's `state.json` (informational) |
| `min_conversations`, `max_conversations`, `max_page_bytes` | The config values the run used |
| `count` | Number of messages in the transcript (after the channel filter and the cap); `0` on a skip that happened before reading |

## `window`

`begin` / `end` are the time range that was fetched, rendered in the owner's
time zone (`time_zone`, the `TZ` from the zylos `.env`) with the UTC offset
spelled out, e.g. `2026-09-05 19:20:14 +08:00`; `lookback` echoes the lookback
text the window was built from (e.g. `24h`). Every message timestamp in
`conversations` uses the same form, so dates in a source-event line follow the
owner's day, not UTC. Pass `window.end` back to `commit --window-end`.

## `conversations`

A single **string** (present only when `status` is `ready`): the transcript
of the messages inside the window, oldest first, after the policy's channel
filter and the cap. It starts with a header line and then, per message, a
one-line stamp followed by the content and a blank line:

```
[Conversations] (window <begin> ~ <end>, time zone <tz>, lookback <lookback>, <count> messages)
[2026-09-05 19:20:14 +08:00] IN (telegram:8101553026):
<message content>

[2026-09-05 19:21:02 +08:00] OUT (telegram:8101553026):
<message content>
```

The stamp carries the timestamp (owner's zone), the direction (`IN` = received
by the agent, `OUT` = sent by the agent) and `channel:endpoint` from C4. It is
text for you to read, not JSON to parse.

## Filtering, capping and truncation

| Field | Meaning |
|-------|---------|
| `filters` | `{ channels, exclude_channels }` — the `Channels:` include list (`null` = all) and the `Exclude channels:` list that were applied (default exclude: `system`, `void`) |
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
| `patterns_file` | The policy's `Patterns file:` path (`null` when the policy has no such line; the file itself may not exist yet) |
| `exists` | Whether the file exists |
| `entry_count`, `max_number`, `next_number` | Entry count, highest number in use, and the number the next new entry must use |
| `reinforced_count` | Number of `**Reinforced (...)**` blocks in the file |
| `domains`, `types` | Distribution of the `[Domain: X | Type: Y]` tags over existing entries |
| `entries` | Index of every existing entry: `number`, `title`, `domain`, `type`, `reinforced` count. Screen candidates against titles and tags first; read in full only the entries that could match |
| `lint` | Read-only drift report against the methodology (nothing is changed): `type_off_vocabulary` (`{number, type}` for every entry whose Type is not one of the six), `compound_domain` (`{number, domain}` where the Domain holds `/` — `Data & Metrics` is one Domain), `related_without_number` (`{number, text, located}` for every `Related patterns` line with no `#N` — `located` is the entry whose full title the line contains, else the single entry whose title prefix before its dash it contains, else `null`; anything ambiguous is `null`), `related_dangling` (`{number, ref}` for every `#N` that resolves to no entry — a bare ticket number counts, and the owner rewrites that line). Only `Issue #N` / `PR #N` / `MR #N` are recognised as tickets and ignored. A list item that wraps onto the next line is read as one item; a bold label, `---` or a heading ends the list. `summary` carries the counts (`type_off_vocabulary`, `compound_domain`, `related_lines`, `related_without_number`, `related_located`, `related_dangling`); quote it in the run summary |

## Skip statuses

| `reason` | Meaning | What to do |
|----------|---------|------------|
| `disabled` | `enabled` is `false` in `config.json` | Commit a skip and stop |
| `unconfigured` | The policy still carries the `UNCONFIGURED` marker or has no `Patterns file:` line | Relay `owner_action` to the owner, commit a skip, stop |
| `below_threshold` | The window really held fewer than `min_conversations` in-scope messages | Commit a skip and stop — a quiet window is a normal outcome |
| `incomplete_read` | The part of the window that fit under `max_page_bytes` held too few messages; the rest is unread, so this is **not** a quiet window | Relay `owner_action` to the owner, commit a skip, stop |

## Errors

Every command, on a bad argument, an unusable `c4_db_cli`, a comm-bridge call that fails, or any other exception, prints `{ "status": "error", "error": "<message>" }` and exits 1. Nothing else is in that envelope. An unknown command prints the usage line as the `error` text, also with exit 1. Do not commit a skip for an error: report it in the run summary and stop.
