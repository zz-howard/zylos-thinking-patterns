# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-09-06

### Changed
- `patterns.lint.related_without_number` now reports only number-less `Related patterns` items that read as an entry reference — opening with a relation verb (`Connects to`, `See`, `Extends`, `Inverse of`, …) or naming an existing entry's title. Other number-less items are *concept items* (a principle with no entry, such as `Whitelist over blacklist`), which the methodology now allows explicitly; they are counted in `summary.related_concept_items` and not reported. Two shapes stay reported that a first cut let through (jinglever, review of c421ac1): an item that names *two* existing titles (reported with `located` null — ambiguity is not absence) and the explicit `Pattern (title)` form with a title that no longer exists. On a 166-entry file this turns 131 reported lines, 0 of them real, into the handful that actually name an entry without its number (#9).

## [0.2.1] - 2026-09-06

### Added
- `patterns.lint.reinforced_off_format`: every line that reads as a reinforcement header but is not the methodology's `**Reinforced (YYYY-MM-DD)**: ` at the line start — bulleted, `Day N` or another qualifier inside the parentheses, `**Reinforced**:` with the date in the text, or the labels `Reinforcing event` / `Reinforcement` — reported as `{number, line}`; `summary.reinforced_off_format` carries the count. Found while normalizing a 166-entry file: 50 such headers in four shapes, some written by the extraction workflow itself. Report only; nothing is changed (#7).
- `SKILL.md` hard requirement for the Reinforced header shape; `references/methodology.md` states that the header carries the date alone and the block is a paragraph, not a list item (#7).

## [0.2.0] - 2026-09-05

### Added
- `patterns.lint` in `inspect` / `fetch`: read-only drift report against the methodology — entries whose Type is outside the six fixed values, possible compound Domains, `Related patterns` lines with no entry number (with the entry located by title when the line names one), and `#N` references that resolve to no entry. Only `Issue #N` / `PR #N` / `MR #N` are read as tickets and skipped; wrapped list items are read as one item; `compound_domain` lists possible compound Domains — any Domain holding `/`, `,` or `&` — with the separator found, as a hint for the owner to check against their set (an owner-defined `&` name such as `Data & Metrics` is legal), not a confirmed violation. `summary` carries the counts. Nothing is changed in the file (#4).
- `SKILL.md`: hard requirements for writes — Type ∈ the six, single Domain, every Related line names `#N` from this entry toward the target — and the run summary ends with the lint counts (#4).
- `references/methodology.md`: relation-direction convention (written from the entry toward the target; conflicts may be recorded on both sides) and Reinforced blocks may record counter-cases; the run summary carries the lint counts (#4).

## [0.1.0] - 2026-09-05

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
- `test/release-consistency.test.js` (from the zylos component template): the four version faces — `package.json`, `package-lock.json`, `SKILL.md` frontmatter, latest released CHANGELOG heading — must agree, with negative controls for each stale face (#3).

### Changed
- Post-install and post-upgrade hooks write `config.json` / `state.json` only when the merged content differs from the file on disk (compared with sorted keys), so re-running a hook on an up-to-date data directory touches nothing; owner values still win over defaults (#2).
- Printed install paths (`SKILL.md`, `extract.js`, the scheduler CLI, and the default `c4_db_cli`) follow `ZYLOS_DIR` when it is set, and default to `~/zylos` as before. Where such a path is a shell argument (the registration line and the fetch command inside the prompt) it is single-quoted when it holds spaces or quotes, so the shell passes it as one argument; the bare `~/zylos` default keeps its home expansion. Covered by a test that runs both printed commands through bash against fake CLIs under plain, space and single-quote directories (#2).
- `SKILL.md` body no longer repeats the frontmatter triggers and points to `references/fetch-output.md` instead of carrying the full field reference inline; the unused `config.optional` environment-variable declaration is removed (the threshold is a `config.json` key, not an env override) (#2).
- `AGENTS.md` / `CLAUDE.md` replaced with the component-level conventions from the zylos component template (release hard gate, testing rules) plus component-specific rules; `SKILL_DIR` resolution uses `fileURLToPath(import.meta.url)` so the declared `node >=20.0.0` engine range is accurate; README gains the template badge row (without the OpenMax branding — this is a personal repository) and a `max_page_bytes` line in the configuration block; `package.json` author aligned with the LICENSE holder (Howard Zhou) (#2).

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add zz-howard/zylos-thinking-patterns
```

No migration required. `config.json`, `policy.md`, `state.json`, `logs/` and `backups/` are preserved across upgrades.
