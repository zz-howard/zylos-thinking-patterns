# zylos-thinking-patterns

Extract reusable decision heuristics from digested memory and C4 context.
Requires Node.js 20+ and Zylos comm-bridge/scheduler. Production uses public
CLIs, never C4's database. A background agent follows the unchanged
[methodology](references/methodology.md) and prepares drafts; the explicit
`write` command validates and publishes them.

## Setup

```bash
zylos add zz-howard/zylos-thinking-patterns
```

Hooks create config, state, logs and a policy template under
`~/zylos/components/thinking-patterns/`. Fill the subject, destination, source
channels, domains, confirmation, notifications and guidance; remove the
`UNCONFIGURED` marker. `Patterns file:` under `## Target` remains the only
append-only pattern destination. Owner policy is never overwritten.

Channel filters default to excluding `internal, system, void, multica` and
never filter senders. Additional policies use `policy-<name>.md` and
`--policy <name>`. Each policy/task owns independent checkpoint progress.

Hooks register no scheduler tasks. Ask the owner for frequency, fallback
lookback, task name and policy; print the exact registration command:

```bash
node scripts/extract.js template --lookback 24h --task daily --cron '50 23 * * *'
```

## Flow

1. Fetch each group's Memory Sync checkpoint-covered range, daily memory paths,
   changed decision/preference paths and allowed-channel inbound messages.
2. The background agent reads memory, then the complete inbound net; selects
   decision/correction clues by meaning; traces them in their original group.
3. Trace includes replies under clue/context/byte limits. Deferred work persists.
4. Apply the methodology, publish a draft or hold according to confirmation, notify only
   the policy endpoint. Source attributions include group and C4 message ID.
5. Commit finished ranges. Identity-reflection reuses matching correction traces.

New groups start from the latest day; unsynced tails wait for a checkpoint.
Older Core uses explicit `legacy_time_window` fallback with a reason. Only
fallback applies lookback and legacy conversation caps; truncation stays visible.

## Configuration And CLI

Config in the data directory includes `enabled`, `c4_db_cli`, `c4_fetch_cli`,
`trace_max_clues` (15), `trace_context` (10 messages each side),
`trace_max_bytes` (512000), `artifact_retention_days` (7), `max_page_bytes`
(64 MiB), plus legacy-only `min_conversations` (4), `max_conversations` (300),
and `default_lookback` (`24h`). CLI paths default to the installed comm-bridge.
`memory_writer` defaults to Core's installed locked memory writer.

`max_page_bytes` bounds each CLI response; sparse same-group traces may require
more range scans. Owner `TZ` selects session days. Normal collection does not
drop checkpoint-covered rows at a fixed conversation count.

```bash
node scripts/extract.js fetch --task daily --lookback 24h
node scripts/extract.js trace --run UUID --task daily --clues clues.json
node scripts/extract.js trace --run UUID --task daily
node scripts/extract.js write --file draft.md --sha256 HASH --run UUID --task daily
node scripts/extract.js commit --run UUID --task daily --result no_change
node scripts/extract.js inspect
node scripts/extract.js status
```

Commands also accept `--policy name`; `commit --groups G,H` completes only
selected finished groups. Fetch resumes an active run; skip advances nothing.
Before writing, read the full destination and hash its raw bytes. Existing memory
files use Core's locked replacement mode. Busy locks, conflicts and writer errors
defer publication and block progress until a successful write. Reread and merge
conflicts before retrying. Missing files, paths outside memory and older Core
without the writer use direct mode with an explicit fallback reason.
See [SKILL.md](SKILL.md), [output fields](references/fetch-output.md),
[shared artifacts](references/materials.md) and [design](docs/DESIGN.md).

Hooks merge defaults idempotently, preserving owner values, state, logs,
`materials/` and backups. `pre-upgrade` snapshots config/policy/state, but Core
currently takes its own backup rather than invoking that hook.

## Verification

```bash
npm run test:materials
npm run check
```

Fixture tests invoke product modules/CLIs with isolated HOME, ZYLOS_DIR, data,
PM2_HOME and short TMPDIR, no live C4/services. Entries name `.test.js` files
explicitly. Tests do not rewrite product code. Full unit/release tests remain
available through `npm test`; run affected tests for focused changes.

Real-Core checkpoint integration requires existing Core dependencies:

```bash
ZYLOS_PACKAGE_ROOT=/path/to/core node --test test/checkpoint-history.test.js
```

It uses private databases and isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no model,
runtime, PM2, tmux or network. Only fixtures seed private databases directly.
Cases document coverage and when required. Never target live resources.

Locked publication integration requires a Core checkout containing the memory
writer; run it for pattern publication or commit-guard changes:

```bash
ZYLOS_PACKAGE_ROOT=/path/to/core node --test test/pattern-write.test.js
```

It isolates HOME, ZYLOS_DIR, data, PM2_HOME, TMPDIR and TMUX_TMPDIR. It calls the
real Core writer with only its run observer injected, touches no live resources,
starts no services or network, bounds children and cleans its owned directories.

Existing projection compatibility integration additionally requires sqlite3,
an older Core checkout and the `v0.2.2` baseline tag:

```bash
ZYLOS_PACKAGE_ROOT=/path/to/current-core TEST_LEGACY_CORE_ROOT=/path/to/old-core npm run test:integration
```

## License

[MIT](LICENSE)
