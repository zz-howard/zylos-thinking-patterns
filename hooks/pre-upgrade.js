#!/usr/bin/env node
// pre-upgrade: snapshot the owner-owned files before the component code is replaced.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../scripts/lib.js';

const BACKUP_DIR = path.join(DATA_DIR, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
const FILES = ['config.json', 'policy.md', 'state.json'];

console.log('[pre-upgrade] Backing up thinking-patterns data...');

let copied = 0;
for (const name of FILES) {
  const source = path.join(DATA_DIR, name);
  if (!fs.existsSync(source)) continue;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(source, path.join(BACKUP_DIR, name));
  copied += 1;
  console.log(`Backed up ${name}`);
}

console.log(copied === 0 ? 'No existing config/policy/state files to back up.' : `Backup directory: ${BACKUP_DIR}`);
console.log('[pre-upgrade] Complete!');
