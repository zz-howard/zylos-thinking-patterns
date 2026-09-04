#!/usr/bin/env node
// post-upgrade: migrate config/state to the current schema. Owner files are never overwritten.

import {
  CONFIG_PATH, STATE_PATH, POLICY_PATH,
  DEFAULT_CONFIG, DEFAULT_STATE,
  readJson, atomicWriteJson, normalizeState, policyIsUnconfigured
} from '../scripts/lib.js';

console.log('[post-upgrade] Migrating thinking-patterns config/state...');

atomicWriteJson(CONFIG_PATH, { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) });
atomicWriteJson(STATE_PATH, normalizeState(readJson(STATE_PATH, DEFAULT_STATE)));

if (policyIsUnconfigured(POLICY_PATH)) {
  console.log(`policy.md is still unconfigured (${POLICY_PATH}); runs will be skipped until the owner fills it in.`);
}
console.log('[post-upgrade] Complete!');
