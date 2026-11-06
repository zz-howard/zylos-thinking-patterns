import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function coreRoot() {
  assert.ok(process.env.ZYLOS_PACKAGE_ROOT, 'Set ZYLOS_PACKAGE_ROOT to the compatible Core checkout');
  return fs.realpathSync(process.env.ZYLOS_PACKAGE_ROOT);
}

// Existing window/buffer tests keep their stand-in fetch, but use the actual
// Core resolver and public projector for the new availability prerequisite.
export function copyCoreResolver(directory) {
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(path.join(coreRoot(), 'skills/comm-bridge/scripts/core-config-loader.js'),
    path.join(directory, 'core-config-loader.js'));
}
