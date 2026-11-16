---
name: thinking-patterns
version: 0.3.0
description: Extract reusable decision heuristics (thinking patterns) from a Zylos agent's C4 conversations on a schedule the owner sets. Use when a scheduled `thinking-patterns` task arrives, when the owner asks to run thinking-pattern extraction, or when the owner asks to configure whose or what decision patterns this agent should extract (the extraction policy) and when it runs.
type: utility

lifecycle:
  npm: true
  data_dir: ~/zylos/components/thinking-patterns
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - policy.md
    - state.json
    - logs/
    - backups/
    - materials/

upgrade:
  repo: zz-howard/zylos-thinking-patterns
  branch: main

dependencies:
  - comm-bridge
  - scheduler
---

# Thinking Patterns

The component finds decision moments in digested memory and inbound messages, then fetches their original C4 context. The methodology and pattern format remain in `references/methodology.md`. The owner controls the policy, destination, confirmation and notifications. Scripts collect materials and keep progress; the background agent judges and appends patterns.

## Core History Compatibility

Checkpoint collection uses only the public comm-bridge CLIs. Each group is
limited to its latest Memory Sync checkpoint. New groups start with the last
day; unsynced tails wait. Missing checkpoint support, missing group metadata,
or checkpoint query failures produce explicit `legacy_time_window` output
with `fallback_reason`. Only this fallback uses `--lookback` and the legacy
conversation thresholds/cap. Report fallback and truncation to the owner.

## Owner Setup (once, after install)

Installation creates the data directory with a policy **template**. Until the owner fills it in, every run is skipped with reason `unconfigured`.

1. Ask the owner, in plain language, the questions in `~/zylos/components/thinking-patterns/policy.md` (subject, target file, sources, domains, confirmation mode, notification endpoint, extra guidance). Write the answers into that file and delete the `UNCONFIGURED` marker line. Print a fresh template any time with:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template --policy
   ```
   Two lines of the policy are machine-read, each only inside its own section (the same words under any other heading are prose); everything else is prose for you:
   - `## Target` → `Patterns file: <path>` — the only file the workflow may write. Without this line every run skips as `unconfigured`. If the file already contains numbered entries in the methodology's format, extraction continues from its highest number.
   - `## Sources` → `Channels: all|<list>` and `Exclude channels: <list>|none` filter C4 channels. The default excludes `internal, system, void, multica`. Inbound collection also excludes stored content starting with `[Scheduled Task:` in checkpoint and legacy modes, leaving trace context unchanged. Scripts never filter senders or classify words.
2. Optionally adjust `trace_max_clues` (15), `trace_context` (10 messages each side), `trace_max_bytes` (512000), `artifact_retention_days` (7), and `max_page_bytes` (64 MiB). `min_conversations`, `max_conversations` and `default_lookback` apply only to fallback. The target file remains in policy.
3. Register the schedule — see the next section.

**A second subject** (another person, role or domain) is a second policy file `policy-<name>.md` in the same directory with its own target file; every `fetch`/`commit`/`inspect`/`template` call for it passes `--policy <name>`. There is no other new concept: one policy = one subject = one pattern file.

## Before Registering Any Scheduled Task — Ask the Owner

Every scheduled task carries its own run interval and lookback. **Whenever you set up a new task (the first one or an additional one), ask the owner these three things** and do not guess them:

1. **How often should it run?** A cron expression in the scheduler timezone. A nightly run after the working day is typical.
2. **Fallback lookback?** `24h` is typical; it only applies when Core cannot provide checkpoint material. Normal runs follow each group's digested progress.
3. **A short task name** for additional tasks (e.g. `daily`, `weekly`) and the policy when multiple exist. Progress is independent per policy/task; tasks share the pattern file's de-duplication rules.

Then print the registration command with the owner's values and run it exactly as printed — the prompt is single-quoted so its backticks and quotes reach the scheduler verbatim; do not re-wrap it in double quotes:

```bash
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template --lookback 24h --task daily --cron "50 23 * * *"
```

## Execution Model

Extraction must run in a background subagent. The main session must not do the conversation analysis inline.

Outer layer, in the main session:
1. Launch a background subagent.
   - Claude runtime: use the Task tool with `run_in_background: true`.
   - Codex runtime: use the available background agent mechanism such as `spawn_agent`.
