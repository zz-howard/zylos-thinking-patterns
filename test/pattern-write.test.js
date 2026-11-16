import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// Run for publication/commit-guard changes; skip for unrelated extraction edits.
// Use the real Core writer with a private instance and injected run observer only.
// No live data, services, tmux or network; children are bounded and fixtures cleaned.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/extract.js');
const RUN = '11111111-1111-4111-8111-111111111111';
const GROUP = 'dashboard:private-fixture';
const ORIGINAL = '# Patterns\n\n## 1. Check the evidence\n\n**Source event**: Private fixture, 2026-11-15.\n\n**Extracted principle**: Preserve the original judgment.\n\n---\n';
const NEW_ENTRY = '\n## 2. Read the context\n\n**Source event**: Private fixture, 2026-11-16.\n\n**Extracted principle**: Read relevant context before acting.\n';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, { target = 'memory', existing = true, writer = true } = {}) {
  assert.ok(process.env.ZYLOS_PACKAGE_ROOT, 'Set ZYLOS_PACKAGE_ROOT to a Core checkout');
  const core = fs.realpathSync(process.env.ZYLOS_PACKAGE_ROOT);
  const coreWriter = path.join(core, 'skills/zylos-memory/scripts/memory-write.js');
  assert.ok(fs.existsSync(coreWriter), 'The real Core memory writer must exist');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-write-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ZYLOS_PACKAGE_ROOT: core };
  for (const [key, name] of Object.entries({ HOME: 'home', ZYLOS_DIR: 'instance', ZYLOS_DATA_DIR: 'data', PM2_HOME: 'pm2', TMPDIR: 'tmp', TMUX_TMPDIR: 'tmux' })) {
    env[key] = path.join(root, name);
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep), key);
  }
  for (const key of Object.keys(env)) {
    if (/^(ZYLOS_(RUN_ID|SESSION_GROUP)|CLAUDE_SESSION_ID|CODEX_SESSION_ID|TMUX|TMUX_PANE)$/.test(key)) delete env[key];
  }
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'));
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
  const memory = path.join(env.ZYLOS_DIR, 'memory');
  fs.mkdirSync(memory);
  fs.writeFileSync(path.join(memory, 'references.md'), '# References\n');
  const patterns = target === 'memory' ? path.join(memory, 'thinking-patterns.md') : path.join(root, 'outside-patterns.md');
  if (existing) fs.writeFileSync(patterns, ORIGINAL);
  const writerFile = path.join(root, 'writer.mjs');
  if (writer) {
    fs.writeFileSync(writerFile, `import { runMemoryWriteCli } from ${JSON.stringify(pathToFileURL(coreWriter).href)};\nprocess.exitCode = await runMemoryWriteCli(process.argv.slice(2), { currentRunId: async () => 'fixture-run' });\n`);
  }
  const materialCli = path.join(ROOT, 'test/fixtures/material-cli.js');
  env.MATERIAL_FIXTURE = path.join(root, 'material-fixture.json');
  env.MATERIAL_CALLS = path.join(root, 'material-calls.jsonl');
  fs.writeFileSync(env.MATERIAL_FIXTURE, JSON.stringify({ groups: [GROUP], checkpoints: [{ id: 2, session_group: GROUP, start_conversation_id: 11, end_conversation_id: 20 }], rows: [] }));
  fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify({ enabled: true, memory_writer: writerFile, c4_db_cli: materialCli, c4_fetch_cli: materialCli }));
  fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'policy.md'), `# Private fixture policy\n\nSubject: the owner\n\n## Target\n\nPatterns file: ${patterns}\n\n## Sources\n\nChannels: all\nConfirmation: record and notify me\n`);
  const stateFile = path.join(env.ZYLOS_DATA_DIR, 'state.json');
  const state = {
    schema_version: 3,
    material_scopes: { 'default:daily': { active_run: RUN, groups: { [GROUP]: { end_conversation_id: 10, checkpoint_id: 1 } } } },
    last_run_at: null, last_result: null, last_update_at: null, last_window: null
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const artifactDir = path.join(env.ZYLOS_DATA_DIR, 'materials');
  fs.mkdirSync(artifactDir);
  const artifactFile = path.join(artifactDir, `${RUN}.json`);
  fs.writeFileSync(artifactFile, JSON.stringify({ run_id: RUN, scope: 'default:daily', created_at: new Date().toISOString(), ranges: [{ session_group: GROUP, after: 10, end: 20, checkpoint_id: 2 }], trace_complete: true, report: {} }));
  const proposal = path.join(root, 'proposal.md');
  function invoke(args) {
    const child = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    let value;
    try { value = JSON.parse(child.stdout); } catch { assert.fail(`CLI did not return JSON: ${child.stdout}\n${child.stderr}`); }
    return { ...value, exitCode: child.status };
  }
  return {
    root, env, patterns, stateFile, artifactFile,
    state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    invoke,
    write(content, expected = hash(existing ? ORIGINAL : ''), { run = true } = {}) {
      fs.writeFileSync(proposal, content);
      return invoke(['write', '--file', proposal, '--sha256', expected, '--task', 'daily', ...(run ? ['--run', RUN] : [])]);
    },
    commit(result, run = true) { return invoke(['commit', '--result', result, '--task', 'daily', ...(run ? ['--run', RUN] : [])]); }
  };
}

