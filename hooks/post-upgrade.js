#!/usr/bin/env node
// post-upgrade: migrate config/state to the current schema. Owner prose in policy.md is
// never rewritten; the only policy edit is appending a missing "## Target" section when
// the target file used to live in config.json (schema 1).

import fs from 'node:fs';
import {
  CONFIG_PATH, STATE_PATH, POLICY_PATH,
  DEFAULT_CONFIG, DEFAULT_STATE,
  readJson, atomicWriteJson, normalizeState, policyIsUnconfigured, parsePolicy
} from '../scripts/lib.js';

console.log('[post-upgrade] Migrating thinking-patterns config/state...');

const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) };

// Schema 1 kept patterns_file in config.json; it now belongs to the owner's policy.
// The config value is removed only once the policy carries a target — never lost.
if (typeof config.patterns_file === 'string' && config.patterns_file.trim()) {
  const target = config.patterns_file.trim();
  if (!fs.existsSync(POLICY_PATH)) {
    console.log(`policy.md missing; patterns_file ${target} stays in config.json until a policy exists — it is migrated on the next upgrade, or set "Patterns file:" under ## Target yourself`);
  } else {
    if (!parsePolicy(fs.readFileSync(POLICY_PATH, 'utf8')).patterns_file) {
      fs.appendFileSync(POLICY_PATH, `\n## Target\n\nPatterns file: ${target}\n`);
      console.log(`Moved patterns_file from config.json into policy.md (## Target): ${target}`);
    } else {
      console.log('policy.md already names a Patterns file; dropping the config.json copy');
    }
    delete config.patterns_file;
  }
}
delete config.c4_fetch_script; // schema 1 leftover, no longer used

atomicWriteJson(CONFIG_PATH, config);
atomicWriteJson(STATE_PATH, normalizeState(readJson(STATE_PATH, DEFAULT_STATE)));

if (policyIsUnconfigured(POLICY_PATH)) {
  console.log(`policy.md is still unconfigured (${POLICY_PATH}); runs will be skipped until the owner fills it in.`);
}
console.log('[post-upgrade] Complete!');
