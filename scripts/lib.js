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
export const SCHEDULER_CLI_INSTALLED = '~/zylos/.claude/skills/scheduler/scripts/cli.js';
export const TASK_NAME = 'thinking-patterns';

// A policy.md that still carries this marker has not been filled in by the owner.
export const UNCONFIGURED_MARKER = '<!-- thinking-patterns: UNCONFIGURED -->';

export const DEFAULT_CONFIG = {
  enabled: true,
  min_conversations: 30,
  max_conversations: 300,
  patterns_file: '~/zylos/memory/thinking-patterns.md',
  c4_db_cli: '~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js',
  c4_fetch_script: '~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js'
};

export const DEFAULT_STATE = {
  schema_version: 1,
  last_processed_id: 0,
  last_observed_id: 0,
  last_run_at: null,
  last_result: null,
  last_update_at: null
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

export function schedulerPrompt() {
  return `Run the thinking-patterns skill. Load and follow ${SKILL_MD_INSTALLED}. Use its required background-subagent execution model; the main session should only orchestrate and mark the scheduler task done after the subagent completes.`;
}

export function schedulerTemplate() {
  const prompt = schedulerPrompt();
  return [
    '# Scheduler task template for thinking-patterns',
    '',
    'The owner decides when extraction runs. Pick a cron expression in the',
    'scheduler timezone (a nightly run after the working day is typical), then',
    'register the task once:',
    '',
    `node ${SCHEDULER_CLI_INSTALLED} add "${prompt}" --cron "50 23 * * *" --priority 3 --name ${TASK_NAME}`,
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

export function normalizeId(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`Invalid conversation id: ${value}`);
  }
  return numeric;
}

export function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...state,
    schema_version: 1,
    last_processed_id: normalizeId(state.last_processed_id, 0),
    last_observed_id: normalizeId(state.last_observed_id, 0)
  };
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

// Message headers as printed by c4-fetch.js: "[YYYY-MM-DD HH:MM:SS] IN (channel:endpoint):"
const MESSAGE_HEADER = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] (?:IN|OUT) \(/gm;

export function countMessages(transcript) {
  return [...transcript.matchAll(MESSAGE_HEADER)].length;
}
