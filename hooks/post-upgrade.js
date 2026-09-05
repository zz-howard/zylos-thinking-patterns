#!/usr/bin/env node
// post-upgrade: merge new config defaults and normalize state. Owner prose in
// policy.md is never touched; the target pattern file is the policy's own
// "Patterns file:" line and is not migrated from anywhere.

import {
  CONFIG_PATH, STATE_PATH, POLICY_PATH,
  DEFAULT_CONFIG, DEFAULT_STATE,
  readJson, writeJsonIfChanged, normalizeState, policyIsUnconfigured
} from '../scripts/lib.js';

console.log('[post-upgrade] Merging thinking-patterns config/state defaults...');

const configChanged = writeJsonIfChanged(CONFIG_PATH, { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) });
const stateChanged = writeJsonIfChanged(STATE_PATH, normalizeState(readJson(STATE_PATH, DEFAULT_STATE)));
console.log(configChanged ? 'config.json: added missing default fields' : 'config.json: up to date');
console.log(stateChanged ? 'state.json: normalized' : 'state.json: up to date');

if (policyIsUnconfigured(POLICY_PATH)) {
  console.log(`policy.md is still unconfigured (${POLICY_PATH}); runs will be skipped until the owner fills it in.`);
}
console.log('[post-upgrade] Complete!');
