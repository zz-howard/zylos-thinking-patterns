---
name: thinking-patterns
version: 0.0.0
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

config:
  optional:
    - name: THINKING_PATTERNS_MIN_CONVERSATIONS
      description: Minimum unprocessed C4 conversations before an extraction run analyzes anything. Stored in component config.json as min_conversations.
      default: "30"

dependencies:
  - comm-bridge
  - scheduler
---

# Thinking Patterns

Use this skill when a scheduled `thinking-patterns` task arrives, when the owner explicitly asks to run thinking-pattern extraction, or when the owner wants to set up or change the extraction policy.

The component mines conversations for decision moments and distills the ones that generalize into numbered pattern entries. The methodology is fixed and ships with the component (`references/methodology.md`). What is extracted, from where, into which file, and how candidates are confirmed is the **owner's** decision, written in `policy.md`. The script keeps the cursor and state; it never writes patterns. Judgment belongs to the agent.

## Owner Setup (once, after install)

Installation creates the data directory with a policy **template**. Until the owner fills it in, every run is skipped with reason `unconfigured`.

1. Ask the owner, in plain language, the questions in `~/zylos/components/thinking-patterns/policy.md` (subject, sources, domains, confirmation mode, notification endpoint, extra guidance). Write the answers into that file and delete the `UNCONFIGURED` marker line. Print a fresh template any time with:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template --policy
   ```
2. Set `patterns_file` (and optionally `min_conversations`) in `~/zylos/components/thinking-patterns/config.json`. If the target file already contains numbered entries in the methodology's format, extraction continues from its highest number.
3. Ask the owner when it should run. Register the scheduler task from the template (the owner picks the cron expression; the prompt must be used verbatim):
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template
   ```
4. Optional: to avoid mining old history on the first run, set `last_processed_id` in `state.json` to the current latest C4 conversation id.

## Execution Model

Extraction must run in a background subagent. The main session must not do the conversation analysis inline.

Outer layer, in the main session:
1. Launch a background subagent.
   - Claude runtime: use the Task tool with `run_in_background: true`.
   - Codex runtime: use the available background agent mechanism such as `spawn_agent`.
2. Give the subagent the Inner Subagent Workflow below.
3. Wait for the subagent result only when you are ready to mark the scheduled task done.
4. Run the scheduler `done` command from the scheduled task after the subagent completes.
5. If the subagent reports failure, investigate enough to avoid losing state; do not mark success silently.

## Inner Subagent Workflow

1. Run:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js fetch
   ```
2. Parse the JSON output.
3. If `status` is `skip`:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result skip --observed-end-id <end_id>
   ```
   If `reason` is `unconfigured`, relay the `owner_action` text to the owner through the normal reply channel. Then stop. Do not edit any file.
4. Read, in this order:
   - the owner's policy: `policy_file` from the fetch JSON;
   - the methodology: `methodology_file` from the fetch JSON;
   - the current pattern file: `patterns.patterns_file` from the fetch JSON (may not exist yet). `patterns.next_number` is the number for the next new entry.
5. Analyze `conversations` following the methodology: detect decision moments → extract cues and rationale → induce candidates → check each against the existing file (reinforce, flag contradiction, or new entry) → apply the quality bar. Extracting nothing is a normal outcome.
6. Write according to the policy's **Confirmation** mode:
   - *record and notify*: append new entries and Reinforced blocks to the pattern file, then send the run summary to the policy's **Notification** endpoint.
   - *ask me first*: do not touch the pattern file. Send the candidates (title, tag, one-line principle, source event) to the notification endpoint and stop; the owner's approval arrives as a normal message, and whoever handles it appends the approved entries by hand.
   - *record silently*: append; send nothing.
7. Commit state:
   - pattern file changed:
     ```bash
     node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result updated --end-id <end_id>
     ```
   - nothing written (including the *ask me first* case):
     ```bash
     node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result no_change --end-id <end_id>
     ```

## Write Boundary

- The only file the workflow may modify is the configured `patterns_file`, and only by **appending**: a new numbered entry uses exactly `patterns.next_number`; a repeat occurrence adds a `**Reinforced (<date>)**` block under the existing entry. Existing entries are never rewritten or renumbered; a contradiction is recorded as a Reinforced block that states the tension and is flagged in the summary.
- Never edit other memory files, identity files, or the policy.
- Pattern content goes only to the pattern file and the owner's notification endpoint from the policy. Never post it to any other channel, group, or document.
- Never record credentials, configuration paths, project status, or private message content beyond the quote needed to attribute a judgment.

## CLI

```bash
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js fetch                 # cursor + threshold check; ready → transcript
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result skip --observed-end-id <N>
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result no_change|updated --end-id <N>
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js inspect               # entry count, max/next number
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js status                # config + state + policy + patterns
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template [--policy] [--json]
```

All C4 access goes through the comm-bridge CLI (`c4-db.js recent`, `c4-fetch.js --begin/--end`); the script never opens `c4.db` directly.
