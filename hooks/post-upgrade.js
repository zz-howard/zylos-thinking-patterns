#!/usr/bin/env node
// post-upgrade: merge new config defaults and normalize state. Owner prose in
// policy.md is never touched; the target pattern file is the policy's own
// "Patterns file:" line and is not migrated from anywhere.

import {
  CONFIG_PATH, STATE_PATH, POLICY_PATH,
  DEFAULT_CONFIG, DEFAULT_STATE,
  readJson, atomicWriteJson, normalizeState, policyIsUnconfigured
} from '../scripts/lib.js';

console.log('[post-upgrade] Merging thinking-patterns config/state defaults...');

atomicWriteJson(CONFIG_PATH, { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) });
atomicWriteJson(STATE_PATH, normalizeState(readJson(STATE_PATH, DEFAULT_STATE)));

if (policyIsUnconfigured(POLICY_PATH)) {
  console.log(`policy.md is still unconfigured (${POLICY_PATH}); runs will be skipped until the owner fills it in.`);
}
console.log('[post-upgrade] Complete!');
