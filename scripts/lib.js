import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(HOME, 'zylos');
export const DATA_DIR = process.env.ZYLOS_DATA_DIR || path.join(ZYLOS_DIR, 'components/thinking-patterns');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const POLICY_PATH = path.join(DATA_DIR, 'policy.md');
export const STATE_PATH = path.join(DATA_DIR, 'state.json');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const RUN_LOG_PATH = path.join(LOG_DIR, 'runs.jsonl');
export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const METHODOLOGY_PATH = path.join(SKILL_DIR, 'references/methodology.md');
// Paths as they are printed into templates and the default config. `~/zylos` is
// the platform convention; a non-default ZYLOS_DIR is honoured here as well as
// for the data directory above.
const ZYLOS_DIR_DISPLAY = process.env.ZYLOS_DIR || '~/zylos';
export const SKILL_MD_INSTALLED = `${ZYLOS_DIR_DISPLAY}/.claude/skills/thinking-patterns/SKILL.md`;
export const EXTRACT_INSTALLED = `${ZYLOS_DIR_DISPLAY}/.claude/skills/thinking-patterns/scripts/extract.js`;
export const SCHEDULER_CLI_INSTALLED = `${ZYLOS_DIR_DISPLAY}/.claude/skills/scheduler/scripts/cli.js`;
export const TASK_NAME_PREFIX = 'thinking-patterns';
export const DEFAULT_TASK = 'default';

// A policy.md that still carries this marker has not been filled in by the owner.
export const UNCONFIGURED_MARKER = '<!-- thinking-patterns: UNCONFIGURED -->';

export const DEFAULT_CONFIG = {
  enabled: true,
  min_conversations: 4,
  max_conversations: 300,
  max_page_bytes: 64 * 1024 * 1024,
  default_lookback: '24h',
  c4_db_cli: `${ZYLOS_DIR_DISPLAY}/.claude/skills/comm-bridge/scripts/c4-db.js`
};

// Channels that never carry the subject's judgment: scheduler/system notices
// and the agent's own void memos. Owners can override in the policy.
export const DEFAULT_EXCLUDE_CHANNELS = ['system', 'void'];
export const DEFAULT_POLICY = 'default';

export const DEFAULT_STATE = {
  schema_version: 2,
  last_run_at: null,
  last_result: null,
  last_update_at: null,
  last_window: null
};

export const POLICY_TEMPLATE = `${UNCONFIGURED_MARKER}
# Thinking-Pattern Extraction Policy

> Written by the owner, read by the agent before every extraction run.
> Fill in the sections below in plain language, then delete the first line
> of this file (the UNCONFIGURED marker). Until the marker is gone, runs are
> skipped and the agent will keep reminding you.

## Subject

Whose or what decision patterns should be extracted? One of:

- a person — e.g. "my owner Alex's decision-making patterns as an engineering lead"
- a role — e.g. "how this product-manager agent decides, as it does its daily work"
- a domain — e.g. "product-design decisions made in the projects this agent works on"

Subject: (fill in)

## Target

Which file the patterns are written to. Only this file is ever modified, and
only by appending. An existing file in the entry format is picked up as-is.

Patterns file: (fill in, e.g. ~/zylos/memory/thinking-patterns.md)

## Sources

Which conversation streams count? The two lines below are applied by the
fetch step as a coarse filter on the C4 \`channel\` field (a comma-separated
list, or "all"); everything finer — which groups, which topics, what to
ignore — is written in plain language for the agent to judge.

Channels: all
Exclude channels: system, void

Sources: (fill in, or "all")

## Domains

Starting set of Domain tags for the \`[Domain: X | Type: Y]\` label. The
extractor may add a Domain when nothing fits and will tell you in the run
summary. Examples: Architecture / Process / People / Strategy, or
Requirements / Interaction / Data & Metrics / Monetization.

Domains: (fill in)

## Confirmation

How should newly extracted patterns be handled?

- "record and notify me" — entries are written directly; you get a short summary
- "ask me first" — candidates are held in the run summary and only written after you approve
- "record silently" — entries are written; no message

Confirmation: (fill in)

## Notification

Where should run summaries go? A channel and endpoint the agent can send to,
e.g. "telegram 123456789". Leave empty for none.

Notification: (fill in)

## Extra guidance

Anything the extractor should pay special attention to, or must not record.

Guidance: (fill in)
`;

// Durations are written the way an owner would say them: "24h", "7d", "90m", "36h".
const DURATION = /^(\d+)\s*(m|h|d)$/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value) {
  if (typeof value !== 'string') throw new Error(`Invalid lookback: ${value}`);
  const match = value.trim().match(DURATION);
  if (!match || Number(match[1]) < 1) {
    throw new Error(`Invalid lookback: "${value}" (use e.g. 90m, 24h, 7d)`);
  }
  return Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
}

