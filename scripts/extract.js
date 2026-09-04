#!/usr/bin/env node
// thinking-patterns CLI: time-window fetch, run state and templates.
// It never reads c4.db directly — every C4 access goes through the comm-bridge CLI
// (c4-db.js recent) — and it never writes the pattern file. Judgment belongs to the agent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  CONFIG_PATH, POLICY_PATH, STATE_PATH, LOG_DIR, RUN_LOG_PATH, METHODOLOGY_PATH,
  DEFAULT_CONFIG, SCHEDULE_QUESTIONS, POLICY_TEMPLATE,
  atomicWriteJson, ensureDir, expandHome, formatC4Timestamp, formatTranscript, inspectPatternsFile,
  loadConfig, loadState, normalizeTaskName, parseC4Timestamp, parseDuration, policyIsUnconfigured, run,
  schedulerPrompt, schedulerTaskName, schedulerTemplate
} from './lib.js';

function outputJson(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(exitCode);
}

function outputError(message) {
  outputJson({ status: 'error', error: message }, 1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return { command, args };
}

function requireScript(filePath, label) {
  const resolved = expandHome(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  return resolved;
}

// `c4-db.js recent N` returns the N newest rows ordered by timestamp, oldest first,
// each with its content — exactly the primitive a time window needs.
function recentRows(c4DbCli, limit) {
  const raw = run('node', [c4DbCli, 'recent', String(limit)]).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('c4-db.js recent did not return a JSON array');
  return parsed.map(row => ({ ...row, _ms: parseC4Timestamp(row.timestamp) }));
}

function commandFetch(args) {
  const config = loadConfig();
  const task = normalizeTaskName(args.task);
  const lookbackText = args.lookback === undefined || args.lookback === true
    ? String(config.default_lookback ?? DEFAULT_CONFIG.default_lookback)
    : String(args.lookback);
  const lookbackMs = parseDuration(lookbackText);
  const minConversations = Number(config.min_conversations ?? DEFAULT_CONFIG.min_conversations);
  if (!Number.isSafeInteger(minConversations) || minConversations < 1) {
    throw new Error(`Invalid min_conversations: ${config.min_conversations}`);
  }
  const maxConversations = Number(config.max_conversations ?? DEFAULT_CONFIG.max_conversations);
  if (!Number.isSafeInteger(maxConversations) || maxConversations < 1) {
    throw new Error(`Invalid max_conversations: ${config.max_conversations}`);
  }

  const endMs = Date.now();
  const beginMs = endMs - lookbackMs;
  const window = { begin: formatC4Timestamp(beginMs), end: formatC4Timestamp(endMs), lookback: lookbackText };
  const base = {
    task,
    window,
    count: 0,
    min_conversations: minConversations,
    max_conversations: maxConversations,
    patterns: inspectPatternsFile(config.patterns_file),
    policy_file: POLICY_PATH,
    methodology_file: METHODOLOGY_PATH,
    state_file: STATE_PATH
  };

  if (config.enabled === false) {
    outputJson({ status: 'skip', reason: 'disabled', ...base });
  }
  if (policyIsUnconfigured(POLICY_PATH)) {
    outputJson({ status: 'skip', reason: 'unconfigured', ...base, owner_action: 'policy.md still carries the UNCONFIGURED marker; ask the owner to fill it in' });
  }

  const c4DbCli = requireScript(config.c4_db_cli, 'c4-db.js');
  const recent = recentRows(c4DbCli, maxConversations);
  const rows = recent.filter(row => row._ms >= beginMs && row._ms <= endMs);
  // If the cap returned a full page and its oldest row is already inside the
  // window, older in-window rows exist that this run cannot see.
  const truncated = recent.length >= maxConversations && rows.length === recent.length;
  const envelope = { ...base, count: rows.length, truncated };

  if (rows.length < minConversations) {
    outputJson({ status: 'skip', reason: 'below_threshold', ...envelope });
  }
  outputJson({
    status: 'ready',
    ...envelope,
    conversations: formatTranscript(rows.map(({ _ms, ...row }) => row), window)
  });
}

function commandCommit(args) {
  const result = args.result;
  if (!['skip', 'no_change', 'updated'].includes(result)) {
    throw new Error('commit requires --result skip|no_change|updated');
  }
  const task = normalizeTaskName(args.task);
  const state = loadState();
  const now = new Date().toISOString();
  const windowEnd = args['window-end'] === undefined || args['window-end'] === true ? null : String(args['window-end']);
  const lookback = args.lookback === undefined || args.lookback === true ? null : String(args.lookback);

  const nextState = {
    ...state,
    last_run_at: now,
    last_result: result,
    last_window: { task, lookback, end: windowEnd }
  };
  if (result === 'updated') nextState.last_update_at = now;

  atomicWriteJson(STATE_PATH, nextState);
  ensureDir(LOG_DIR);
  fs.appendFileSync(RUN_LOG_PATH, `${JSON.stringify({
    timestamp: now,
    task,
    result,
    lookback,
    window_end: windowEnd,
    state_hash: crypto.createHash('sha256').update(JSON.stringify(nextState)).digest('hex')
  })}\n`);

  outputJson({
    status: 'committed',
    task,
    result,
    last_run_at: nextState.last_run_at,
    last_update_at: nextState.last_update_at
  });
}

function commandInspect() {
  const config = loadConfig();
  outputJson({
    status: 'ok',
    ...inspectPatternsFile(config.patterns_file),
    policy_file: POLICY_PATH,
    policy_unconfigured: policyIsUnconfigured(POLICY_PATH),
    methodology_file: METHODOLOGY_PATH
  });
}

function commandStatus() {
  const config = loadConfig();
  outputJson({
    status: 'ok',
    config_file: CONFIG_PATH,
    config,
    state_file: STATE_PATH,
    state: loadState(),
    policy_file: POLICY_PATH,
    policy_unconfigured: policyIsUnconfigured(POLICY_PATH),
    patterns: inspectPatternsFile(config.patterns_file)
  });
}

function commandTemplate(args) {
  if (args.policy) {
    process.stdout.write(POLICY_TEMPLATE);
    process.exit(0);
  }
  const lookback = args.lookback === undefined || args.lookback === true ? loadConfig().default_lookback : String(args.lookback);
  parseDuration(lookback);
  const task = normalizeTaskName(args.task);
  const cron = args.cron === undefined || args.cron === true ? '50 23 * * *' : String(args.cron);
  if (args.json) {
    outputJson({
      status: 'ok',
      task,
      lookback,
      cron,
      scheduler_task_name: schedulerTaskName(task),
      scheduler_prompt: schedulerPrompt(lookback, task),
      questions: SCHEDULE_QUESTIONS,
      template: schedulerTemplate(lookback, task, cron)
    });
  }
  process.stdout.write(schedulerTemplate(lookback, task, cron));
  process.exit(0);
}

function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  try {
    if (command === 'fetch') commandFetch(args);
    if (command === 'commit') commandCommit(args);
    if (command === 'inspect') commandInspect();
    if (command === 'status') commandStatus();
    if (command === 'template') commandTemplate(args);
    outputJson({
      status: 'error',
      error: 'Usage: extract.js fetch [--lookback 24h] [--task name] | commit --result <skip|no_change|updated> [--task name] [--lookback 24h] [--window-end "YYYY-MM-DD HH:MM:SS"] | inspect | status | template [--policy] [--lookback 24h] [--task name] [--cron "50 23 * * *"] [--json]'
    }, 1);
  } catch (err) {
    outputError(err.message);
  }
}

main();
