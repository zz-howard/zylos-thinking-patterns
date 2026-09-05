# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository skeleton (package metadata, development guides, changelog).
- `references/methodology.md`: the fixed extraction procedure (CDM-adapted), two-axis `[Domain | Type]` taxonomy, entry and Reinforced-block format, quality bar, and run-summary rules.
- `scripts/extract.js` CLI (`fetch`, `commit`, `inspect`, `status`, `template`). `fetch` reads a time window (`--lookback`, per scheduled task) via the comm-bridge CLI (`c4-db.js recent`), no cursor, no direct database access; `max_conversations` caps a run and flags truncation.
- `SKILL.md`: owner setup, background-subagent execution model, inner workflow, write boundary (append-only to the configured pattern file).
- Owner `policy.md` template (subject / sources / domains / confirmation mode / notification / guidance) with an `UNCONFIGURED` marker that makes runs skip until filled in; scheduler-task template printed by `extract.js template` with the three questions to ask the owner (interval, lookback, task name) — the owner sets the schedule, post-install registers nothing. Several tasks with different lookbacks may share one policy.
- Lifecycle hooks: post-install (data dir, defaults, template, owner-action message), pre-upgrade (backup config/policy/state), post-upgrade (schema merge).
- `node:test` suite covering fetch/commit/inspect/status/template and the lifecycle hooks with fake comm-bridge CLIs.
- Policy owns the target file: `## Target` → `Patterns file:` line in `policy.md` replaces `patterns_file` in `config.json` (post-upgrade moves an existing value across; runs skip as `unconfigured` until the line exists).
- Multiple subjects: `policy-<name>.md` selected with `--policy <name>` on every command; scheduler tasks for it are named `thinking-patterns-<name>[-<task>]`.
- Policy `## Sources` carries two machine-read lines, `Channels:` and `Exclude channels:` (default exclude `system, void`), applied by `fetch` as a coarse channel filter and echoed back as `filters` / `filtered_out`.
- `inspect` / `fetch` report the pattern file's Domain and Type distribution and an entry index (`patterns.entries`: number, title, tag, reinforcement count) so the agent screens candidates against the index before reading entries in full.
- `fetch` / `inspect` / `status` report `policy_placeholders`: policy sections that still contain the template's `(fill in` marker, for the agent to relay to the owner; the run itself proceeds.

### Fixed
- CLI output is written synchronously so a large transcript (a 7d window) is not truncated on a pipe.
- The printed scheduler registration command single-quotes the prompt: its backticks and double quotes are data, so registering a task no longer runs `fetch` in the shell or alters the prompt (review finding; covered by a fake-shell end-to-end test).
- Post-upgrade no longer drops `patterns_file` from config when `policy.md` is missing; the value stays until a policy exists and is migrated then.
- Policy lines are read only inside their own sections (`Patterns file:` under `## Target`, channel lines under `## Sources`), so owner prose elsewhere cannot be mistaken for configuration.
- The comm-bridge call uses a 64 MiB output buffer; a full 300-row page of long messages no longer fails with ENOBUFS.
- `truncated` is exact: fetch reads one row beyond `max_conversations` as a sentinel and reports truncation only when that row lies inside the window.
- README states that the pre-upgrade backup hook is not invoked by the current core upgrade pipeline; AGENTS.md / CLAUDE.md lifecycle tables say the same.
- Post-upgrade fills the template's `## Target` placeholder line in place (no duplicate section) and drops `patterns_file` from config only after reading the policy back and resolving the same target (review finding: legacy config + current template left the target unresolvable). The policy is replaced atomically (sibling temp file + rename) and config keeps its copy unless the rename succeeded, so an interrupted upgrade cannot leave a half-written owner policy.
