import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function coreRoot() {
  assert.ok(process.env.ZYLOS_PACKAGE_ROOT, 'Set ZYLOS_PACKAGE_ROOT to the compatible Core checkout');
  return fs.realpathSync(process.env.ZYLOS_PACKAGE_ROOT);
}

// Unit tests use a private, minimal Core package and stand-in history CLI.
// Only the separately selected integration file requires an actual checkout.
export function createFakeCore(directory) {
  const lib = path.join(directory, 'cli/lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"zylos","type":"module"}');
  fs.writeFileSync(path.join(lib, 'config.js'), 'export {};\n');
  fs.writeFileSync(path.join(lib, 'content-projection.js'), 'export const projectC4Content = content => content;\n');
  fs.writeFileSync(path.join(directory, 'core-config-loader.js'),
    "import { fileURLToPath } from 'node:url';\nexport function resolveCoreConfigModule() { return fileURLToPath(new URL('./cli/lib/config.js', import.meta.url)); }\n");
}