// Owner-facing questions the agent must ask before registering a scheduled task.
export const SCHEDULE_QUESTIONS = [
  'How often should it run? (a cron expression in the scheduler timezone; nightly after the working day is typical)',
  'How far back should each run look? (the lookback, e.g. 24h or 7d; default = the run interval. Shorter than the interval leaves gaps; longer overlaps, which is harmless because the methodology de-duplicates against the pattern file)',
  'A short task name, only when this is not the first scheduled task (e.g. daily, weekly) — several tasks may run with different lookbacks against the same policy; and, when more than one policy file exists (policy.md, policy-<name>.md, one per subject), which policy this task uses'
];

export function normalizePolicyName(value) {
  if (value === undefined || value === null || value === true || value === '') return DEFAULT_POLICY;
  const name = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(`Invalid policy name: "${value}" (letters, digits, - and _, up to 32 chars)`);
  }
  return name;
}

export function policyPath(policy = DEFAULT_POLICY) {
  return policy === DEFAULT_POLICY ? POLICY_PATH : path.join(DATA_DIR, `policy-${policy}.md`);
}

const PLACEHOLDER = /^\(fill in/i;

// Body of one "## <heading>" section (up to the next "## " heading), or '' when absent.
export function policySection(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// A "Label: value" line at line start inside `text`; placeholders count as absent.
function policyLine(text, label) {
  const match = text.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'mi'));
  if (!match) return null;
  const value = match[1].trim();
  return value === '' || PLACEHOLDER.test(value) ? null : value;
}

// null / "all" → null (no restriction); "none" → []; otherwise a list.
function channelList(value) {
  if (value === null || /^all$/i.test(value)) return null;
  if (/^none$/i.test(value)) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

// Sections (by "## Heading") that still contain a "(fill in" placeholder from
// the template — the owner filled the policy in only partly. Reported so the
// agent can remind the owner instead of guessing from placeholder prose.
const PLACEHOLDER_ANYWHERE = /\(fill in/i;
export function policyPlaceholders(text) {
  const sections = [];
  let current = null;
  let flagged = false;
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      flagged = false;
      continue;
    }
    if (!flagged && current !== null && PLACEHOLDER_ANYWHERE.test(line)) {
      sections.push(current);
      flagged = true;
    }
  }
  return sections;
}

// Machine-readable lines of an owner policy, read only inside their own
// sections ("Patterns file:" under ## Target; "Channels:" / "Exclude channels:"
// under ## Sources) so the same words in owner prose elsewhere are ignored.
// Everything else in the file is prose for the agent. `channels` null = all;
// `exclude_channels` defaults to DEFAULT_EXCLUDE_CHANNELS when the line is absent.
export function parsePolicy(text) {
  const target = policySection(text, 'Target');
  const sources = policySection(text, 'Sources');
  const excludeLine = policyLine(sources, 'Exclude channels');
  return {
    patterns_file: policyLine(target, 'Patterns file'),
    channels: channelList(policyLine(sources, 'Channels')),
    exclude_channels: excludeLine === null && !/^Exclude channels:/mi.test(sources)
      ? [...DEFAULT_EXCLUDE_CHANNELS]
      : (channelList(excludeLine) ?? []),
    placeholders: policyPlaceholders(text)
  };
}

export function readPolicy(policy = DEFAULT_POLICY) {
  const file = policyPath(policy);
  if (!fs.existsSync(file)) return { policy, policy_file: file, exists: false, unconfigured: true, patterns_file: null, channels: null, exclude_channels: [], placeholders: [] };
  const text = fs.readFileSync(file, 'utf8');
  return { policy, policy_file: file, exists: true, unconfigured: text.includes(UNCONFIGURED_MARKER), ...parsePolicy(text) };
}

export function normalizeTaskName(value) {
  if (value === undefined || value === null || value === true || value === '') return DEFAULT_TASK;
  const name = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(`Invalid task name: "${value}" (letters, digits, - and _, up to 32 chars)`);
  }
  return name;
}

export function schedulerPrompt(lookback = DEFAULT_CONFIG.default_lookback, task = DEFAULT_TASK, policy = DEFAULT_POLICY) {
  const policyArg = policy === DEFAULT_POLICY ? '' : ` --policy ${policy}`;
  const policyNote = policy === DEFAULT_POLICY ? '' : `, policy "${policy}"`;
  return `Run the thinking-patterns skill (task "${task}", lookback ${lookback}${policyNote}). Load and follow ${SKILL_MD_INSTALLED}. Use its required background-subagent execution model; the subagent's fetch step is \`node ${shellPath(EXTRACT_INSTALLED)} fetch --lookback ${lookback} --task ${task}${policyArg}\`, and every commit step must pass \`--task ${task}${policyArg}\`. The main session only orchestrates and marks the scheduler task done after the subagent completes.`;
}

