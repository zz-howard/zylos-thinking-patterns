import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { coreRoot } from './helpers/core-fixture.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTRACT = path.join(ROOT, 'scripts/extract.js');
const CORE = coreRoot();
const CORE_SCRIPTS = path.join(CORE, 'skills/comm-bridge/scripts');
const { CONTENT_PREFIX } = await import(pathToFileURL(path.join(CORE_SCRIPTS, 'c4-content-schema.js')).href);
const protocol = JSON.parse(fs.readFileSync(path.join(CORE, 'test/fixtures/c4-content-protocol.json'), 'utf8'));
const hidden = 'HOST_PRIVATE_PAYLOAD_SENTINEL';
const encode = value => CONTENT_PREFIX + JSON.stringify(value);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function envelope(extra = {}) {
  const value = structuredClone(protocol.valid.find(x => x.name === 'markdown').envelope);
  value.fallbackText = 'visible extraction summary'; value.blocks[0].data.text = hidden;
  return { ...value, ...extra };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterns-projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    ZYLOS_DATA_DIR: path.join(root, 'data'), PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'), ZYLOS_PACKAGE_ROOT: CORE,
    TZ: 'UTC', TEST_CLOCK_MS: String(Date.parse('2026-01-01T02:00:00Z')) };
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const key of ['HOME', 'ZYLOS_DIR', 'ZYLOS_DATA_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep), key);
  }
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'));
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), '{"runtime":"claude","session_mode":"multi"}');
  const patternsFile = path.join(root, 'patterns.md');
  fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'policy.md'), `# Policy\n\nSubject: fixture\n\n## Target\n\nPatterns file: ${patternsFile}\n\n## Sources\n\nChannels: all\nExclude channels: none\n`);
  const config = { min_conversations: 1, max_conversations: 50, default_lookback: '24h',
    c4_db_cli: path.join(CORE_SCRIPTS, 'c4-db.js') };
  function configure(changes = {}) {
    Object.assign(config, changes);
    fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify(config));
  }
  configure();
  const db = path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db');
  assert.ok(path.resolve(db).startsWith(root + path.sep));
  function invoke(script, args, override = {}, clock = false) {
    const prelude = clock ? ['--import', pathToFileURL(path.join(ROOT, 'test/helpers/fixed-clock.js')).href] : [];
    return spawnSync(process.execPath, [...prelude, script, ...args], {
      cwd: ROOT, env: { ...env, ...override }, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  }
  const init = invoke(config.c4_db_cli, ['init']);
  assert.equal(init.status, 0, init.stderr);
  function sql(input) {
    return execFileSync('sqlite3', [db], { env, input, encoding: 'utf8', timeout: 5000 });
  }
  function seed(contents) {
    const rows = []; let id = 0;
    for (const direction of ['in', 'out']) for (const content of contents) {
      id += 1; rows.push({ id, direction, content });
      sql(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,status,session_group)
        VALUES(${id},'2026-01-01 01:00:00',${quote(direction)},'dashboard','room',${quote(content)},'delivered','dashboard:room');`);
    }
    return rows;
  }
  const fetch = (script = EXTRACT, override = {}) => invoke(script, ['fetch'], override, true);
  return { root, env, config, patternsFile, configure, invoke, fetch, seed, sql };
}
function ready(f, script) {
  const child = f.fetch(script);
  assert.equal(child.status, 0, child.stdout.slice(0, 500) + child.stderr);
  const result = JSON.parse(child.stdout); assert.equal(result.status, 'ready');
  return result;
}

// Integration: actual extract CLI -> fixed Core recent -> private SQLite -> final
// transcript/JSON given to the extraction agent. No model/runtime/network/PM2/
// tmux. Owned paths checked before DB/CLI use; children bounded, cleanup registered.
// Run for recent ingestion/transcript changes; skip unrelated policy/lifecycle.
test('extraction transcript uses projected content for both directions and preserves stored bodies', t => {
  const f = fixture(t);
  const long = envelope({ messageId: 'long_history' }); long.blocks[0].data.text = hidden + 'x'.repeat(20000);
  const nested = envelope({ messageId: 'nested_history', fallbackText: CONTENT_PREFIX + 'literal fallback' });
  const plain = 'ordinary {"json":true}\nUnicode 中🚀 and \\ slash';
  const rows = f.seed([encode(envelope()), CONTENT_PREFIX + '{"private":"' + hidden + '"', encode(long), plain,
    encode(nested), protocol.valid.find(x => x.name === 'answer_single_select').content]);
  const before = f.sql('SELECT id,hex(content) FROM conversations ORDER BY id;');
  const result = ready(f);
  assert.equal(result.count, rows.length); assert.equal(result.window_complete, true);
  assert.equal(JSON.stringify(result).includes(hidden), false);
  assert.equal(result.conversations.includes('"blocks"'), false);
  assert.equal(result.conversations.includes('"version"'), false);
  for (const row of rows) {
    assert.ok(result.conversations.includes(`${row.direction.toUpperCase()} (dashboard:room):`));
    if (row.content.includes('"private"')) assert.ok(result.conversations.includes(`[C4 content invalid; c4_id=${row.id}]`));
    else if (row.content === plain) assert.ok(result.conversations.includes(plain));
    else {
      const value = JSON.parse(row.content.slice(CONTENT_PREFIX.length));
      const interrupt = value.interruptId === undefined ? '' : ` interruptId=${value.interruptId}`;
      assert.ok(result.conversations.includes(`${value.fallbackText}\n[C4 messageId=${value.messageId}${interrupt}; c4_id=${row.id}]`));
      assert.equal(result.conversations.includes(row.content), false);
    }
  }
  assert.equal(f.sql('SELECT id,hex(content) FROM conversations ORDER BY id;'), before);
  assert.equal(fs.existsSync(f.patternsFile), false);
  assert.equal(fs.existsSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json')), false);
});

// Integration: real JSON byte boundary (including row metadata), not raw-envelope
// size or only transcript bytes. Run for max_page_bytes or projection changes;
// skip unrelated lifecycle. Both reads use the same checked fixture and bounds.
test('page budget counts the projected Core JSON and retains the exact byte boundary', t => {
  const f = fixture(t), long = envelope(); long.blocks[0].data.text = hidden + 'x'.repeat(20000);
  f.seed([encode(long)]);
  const child = f.invoke(f.config.c4_db_cli, ['recent', '100']);
  assert.equal(child.status, 0, child.stderr);
  const bytes = Buffer.byteLength(child.stdout);
  assert.ok(Number(f.sql('SELECT SUM(length(CAST(content AS BLOB))) FROM conversations;').trim()) > bytes * 10);
  f.configure({ max_page_bytes: bytes });
  assert.equal(ready(f).max_page_bytes, bytes);
  f.configure({ max_page_bytes: bytes - 1 });
  const failure = f.fetch(); assert.equal(failure.status, 1);
  assert.match(JSON.parse(failure.stdout).error, new RegExp(`over max_page_bytes \\(${bytes - 1}\\)`));
  assert.equal(failure.stdout.includes(hidden), false);
});

// Integration: unmodified v0.2.2 scripts, a fixed fixture clock and real Core.
// Run for transcript/time rendering changes; skip unrelated hooks. No source
// rewriting/evaluation; baseline files are executed normally with identical env.
test('ordinary transcript is byte identical to the previous component release', t => {
  const f = fixture(t); f.seed(['ordinary text', '{"ordinary":"JSON"}\n中文🚀', 'quotes \' and \\ slash']);
  const dir = path.join(f.root, 'baseline'); fs.mkdirSync(dir);
  const archive = execFileSync('git', ['archive', 'v0.2.2', 'package.json', 'scripts/', 'references/methodology.md'], { cwd: ROOT, timeout: 5000 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive, timeout: 5000 });
  const current = ready(f), baseline = ready(f, path.join(dir, 'scripts/extract.js'));
  assert.equal(current.conversations, baseline.conversations);
  for (const field of ['count', 'filtered_out', 'truncated', 'truncated_out', 'window_complete', 'window']) assert.deepEqual(current[field], baseline[field]);
});

// Integration: older Core without projection reads ordinary history normally.
// Run for Core compatibility/history handoff changes; skip unrelated hooks.
// Same checked private DB/env, fixed clock, bounded children and cleanup; the
// transcript and result fields must match the unchanged main release; only
// the separately checked code-relative methodology path differs by checkout.
test('Core without projection reads plain history byte identically to the main baseline', t => {
  const f = fixture(t);
  f.seed(['ordinary legacy history', '{"ordinary":"JSON"}\n中文🚀', 'quotes \' and \\ slash']);
  const legacy = fs.realpathSync(process.env.TEST_LEGACY_CORE_ROOT);
  assert.equal(fs.existsSync(path.join(legacy, 'cli/lib/content-projection.js')), false);
  f.configure({ c4_db_cli: path.join(legacy, 'skills/comm-bridge/scripts/c4-db.js') });
  f.env.ZYLOS_PACKAGE_ROOT = legacy;
  const dir = path.join(f.root, 'baseline'); fs.mkdirSync(dir);
  const archive = execFileSync('git', ['archive', 'v0.2.2', 'package.json', 'scripts/', 'references/methodology.md'], { cwd: ROOT, timeout: 5000 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive, timeout: 5000 });
  const state = '{"last_result":null}\n';
  fs.writeFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json'), state);
  const current = f.fetch(), previous = f.fetch(path.join(dir, 'scripts/extract.js'));
  assert.equal(current.status, 0, current.stderr);
  assert.equal(previous.status, 0, previous.stderr);
  const result = JSON.parse(current.stdout);
  const previousResult = JSON.parse(previous.stdout);
  assert.equal(result.conversations, previousResult.conversations);
  assert.equal(result.methodology_file, path.join(ROOT, 'references/methodology.md'));
  assert.equal(previousResult.methodology_file, path.join(dir, 'references/methodology.md'));
  const { methodology_file: currentPath, ...currentFields } = result;
  const { methodology_file: previousPath, ...previousFields } = previousResult;
  assert.equal(JSON.stringify(currentFields), JSON.stringify(previousFields));
  assert.equal(result.status, 'ready');
  assert.equal(result.count, 6);
  assert.ok(result.conversations.includes('ordinary legacy history'));
  assert.equal(fs.readFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json'), 'utf8'), state);
  assert.equal(fs.existsSync(f.patternsFile), false);
});
