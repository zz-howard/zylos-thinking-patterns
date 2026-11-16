#!/usr/bin/env node
// thinking-patterns CLI: checkpoint materials, explicit legacy fetch and run state.
// It never reads c4.db directly — every C4 access goes through the comm-bridge CLI
// Pattern proposals are published only through the explicit write command.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectMaterials, traceMaterials, commitMaterials, saveArtifact, materialFailureReason } from './materials.js';
import { writePatterns } from './pattern-write.js';
import {
  ZYLOS_DIR, DATA_DIR, CONFIG_PATH, STATE_PATH, LOG_DIR, RUN_LOG_PATH, METHODOLOGY_PATH,
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
// What this process parses is bounded by max_page_bytes: a page over it is
// discarded unread and the previous page (the newest rows; the caller still
// applies the window, so rows newer than `end` are dropped) is used with
// `complete: false`, meaning the oldest part of the window was not read. The
// over-sized page has still been produced by the CLI and written to temp disk
// before it is measured; only its parsing is skipped.
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

function commandLegacyFetch(args, fallbackReason) {
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
    mode: 'legacy_time_window',
    fallback_reason: typeof fallbackReason === 'string' ? fallbackReason : materialFailureReason(fallbackReason),
    fallback_detail: typeof fallbackReason === 'string' ? undefined : fallbackReason?.message,
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
  // Core supplies readable history. Count its JSON bytes and format its text
  // unchanged; do not project the output a second time.
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
  const inScope = inWindow.filter(row => (include === null || include.has(row.channel)) && !exclude.has(row.channel) && !String(row.content ?? '').startsWith('[Scheduled Task:'));
  const capped = inScope.length > maxConversations;
  // Rows are oldest-first; when capping, keep the newest and leave out the oldest.
  const rows = capped ? inScope.slice(inScope.length - maxConversations) : inScope;
  const envelope = {
    ...base,
    count: rows.length,
    filtered_out: inWindow.length - inScope.length,
    truncated: capped || !read.complete,
    truncated_out: read.complete ? inScope.length - rows.length : null,
    window_complete: read.complete,
    report: { legacy: { count: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)), characters: rows.reduce((n, row) => n + [...String(row.content ?? '')].length, 0) } }
  };

  if (rows.length < minConversations) {
    // Below threshold on an incomplete read is not "the window was quiet":
    // the unread, older part may hold enough. Say so, and what the owner can do.
    if (!read.complete) {
      outputJson({
        status: 'skip', reason: 'incomplete_read', ...envelope,
        owner_action: `the read stopped at max_page_bytes (${maxPageBytes}) after the newest ${read.rows.length} rows; those inside the window hold ${rows.length} in-scope messages, below min_conversations (${minConversations}), and the older part of the window is unread; raise max_page_bytes, shorten the lookback, or lower max_conversations`
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

function scopeKey(args) { return `${normalizePolicyName(args.policy)}:${normalizeTaskName(args.task)}`; }
function materialFile(id) {
  if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid run id');
  return path.join(DATA_DIR, 'materials', `${id}.json`);
}
function readRun(id) { return JSON.parse(fs.readFileSync(materialFile(id), 'utf8')); }
function commandFetch(args) {
  const config = loadConfig();
  const policy = readPolicy(normalizePolicyName(args.policy));
  if (config.enabled === false || policy.unconfigured || !policy.patterns_file) return commandLegacyFetch(args, 'checkpoint collection not started: disabled or unconfigured');
  const state = loadState();
  const key = scopeKey(args);
  const scope = state.material_scopes?.[key] ?? {};
  let run;
  if (scope.active_run) run = readRun(scope.active_run);
  else {
    if (scope.write_pending) {
      delete scope.write_pending;
      state.material_scopes = { ...state.material_scopes, [key]: scope };
      atomicWriteJson(STATE_PATH, state);
    }
    try {
      run = collectMaterials(config, scope, { channels: policy.channels, exclude_channels: policy.exclude_channels });
    } catch (err) {
      return commandLegacyFetch(args, err);
    }
    run.scope = key;
    if (run.ranges.length || scope.pending_clues?.length) {
      saveArtifact(path.join(DATA_DIR, 'materials'), run, config.artifact_retention_days);
      state.material_scopes = { ...state.material_scopes, [key]: { ...scope, active_run: run.run_id } };
      atomicWriteJson(STATE_PATH, state);
    }
  }
  const ready = run.ranges.length > 0 || scope.pending_clues?.length > 0;
  outputJson({ status: ready ? 'ready' : 'skip', reason: ready ? null : 'no_checkpoint_progress', ...run, completed_groups: scope.completed_groups ?? [], ...policySummary(policy), filters: run.filters, methodology_file: METHODOLOGY_PATH, state_file: STATE_PATH, artifact_file: ready ? materialFile(run.run_id) : null });
}
function commandTrace(args) {
  const run = readRun(optional(args, 'run'));
  if (run.scope !== scopeKey(args)) throw new Error('Run belongs to another task/policy');
  const state = loadState();
  const scope = state.material_scopes?.[run.scope];
  if (scope?.active_run !== run.run_id) throw new Error('Run is no longer active');
  const file = optional(args, 'clues');
  const clues = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(clues)) throw new Error('Clues must be a JSON array');
  traceMaterials(loadConfig(), scope, run, clues);
  saveArtifact(path.join(DATA_DIR, 'materials'), run, loadConfig().artifact_retention_days);
  atomicWriteJson(STATE_PATH, state);
  outputJson({ status: 'ready', run_id: run.run_id, trace_complete: run.trace_complete, traces: run.traces, report: run.trace_report, artifact_file: materialFile(run.run_id) });
}

function commandWrite(args) {
  const policy = readPolicy(normalizePolicyName(args.policy));
  if (policy.unconfigured || !policy.patterns_file) throw new Error('Pattern policy is unconfigured');
  const file = optional(args, 'file'), sha256 = optional(args, 'sha256');
  if (!file || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('write requires --file and raw-byte --sha256');
  const state = loadState(), key = scopeKey(args), scope = state.material_scopes?.[key] ?? {};
  const runId = optional(args, 'run');
  if (scope.active_run && runId !== scope.active_run) throw new Error('Pattern write requires the active --run');
  if (runId && (readRun(runId).scope !== key || scope.active_run !== runId)) throw new Error('Run is no longer active for this task/policy');
  // Persist refusal before invoking a writer so interrupted writes cannot advance.
  scope.write_pending = runId ?? 'legacy';
  state.material_scopes = { ...state.material_scopes, [key]: scope };
  atomicWriteJson(STATE_PATH, state);
  const result = writePatterns({ target: path.resolve(expandHome(policy.patterns_file)), file,
    sha256, writer: expandHome(loadConfig().memory_writer), memoryRoot: path.join(ZYLOS_DIR, 'memory') });
  if (result.status === 'updated') delete scope.write_pending;
  atomicWriteJson(STATE_PATH, state);
  outputJson(result);
}

function commandCommit(args) {
  const result = args.result;
  if (!['skip', 'no_change', 'updated'].includes(result)) {
    throw new Error('commit requires --result skip|no_change|updated');
  }
  const task = normalizeTaskName(args.task);
  const policy = normalizePolicyName(args.policy);
  let state = loadState();
  const scope = state.material_scopes?.[scopeKey(args)];
  const pending = scope?.write_pending;
  if (result !== 'skip' && pending && pending === (optional(args, 'run') ?? scope.active_run ?? 'legacy')) throw new Error('Pattern write is pending; progress cannot advance until writing succeeds or this run is skipped');
  let finishedRun;
  let materialRun;
  const runId = optional(args, 'run');
  if (runId) {
    const run = readRun(runId);
    materialRun = run;
    const key = scopeKey(args);
    if (run.scope !== key || state.material_scopes?.[key]?.active_run !== runId) throw new Error('Run is no longer active for this task/policy');
    if (run.deferred_clues) state.material_scopes[key].pending_clues = run.deferred_clues;
    if (result !== 'skip') {
      const done = state.material_scopes[key].completed_groups ?? [];
      const groups = optional(args, 'groups')?.split(',') ?? run.ranges.map(r => r.session_group).filter(g => !done.includes(g));
      const scope = commitMaterials(state.material_scopes[key], run, groups);
      scope.completed_groups = [...new Set([...done, ...groups])];
      if (run.ranges.every(r => scope.completed_groups.includes(r.session_group))) {
        delete scope.active_run; delete scope.completed_groups;
        run.committed = true;
        finishedRun = run;
      }
      state = { ...state, material_scopes: { ...state.material_scopes, [key]: scope } };
      // Keep immutable artifact ranges available to the sibling component.
    } else {
      delete state.material_scopes[key].active_run;
      delete state.material_scopes[key].completed_groups;
      run.closed = true;
      finishedRun = run;
    }
  } else if (state.material_scopes?.[scopeKey(args)]?.active_run && result !== 'skip') {
    throw new Error('Checkpoint commit requires --run from fetch');
  }
  // Only a skip that closes the run (or a run-less fallback) releases the guard.
  if (result === 'skip' && scope && !scope.active_run) delete scope.write_pending;
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
  if (finishedRun) saveArtifact(path.join(DATA_DIR, 'materials'), finishedRun, loadConfig().artifact_retention_days);
  ensureDir(LOG_DIR);
  fs.appendFileSync(RUN_LOG_PATH, `${JSON.stringify({
    timestamp: now,
    task,
    policy,
    result,
    lookback,
    window_end: windowEnd,
    report: materialRun?.report ?? {},
    trace_report: materialRun?.trace_report ?? {},
    pending_clues: nextState.material_scopes?.[scopeKey(args)]?.pending_clues?.length ?? 0,
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
    if (command === 'trace') commandTrace(args);
    if (command === 'write') commandWrite(args);
    if (command === 'commit') commandCommit(args);
    if (command === 'inspect') commandInspect(args);
    if (command === 'status') commandStatus(args);
    if (command === 'template') commandTemplate(args);
    outputJson({
      status: 'error',
      error: 'Usage: extract.js fetch [--lookback 24h] [--task name] [--policy name] | trace --run UUID [--clues file.json] [--task name] [--policy name] | write --file DRAFT --sha256 HASH [--run UUID] [--task name] [--policy name] | commit --result <skip|no_change|updated> [--run UUID] [--groups G,H] [--task name] [--policy name] [--lookback 24h] [--window-end "YYYY-MM-DD HH:MM:SS +HH:MM"] | inspect [--policy name] | status [--policy name] | template [--policy | --policy name] [--lookback 24h] [--task name] [--cron "50 23 * * *"] [--json]'
    }, 1);
  } catch (err) {
    outputError(err.message);
  }
}

main();
