<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-thinking-patterns</h1>

<p align="center">
  Thinking-pattern extraction component for Zylos agents.
</p>

---

`zylos-thinking-patterns` periodically mines an agent's conversations for decision moments and distills them into reusable decision heuristics — of a person (an owner's way of deciding), a role, or a domain. One methodology, configurable per scenario through profiles.

It packages a workflow that has been running as a hand-written scheduler task for months into an installable Zylos utility component, in the same shape as [zylos-identity-reflection](https://github.com/zz-howard/zylos-identity-reflection): a script keeps a cursor over unprocessed C4 conversations and maintains state; a background subagent applies the methodology and writes pattern entries. The script never writes patterns on its own.

## Status

**Design in review.** This repository currently holds the skeleton only. Runtime code (`scripts/`, `hooks/`, `SKILL.md`) lands once the solution design is finalized. A public design document will be published under `docs/project/` at that point.

## Planned Shape

- **Methodology** ships with the component and upgrades with it: how decision moments are detected, how cues and rationale are extracted, the pattern taxonomy, the entry format, and the quality bar (only generalizable heuristics are recorded).
- **Profiles** live in the data directory and are preserved across upgrades: who or what the patterns describe, which conversation streams to read, the domain axis, the target file, and how candidates are confirmed.
- **Runtime model**: a recurring scheduler task dispatches the skill; the main session launches a background subagent; the subagent runs fetch → analyze → write → commit.

## License

[MIT](./LICENSE)
