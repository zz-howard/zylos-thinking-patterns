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
- Lifecycle hooks: post-install (data dir, defaults, template, owner-action message), pre-upgrade (backup config/policy/state), post-upgrade (merge new config defaults, normalize state).
- `node:test` suite covering fetch/commit/inspect/status/template and the lifecycle hooks with fake comm-bridge CLIs.
- Policy owns the target file: `## Target` → `Patterns file:` line in `policy.md` replaces `patterns_file` in `config.json`; runs skip as `unconfigured` until the line exists.
- Multiple subjects: `policy-<name>.md` selected with `--policy <name>` on every command; scheduler tasks for it are named `thinking-patterns-<name>[-<task>]`.
- Policy `## Sources` carries two machine-read lines, `Channels:` and `Exclude channels:` (default exclude `system, void`), applied by `fetch` as a coarse channel filter and echoed back as `filters` / `filtered_out`.
- `inspect` / `fetch` report the pattern file's Domain and Type distribution and an entry index (`patterns.entries`: number, title, tag, reinforcement count) so the agent screens candidates against the index before reading entries in full.
- Times the agent reads are in the owner's zone with an explicit offset: `fetch` renders `window.begin` / `window.end` and every transcript timestamp as `YYYY-MM-DD HH:MM:SS +HH:MM` in `TZ` (echoed as `window.time_zone`); C4's zone-less UTC strings are only parsed, never shown. Selection is unchanged (epoch comparison), covered by a multi-zone test.
- `min_conversations` defaults to 4 (about two exchanges) instead of 30: a skip triggers no catch-up read (later runs take their own windows, so messages outside every later window are never read), and the methodology already treats an empty extraction as a normal outcome, so a high threshold only lost quiet days (decided by Howard in review).
- `fetch` / `inspect` / `status` report `policy_placeholders`: policy sections that still contain the template's `(fill in` marker, for the agent to relay to the owner; the run itself proceeds.

### Fixed
- CLI output is written synchronously so a large transcript (a 7d window) is not truncated on a pipe.
- The printed scheduler registration command single-quotes the prompt: its backticks and double quotes are data, so registering a task no longer runs `fetch` in the shell or alters the prompt (review finding; covered by a fake-shell end-to-end test).
- Policy lines are read only inside their own sections (`Patterns file:` under `## Target`, channel lines under `## Sources`), so owner prose elsewhere cannot be mistaken for configuration.
- The comm-bridge call no longer goes through a pipe buffer: `c4-db.js recent N` writes to a private temp file (0600, removed on every path) that is measured before it is parsed. A page over `max_page_bytes` (new config key, default 64 MiB) is discarded unread and fetch works from the previous page, reporting `window_complete: false`, `truncated: true`, `truncated_out: null`; too few messages on such a read skip as `incomplete_read` with an `owner_action`, not as `below_threshold`. This bounds what this process parses; the comm-bridge CLI still materializes the page in its own memory and on temp disk (review finding on the paging change; a time-range primitive on the C4 side is the real fix).
- `max_conversations` is applied last — window, then the policy's channel filter, then the cap — so excluded channels never use up the cap and, on a complete read, `truncated` means the window holds more in-scope messages than the cap (`truncated_out` says how many were left out; the newest are kept). On an incomplete read (`window_complete: false`, below) `truncated` is also true and `truncated_out` is null. Because `c4-db.js recent N` has no time-range parameter, fetch asks for one row beyond the cap and doubles the page until the oldest row predates the window.
- README states that the pre-upgrade backup hook is not invoked by the current core upgrade pipeline; AGENTS.md / CLAUDE.md lifecycle tables say the same.
