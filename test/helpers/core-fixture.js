import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function coreRoot() {
  assert.ok(process.env.ZYLOS_PACKAGE_ROOT, 'Set ZYLOS_PACKAGE_ROOT to the Core checkout used by the integration tests');
  return fs.realpathSync(process.env.ZYLOS_PACKAGE_ROOT);
}
