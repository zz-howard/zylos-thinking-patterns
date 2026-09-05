---
name: thinking-patterns
version: 0.1.0
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

upgrade:
  repo: zz-howard/zylos-thinking-patterns
  branch: main

dependencies:
  - comm-bridge
  - scheduler
---

# Thinking Patterns

The component mines conversations for decision moments and distills the ones that generalize into numbered pattern entries. The methodology is fixed and ships with the component (`references/methodology.md`). What is extracted, from where, into which file, how candidates are confirmed, and **when and how far back each run looks** are the **owner's** decisions, all written in one policy file. The script fetches a time window, applies the policy's channel filter and keeps run state; it never writes patterns. Judgment belongs to the agent.

## Owner Setup (once, after install)

Installation creates the data directory with a policy **template**. Until the owner fills it in, every run is skipped with reason `unconfigured`.

1. Ask the owner, in plain language, the questions in `~/zylos/components/thinking-patterns/policy.md` (subject, target file, sources, domains, confirmation mode, notification endpoint, extra guidance). Write the answers into that file and delete the `UNCONFIGURED` marker line. Print a fresh template any time with:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template --policy
   ```
   Two lines of the policy are machine-read, each only inside its own section (the same words under any other heading are prose); everything else is prose for you:
   - `## Target` → `Patterns file: <path>` — the only file the workflow may write. Without this line every run skips as `unconfigured`. If the file already contains numbered entries in the methodology's format, extraction continues from its highest number.
   - `## Sources` → `Channels: all|<list>` and `Exclude channels: <list>|none` — a coarse filter on the C4 channel applied by `fetch` (default when the exclude line is absent: `system, void`). Which groups, topics or people count is written in prose and is your judgment.
2. Optionally adjust `min_conversations`, `max_conversations`, `max_page_bytes`, `default_lookback` in `~/zylos/components/thinking-patterns/config.json`. The target file is **not** in config.
3. Register the schedule — see the next section.

**A second subject** (another person, role or domain) is a second policy file `policy-<name>.md` in the same directory with its own target file; every `fetch`/`commit`/`inspect`/`template` call for it passes `--policy <name>`. There is no other new concept: one policy = one subject = one pattern file.

## Before Registering Any Scheduled Task — Ask the Owner

Every scheduled task carries its own run interval and lookback. **Whenever you set up a new task (the first one or an additional one), ask the owner these three things** and do not guess them:

1. **How often should it run?** A cron expression in the scheduler timezone. A nightly run after the working day is typical.
2. **How far back should each run look?** The lookback, e.g. `24h` or `7d`. Default suggestion: equal to the run interval. Shorter than the interval leaves gaps; longer overlaps previous runs, which is harmless because the methodology de-duplicates against the pattern file.
3. **A short task name** — only needed when this is not the first task (e.g. `daily`, `weekly`). Several tasks may run with different lookbacks (a daily 24h pass plus a weekly 7d pass that catches cross-day patterns); they share the one policy and pattern file. When more than one policy file exists, also ask **which policy** the task is for (`--policy <name>`; the task is then named `thinking-patterns-<policy>[-<task>]`).

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
2. Parse the JSON output. Every field is documented in `references/fetch-output.md` (read it when a field is unclear). What the workflow depends on:
   - `window.begin` / `window.end` and every transcript timestamp are in the owner's time zone with the UTC offset spelled out (`2026-09-05 19:20:14 +08:00`), so dates in a source-event line follow the owner's day, not UTC. Pass `window.end` back to `commit`.
   - `count` is the number of messages after the policy's channel filter; `filters` / `filtered_out` echo what the filter removed.
   - `truncated: true` with `window_complete: true`: the window held more in-scope messages than `max_conversations`; the oldest `truncated_out` were left out — mention both numbers in the run summary.
   - `window_complete: false`: the read stopped at `max_page_bytes` before reaching the start of the window; the transcript holds only the newest rows and `truncated_out` is `null` — say so in the summary and relay the situation to the owner (raise `max_page_bytes`, shorten the lookback or lower `max_conversations`).
   - `patterns`: `patterns_file`, `next_number`, `entry_count`, the `domains` / `types` distribution, and `entries` — the index of existing entries (`number`, `title`, `domain`, `type`, `reinforced`).
   - `policy_placeholders`: policy sections still holding the template's `(fill in` marker.
