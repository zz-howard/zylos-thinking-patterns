#!/usr/bin/env node
// post-upgrade: migrate config/state to the current schema. Owner prose in policy.md is
// never rewritten; the only policy edit is placing the schema-1 config.json patterns_file
// into "## Target" — replacing that section's placeholder "Patterns file:" line, inserting
// the line when the section has none, or appending the section when it is missing. The
// policy is replaced atomically (temp file + rename) and config gives up its copy only
// after that rename succeeded.

import fs from 'node:fs';
import {
  CONFIG_PATH, STATE_PATH, POLICY_PATH,
  DEFAULT_CONFIG, DEFAULT_STATE,
  readJson, atomicWriteJson, atomicWriteText, normalizeState, policyIsUnconfigured, parsePolicy, setPolicyTarget
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
    const before = fs.readFileSync(POLICY_PATH, 'utf8');
    if (parsePolicy(before).patterns_file) {
      console.log('policy.md already names a Patterns file; dropping the config.json copy');
      delete config.patterns_file;
    } else {
      // Fill the template's placeholder line in place (or add the line/section),
      // then read the result back: config gives up its value only once the
      // policy actually resolves to the same target.
      const after = setPolicyTarget(before, target);
      if (parsePolicy(after).patterns_file !== target) {
        console.log(`Could not place patterns_file ${target} into policy.md ## Target; it stays in config.json — set "Patterns file:" under ## Target yourself`);
      } else {
        let written = false;
        try {
          atomicWriteText(POLICY_PATH, after);
          written = true;
        } catch (err) {
          console.log(`Failed to replace policy.md atomically (${err.message}); policy.md left untouched and patterns_file stays in config.json`);
        }
        if (written) {
          console.log(`Moved patterns_file from config.json into policy.md (## Target): ${target}`);
          delete config.patterns_file;
        }
      }
    }
  }
}
delete config.c4_fetch_script; // schema 1 leftover, no longer used

atomicWriteJson(CONFIG_PATH, config);
atomicWriteJson(STATE_PATH, normalizeState(readJson(STATE_PATH, DEFAULT_STATE)));

if (policyIsUnconfigured(POLICY_PATH)) {
  console.log(`policy.md is still unconfigured (${POLICY_PATH}); runs will be skipped until the owner fills it in.`);
}
console.log('[post-upgrade] Complete!');
