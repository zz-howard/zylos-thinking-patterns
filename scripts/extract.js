#!/usr/bin/env node
// thinking-patterns CLI: time-window fetch, run state and templates.
// It never reads c4.db directly — every C4 access goes through the comm-bridge CLI
// (c4-db.js recent) — and it never writes the pattern file. Judgment belongs to the agent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  CONFIG_PATH, STATE_PATH, LOG_DIR, RUN_LOG_PATH, METHODOLOGY_PATH,
  DEFAULT_CONFIG, SCHEDULE_QUESTIONS, POLICY_TEMPLATE,
  atomicWriteJson, ensureDir, expandHome, formatLocalTimestamp, formatTranscript, inspectPatternsFile,
  loadConfig, loadState, localTimeZone, normalizePolicyName, normalizeTaskName, parseC4Timestamp, parseDuration, readPolicy, run,
  schedulerPrompt, schedulerTaskName, schedulerTemplate
} from './lib.js';

// Synchronous write: on a pipe, process.stdout.write is asynchronous and a
// following process.exit would truncate large payloads (a 7d transcript is
// hundreds of KB). fs.writeSync completes before exit.
function writeOut(text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(process.stdout.fd, buffer, offset);
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err;
    }
  }
}

function outputJson(value, exitCode = 0) {
  writeOut(`${JSON.stringify(value, null, 2)}\n`);
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

function optional(args, key) {
  return args[key] === undefined || args[key] === true ? null : String(args[key]);
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

function policySummary(policy) {
  return {
    policy: policy.policy,
    policy_file: policy.policy_file,
    policy_unconfigured: policy.unconfigured,
    policy_placeholders: policy.placeholders,
    filters: { channels: policy.channels, exclude_channels: policy.exclude_channels },
    patterns: inspectPatternsFile(policy.patterns_file)
  };
}

function commandFetch(args) {
  const config = loadConfig();
  const task = normalizeTaskName(args.task);
  const policy = readPolicy(normalizePolicyName(args.policy));
  const lookbackText = optional(args, 'lookback') ?? String(config.default_lookback ?? DEFAULT_CONFIG.default_lookback);
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
  // Window bounds are computed in epoch ms and only rendered in the owner's
  // zone (with offset); C4's own UTC strings never reach the agent.
  const timeZone = localTimeZone();
  const window = { begin: formatLocalTimestamp(beginMs, timeZone), end: formatLocalTimestamp(endMs, timeZone), time_zone: timeZone, lookback: lookbackText };
  const base = {
    task,
    window,
    count: 0,
    min_conversations: minConversations,
    max_conversations: maxConversations,
    ...policySummary(policy),
    methodology_file: METHODOLOGY_PATH,
    state_file: STATE_PATH
  };

  if (config.enabled === false) {
    outputJson({ status: 'skip', reason: 'disabled', ...base });
  }
  if (policy.unconfigured) {
    outputJson({
      status: 'skip', reason: 'unconfigured', ...base,
      owner_action: policy.exists
        ? `${policy.policy_file} still carries the UNCONFIGURED marker; ask the owner to fill it in`
        : `${policy.policy_file} does not exist; ask the owner for the policy (print a template with \`extract.js template --policy\`)`
    });
  }
  if (!policy.patterns_file) {
    outputJson({
      status: 'skip', reason: 'unconfigured', ...base,
      owner_action: `${policy.policy_file} has no "Patterns file:" line under ## Target; ask the owner which file the patterns go to`
    });
  }

  const c4DbCli = requireScript(config.c4_db_cli, 'c4-db.js');
  // One row beyond the cap is a sentinel: if it exists and lies inside the
  // window, older in-window rows exist that this run will not read. It is
  // never part of the transcript.
  const page = recentRows(c4DbCli, maxConversations + 1);
  const sentinel = page.length > maxConversations ? page[0] : null;
  const recent = sentinel ? page.slice(1) : page;
  const truncated = sentinel !== null && sentinel._ms >= beginMs && sentinel._ms <= endMs;
  const inWindow = recent.filter(row => row._ms >= beginMs && row._ms <= endMs);
  const include = policy.channels === null ? null : new Set(policy.channels);
  const exclude = new Set(policy.exclude_channels);
  const rows = inWindow.filter(row => (include === null || include.has(row.channel)) && !exclude.has(row.channel));
  const envelope = { ...base, count: rows.length, filtered_out: inWindow.length - rows.length, truncated };

  if (rows.length < minConversations) {
    outputJson({ status: 'skip', reason: 'below_threshold', ...envelope });
  }
  outputJson({
    status: 'ready',
    ...envelope,
    conversations: formatTranscript(rows, window)
  });
}

function commandCommit(args) {
  const result = args.result;
  if (!['skip', 'no_change', 'updated'].includes(result)) {
    throw new Error('commit requires --result skip|no_change|updated');
  }
  const task = normalizeTaskName(args.task);
  const policy = normalizePolicyName(args.policy);
  const state = loadState();
  const now = new Date().toISOString();
  const windowEnd = optional(args, 'window-end');
  const lookback = optional(args, 'lookback');

  const nextState = {
    ...state,
    last_run_at: now,
    last_result: result,
    last_window: { task, policy, lookback, end: windowEnd }
  };
  if (result === 'updated') nextState.last_update_at = now;

  atomicWriteJson(STATE_PATH, nextState);
  ensureDir(LOG_DIR);
  fs.appendFileSync(RUN_LOG_PATH, `${JSON.stringify({
    timestamp: now,
    task,
    policy,
    result,
    lookback,
    window_end: windowEnd,
    state_hash: crypto.createHash('sha256').update(JSON.stringify(nextState)).digest('hex')
  })}\n`);

  outputJson({
    status: 'committed',
    task,
    policy,
    result,
    last_run_at: nextState.last_run_at,
    last_update_at: nextState.last_update_at
  });
}

function commandInspect(args) {
  const policy = readPolicy(normalizePolicyName(args.policy));
  outputJson({ status: 'ok', ...policySummary(policy), methodology_file: METHODOLOGY_PATH });
}

function commandStatus(args) {
  const config = loadConfig();
  const policy = readPolicy(normalizePolicyName(args.policy));
  outputJson({
    status: 'ok',
    config_file: CONFIG_PATH,
    config,
    state_file: STATE_PATH,
    state: loadState(),
    ...policySummary(policy)
  });
}

function commandTemplate(args) {
  if (args.policy === true) {
    writeOut(POLICY_TEMPLATE);
    process.exit(0);
  }
  const lookback = optional(args, 'lookback') ?? loadConfig().default_lookback;
  parseDuration(lookback);
  const task = normalizeTaskName(args.task);
  const policy = normalizePolicyName(args.policy);
  const cron = optional(args, 'cron') ?? '50 23 * * *';
  if (args.json) {
    outputJson({
      status: 'ok',
      task,
      policy,
      lookback,
      cron,
      scheduler_task_name: schedulerTaskName(task, policy),
      scheduler_prompt: schedulerPrompt(lookback, task, policy),
      questions: SCHEDULE_QUESTIONS,
      template: schedulerTemplate(lookback, task, cron, policy)
    });
  }
  writeOut(schedulerTemplate(lookback, task, cron, policy));
  process.exit(0);
}

function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  try {
    if (command === 'fetch') commandFetch(args);
    if (command === 'commit') commandCommit(args);
    if (command === 'inspect') commandInspect(args);
    if (command === 'status') commandStatus(args);
    if (command === 'template') commandTemplate(args);
    outputJson({
      status: 'error',
      error: 'Usage: extract.js fetch [--lookback 24h] [--task name] [--policy name] | commit --result <skip|no_change|updated> [--task name] [--policy name] [--lookback 24h] [--window-end "YYYY-MM-DD HH:MM:SS +HH:MM"] | inspect [--policy name] | status [--policy name] | template [--policy | --policy name] [--lookback 24h] [--task name] [--cron "50 23 * * *"] [--json]'
    }, 1);
  } catch (err) {
    outputError(err.message);
  }
}

main();