2. Give the subagent the Inner Subagent Workflow below, including the task name and lookback from the scheduled task's prompt.
3. Wait for the subagent result only when you are ready to mark the scheduled task done.
4. Run the scheduler `done` command from the scheduled task after the subagent completes.
5. If the subagent reports failure, investigate enough to avoid losing state; do not mark success silently.

## Inner Subagent Workflow

1. Run, with the lookback, task name and (if given) policy from the scheduled task's prompt (omit them to use `default_lookback`, task `default`, policy `policy.md`):
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js fetch --lookback 24h --task daily [--policy <name>]
   ```
2. Parse the output (contract in `references/fetch-output.md`). In checkpoint mode, retain `run_id` and `ranges`. Read all `session_files`, use `reference_files` as paths to read when relevant, and read the complete `inbound` net. The dates use `time_zone` (owner's `TZ`). Treat dates in C4's zone-less timestamps as UTC when attributing sources. `completed_groups` lists ranges already committed in a partial run; do not process those again. Inspect `patterns.entries` first to locate possible existing patterns.
3. On `status: skip`, relay `owner_action` if provided, record a skip and stop. `no_checkpoint_progress` advances nothing. Errors advance nothing and must be reported. Use the same task/policy on every command:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result skip --task daily --lookback 24h --window-end "<window.end>"
   ```
   If `reason` is `unconfigured`, relay the `owner_action` text to the owner through the normal reply channel. Then stop. Do not edit any file.
   If `status` is `ready` but `policy_placeholders` is not empty, the run proceeds; treat those sections as unanswered (do not act on placeholder prose) and add one line to the run summary asking the owner to fill them in.
4. Read, in this order:
   - the owner's policy: `policy_file` from the fetch JSON;
   - the methodology: `methodology_file` from the fetch JSON;
   - the current pattern file: `patterns.patterns_file` from the fetch JSON (may not exist yet). `patterns.next_number` is the number for the next new entry. Use `patterns.entries` as the index: screen each candidate against titles and `[Domain | Type]` tags first, then read in full only the entries that could match, instead of re-reading the whole file every run.
5. Read memory first to find clues, then read the entire inbound net to catch omissions. Select both decisions and corrections by meaning, never a keyword list. Write a JSON array to a local clue file: `[{"session_group":"telegram:example","c4_id":123,"kind":"decision"},{"session_group":"telegram:example","c4_id":124,"kind":"correction"}]`. Do not include secrets. Run:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js trace --run <run_id> --clues <file.json> --task daily [--policy <name>]
   ```
   Even an empty list requires `trace` to record completed clue selection. Read the traces, which include replies and only same-group context. Deferred clues are saved independently in state and processed first in the next run, together with newly collected checkpoint ranges. Limits apply cumulatively to the whole run; do not call trace repeatedly to bypass them. After processing the returned traces, commit the selected ranges even when clues were deferred. Artifacts under `materials/` are shared with identity-reflection; see `references/materials.md`.

   Apply the unchanged methodology to decisions after reading their original context: extract cues and rationale, induce candidates, compare with existing entries, apply the quality bar. Source attributions must include session group and C4 message ID so they can be verified. In fallback mode use `conversations`, skip `trace`, and report fallback reason, count, bytes and any truncation. An event already recorded in the pattern file is never recorded again.
   Hard requirements for anything you write (the methodology's format, machine-checked by `patterns.lint` on the next run):
   - `Type` is one of the six methodology values: Simplification, Abstraction, Constraint, Prioritization, Delegation, Temporal. No other Type, ever — pick the closest of the six.
   - `Domain` is a single value from the policy's set (or one new value, named in the run summary); never combined as `A/B`, `A, B` or `A & B`. The lint reports every Domain holding `/`, `,` or `&` with the separator found; a set may legitimately contain an `&` name (the methodology's `Data & Metrics`), which the owner recognises from the report.
   - A `Related patterns` item is either an entry reference — `#N (title) — how it relates`, written from this entry toward the target, number required — or a concept item (a principle or idea that has no entry, e.g. `Whitelist over blacklist`). Never refer to an entry by title alone: the lint reports every number-less item that reads as a reference (opens with `Connects to` / `See` / `Extends` / `Inverse of` …, uses the explicit `Pattern (title)` form, or names an existing entry's title — one or several; naming two titles still reports, it just locates nothing).
   - A Reinforced block is a paragraph starting at the line start as `**Reinforced (YYYY-MM-DD)**: ` — the date alone inside the parentheses (no `Day N`, no time or place qualifier: those go into the text), never a list bullet, never another label such as `Reinforcing event` or `Reinforcement`. The lint reports every header that reads as a reinforcement but is not this shape.
