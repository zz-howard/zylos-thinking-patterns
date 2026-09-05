# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `references/methodology.md`: the fixed extraction procedure (CDM-adapted), two-axis `[Domain | Type]` taxonomy, entry and Reinforced-block format, quality bar, and run-summary rules (#1).
- `scripts/extract.js` CLI (`fetch`, `commit`, `inspect`, `status`, `template`). `fetch` reads a time window (`--lookback`, per scheduled task) through the comm-bridge CLI (`c4-db.js recent N`) — no cursor, no direct database access. The page grows until the window is covered; `max_page_bytes` (default 64 MiB) bounds what this process parses from one call, and an incomplete read is reported (`window_complete: false`, `truncated: true`, `truncated_out: null`) rather than hidden. `max_conversations` is applied after the window and the policy's channel filter, so excluded channels never use up the cap (#1).
- `SKILL.md`: owner setup, background-subagent execution model, inner workflow, write boundary (append-only to the configured pattern file) (#1).
- Owner `policy.md` with an `UNCONFIGURED` marker that makes runs skip until it is filled in. The policy owns the target file (`## Target` → `Patterns file:`) and the coarse channel filter (`## Sources` → `Channels:` / `Exclude channels:`, default exclude `system, void`); those lines are read only inside their own sections, so owner prose elsewhere is never mistaken for configuration (#1).
- Scheduler-task template printed by `extract.js template` with the three questions to ask the owner (interval, lookback, task name); the printed command single-quotes the prompt so its backticks and quotes reach the scheduler verbatim. Post-install registers nothing — the owner sets the schedule. Several tasks with different lookbacks may share one policy (#1).
- Multiple subjects: `policy-<name>.md` selected with `--policy <name>` on every command; scheduler tasks for it are named `thinking-patterns-<name>[-<task>]` (#1).
- `inspect` / `fetch` report the pattern file's Domain and Type distribution and an entry index (`patterns.entries`: number, title, tag, reinforcement count) so the agent screens candidates against the index before reading entries in full; `policy_placeholders` lists policy sections still holding the template's `(fill in` marker (#1).
- Times the agent reads are rendered in the owner's zone with an explicit offset (`YYYY-MM-DD HH:MM:SS +HH:MM`, `TZ` from `.env`, echoed as `window.time_zone`); selection compares instants and is covered by a multi-zone test (#1).
- `min_conversations` defaults to 4 (about two exchanges): a skip triggers no catch-up read — later runs take their own windows, so messages outside every later window are never read — and the methodology treats an empty extraction as a normal outcome, so a high threshold only lost quiet days (decided by Howard in review) (#1).
- Lifecycle hooks: post-install (data dir, defaults, policy template, owner-action message), pre-upgrade (backup config/policy/state; not invoked by the current zylos-core upgrade pipeline, documented as such), post-upgrade (merge new config defaults, normalize state) (#1).
- `node:test` suite covering fetch/commit/inspect/status/template and the lifecycle hooks with fake comm-bridge and scheduler CLIs; CLI output is written synchronously so a large transcript is not truncated on a pipe (#1).
- `docs/DESIGN.md` (architecture, data flow, design decisions) and `references/fetch-output.md` (field-by-field reference for the `fetch` JSON); `references/methodology.md` gains a table of contents (#2).

### Changed
- Post-install and post-upgrade hooks write `config.json` / `state.json` only when the merged content differs from the file on disk (compared with sorted keys), so re-running a hook on an up-to-date data directory touches nothing; owner values still win over defaults (#2).
- Printed install paths (`SKILL.md`, `extract.js`, the scheduler CLI, and the default `c4_db_cli`) follow `ZYLOS_DIR` when it is set, and default to `~/zylos` as before (#2).
- `SKILL.md` body no longer repeats the frontmatter triggers and points to `references/fetch-output.md` instead of carrying the full field reference inline; the unused `config.optional` environment-variable declaration is removed (the threshold is a `config.json` key, not an env override) (#2).
- `AGENTS.md` / `CLAUDE.md` replaced with the component-level conventions from the zylos component template (release hard gate, testing rules) plus component-specific rules; `SKILL_DIR` resolution uses `fileURLToPath(import.meta.url)` so the declared `node >=20.0.0` engine range is accurate; README gains the template badge row (without the OpenMax branding — this is a personal repository) and a `max_page_bytes` line in the configuration block; `package.json` author aligned with the LICENSE holder (Howard Zhou) (#2).

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add zz-howard/zylos-thinking-patterns
```

No migration required. `config.json`, `policy.md`, `state.json`, `logs/` and `backups/` are preserved across upgrades.
