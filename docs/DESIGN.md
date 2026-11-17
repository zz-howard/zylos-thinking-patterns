# Thinking Patterns Design

Scripts supply material and track completed work. The background agent selects
meaningful clues and applies the unchanged methodology. Pattern files,
confirmation, notifications and append-only boundaries remain owner policy.

## Material Flow

1. Discover groups using `c4-db.js groups`; query checkpoints explicitly per
   group (`*` uses the CLI's omitted-group default).
2. For each group process `(committed end, latest checkpoint end]`. New groups
   bootstrap from the latest day, ignoring old global state. Unsynced tails wait.
3. Find session logs in Core memory directories, using owner `TZ`. List decision
   pages and preferences modified since the previous material run.
4. Provide allowed-channel inbound rows as the original-message net. No sender
   filtering or keyword heuristics. Extract current-message bodies and preserve
   bracket-prefixed first lines; leave messages without that pair unchanged.
5. The agent selects decision and correction clues. `trace` retrieves only the
   source group, including replies, under clue/context/byte limits.
6. The agent prepares an append-only pattern draft. The explicit write command
   validates existing content and uses Core's hash/lock replacement writer for
   existing files under memory. A busy or conflicting write blocks progress;
   missing files, outside-memory targets and old Core report direct-write mode.
7. Deferred clues and the active run persist. Commit advances only completed
   ranges. Identity-reflection can reuse matching artifacts per thread once clue selection ran.

`scripts/materials.js` and `scripts/reference-deltas.js` are copied verbatim to
identity-reflection, with no runtime component dependency; reference fragments
need the installed git executable. See the artifact
contract in [materials.md](../references/materials.md).

## CLI Boundary

Current Core lists groups with `sessionGroup`, checkpoint/conversation metadata
with `session_group`, and wraps some responses in `{ok:true,data}`. Range
queries have no group flag, so bounded ID pages are checked and filtered by
group. New groups use the CLI time query to avoid reading historical backlog.
`max_page_bytes` bounds each CLI response, not total range cost. Sparse group
history can require more raw range scans during trace expansion; only bounded
same-group context reaches the agent.

Checkpoint capability/query failures or missing group metadata produce an
explicit legacy time-window fallback. Its reason, cap and truncation remain
visible, and it never advances checkpoint cursors.

Installed Core interprets checkpoint `--after` as conversation-end coverage,
while older contracts describe checkpoint IDs. Querying from the lesser of
the saved checkpoint ID and conversation end safely covers both; ranges are
still deduplicated against the saved conversation end before processing.

## Ownership And Verification

Each policy/task owns independent cursors and an active run. Hooks never create
scheduler tasks. Upgrades preserve owner files, state, artifacts and logs.
Methodology, lint and pattern content boundaries are unchanged.

Focused fixture tests call real product modules/CLIs with isolated
HOME/ZYLOS_DIR/data/PM2_HOME/TMPDIR. Separate real-Core checkpoint integration
uses a private database, never live C4. See README for explicit entries.