// POSIX single-quoting: the prompt is data, never shell syntax. Backticks,
// "$", and double quotes inside it must reach the scheduler byte-for-byte.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// An installed path as one shell argument. Plain path characters stay bare so
// the default `~/zylos` still expands at the owner's shell; anything else
// (a ZYLOS_DIR with spaces or quotes) is single-quoted. Display strings in
// prose are not shell arguments and keep the bare form.
export function shellPath(value) {
  return /^[A-Za-z0-9_./~-]+$/.test(value) ? value : shellQuote(value);
}

export function schedulerTaskName(task = DEFAULT_TASK, policy = DEFAULT_POLICY) {
  const parts = [TASK_NAME_PREFIX];
  if (policy !== DEFAULT_POLICY) parts.push(policy);
  if (task !== DEFAULT_TASK) parts.push(task);
  return parts.join('-');
}

export function schedulerTemplate(lookback = DEFAULT_CONFIG.default_lookback, task = DEFAULT_TASK, cron = '50 23 * * *', policy = DEFAULT_POLICY) {
  const prompt = schedulerPrompt(lookback, task, policy);
  return [
    '# Scheduler task template for thinking-patterns',
    '',
    'The owner decides when extraction runs and how far back each run looks.',
    'Before registering a task, ask the owner:',
    '',
    ...SCHEDULE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Then register the task once (values below are examples):',
    '',
    `node ${shellPath(SCHEDULER_CLI_INSTALLED)} add ${shellQuote(prompt)} --cron ${shellQuote(cron)} --priority 3 --name ${schedulerTaskName(task, policy)}`,
    '',
    'Print a template for other values with:',
    '',
    `node ${shellPath(EXTRACT_INSTALLED)} template --lookback 7d --task weekly --cron "0 22 * * 0" [--policy <name>]`,
    '',
    'Task description (used verbatim above):',
    '',
    prompt,
    ''
  ].join('\n');
}

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return HOME;
  if (value.startsWith('~/')) return path.join(HOME, value.slice(2));
  return value;
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { ...fallback };
    throw new Error(`Failed to read ${filePath}: ${err.message}`);
  }
}

export function atomicWriteJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, filePath);
}

// Deterministic serialization (sorted keys, recursively) so two JSON files that
// hold the same values compare equal regardless of key order or formatting.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Write only when the content differs from what is on disk: hooks that merge
// defaults stay idempotent instead of rewriting owner files on every run.
// Returns true when the file was written.
export function writeJsonIfChanged(filePath, value) {
  const current = fs.existsSync(filePath) ? readJson(filePath, {}) : undefined;
  if (current !== undefined && stableStringify(current) === stableStringify(value)) return false;
  atomicWriteJson(filePath, value);
  return true;
}

export function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  return true;
}

export function loadConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) };
}

export function normalizeState(state) {
  return { ...DEFAULT_STATE, ...state, schema_version: DEFAULT_STATE.schema_version };
}

export function loadState() {
  return normalizeState(readJson(STATE_PATH, DEFAULT_STATE));
}

export function policyIsUnconfigured(policyPath = POLICY_PATH) {
  if (!fs.existsSync(policyPath)) return true;
  return fs.readFileSync(policyPath, 'utf8').includes(UNCONFIGURED_MARKER);
}

