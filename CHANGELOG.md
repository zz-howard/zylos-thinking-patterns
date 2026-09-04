# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository skeleton (package metadata, development guides, changelog).
- `references/methodology.md`: the fixed extraction procedure (CDM-adapted), two-axis `[Domain | Type]` taxonomy, entry and Reinforced-block format, quality bar, and run-summary rules.
- `scripts/extract.js` CLI (`fetch`, `commit`, `inspect`, `status`, `template`) with cursor, threshold, first-run cap and forward-only state; all C4 access via the comm-bridge CLI (`c4-db.js recent`, `c4-fetch.js`), no direct database access.
- `SKILL.md`: owner setup, background-subagent execution model, inner workflow, write boundary (append-only to the configured pattern file).
- Owner `policy.md` template (subject / sources / domains / confirmation mode / notification / guidance) with an `UNCONFIGURED` marker that makes runs skip until filled in; scheduler-task template printed by `extract.js template` — the owner sets the schedule, post-install registers nothing.
- Lifecycle hooks: post-install (data dir, defaults, template, owner-action message), pre-upgrade (backup config/policy/state), post-upgrade (schema merge).
- `node:test` suite covering fetch/commit/inspect/status/template and the post-install hook with fake comm-bridge CLIs.