test('real locked writer defers during Sync and advances progress only after successful retry', t => {
  const f = fixture(t);
  const markerDir = path.join(f.env.ZYLOS_DIR, 'activity-monitor/session-groups/origin');
  fs.mkdirSync(markerDir, { recursive: true });
  const marker = path.join(markerDir, 'sync.lock');
  fs.writeFileSync(marker, JSON.stringify({ runId: 'fixture-run', kind: 'group', token: 'a'.repeat(32), expiresAt: Date.now() + 60000 }));
  const before = f.state();
  const artifactBefore = fs.readFileSync(f.artifactFile, 'utf8');
  const rejected = f.write(ORIGINAL + NEW_ENTRY);
  assert.equal(rejected.status, 'write_deferred');
  assert.equal(rejected.reason, 'SYNC_BUSY');
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), ORIGINAL);
  assert.equal(f.state().material_scopes['default:daily'].groups[GROUP].end_conversation_id, 10);
  assert.equal(f.state().last_run_at, before.last_run_at);
  assert.equal(f.state().material_scopes['default:daily'].write_pending, RUN);
  const pendingState = fs.readFileSync(f.stateFile, 'utf8');
  for (const run of [true, false]) {
    for (const result of ['no_change', 'updated']) {
      const blocked = f.commit(result, run);
      assert.equal(blocked.status, 'error');
      assert.notEqual(blocked.exitCode, 0);
      assert.match(blocked.error, /pending|deferred|write/i);
      assert.equal(fs.readFileSync(f.stateFile, 'utf8'), pendingState);
    }
  }
  assert.equal(fs.readFileSync(f.artifactFile, 'utf8'), artifactBefore);
  assert.equal(f.state().material_scopes['default:daily'].groups[GROUP].end_conversation_id, 10);
  fs.unlinkSync(marker);
  const published = f.write(ORIGINAL + NEW_ENTRY);
  assert.equal(published.status, 'updated');
  assert.equal(published.mode, 'locked');
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), ORIGINAL + NEW_ENTRY);
  const committed = f.commit('updated');
  assert.equal(committed.status, 'committed');
  const scope = f.state().material_scopes['default:daily'];
  assert.equal(scope.groups[GROUP].end_conversation_id, 20);
  assert.equal(scope.groups[GROUP].checkpoint_id, 2);
  assert.equal(scope.active_run, undefined);
  assert.equal(scope.write_pending, undefined);
});

test('stale hash defers publication and blocks a no-change commit', t => {
  const f = fixture(t);
  const result = f.write(ORIGINAL + NEW_ENTRY, hash('stale bytes'));
  assert.equal(result.status, 'write_deferred');
  assert.equal(result.reason, 'MEMORY_CONFLICT');
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), ORIGINAL);
  assert.equal(f.commit('no_change').status, 'error');
  assert.equal(f.state().material_scopes['default:daily'].groups[GROUP].end_conversation_id, 10);
});

// Guard lifecycle: required for skip/new-run changes, otherwise skippable; private fixture only.
test('skipping a deferred write allows a fresh run to commit without publication', t => {
  const f = fixture(t);
  assert.equal(f.write(ORIGINAL + NEW_ENTRY, hash('stale bytes')).status, 'write_deferred');
  assert.equal(f.commit('no_change').status, 'error');
  assert.equal(f.commit('skip').status, 'committed');
  assert.equal(f.state().material_scopes['default:daily'].write_pending, undefined);
  assert.equal(f.state().material_scopes['default:daily'].groups[GROUP].end_conversation_id, 10);
  const policy = path.join(f.env.ZYLOS_DATA_DIR, 'policy.md');
  fs.writeFileSync(policy, fs.readFileSync(policy, 'utf8').replace('record and notify me', 'ask me first'));
  const next = f.invoke(['fetch', '--task', 'daily']);
  assert.equal(next.status, 'ready');
  assert.notEqual(next.run_id, RUN);
  assert.equal(f.invoke(['trace', '--run', next.run_id, '--task', 'daily']).status, 'ready');
  assert.equal(f.invoke(['commit', '--result', 'no_change', '--run', next.run_id, '--task', 'daily']).status, 'committed');
  assert.equal(f.state().material_scopes['default:daily'].groups[GROUP].end_conversation_id, 20);
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), ORIGINAL);
});

// Active-run resume: required for fetch/guard changes, otherwise skippable; private fixture only.
test('fetch resumes an active deferred run and preserves its publication guard', t => {
  const f = fixture(t);
  assert.equal(f.write(ORIGINAL + NEW_ENTRY, hash('stale bytes')).status, 'write_deferred');
  const resumed = f.invoke(['fetch', '--task', 'daily']);
  assert.equal(resumed.run_id, RUN);
  assert.equal(f.state().material_scopes['default:daily'].write_pending, RUN);
  assert.equal(f.commit('no_change').status, 'error');
  assert.equal(f.state().material_scopes['default:daily'].groups[GROUP].end_conversation_id, 10);
});