3. If `status` is `skip` (pass the same `--policy` if one was given) — `reason` is `disabled`, `unconfigured`, `below_threshold` (the window really held too few in-scope messages) or `incomplete_read` (the part of the window that fit under `max_page_bytes` held too few; the rest is unread, so this is not a quiet window — relay `owner_action` to the owner):
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result skip --task daily --lookback 24h --window-end "<window.end>"
   ```
   If `reason` is `unconfigured`, relay the `owner_action` text to the owner through the normal reply channel. Then stop. Do not edit any file.
   If `status` is `ready` but `policy_placeholders` is not empty, the run proceeds; treat those sections as unanswered (do not act on placeholder prose) and add one line to the run summary asking the owner to fill them in.
4. Read, in this order:
   - the owner's policy: `policy_file` from the fetch JSON;
   - the methodology: `methodology_file` from the fetch JSON;
   - the current pattern file: `patterns.patterns_file` from the fetch JSON (may not exist yet). `patterns.next_number` is the number for the next new entry. Use `patterns.entries` as the index: screen each candidate against titles and `[Domain | Type]` tags first, then read in full only the entries that could match, instead of re-reading the whole file every run.
5. Analyze `conversations` following the methodology: detect decision moments → extract cues and rationale → induce candidates → check each against the existing file (reinforce, flag contradiction, or new entry) → apply the quality bar. Extracting nothing is a normal outcome. Overlap with an earlier run is expected when the lookback exceeds the interval: an event already recorded or reinforced in the file is not recorded again.
   Hard requirements for anything you write (the methodology's format, machine-checked by `patterns.lint` on the next run):
   - `Type` is one of the six methodology values: Simplification, Abstraction, Constraint, Prioritization, Delegation, Temporal. No other Type, ever — pick the closest of the six.
   - `Domain` is a single value from the policy's set (or one new value, named in the run summary); never `A/B`.
   - Every `Related patterns` line names the target entry by number, `#N (title) — how it relates`, written from this entry toward the target.
6. Write according to the policy's **Confirmation** mode:
   - *record and notify*: append new entries and Reinforced blocks to the pattern file, then send the run summary to the policy's **Notification** endpoint.
   - *ask me first*: do not touch the pattern file. Send the candidates (title, tag, one-line principle, source event) to the notification endpoint and stop; the owner's approval arrives as a normal message, and whoever handles it appends the approved entries by hand.
   - *record silently*: append; send nothing.
   Whenever a run summary is sent, end it with one line from `patterns.lint.summary`, e.g. `lint: 31 Type outside the six, 6 compound Domain, 131/612 Related lines without #N, 0 dangling` — so drift in the file stays visible to the owner. The lint reports; it never edits the file, and neither does this workflow beyond appending.
7. Commit state (same `--task`, `--policy`, `--lookback`, `--window-end` as above):
   - pattern file changed: `commit --result updated ...`
   - nothing written (including the *ask me first* case): `commit --result no_change ...`

## Write Boundary

- The only file the workflow may modify is the policy's `Patterns file` (`patterns.patterns_file` in the fetch JSON), and only by **appending**: a new numbered entry uses exactly `patterns.next_number`; a repeat occurrence adds a `**Reinforced (<date>)**` block under the existing entry. Existing entries are never rewritten or renumbered; a contradiction is recorded as a Reinforced block that states the tension and is flagged in the summary.
- Never edit other memory files, identity files, or the policy.
- Pattern content goes only to the pattern file and the owner's notification endpoint from the policy. Never post it to any other channel, group, or document.
- Never record credentials, configuration paths, project status, or private message content beyond the quote needed to attribute a judgment.

## CLI

```bash
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js fetch [--lookback 24h] [--task name] [--policy name]   # time window → filtered transcript, or skip
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result skip|no_change|updated [--task name] [--policy name] [--lookback 24h] [--window-end "YYYY-MM-DD HH:MM:SS +HH:MM"]
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js inspect [--policy name]     # policy filters + pattern file: entry count, next number, Domain/Type distribution
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js status [--policy name]      # config + state + policy + patterns
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template [--policy | --policy name] [--lookback 24h] [--task name] [--cron "..."] [--json]
```

`template --policy` (no value) prints the policy template; `template --policy <name>` prints the scheduler template for that policy.

All C4 access goes through the comm-bridge CLI (`c4-db.js recent N`, which returns the newest N rows ordered by timestamp with their content); the script never opens `c4.db` directly.
