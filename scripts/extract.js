#!/usr/bin/env node
// thinking-patterns CLI: time-window fetch, run state and templates.
// It never reads c4.db directly — every C4 access goes through the comm-bridge CLI
// (c4-db.js recent) — and it never writes the pattern file. Judgment belongs to the agent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONFIG_PATH, STATE_PATH, LOG_DIR, RUN_LOG_PATH, METHODOLOGY_PATH,
  DEFAULT_CONFIG, SCHEDULE_QUESTIONS, POLICY_TEMPLATE,
  atomicWriteJson, ensureDir, expandHome, formatLocalTimestamp, formatTranscript, inspectPatternsFile,
  loadConfig, loadState, localTimeZone, normalizePolicyName, normalizeTaskName, parseC4Timestamp, parseDuration, readPolicy,
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
// each with its content — exactly the primitive a time window needs. Its output
// goes to a private temp file, not a pipe buffer, so a page can be measured
// before anything is parsed: a page larger than maxBytes is discarded unread
// (`rows: null`) instead of failing with ENOBUFS or being parsed into memory.
// What this bounds is this process: the comm-bridge CLI still builds the whole
// page in its own memory and the page still lands on temp disk before it is
// measured. A time-range or content-less primitive on the C4 side is the only
// way to bound those; until then that residual cost is documented, not closed.
function recentPage(c4DbCli, limit, maxBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-patterns-'));
  const file = path.join(dir, 'recent.json');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    let result;
    try {
      result = spawnSync('node', [c4DbCli, 'recent', String(limit)], { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' });
    } finally {
      fs.closeSync(fd);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`c4-db.js recent ${limit} failed (exit ${result.status}): ${String(result.stderr).trim()}`);
    const bytes = fs.statSync(file).size;
    if (bytes > maxBytes) return { rows: null, bytes };
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return { rows: [], bytes };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('c4-db.js recent did not return a JSON array');
    return { rows: parsed.map(row => ({ ...row, _ms: parseC4Timestamp(row.timestamp) })), bytes };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `recent N` has no time-range parameter, so ask for a growing page until the
// oldest row returned is older than the window start (or the database has no
// more rows). Only then are all in-window rows in hand for filtering and
// capping. The first page is one row beyond the cap, so the common case
// (a window smaller than the cap) still costs a single call.
//
// The read is bounded by max_page_bytes: when the next page would exceed it,
// the previous page (the newest rows, all inside the window) is used and
// `complete: false` says the oldest part of the window was not read. The
// cost of larger pages is then never paid, whatever the messages contain.
function windowRows(c4DbCli, beginMs, firstPage, maxBytes) {
  let limit = firstPage;
  let previous = null;
  for (;;) {
    const { rows, bytes } = recentPage(c4DbCli, limit, maxBytes);
    if (rows === null) {
      if (previous === null) {
        throw new Error(`c4-db.js recent ${limit} returned ${bytes} bytes, over max_page_bytes (${maxBytes}); lower max_conversations or raise max_page_bytes in config.json`);
      }
      return { rows: previous, complete: false };
    }
    if (rows.length < limit || rows[0]._ms < beginMs) return { rows, complete: true };
    previous = rows;
    limit *= 2;
  }
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
  const maxPageBytes = Number(config.max_page_bytes ?? DEFAULT_CONFIG.max_page_bytes);
  if (!Number.isSafeInteger(maxPageBytes) || maxPageBytes < 1) {
    throw new Error(`Invalid max_page_bytes: ${config.max_page_bytes}`);
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
    max_page_bytes: maxPageBytes,
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
  // Order matters: window → channel filter → cap. The cap is applied to the
  // messages the agent would actually read, so `truncated` means "the window
  // holds more in-scope messages than max_conversations", and rows that the
  // filter removes never use up the cap. When the read bound stopped the
  // paging early (window_complete: false) the oldest part of the window is
  // unknown: truncated is set and truncated_out is null.
  const read = windowRows(c4DbCli, beginMs, maxConversations + 1, maxPageBytes);
  const inWindow = read.rows.filter(row => row._ms >= beginMs && row._ms <= endMs);
  const include = policy.channels === null ? null : new Set(policy.channels);
  const exclude = new Set(policy.exclude_channels);
  const inScope = inWindow.filter(row => (include === null || include.has(row.channel)) && !exclude.has(row.channel));
  const capped = inScope.length > maxConversations;
  // Rows are oldest-first; when capping, keep the newest and leave out the oldest.
  const rows = capped ? inScope.slice(inScope.length - maxConversations) : inScope;
  const envelope = {
    ...base,
    count: rows.length,
    filtered_out: inWindow.length - inScope.length,
    truncated: capped || !read.complete,
    truncated_out: read.complete ? inScope.length - rows.length : null,
    window_complete: read.complete
  };

  if (rows.length < minConversations) {
    // Below threshold on an incomplete read is not "the window was quiet":
    // the unread, older part may hold enough. Say so, and what the owner can do.
    if (!read.complete) {
      outputJson({
        status: 'skip', reason: 'incomplete_read', ...envelope,
        owner_action: `only the newest ${read.rows.length} rows of the window fit under max_page_bytes (${maxPageBytes}) and they hold ${rows.length} in-scope messages, below min_conversations (${minConversations}); raise max_page_bytes, shorten the lookback, or lower max_conversations`
      });
    }
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
