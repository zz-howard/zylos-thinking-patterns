# zylos-thinking-patterns Design Document

**Date**: 2026-09-05
**Author**: Zylos AI
**Repository**: https://github.com/zz-howard/zylos-thinking-patterns
**Status**: Current (reflects the tree at the time of the 0.1.0 release)

---

## 1. Overview

The component periodically mines an agent's C4 conversations for decision
moments and distills the ones that generalize into numbered decision heuristics
("thinking patterns") — of a person, a role, or a domain. It delivers exactly
three things: a **mechanism** (time-window fetch, thresholds, run state, write
boundary), a **methodology** (`references/methodology.md`, versioned with the
component), and a **task template** (the scheduler registration command the
owner approves). Everything scenario-specific — whose patterns, from which
conversations, into which file, how candidates are confirmed, and when runs
happen — is the installing owner's decision, written once into `policy.md`.

## 2. Architecture

### 2.1 Component Structure

```
zylos-thinking-patterns/
  docs/
    DESIGN.md              — this file
  references/
    methodology.md         — fixed extraction procedure, taxonomy, entry format, quality bar
    fetch-output.md        — field-by-field reference for the `fetch` JSON
  scripts/
    lib.js                 — paths, defaults, policy parsing, C4 paging, templates
    extract.js             — CLI: fetch / commit / inspect / status / template
  hooks/
    post-install.js        — data dir + defaults + policy template + owner-action message
    pre-upgrade.js         — snapshot config/policy/state into backups/<timestamp>/
    post-upgrade.js        — merge new config defaults, normalize state (idempotent)
  test/
    extract.test.js        — node:test suite with fake comm-bridge / scheduler CLIs
  SKILL.md                 — component metadata + the agent's workflow
```

Data directory (`~/zylos/components/thinking-patterns/`, preserved across
upgrades): `config.json`, `policy.md`, `state.json`, `logs/runs.jsonl`,
`backups/`.

### 2.2 Data Flow

```
scheduler task ──▶ main session ──▶ background subagent
                                        │
                     extract.js fetch ◀─┘  (window → comm-bridge `c4-db.js recent N`,
                                            page grows until the window is covered or
                                            max_page_bytes; policy channel filter; cap)
                                        │
                        policy.md + methodology.md + pattern file (index first)
                                        │
                     subagent judgment: reinforce / contradiction / new entry / nothing
                                        │
                   pattern file (append only, per confirmation mode) + owner notification
                                        │
                     extract.js commit ──▶ state.json + logs/runs.jsonl
```

The script never writes patterns; judgment belongs to the agent. The only file
the workflow may modify is the policy's `Patterns file`, and only by appending.

## 3. Configuration

`config.json` holds the mechanism knobs (`enabled`, `min_conversations`,
`max_conversations`, `max_page_bytes`, `default_lookback`, `c4_db_cli`).
`policy.md` holds the owner's scenario in prose plus three machine-read lines
(`Patterns file:` under `## Target`; `Channels:` / `Exclude channels:` under
`## Sources`). The target file deliberately lives in the policy, not in config:
it is part of "whose patterns", which is the owner's call, and the file is
never migrated from anywhere.

## 4. Design Decisions

- **Runs are defined by time, not by id.** The owner sets how often a task runs
  and how far back it looks. `c4-db.js recent N` (newest N rows, with content)
  is the only C4 primitive used; it has no time-range parameter, so `fetch`
  asks for one row beyond the cap and doubles the page until the oldest row
  predates the window, stopping early at `max_page_bytes`. No cursor to seed or
  repair, no id-ordering assumption. A time-range or content-less listing
  primitive on the comm-bridge side would remove the paging; until it exists,
  an incomplete read is reported (`window_complete: false`), never hidden.
- **A skip triggers no catch-up read.** Every run takes its own `now − lookback`
  window. Messages that fall outside every later window are never read again,
  which is why `min_conversations` defaults low (4, about two exchanges) and why
  extracting nothing from a quiet window is a normal outcome.
- **Post-install registers no scheduler task.** The owner answers three
  questions (interval, lookback, task name) and the agent runs the printed
  registration command verbatim. Several tasks with different lookbacks may
  share one policy; overlap is harmless because the methodology de-duplicates
  against the pattern file.
- **One policy = one subject = one pattern file.** A second subject is
  `policy-<name>.md` selected with `--policy <name>`; there is no other new
  concept.
- **Bounded parsing, honest residual.** `max_page_bytes` bounds what this
  process parses from one comm-bridge call; the comm-bridge CLI still builds
  the page in its own memory and on temp disk. The bound is documented as a
  degradation trade-off, not as a full fix.

## 5. Testing

`npm test` runs the `node:test` suite against fake comm-bridge and scheduler
CLIs in a temporary data directory; no sqlite3 and no real `~/zylos` access.
`npm run check` syntax-checks scripts and hooks. Guarded behaviors are proven
with known-bad mutants during review (the suite must be able to go red).