6. Write according to the policy's **Confirmation** mode:
   - *record and notify*: prepare a full replacement containing only appended new entries and Reinforced blocks, publish through the command below, then send the run summary to the policy's **Notification** endpoint.
   - *ask me first*: do not touch the pattern file. Send the candidates (title, tag, one-line principle, source event) to the notification endpoint and stop; the owner's approval arrives as a normal message, and whoever handles it publishes the approved draft through the write command below.
   - *record silently*: publish through the same write command; send nothing.
   Read the entire current pattern file and hash its raw bytes (SHA256 of empty
   bytes if absent). Prepare a separate draft; never edit the destination directly:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js write --file <draft> --sha256 <hash> --run <run_id> --task daily [--policy <name>]
   ```
   Omit `--run` only in legacy fallback mode. Existing files under memory use
   Core's locked replacement writer, not append mode. Missing targets, targets
   outside memory, or a missing writer use direct writing and report respectively
   `file_missing`, `outside_memory`, or `writer_unavailable`. Include mode/reason
   in the summary. On `SYNC_BUSY`/`LOCK_TIMEOUT`, leave the file and progress
   unchanged and retry next run; do not commit these ranges. On `MEMORY_CONFLICT`,
   reread the full file, merge the draft again and retry with the new raw hash.
   Other writer errors also defer; never bypass a writer rejection with direct
   writing. Failed/interrupted writes block non-skip commits in the initiating
   run until a successful write. `skip` clears that run's guard and advances no
   ranges. Fetch resumes an active run with its guard intact; after skip, a new
   fetch starts a fresh run and clears any abandoned guard. A fresh run may
   legitimately conclude `no_change`, including the *ask me first* case.
   Whenever a run summary is sent, end it with one line from `patterns.lint.summary`, e.g. `lint: 31 Type outside the six, 6 possible compound Domain (owner check), 7 Related references without #N (124 concept items), 0 dangling, 0 Reinforced headers off format` — so drift in the file stays visible to the owner. The lint reports; it never edits the file, and neither does this workflow beyond appending.
7. Commit only fully processed ranges. Checkpoint mode requires `--run <run_id>` and optionally `--groups <comma-separated-groups>`; without `--groups`, all remaining ranges are completed. `skip` never advances progress. Fallback commits retain `--lookback` and `--window-end`. Use the same task/policy:
   - pattern file changed: `commit --result updated ...`
   - nothing written (including the *ask me first* case): `commit --result no_change ...`
   Include material session/reference counts and bytes, inbound count/characters/bytes, trace count/characters/bytes, and deferred clue count in the run summary alongside the existing lint line.

## Write Boundary

- The only file the workflow may modify is the policy's `Patterns file` (`patterns.patterns_file` in the fetch JSON), and only by **appending**: a new numbered entry uses exactly `patterns.next_number`; a repeat occurrence adds a `**Reinforced (<date>)**` block under the existing entry. Existing entries are never rewritten or renumbered; a contradiction is recorded as a Reinforced block that states the tension and is flagged in the summary.
- Never edit other memory files, identity files, or the policy.
- Pattern content goes only to the pattern file and the owner's notification endpoint from the policy. Never post it to any other channel, group, or document.
- Never record credentials, configuration paths, project status, or private message content beyond the quote needed to attribute a judgment.

## CLI

```bash
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js fetch [--lookback 24h] [--task name] [--policy name]
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js trace --run UUID [--clues file.json] [--task name] [--policy name]
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js write --file draft.md --sha256 HASH [--run UUID] [--task name] [--policy name]
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result skip|no_change|updated [--run UUID] [--groups G,H] [--task name] [--policy name] [--lookback 24h] [--window-end "YYYY-MM-DD HH:MM:SS +HH:MM"]
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js inspect [--policy name]     # policy filters + pattern file: entry count, next number, Domain/Type distribution
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js status [--policy name]      # config + state + policy + patterns
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template [--policy | --policy name] [--lookback 24h] [--task name] [--cron "..."] [--json]
```

`template --policy` (no value) prints the policy template; `template --policy <name>` prints the scheduler template for that policy.

All C4 access uses public comm-bridge CLIs: `c4-db.js groups`, `c4-fetch.js --checkpoints`, `--since` for new groups, and `--begin/--end` for processed group ranges and traces. Only fallback uses `c4-db.js recent N`. The script never opens `c4.db`.