// Abandoned guard: required for new-run initialization, otherwise skippable; private fixture only.
test('fetch clears an abandoned write guard when starting a new run', t => {
  const f = fixture(t);
  const state = f.state();
  delete state.material_scopes['default:daily'].active_run;
  state.material_scopes['default:daily'].write_pending = RUN;
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  const next = f.invoke(['fetch', '--task', 'daily']);
  assert.equal(next.status, 'ready');
  assert.notEqual(next.run_id, RUN);
  assert.equal(f.state().material_scopes['default:daily'].write_pending, undefined);
  assert.equal(f.invoke(['trace', '--run', next.run_id, '--task', 'daily']).status, 'ready');
  assert.equal(f.invoke(['commit', '--result', 'no_change', '--run', next.run_id, '--task', 'daily']).status, 'committed');
});

for (const scenario of [
  { name: 'missing target', options: { existing: false }, reason: 'file_missing' },
  { name: 'target outside memory', options: { target: 'outside' }, reason: 'outside_memory' },
  { name: 'unavailable writer', options: { writer: false }, reason: 'writer_unavailable' }
]) {
  test(`direct fallback publishes for ${scenario.name}`, t => {
    const f = fixture(t, scenario.options);
    const content = scenario.options.existing === false ? '# Patterns\n\n## 1. First pattern\n\nEvidence from a private fixture.\n' : ORIGINAL + NEW_ENTRY;
    const result = f.write(content);
    assert.equal(result.status, 'updated');
    assert.equal(result.mode, 'direct');
    assert.equal(result.reason, scenario.reason);
    assert.equal(fs.readFileSync(f.patterns, 'utf8'), content);
  });
}

test('existing entry edits are rejected while a canonical reinforcement preserves original bytes', t => {
  const f = fixture(t);
  const changed = f.write(ORIGINAL.replace('Preserve the original judgment.', 'Replace the original judgment.'));
  assert.equal(changed.status, 'error');
  assert.notEqual(changed.exitCode, 0);
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), ORIGINAL);
  const reinforcement = '**Reinforced (2026-11-16)**: A second private event confirms this boundary.\n\n';
  const content = ORIGINAL.replace('---\n', `${reinforcement}---\n`);
  const accepted = f.write(content);
  assert.equal(accepted.status, 'updated');
  assert.equal(accepted.mode, 'locked');
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), content);
});

test('new entries must use the next sequential number', t => {
  const f = fixture(t);
  const result = f.write(ORIGINAL + NEW_ENTRY.replace('## 2.', '## 4.'));
  assert.equal(result.status, 'error');
  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), ORIGINAL);
});

test('existing separators and whitespace cannot be removed', t => {
  const f = fixture(t);
  const result = f.write(ORIGINAL.replace('\n\n---\n', '\n'));
  assert.equal(result.status, 'error');
  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), ORIGINAL);
});

test('a reinforcement date must use the canonical heading', t => {
  const f = fixture(t);
  const content = ORIGINAL.replace('---\n', '**Reinforced (2026-11-16 morning)**: Additional context.\n\n---\n');
  const result = f.write(content);
  assert.equal(result.status, 'error');
  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), ORIGINAL);
});

test('a preamble-only existing file accepts a first entry without changing its preamble', t => {
  const f = fixture(t);
  const preamble = '# Patterns\n\n';
  fs.writeFileSync(f.patterns, preamble);
  const content = preamble + '## 1. First pattern\n\nEvidence.\n';
  assert.equal(f.write(content.replace('# Patterns', '# Changed'), hash(preamble)).status, 'error');
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), preamble);
  assert.equal(f.write(content, hash(preamble)).status, 'updated');
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), content);
});

test('multiple existing entries retain their separators while both receive reinforcement', t => {
  const f = fixture(t);
  const original = ORIGINAL + NEW_ENTRY;
  fs.writeFileSync(f.patterns, original);
  const reinforcement = '\n\n**Reinforced (2026-11-16)**: More evidence.';
  const content = ORIGINAL.replace('\n\n---\n', reinforcement + '\n\n---\n') + NEW_ENTRY.replace(/\n$/, reinforcement + '\n');
  assert.equal(f.write(content, hash(original)).status, 'updated');
  assert.equal(fs.readFileSync(f.patterns, 'utf8'), content);
});

test('a real writer path rejection defers without direct fallback or progress', t => {
  const f = fixture(t);
  const destination = path.join(f.root, 'symlink-destination.md');
  fs.renameSync(f.patterns, destination);
  fs.symlinkSync(destination, f.patterns);
  const result = f.write(ORIGINAL + NEW_ENTRY);
  assert.equal(result.status, 'write_deferred');
  assert.equal(result.mode, 'locked');
  assert.notEqual(result.reason, 'MEMORY_CONFLICT');
  assert.equal(fs.readFileSync(destination, 'utf8'), ORIGINAL);
  assert.equal(f.commit('updated').status, 'error');
  assert.equal(f.state().material_scopes['default:daily'].groups[GROUP].end_conversation_id, 10);
});
