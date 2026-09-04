#!/usr/bin/env node
// post-install: create the data directory with defaults and tell the agent what the owner must do next.
// It deliberately does NOT register a scheduler task — the owner decides when extraction runs.

import {
  DATA_DIR, CONFIG_PATH, POLICY_PATH, STATE_PATH, LOG_DIR,
  DEFAULT_CONFIG, DEFAULT_STATE, POLICY_TEMPLATE,
  ensureDir, readJson, atomicWriteJson, writeIfMissing, schedulerTemplate
} from '../scripts/lib.js';

console.log('[post-install] Setting up thinking-patterns...');
ensureDir(DATA_DIR);
ensureDir(LOG_DIR);

if (writeIfMissing(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)) {
  console.log('Created config.json');
} else {
  atomicWriteJson(CONFIG_PATH, { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) });
  console.log('Config exists; ensured default fields');
}

if (writeIfMissing(POLICY_PATH, POLICY_TEMPLATE)) {
  console.log('Created policy.md (template — owner must fill it in)');
} else {
  console.log('Policy exists; preserving owner edits');
}

if (writeIfMissing(STATE_PATH, `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`)) {
  console.log('Created state.json');
} else {
  atomicWriteJson(STATE_PATH, { ...DEFAULT_STATE, ...readJson(STATE_PATH, DEFAULT_STATE), schema_version: 1 });
  console.log('State exists; ensured default fields');
}

console.log(`
[post-install] OWNER ACTION REQUIRED — agent, relay this to your owner:

  thinking-patterns is installed but not configured. Two things are yours to decide:
  1. Whose or what decision patterns to extract, from which conversations, into which file,
     and whether you want to approve entries before they are recorded.
     Tell me in plain language and I will write it into ${POLICY_PATH}
     (a template with the questions is already there).
  2. When it runs. Give me a time and I will register the scheduler task from the
     template below (or run the command yourself).

${schedulerTemplate()}
Until policy.md is filled in, every run is skipped and I will remind you.
`);
console.log('[post-install] Complete!');
