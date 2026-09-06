# Thinking-Pattern Extraction Methodology

This file ships with the component and is the authoritative procedure for every
extraction run. The owner's `policy.md` (in the data directory) says *whose* or
*what* patterns to extract and how the owner wants candidates handled; this file
says *how* extraction is done. When the two conflict on scope or confirmation,
the owner's policy wins; on method and format, this file wins.

## Contents

- [Theoretical Basis](#theoretical-basis)
- [Extraction Procedure (adapted from CDM)](#extraction-procedure-adapted-from-cdm)
- [Quality Bar](#quality-bar)
- [Classification (two-axis taxonomy)](#classification-two-axis-taxonomy)
- [Entry Format](#entry-format)
- [What Never Goes Into the Pattern File](#what-never-goes-into-the-pattern-file)
- [Run Summary](#run-summary)

## Theoretical Basis

- **Recognition-Primed Decision model** (Gary Klein): experts decide by
  recognizing situations and applying learned responses, often without stating
  the rule. The rule has to be induced from repeated cue–response pairs.
- **Dual-process theory** (Daniel Kahneman): fast, intuitive judgments carry
  implicit heuristics that the decision-maker may never articulate; the
  extractor's job is to make them explicit and testable.
- **Cognitive Task Analysis**, in particular the **Critical Decision Method**
  (CDM): reconstruct a decision from the cues that were present, the options
  that existed, the choice made, and the rationale given.

## Extraction Procedure (adapted from CDM)

1. **Detect decision moments** in the conversations. A decision moment is any
   of:
   - a choice of one approach over another when several were on the table;
   - a proposal rejected *with a reason*;
   - a rule, constraint, or precedent being set ("from now on…", "never…");
   - a judgment call that reveals an underlying principle;
   - a correction of someone else's approach that carries a deeper rationale.
   A statement of fact, a task assignment, or an acknowledgement is not a
   decision moment.
2. **Extract cues**: what was observed or known immediately before the
   decision — the situation, the options, the pressure.
3. **Extract rationale**: the justification given, quoted where possible.
   Expert decisions frequently come without explicit reasoning; record the
   absence honestly rather than inventing one.
4. **Induce a candidate pattern**: only when the cue–rationale pair is
   generalizable — it would guide a *different* future situation, not just
   restate this one. If it is a one-off operational decision, stop here.
5. **Check against the existing pattern file**:
   - If the same heuristic is already recorded, do **not** create a new entry.
     Append a **Reinforced** block under the existing entry with the new source
     event (see format below).
   - If an existing entry is *contradicted* by the new event, do not silently
     edit it. Record the new event as a Reinforced block that states the
     tension explicitly, and flag it in the run summary for the owner.
   - Only when nothing matches, create a new numbered entry.
6. **Confirm** according to the owner's policy: either record directly and
   notify, or hold the candidate for the owner's approval before it becomes a
   numbered entry.

## Quality Bar

Record a pattern only if all of the following hold:

- **Generalizable**: applicable across multiple future situations, not tied to
  the specific artifact or ticket in which it appeared.
- **Attributable**: traceable to a concrete source event (date, channel,
  quote or close paraphrase). Never infer a pattern from what the subject
  "probably" thinks.
- **Non-redundant**: not already captured, including under a different name.
- **Heuristic, not preference**: "prefers dark mode" is a preference; "verify
  a negative claim with two independent methods" is a heuristic.

Quality over quantity. A run that extracts nothing is a normal outcome. Never
force a pattern out of a quiet day.

## Classification (two-axis taxonomy)

Every entry carries a tag `[Domain: X | Type: Y]`.

**Type** (fixed by this methodology — describes *how* the subject thinks):

| Type | Description |
|------|-------------|
| Simplification | reduces complexity by discarding detail |
| Abstraction | elevates to a higher-level framing |
| Constraint | adds a hard rule that eliminates options |
| Prioritization | ranks competing concerns |
| Delegation | decides who or what should own something |
| Temporal | controls when to act versus wait |

**Domain** (defined by the owner's policy — describes *what* the pattern is
about). The policy provides a starting set; the extractor may introduce a new
Domain when no existing one fits, and should say so in the run summary so the
owner can consolidate later. Example sets:

- Engineering-leadership subject: Architecture, Process, People, Strategy.
- Product-design subject: Requirements, Interaction, Data & Metrics,
  Monetization.

## Entry Format

Entries are numbered sequentially. The next number is always
`(largest existing number in the file) + 1`; use the `inspect` command of the
component CLI to read it rather than counting by hand.

```markdown
## <N>. <Short, memorable title — optionally with a defining quote>
`[Domain: <Domain> | Type: <Type>]`

**Source event**: <what happened, where, and when — date required>

**Context**: <the situation and the options that were on the table>

**<Subject>'s judgment**: <what was chosen and, verbatim where possible, why>

**Extracted principle**: **<one-sentence heuristic in bold>** <one or two
sentences on when it applies and what test tells you it applies>

**Related patterns**:
- <#M (title) — how it relates>
```

For a repeat occurrence of an existing pattern, append under that entry (before
the next `---` separator), never as a new entry:

```markdown
**Reinforced (<YYYY-MM-DD>)**: <the new source event and what it adds — a
sharper boundary, a corollary, a counter-case>
```

The header carries the date alone; a time, place, or day-count qualifier belongs in
the text, and the block is a paragraph at the line start, not a list item.

If the reinforcement yields a genuinely new corollary, add an
`**Extracted corollary**:` paragraph after it. A Reinforced block may also
record a counter-case — an event where the principle did not apply or was
overridden — stated as such; a counter-case sharpens the boundary and is not a
contradiction unless the principle itself no longer holds.

**Relation direction.** A `Related patterns` line is written from the entry it
sits under toward the target: `#M (title) — how #M relates to this entry`. The
target entry need not carry the reverse line; a reader following relations
starts from the entry at hand. Conflict relations ("#M pulls the other way
when …") may be recorded on both entries, since a conflict reads the same from
either side. Every relation line names its target by number; a line with only a
title is unresolvable once titles change.

**Two kinds of item.** A `Related patterns` list may also hold a *concept item*:
a principle or idea that has no entry of its own (`Whitelist over blacklist`,
`Declarative over imperative`). A concept item carries no number because it is
not a reference. What is never allowed is referring to an entry by its title
alone; the component's lint reports number-less items that read as references.

Entries are separated by a line containing only `---`.

## What Never Goes Into the Pattern File

- Task status, version numbers, dates of delivery, or other project state.
- Credentials, configuration paths, or operational details.
- Content about people other than the subject beyond what the source event
  requires (name roles, not individuals, where possible).
- Verbatim private messages beyond the quote needed to attribute the judgment.

## Run Summary

When a run records or reinforces anything, the summary to the owner (if the
policy asks for one) is short: one line per new entry (number + title) and one
line per reinforcement (number + what it added). If a contradiction with an
existing entry was found, say so explicitly. No summary is sent when nothing
was recorded, unless the policy says otherwise. Any summary that is sent ends
with the file's lint counts (Type outside the six, possible compound Domain, Related
lines without a number, dangling references) as reported by the component,
so format drift is visible to the owner without opening the file.
