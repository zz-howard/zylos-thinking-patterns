<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-thinking-patterns</h1>

<p align="center">
  Thinking-pattern extraction component for Zylos agents.
</p>

---

`zylos-thinking-patterns` periodically mines an agent's C4 conversations for decision moments and distills the ones that generalize into numbered decision heuristics — of a person (an owner's way of deciding), a role (how a product-manager agent decides), or a domain (product-design decisions across projects).

The **methodology** is fixed and ships with the component. Everything scenario-specific — whose patterns, from which conversations, into which file, and how candidates are confirmed — is the installing **owner's** decision, written once into a plain-language `policy.md`. It has the same shape as [zylos-identity-reflection](https://github.com/zz-howard/zylos-identity-reflection): a script fetches the time window the owner chose and records run state; a background subagent applies the methodology and writes pattern entries. The script never writes patterns on its own.

## System Requirements

- Node.js 20+, provided by the Zylos runtime.
- The Zylos `comm-bridge` and `scheduler` skills. All conversation access goes through the comm-bridge CLI; the component never opens the C4 database directly and does not need `sqlite3`.

## Install

```bash
zylos add zz-howard/zylos-thinking-patterns
```

The post-install hook creates:

- `~/zylos/components/thinking-patterns/config.json`
- `~/zylos/components/thinking-patterns/policy.md` — a **template** with the owner's questions
- `~/zylos/components/thinking-patterns/state.json`
- `~/zylos/components/thinking-patterns/logs/`

It does **not** register a scheduler task. The owner decides when extraction runs. The hook prints an "OWNER ACTION REQUIRED" block that the agent relays to the owner.

## Owner Setup

Three decisions belong to the owner; the agent asks and writes them down.

1. **Policy.** Answer the questions in `policy.md` (whose or what patterns; which conversation streams; the starting set of Domain tags; whether to record directly, ask first, or record silently; where run summaries go), then remove the `UNCONFIGURED` marker line. Until the marker is gone every run is skipped and the agent keeps reminding the owner. A fresh template:
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template --policy
   ```
2. **Target and threshold.** Set `patterns_file` (and optionally `min_conversations`) in `config.json`. An existing file in the methodology's entry format is picked up as-is; numbering continues from its highest entry.
3. **Schedule.** Before registering any scheduled task the agent asks the owner three things: how often it runs (cron), how far back each run looks (the lookback, default = the run interval), and a task name when it is not the first task. The template prints these questions and the registration command with the chosen values (the prompt must be used verbatim):
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template --lookback 24h --task daily --cron "50 23 * * *"
   ```

Several tasks may coexist with different lookbacks — for example a daily `24h` pass and a weekly `7d` pass that catches cross-day patterns. They share the one policy and pattern file; overlap between runs is harmless because the methodology de-duplicates against the file. There is no cursor and nothing to seed on first install: the first run simply looks back its lookback.

## Configuration

`~/zylos/components/thinking-patterns/config.json`:

```json
{
  "enabled": true,
  "min_conversations": 30,
  "max_conversations": 300,
  "default_lookback": "24h",
  "patterns_file": "~/zylos/memory/thinking-patterns.md",
  "c4_db_cli": "~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js"
}
```

- `min_conversations` — below this many messages inside the window the run is recorded as `skip`.
- `max_conversations` — the most messages a single run will read; when a window holds more, the oldest part is left out and the fetch result says `truncated: true`.
- `default_lookback` — used when a task does not pass `--lookback`. Each scheduled task normally carries its own.
- `patterns_file` — the only file the workflow may write to, and only by appending.

## Runtime Model

A recurring scheduler task dispatches the skill. The main session launches a **background subagent** and only marks the task done afterwards. The subagent:

1. `extract.js fetch --lookback <d> --task <name>` — asks comm-bridge for the newest rows, keeps those inside the lookback window, checks the threshold and the policy marker.
2. Reads `policy.md`, `references/methodology.md`, and the current pattern file.
3. Applies the methodology: detect decision moments → extract cues and rationale → induce candidates → reinforce an existing entry, flag a contradiction, or create a new numbered entry → apply the quality bar. Extracting nothing is a normal outcome.
4. Writes (or holds candidates) per the policy's confirmation mode and notifies the owner's endpoint if the policy asks for it.
5. `extract.js commit --result updated|no_change|skip --task <name> ...` — records the run.

See [`SKILL.md`](./SKILL.md) for the exact workflow and write boundary, and [`references/methodology.md`](./references/methodology.md) for the extraction procedure, two-axis taxonomy (`[Domain: X | Type: Y]`), entry format and quality bar.

## CLI

```bash
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js fetch [--lookback 24h] [--task name]
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result skip|no_change|updated [--task name] [--lookback 24h] [--window-end "YYYY-MM-DD HH:MM:SS"]
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js inspect     # entry count, max/next number, policy state
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js status      # config + state + policy + patterns
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template [--policy] [--lookback 24h] [--task name] [--cron "..."] [--json]
```

Every command prints JSON except `template`, which prints text unless `--json` is given.

## State

`state.json` records `last_run_at`, `last_result`, `last_update_at`, and `last_window` (task, lookback, window end). There is no cursor: each run is defined by its own window. Each commit appends one line to `logs/runs.jsonl`. `config.json`, `policy.md`, `state.json`, `logs/` and `backups/` are preserved across upgrades; `pre-upgrade` snapshots the first three into `backups/<timestamp>/`.

## Design Note

Runs are defined by time, not by id: the owner sets how often a task runs and how far back it looks, and `c4-db.js recent N` (the newest N rows ordered by timestamp, with content) is the only C4 primitive used. No id-ordering assumption, no second fetch call, no cursor to seed or repair.

## Development

```bash
npm test        # node:test suite; fakes the comm-bridge CLIs, no sqlite3 needed
npm run check   # syntax check of scripts and hooks
```

## License

[MIT](./LICENSE)
