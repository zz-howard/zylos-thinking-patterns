import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOME = os.homedir();
export const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(HOME, 'zylos');
export const DATA_DIR = process.env.ZYLOS_DATA_DIR || path.join(ZYLOS_DIR, 'components/thinking-patterns');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const POLICY_PATH = path.join(DATA_DIR, 'policy.md');
export const STATE_PATH = path.join(DATA_DIR, 'state.json');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const RUN_LOG_PATH = path.join(LOG_DIR, 'runs.jsonl');
export const SKILL_DIR = path.resolve(import.meta.dirname, '..');
export const METHODOLOGY_PATH = path.join(SKILL_DIR, 'references/methodology.md');
export const SKILL_MD_INSTALLED = '~/zylos/.claude/skills/thinking-patterns/SKILL.md';
export const EXTRACT_INSTALLED = '~/zylos/.claude/skills/thinking-patterns/scripts/extract.js';
export const SCHEDULER_CLI_INSTALLED = '~/zylos/.claude/skills/scheduler/scripts/cli.js';
export const TASK_NAME_PREFIX = 'thinking-patterns';
export const DEFAULT_TASK = 'default';

// A policy.md that still carries this marker has not been filled in by the owner.
export const UNCONFIGURED_MARKER = '<!-- thinking-patterns: UNCONFIGURED -->';

export const DEFAULT_CONFIG = {
  enabled: true,
  min_conversations: 30,
  max_conversations: 300,
  default_lookback: '24h',
  patterns_file: '~/zylos/memory/thinking-patterns.md',
  c4_db_cli: '~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js'
};

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

## Sources

Which conversation streams count? All channels by default. Name channels or
groups to focus on, and any to ignore (for example, small talk channels).

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
  'A short task name, only when this is not the first scheduled task (e.g. daily, weekly) — several tasks may run with different lookbacks; they share the one policy and pattern file'
];

export function normalizeTaskName(value) {
  if (value === undefined || value === null || value === true || value === '') return DEFAULT_TASK;
  const name = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(`Invalid task name: "${value}" (letters, digits, - and _, up to 32 chars)`);
  }
  return name;
}

export function schedulerPrompt(lookback = DEFAULT_CONFIG.default_lookback, task = DEFAULT_TASK) {
  return `Run the thinking-patterns skill (task "${task}", lookback ${lookback}). Load and follow ${SKILL_MD_INSTALLED}. Use its required background-subagent execution model; the subagent's fetch step is \`node ${EXTRACT_INSTALLED} fetch --lookback ${lookback} --task ${task}\`, and every commit step must pass \`--task ${task}\`. The main session only orchestrates and marks the scheduler task done after the subagent completes.`;
}

export function schedulerTaskName(task = DEFAULT_TASK) {
  return task === DEFAULT_TASK ? TASK_NAME_PREFIX : `${TASK_NAME_PREFIX}-${task}`;
}

export function schedulerTemplate(lookback = DEFAULT_CONFIG.default_lookback, task = DEFAULT_TASK, cron = '50 23 * * *') {
  const prompt = schedulerPrompt(lookback, task);
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
    `node ${SCHEDULER_CLI_INSTALLED} add "${prompt}" --cron "${cron}" --priority 3 --name ${schedulerTaskName(task)}`,
    '',
    'Print a template for other values with:',
    '',
    `node ${EXTRACT_INSTALLED} template --lookback 7d --task weekly --cron "0 22 * * 0"`,
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
  const { last_processed_id, last_observed_id, ...rest } = state; // schema 1 leftovers are dropped
  return { ...DEFAULT_STATE, ...rest, schema_version: 2 };
}

export function loadState() {
  return normalizeState(readJson(STATE_PATH, DEFAULT_STATE));
}

export function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function policyIsUnconfigured(policyPath = POLICY_PATH) {
  if (!fs.existsSync(policyPath)) return true;
  return fs.readFileSync(policyPath, 'utf8').includes(UNCONFIGURED_MARKER);
}

// Pattern-file introspection. Entries are "## <N>. Title" headings; the next
// number is always max + 1, read from the file rather than from state, so a
// hand-edited file stays authoritative.
const ENTRY_HEADING = /^## (\d+)\. /gm;
const REINFORCED = /^\*\*Reinforced \(/gm;

export function inspectPatternsFile(patternsFile) {
  const resolved = expandHome(patternsFile);
  if (!fs.existsSync(resolved)) {
    return { patterns_file: resolved, exists: false, entry_count: 0, max_number: 0, next_number: 1, reinforced_count: 0 };
  }
  const text = fs.readFileSync(resolved, 'utf8');
  const numbers = [...text.matchAll(ENTRY_HEADING)].map(m => Number(m[1]));
  const maxNumber = numbers.length ? Math.max(...numbers) : 0;
  return {
    patterns_file: resolved,
    exists: true,
    entry_count: numbers.length,
    max_number: maxNumber,
    next_number: maxNumber + 1,
    reinforced_count: [...text.matchAll(REINFORCED)].length
  };
}

// C4 stores timestamps as "YYYY-MM-DD HH:MM:SS" in UTC (SQLite CURRENT_TIMESTAMP).
export function parseC4Timestamp(value) {
  const ms = Date.parse(`${String(value).trim().replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid C4 timestamp: ${value}`);
  return ms;
}

export function formatC4Timestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Transcript in the same shape c4-fetch.js prints, built directly from rows.
export function formatTranscript(rows, window) {
  const lines = [`[Conversations] (window ${window.begin} ~ ${window.end} UTC, lookback ${window.lookback}, ${rows.length} messages)`];
  for (const row of rows) {
    lines.push(`[${row.timestamp}] ${String(row.direction).toUpperCase()} (${row.channel}:${row.endpoint_id ?? ''}):`);
    lines.push(String(row.content ?? ''));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