// Pattern-file introspection. Entries are "## <N>. Title" headings; the next
// number is always max + 1, read from the file rather than from state, so a
// hand-edited file stays authoritative. The entry index (number, title, tag,
// reinforcement count) lets the agent screen candidates against the file by
// title and tag first and read only the entries that match.
const ENTRY_HEADING = /^## (\d+)\.\s+(.*?)\s*$/;
const REINFORCED = /^\*\*Reinforced \(/;
// The methodology's only Reinforced header: `**Reinforced (YYYY-MM-DD)**: ` at the line start.
const REINFORCED_CANONICAL = /^\*\*Reinforced \(\d{4}-\d{2}-\d{2}\)\*\*: /;
// Anything that reads as a reinforcement header: canonical or not, bulleted or not, and the
// labels `Reinforcing event` / `Reinforcement`. Lint compares these against the canonical shape.
const REINFORCED_LIKE = /^\s*(?:[-*]\s+)?\*\*Reinforc(?:ed|ing|ement)\b[^*\n]*\*\*/;
const RELATED_HEADING = /^\*\*Related patterns\*\*/;
const RELATED_ITEM = /^\s*[-*]\s+(.*\S)\s*$/;
const ISSUE_REF = /\b(?:issue|pr|mr)s?\s*#\d+/gi;
// The six Types the methodology fixes (references/methodology.md, "Classification").
export const PATTERN_TYPES = ['Simplification', 'Abstraction', 'Constraint', 'Prioritization', 'Delegation', 'Temporal'];
const TAG = /^`\[Domain: ([^|\]]+?)\s*\|\s*Type: ([^\]]+?)\s*\]`/;

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

// Each entry also carries `related`: the text of every list item under its
// `**Related patterns**` heading (the list ends at the next non-blank line that
// is not an item). The index printed to the agent omits it; lint reads it.
export function parsePatternEntries(text) {
  const entries = [];
  let current = null;
  let inRelated = false;
  for (const line of text.split('\n')) {
    const heading = line.match(ENTRY_HEADING);
    if (heading) {
      current = { number: Number(heading[1]), title: heading[2], domain: null, type: null, reinforced: 0, related: [], reinforcedLines: [] };
      entries.push(current);
      inRelated = false;
      continue;
    }
    if (!current) continue;
    if (REINFORCED_LIKE.test(line)) current.reinforcedLines.push(line);
    if (inRelated) {
      const item = line.match(RELATED_ITEM);
      // A "- **Reinforced (...)**" bullet is a Reinforced block, not a relation: it ends the list.
      if (item && !REINFORCED.test(item[1])) { current.related.push(item[1]); continue; }
      if (line.trim() === '') continue;
      // A wrapped bullet continues the previous item; a bold label, a
      // separator or a heading ends the list.
      if (!item && !/^(\*\*|---|#)/.test(line) && current.related.length > 0) {
        current.related[current.related.length - 1] += ` ${line.trim()}`;
        continue;
      }
      inRelated = false;
    }
    const tag = line.match(TAG);
    if (tag && current.domain === null) {
      current.domain = tag[1].trim();
      current.type = tag[2].trim();
    } else if (REINFORCED.test(line)) {
      current.reinforced += 1;
    } else if (RELATED_HEADING.test(line)) {
      inRelated = true;
    }
  }
  return entries;
}

// Locating a number-less "Related patterns" line among entry titles: the full
// title (case-insensitive) wins; otherwise the title's prefix before its first
// dash/em-dash separator, but only when that prefix is at least 8 characters
// and belongs to exactly one entry. Anything ambiguous locates nothing.
function titleLocator(entries) {
  const full = entries.map(e => ({ number: e.number, key: String(e.title).trim().toLowerCase() })).filter(k => k.key.length >= 2);
  const prefixCounts = new Map();
  const prefixes = entries.map(e => ({ number: e.number, key: String(e.title).split(/\s[—–-]\s|—/)[0].trim().toLowerCase() })).filter(k => k.key.length >= 8);
  for (const k of prefixes) prefixCounts.set(k.key, (prefixCounts.get(k.key) || 0) + 1);
  return (text, self) => {
    const lower = text.toLowerCase();
    const exact = full.filter(k => k.number !== self && lower.includes(k.key));
    if (exact.length === 1) return exact[0].number;
    if (exact.length > 1) return null;
    const byPrefix = prefixes.filter(k => k.number !== self && prefixCounts.get(k.key) === 1 && lower.includes(k.key));
    return byPrefix.length === 1 ? byPrefix[0].number : null;
  };
}

// Read-only drift report against the methodology: Type outside the fixed six,
// possible compound Domain (owner check), Related lines with no #N (and whether the name they use can
// be located among entry titles), #N that resolve to no entry. Reports only —
// nothing here changes the file.
export function lintPatternEntries(entries) {
  const numbers = new Set(entries.map(e => e.number));
  const locate = titleLocator(entries);
  const typeOff = [];
  const compound = [];
  const withoutNumber = [];
  const dangling = [];
  const reinforcedOff = [];
  let relatedLines = 0;
  for (const e of entries) {
    // A reinforcement header in any shape but the canonical one: bulleted, `Day N` or another
    // qualifier inside the parentheses, the date in the text, or a different label.
    for (const line of e.reinforcedLines || []) {
      if (!REINFORCED_CANONICAL.test(line)) reinforcedOff.push({ number: e.number, line: line.length > 120 ? `${line.slice(0, 117)}...` : line });
    }
    if (e.type !== null && !PATTERN_TYPES.includes(e.type)) typeOff.push({ number: e.number, type: e.type });
    // Issue #4 names three compound shapes: "A/B", "A, B", "A & B". All three are
    // reported, with the separator found, so the owner can tell them apart: the
    // Domain set is owner-defined and open, and an "&" may be one legal name
    // ("Data & Metrics" in the methodology), which the report flags for a check
    // rather than declares wrong.
    const sep = e.domain === null ? null : e.domain.match(/[/,&]/);
    if (sep) compound.push({ number: e.number, domain: e.domain, separator: sep[0] });
    for (const text of e.related) {
      relatedLines += 1;
      // "Issue #687" / "PR #12" name tickets and are not references. Every other
      // #N is taken as an entry reference; one that resolves to no entry is
      // dangling — a bare ticket number written without its word is reported
      // too, and the owner rewrites the line to say what it is.
      const refs = [...text.replace(ISSUE_REF, '').matchAll(/#(\d+)/g)].map(m => Number(m[1]));
      if (refs.length === 0) {
        withoutNumber.push({ number: e.number, text: text.length > 120 ? `${text.slice(0, 117)}...` : text, located: locate(text, e.number) });
      } else {
        for (const ref of refs) if (!numbers.has(ref)) dangling.push({ number: e.number, ref });
      }
    }
  }
  return {
    type_off_vocabulary: typeOff,
    compound_domain: compound,
    related_without_number: withoutNumber,
    related_dangling: dangling,
    reinforced_off_format: reinforcedOff,
    summary: {
      type_off_vocabulary: typeOff.length,
      compound_domain: compound.length,
      related_lines: relatedLines,
      related_without_number: withoutNumber.length,
      related_located: withoutNumber.filter(x => x.located !== null).length,
      related_dangling: dangling.length,
      reinforced_off_format: reinforcedOff.length
    }
  };
}

const EMPTY_PATTERNS = { exists: false, entry_count: 0, max_number: 0, next_number: 1, reinforced_count: 0, domains: {}, types: {}, entries: [], lint: lintPatternEntries([]) };

export function inspectPatternsFile(patternsFile) {
  if (!patternsFile) return { patterns_file: null, ...EMPTY_PATTERNS };
  const resolved = expandHome(patternsFile);
  if (!fs.existsSync(resolved)) return { patterns_file: resolved, ...EMPTY_PATTERNS };
  const entries = parsePatternEntries(fs.readFileSync(resolved, 'utf8'));
  const maxNumber = entries.reduce((max, e) => Math.max(max, e.number), 0);
  const tagged = entries.filter(e => e.domain !== null);
  return {
    patterns_file: resolved,
    exists: true,
    entry_count: entries.length,
    max_number: maxNumber,
    next_number: maxNumber + 1,
    reinforced_count: entries.reduce((sum, e) => sum + e.reinforced, 0),
    domains: tally(tagged.map(e => e.domain)),
    types: tally(tagged.map(e => e.type)),
    entries: entries.map(({ related, reinforcedLines, ...index }) => index),
    lint: lintPatternEntries(entries)
  };
}

// C4 stores timestamps as "YYYY-MM-DD HH:MM:SS" in UTC (SQLite CURRENT_TIMESTAMP).
export function parseC4Timestamp(value) {
  const ms = Date.parse(`${String(value).trim().replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid C4 timestamp: ${value}`);
  return ms;
}

// The owner's time zone: TZ from the zylos .env (inherited by every process the
// agent runs), else the system zone.
export function localTimeZone() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// "YYYY-MM-DD HH:MM:SS +08:00": wall-clock time in the owner's zone with the
// UTC offset always spelled out, so no reader has to guess which zone a time
// belongs to. Comparisons never use this form; they stay in epoch ms.
export function formatLocalTimestamp(ms, timeZone = localTimeZone()) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset'
    });
  } catch {
    throw new Error(`Invalid time zone: ${timeZone}`);
  }
  const p = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${offset}`;
}

// Transcript in the same shape c4-fetch.js prints, built directly from rows.
// Rows carry `_ms` (epoch) from the fetch; timestamps are printed in the
// owner's zone with the offset, never as the zone-less UTC string C4 stores.
export function formatTranscript(rows, window) {
  const lines = [`[Conversations] (window ${window.begin} ~ ${window.end}, time zone ${window.time_zone}, lookback ${window.lookback}, ${rows.length} messages)`];
  for (const row of rows) {
    lines.push(`[${formatLocalTimestamp(row._ms, window.time_zone)}] ${String(row.direction).toUpperCase()} (${row.channel}:${row.endpoint_id ?? ''}):`);
    lines.push(String(row.content ?? ''));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
