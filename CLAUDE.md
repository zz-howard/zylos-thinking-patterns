# CLAUDE.md

Engineering conventions for this repository live in [AGENTS.md](./AGENTS.md)
and apply equally to Claude and every other agent. Read it before any
development, review, or release work. Non-negotiable: the Release Process —
all four version files (package.json / package-lock.json / SKILL.md
frontmatter / CHANGELOG.md) bump in the same commit of a dedicated release
PR. `test/release-consistency.test.js` machine-enforces the resulting
final-tree version consistency; the PR/commit discipline itself is
guaranteed by the release flow and review gate.
