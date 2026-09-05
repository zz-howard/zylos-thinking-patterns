# AGENTS.md — zylos-thinking-patterns engineering conventions

This file binds every agent (Claude, Codex, or any other) that develops,
reviews, or releases in this repository. CLAUDE.md points here. Extend it
with component-specific rules as the project grows, but do not remove the
Release Process section below.

## Project Conventions

- **ESM only** — `import`/`export`, never `require()`. `"type": "module"` in package.json
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **All config in `~/zylos/components/thinking-patterns/config.json`** — never committed; code is disposable, data is permanent
- **English for code** — Comments, commit messages, PR descriptions, documentation

## Release Process (hard gate)

Version bumps happen **only in a dedicated release PR** — feature PRs carry
source + tests + CHANGELOG entries under `## [Unreleased]`, never a version
change. The release PR must update **all four files in the same commit**:

1. **`package.json`** — Bump `version`
2. **`package-lock.json`** — Run `npm install` after bumping package.json to sync the lock file
3. **`SKILL.md`** — Update `version` in the YAML frontmatter to match. zylos-core registers the installed version from this field and uses it to decide upgrades; a stale value causes repeated upgrade prompts
4. **`CHANGELOG.md`** — Convert the `## [Unreleased]` section into a `## [X.Y.Z] - YYYY-MM-DD` entry ([Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format)

Version bump commit message: `chore: bump version to X.Y.Z`

After merge, create a GitHub Release with tag `vX.Y.Z` from the merge commit.

Machine gate vs process gate: `test/release-consistency.test.js` enforces the
**final-tree** half of this rule only — the suite fails whenever the four
version faces disagree in the working tree. The dedicated-release-PR and
same-commit requirements are process gates, guaranteed by the release flow
and review, not provable by this test. Keep the test passing and keep its
negative controls intact — a gate that cannot fail proves nothing.

## Testing

- `npm test` runs `node --test` over `test/*.test.js`; `npm run check` syntax-checks scripts and hooks
- The release-consistency gate (above) ships with the component and must stay
- When a test guards specific logic, prove it can fail: temporarily break the
  guarded behavior (a known-bad mutant), confirm the test goes red, restore
  the behavior, and keep the test
- Tests fake the comm-bridge and scheduler CLIs and point the component at a
  temporary data directory (`ZYLOS_DATA_DIR`); they never read the real C4
  database or the real `~/zylos`

## Component-Specific Rules

- **Owner's files are never rewritten by code.** `policy.md` is owner prose;
  the target pattern file is named by the policy's `Patterns file:` line and is
  only ever appended to by the extraction subagent, never by a script or hook.
- **Hooks are idempotent by construction.** `post-install` / `post-upgrade`
  merge new defaults into `config.json` and normalize `state.json`, writing
  only when the merged content differs from what is on disk. `pre-upgrade`
  snapshots config/policy/state into `backups/<timestamp>/` — note that the
  current zylos-core upgrade pipeline does not invoke component pre-upgrade
  hooks (core takes its own backup); document this rather than relying on it.
- **No scheduler task is registered at install time.** The owner decides when
  extraction runs; `extract.js template` prints the questions and the exact
  registration command.
- **The methodology is versioned with the component.** Changes to
  `references/methodology.md` change what every future run writes; historical
  entries are never rewritten to match. Call such changes out in the CHANGELOG.
- **Time, not ids.** Runs are defined by `now − lookback`; the only C4 primitive
  used is `c4-db.js recent N` through the comm-bridge CLI. Do not introduce
  cursors, id-ordering assumptions, or direct `c4.db` access.
