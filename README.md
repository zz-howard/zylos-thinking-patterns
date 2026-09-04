<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-thinking-patterns</h1>

<p align="center">
  Thinking-pattern extraction component for Zylos agents.
</p>

---

`zylos-thinking-patterns` periodically mines an agent's C4 conversations for decision moments and distills the ones that generalize into numbered decision heuristics — of a person (an owner's way of deciding), a role (how a product-manager agent decides), or a domain (product-design decisions across projects).

The **methodology** is fixed and ships with the component. Everything scenario-specific — whose patterns, from which conversations, into which file, and how candidates are confirmed — is the installing **owner's** decision, written once into a plain-language `policy.md`. It has the same shape as [zylos-identity-reflection](https://github.com/zz-howard/zylos-identity-reflection): a script keeps a cursor over unprocessed conversations and maintains state; a background subagent applies the methodology and writes pattern entries. The script never writes patterns on its own.

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
3. **Schedule.** Pick a cron expression and register the scheduler task from the printed template (the prompt must be used verbatim):
   ```bash
   node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template
   ```

To avoid mining old history on the first run, set `last_processed_id` in `state.json` to the current latest conversation id; otherwise the first run processes at most `max_conversations` of the newest backlog.

## Configuration

`~/zylos/components/thinking-patterns/config.json`:

```json
{
  "enabled": true,
  "min_conversations": 30,
  "max_conversations": 300,
  "patterns_file": "~/zylos/memory/thinking-patterns.md",
  "c4_db_cli": "~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js",
  "c4_fetch_script": "~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js"
}
```

- `min_conversations` — below this many unprocessed conversations the run is recorded as `skip` and the cursor does not move.
- `max_conversations` — the largest backlog a single run will look at (oldest rows beyond it are dropped).
- `patterns_file` — the only file the workflow may write to, and only by appending.

## Runtime Model

A recurring scheduler task dispatches the skill. The main session launches a **background subagent** and only marks the task done afterwards. The subagent:

1. `extract.js fetch` — reads the cursor, asks comm-bridge for the newest rows, fetches the unprocessed transcript, checks the threshold and the policy marker.
2. Reads `policy.md`, `references/methodology.md`, and the current pattern file.
3. Applies the methodology: detect decision moments → extract cues and rationale → induce candidates → reinforce an existing entry, flag a contradiction, or create a new numbered entry → apply the quality bar. Extracting nothing is a normal outcome.
4. Writes (or holds candidates) per the policy's confirmation mode and notifies the owner's endpoint if the policy asks for it.
5. `extract.js commit --result updated|no_change --end-id <N>` (or `--result skip`).

See [`SKILL.md`](./SKILL.md) for the exact workflow and write boundary, and [`references/methodology.md`](./references/methodology.md) for the extraction procedure, two-axis taxonomy (`[Domain: X | Type: Y]`), entry format and quality bar.

## CLI

```bash
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js fetch
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result skip --observed-end-id <N>
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js commit --result no_change|updated --end-id <N>
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js inspect     # entry count, max/next number, policy state
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js status      # config + state + policy + patterns
node ~/zylos/.claude/skills/thinking-patterns/scripts/extract.js template [--policy] [--json]
```

Every command prints JSON except `template`, which prints text unless `--json` is given.

## State

`state.json` tracks `last_processed_id` (the cursor; only moves forward), `last_observed_id`, `last_run_at`, `last_result`, and `last_update_at`. Each commit appends one line to `logs/runs.jsonl`. `config.json`, `policy.md`, `state.json`, `logs/` and `backups/` are preserved across upgrades; `pre-upgrade` snapshots the first three into `backups/<timestamp>/`.

## Known Limitation

`c4-db.js recent N` orders rows by timestamp, not id. The component assumes the two orders agree inside the newest `max_conversations` rows; the only effect of skew is which old backlog rows a capped first run leaves behind. An id-ordered range primitive is requested in [zylos-core#775](https://github.com/zylos-ai/zylos-core/issues/775) and the component will switch to it once available.

## Development

```bash
npm test        # node:test suite; fakes the comm-bridge CLIs, no sqlite3 needed
npm run check   # syntax check of scripts and hooks
```

## License

[MIT](./LICENSE)
