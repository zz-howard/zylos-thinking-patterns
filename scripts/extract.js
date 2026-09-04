#!/usr/bin/env node
// thinking-patterns CLI: cursor, threshold, state and templates.
// It never reads c4.db directly — every C4 access goes through the comm-bridge CLI
// (c4-db.js / c4-fetch.js) — and it never writes the pattern file. Judgment belongs to the agent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  CONFIG_PATH, POLICY_PATH, STATE_PATH, LOG_DIR, RUN_LOG_PATH, METHODOLOGY_PATH,
  DEFAULT_CONFIG,
  atomicWriteJson, countMessages, ensureDir, expandHome, inspectPatternsFile,
  loadConfig, loadState, normalizeId, policyIsUnconfigured, run,
  schedulerPrompt, schedulerTemplate, POLICY_TEMPLATE
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

// `c4-db.js recent N` returns the N newest rows ordered by timestamp, not id.
// Until zylos-core exposes an id-ordered range primitive (zylos-ai/zylos-core#775)
// we assume timestamp order ≈ id order within the newest N rows: the latest id is
// the max id among them, and the capped begin id is their min id. Neither
// assumption can lose rows inside the chosen window; skew only shifts which
// old backlog rows a capped first run leaves behind.
function recentRows(c4DbCli, limit) {
  const raw = run('node', [c4DbCli, 'recent', String(limit)]).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('c4-db.js recent did not return a JSON array');
  return parsed.map(row => ({ id: normalizeId(row.id, 0) }));
}

function commandFetch() {
  const config = loadConfig();
  const state = loadState();
  const patterns = inspectPatternsFile(config.patterns_file);
  const base = {
    begin_id: state.last_processed_id + 1,
    end_id: state.last_processed_id,
    count: 0,
    min_conversations: Number(config.min_conversations ?? DEFAULT_CONFIG.min_conversations),
    patterns: patterns,
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
  if (!Number.isSafeInteger(base.min_conversations) || base.min_conversations < 1) {
    throw new Error(`Invalid min_conversations: ${config.min_conversations}`);
  }

  const c4DbCli = requireScript(config.c4_db_cli, 'c4-db.js');
  const c4Fetch = requireScript(config.c4_fetch_script, 'c4-fetch.js');
  const maxConversations = Number(config.max_conversations ?? DEFAULT_CONFIG.max_conversations);
  const window = Number.isSafeInteger(maxConversations) && maxConversations > 0 ? maxConversations : 1;

  const rows = recentRows(c4DbCli, window);
  const latestId = rows.reduce((max, row) => Math.max(max, row.id), 0);
  let beginId = state.last_processed_id + 1;
  if (window > 1 && rows.length >= window) {
    // Backlog exceeds the window: drop the oldest part of it.
    beginId = Math.max(beginId, rows.reduce((min, row) => Math.min(min, row.id), Infinity));
  }
  const endId = latestId;

  let transcript = '';
  let count = 0;
  if (endId >= beginId) {
    transcript = run('node', [c4Fetch, '--begin', String(beginId), '--end', String(endId)]);
    count = countMessages(transcript);
  }

  const envelope = { ...base, begin_id: beginId, end_id: endId, count };
  if (count < base.min_conversations) {
    outputJson({ status: 'skip', reason: 'below_threshold', ...envelope });
  }
  outputJson({ status: 'ready', ...envelope, conversations: transcript });
}

function commandCommit(args) {
  const result = args.result;
  if (!['skip', 'no_change', 'updated'].includes(result)) {
    throw new Error('commit requires --result skip|no_change|updated');
  }

  const state = loadState();
  const now = new Date().toISOString();
  const nextState = { ...state, last_run_at: now, last_result: result };
  let processedEndId = null;
  let observedEndId = null;

  if (result === 'skip') {
    if (args['observed-end-id'] !== undefined && args['observed-end-id'] !== true) {
      observedEndId = normalizeId(args['observed-end-id']);
      nextState.last_observed_id = Math.max(state.last_observed_id, observedEndId);
    }
  } else {
    if (args['end-id'] === undefined || args['end-id'] === true) {
      throw new Error(`commit --result ${result} requires --end-id <N>`);
    }
    processedEndId = normalizeId(args['end-id']);
    if (processedEndId < state.last_processed_id) {
      throw new Error(`Refusing to move last_processed_id backward from ${state.last_processed_id} to ${processedEndId}`);
    }
    nextState.last_processed_id = processedEndId;
    nextState.last_observed_id = Math.max(state.last_observed_id, processedEndId);
    if (result === 'updated') nextState.last_update_at = now;
  }

  atomicWriteJson(STATE_PATH, nextState);
  ensureDir(LOG_DIR);
  fs.appendFileSync(RUN_LOG_PATH, `${JSON.stringify({
    timestamp: now,
    result,
    processed_end_id: processedEndId,
    observed_end_id: observedEndId ?? nextState.last_observed_id,
    state_hash: crypto.createHash('sha256').update(JSON.stringify(nextState)).digest('hex')
  })}\n`);

  outputJson({
    status: 'committed',
    result,
    last_processed_id: nextState.last_processed_id,
    last_observed_id: nextState.last_observed_id,
    last_run_at: nextState.last_run_at
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
  if (args.json) {
    outputJson({ status: 'ok', scheduler_prompt: schedulerPrompt(), template: schedulerTemplate() });
  }
  process.stdout.write(schedulerTemplate());
  process.exit(0);
}

function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  try {
    if (command === 'fetch') commandFetch();
    if (command === 'commit') commandCommit(args);
    if (command === 'inspect') commandInspect();
    if (command === 'status') commandStatus();
    if (command === 'template') commandTemplate(args);
    outputJson({
      status: 'error',
      error: 'Usage: extract.js fetch | commit --result <skip|no_change|updated> [--end-id N] [--observed-end-id N] | inspect | status | template [--policy] [--json]'
    }, 1);
  } catch (err) {
    outputError(err.message);
  }
}

main();
