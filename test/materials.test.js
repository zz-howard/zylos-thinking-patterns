import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectMaterials, traceMaterials, commitMaterials, saveArtifact, readArtifacts, stripWrappers } from '../scripts/materials.js';

// Coverage: product collector/CLI with fixture CLIs; no database or installed services.
// Run when material contracts change; real-Core integration is separately gated.
const fixture = fileURLToPath(new URL('./fixtures/material-cli.js', import.meta.url));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materials-'));
  const original = { ...process.env };
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'), ZYLOS_DATA_DIR: path.join(root, 'data'), PM2_HOME: path.join(root, 'pm2'), TMPDIR: root, MATERIAL_FIXTURE: path.join(root, 'fixture.json'), MATERIAL_CALLS: path.join(root, 'calls.jsonl'), TZ: 'Asia/Shanghai' };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); fs.rmSync(root, { recursive: true, force: true }); });
  const now = Date.parse('2026-11-15T17:00:00Z');
  const row = (id, group, channel = 'telegram', direction = 'in') => ({ id, session_group: group, channel, direction, timestamp: '2026-11-15 16:30:00', content: `person ${id}` });
  const data = { groups: ['A', 'B', 'C'], checkpoints: [{ id: 1, session_group: 'A', start_conversation_id: 1, end_conversation_id: 8 }, { id: 2, session_group: 'B', start_conversation_id: 1, end_conversation_id: 4 }], rows: [row(1, 'A'), row(2, 'B'), row(3, 'A', 'internal'), row(4, 'B'), row(5, 'A', 'openmax'), row(6, 'B'), row(7, 'A', 'dashboard'), row(8, 'A', 'telegram', 'out'), row(9, 'C')] };
  const config = { c4_db_cli: fixture, c4_fetch_cli: fixture, trace_context: 1, trace_max_clues: 1, trace_max_bytes: 10000 };
  const options = { now, zylos_dir: env.ZYLOS_DIR, time_zone: env.TZ };
  const write = () => fs.writeFileSync(env.MATERIAL_FIXTURE, JSON.stringify(data));
  write();
  return { root, env, now, data, config, options, write };
}
test('checkpoint ranges exclude unsynced tails and resume the next checkpoint', t => {
  const s = setup(t);
  const log = path.join(s.env.ZYLOS_DIR, 'memory/session-groups/A/sessions/2026-11-16.md');
  fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, 'digested');
  const run = collectMaterials(s.config, {}, s.options);
  assert.equal(run.ranges.length, 2);
  assert.equal(run.ranges.find(r => r.session_group === 'B').end, 4);
  assert.equal(run.session_files[0], log);
  assert.equal(run.inbound.map(r => r.id).join(','), '1,5,7,2,4');
  traceMaterials(s.config, {}, run, []);
  const state = commitMaterials({}, run, ['A', 'B']);
  s.data.checkpoints.push({ id: 3, session_group: 'B', start_conversation_id: 5, end_conversation_id: 6 }); s.write();
  const next = collectMaterials(s.config, state, s.options);
  assert.equal(next.ranges.length, 1);
  assert.equal(next.ranges[0].after, 4);
  assert.equal(next.inbound.length, 1);
  assert.equal(next.inbound[0].id, 6);
});
test('traces stay in the source group and deferred clues survive bounded batches', t => {
  const s = setup(t), state = {};
  const run = collectMaterials(s.config, state, s.options);
  traceMaterials(s.config, state, run, [{ session_group: 'A', c4_id: 5, kind: 'decision' }, { session_group: 'B', c4_id: 4, kind: 'correction' }]);
  assert.equal(run.traces.length, 1);
  assert.ok(run.traces[0].rows.every(r => r.session_group === 'A'));
  assert.equal(state.pending_clues.length, 1);
  assert.throws(() => commitMaterials(state, run, ['B']), /unfinished/);
  const partial = commitMaterials(state, run, ['A']);
  assert.equal(partial.groups.A.end_conversation_id, 8);
  assert.equal(partial.groups.B, undefined);
  assert.equal(partial.last_material_at, undefined);
  // Recover when a process stopped after artifact save but before state save.
  delete state.pending_clues;
  traceMaterials(s.config, state, run, []);
  assert.equal(run.traces.length, 2);
  assert.equal(state.pending_clues.length, 0);
  assert.equal(commitMaterials(state, run, ['B']).groups.B.end_conversation_id, 4);
  assert.throws(() => traceMaterials(s.config, state, run, [{ session_group: 'C', c4_id: 9, kind: 'correction' }]), /Clue/);
});
test('byte limit defers a complete clue without silently dropping its source', t => {
  const s = setup(t), state = {}, run = collectMaterials(s.config, {}, s.options);
  traceMaterials({ ...s.config, trace_max_bytes: 1 }, state, run, [{ session_group: 'A', c4_id: 5, kind: 'decision' }]);
  assert.equal(run.trace_report.bytes, 0);
  assert.equal(state.pending_clues.length, 1);
  traceMaterials(s.config, state, run, []);
  assert.equal(run.trace_complete, true);
});
test('single-session paths, bootstrap cutoff and missing metadata are explicit', t => {
  const s = setup(t);
  s.data.groups = ['*']; s.data.checkpoints = [{ id: 1, session_group: '*', end_conversation_id: 8 }];
  s.data.rows.forEach(r => { r.session_group = '*'; });
  s.data.rows[0].timestamp = '2020-01-01T00:00:00Z'; s.write();
  const log = path.join(s.env.ZYLOS_DIR, 'memory/sessions/2026-11-16.md'); fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, 'session');
  const run = collectMaterials(s.config, {}, s.options);
  assert.equal(run.session_files[0], log);
  assert.ok(run.inbound.every(r => r.id !== 1));
  assert.throws(() => traceMaterials(s.config, {}, run, [{ session_group: '*', c4_id: 1, kind: 'correction' }]), /bootstrap cutoff/);
  delete s.data.rows[1].session_group; s.write();
  assert.throws(() => collectMaterials(s.config, {}, s.options), /session_group/);
});
test('completed matching artifacts reuse corrections without reading raw materials', t => {
  const s = setup(t), run = collectMaterials(s.config, {}, s.options);
  traceMaterials(s.config, {}, run, [{ session_group: 'B', c4_id: 4, kind: 'correction' }]);
  const dir = path.join(s.root, 'artifacts'); saveArtifact(dir, run);
  fs.writeFileSync(s.env.MATERIAL_CALLS, '');
  const reused = collectMaterials(s.config, {}, { ...s.options, reuse_artifacts: readArtifacts(dir) });
  assert.equal(reused.inbound.length, 0);
  assert.equal(reused.report.reused_ranges, 2);
  assert.equal(reused.reused.find(r => r.range.session_group === 'B').clues.length, 1);
  const calls = fs.readFileSync(s.env.MATERIAL_CALLS, 'utf8');
  assert.ok(!calls.includes('--since') && !calls.includes('--begin'));
  const partial = structuredClone(run);
  partial.ranges = partial.ranges.filter(r => r.session_group === 'A');
  const mixed = collectMaterials(s.config, {}, { ...s.options, reuse_artifacts: [partial] });
  assert.equal(mixed.report.reused_ranges, 1);
  assert.equal(mixed.inbound.length, 2);
  assert.ok(mixed.inbound.every(r => r.session_group === 'B'));
  const mismatch = collectMaterials(s.config, {}, { ...s.options, exclude_channels: ['telegram'], reuse_artifacts: [run] });
  assert.equal(mismatch.report.reused_ranges, 0);
});
test('retention preserves unfinished artifacts and cleans only committed expired runs', t => {
  const s = setup(t), run = collectMaterials(s.config, {}, s.options);
  const directory = path.join(s.root, 'artifacts');
  run.created_at = new Date(Date.now() - 9 * 86400000).toISOString();
  const unfinished = saveArtifact(directory, run);
  saveArtifact(directory, { ...run, run_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', committed: true, trace_complete: true });
  assert.equal(readArtifacts(directory).length, 2);
  saveArtifact(directory, { ...run, run_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', created_at: new Date().toISOString() });
  assert.equal(readArtifacts(directory).length, 2);
  assert.ok(fs.existsSync(unfinished));
  assert.equal(fs.statSync(unfinished).mode & 0o777, 0o600);
});
test('known channel wrappers leave signatures and literal human judgments intact', () => {
  assert.equal(stripWrappers('<smart-mode>decide</smart-mode>\n<current-message>Alex said: Is this right?</current-message>'), 'Alex said: Is this right?');
  assert.equal(stripWrappers('Bob said: not right'), 'Bob said: not right');
  assert.equal(stripWrappers('quoted <current-message>literal</current-message>'), 'quoted <current-message>literal</current-message>');
  assert.equal(stripWrappers('<current-message>Alex said: &lt;smart-mode&gt; &amp; &amp;lt;</current-message> ---- file: /tmp/a&amp;b'), 'Alex said: <smart-mode> & &lt; ---- file: /tmp/a&b');
});
test('product CLI resumes deferred work, rejects unfinished commits and preserves partial group progress', t => {
  const s = setup(t);
  s.data.rows.forEach(r => { r.timestamp = new Date().toISOString().slice(0, 19).replace('T', ' '); }); s.write();
  fs.mkdirSync(s.env.ZYLOS_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(s.env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify(s.config));
  fs.writeFileSync(path.join(s.env.ZYLOS_DATA_DIR, 'policy.md'), '## Target\nPatterns file: /tmp/patterns.md\n## Sources\nChannels: all\n');
  const invoke = (args, success = true) => {
    const child = spawnSync(process.execPath, ['scripts/extract.js', ...args, '--task', 'daily'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: s.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, success ? 0 : 1, child.stdout + child.stderr);
    return JSON.parse(child.stdout);
  };
  const first = invoke(['fetch']);
  assert.equal(invoke(['fetch']).run_id, first.run_id);
  const clues = path.join(s.root, 'clues.json');
  fs.writeFileSync(clues, JSON.stringify([{ session_group: 'A', c4_id: 5, kind: 'decision' }, { session_group: 'B', c4_id: 4, kind: 'correction' }]));
  const batch = invoke(['trace', '--run', first.run_id, '--clues', clues]);
  assert.equal(batch.traces.length, 1); assert.equal(batch.report.deferred, 1);
  assert.match(invoke(['commit', '--run', first.run_id, '--result', 'no_change'], false).error, /unfinished/);
  const resumed = invoke(['trace', '--run', first.run_id]);
  assert.equal(resumed.traces.length, 1); assert.equal(resumed.trace_complete, true);
  invoke(['commit', '--run', first.run_id, '--groups', 'A', '--result', 'no_change']);
  assert.equal(invoke(['fetch']).completed_groups.join(','), 'A');
  invoke(['commit', '--run', first.run_id, '--result', 'no_change']);
  const log = fs.readFileSync(path.join(s.env.ZYLOS_DATA_DIR, 'logs/runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(log.report.inbound.count, 5);
  assert.equal(log.trace_report.deferred, 0);
  assert.equal(log.pending_clues, 0);
  assert.equal(invoke(['fetch']).reason, 'no_checkpoint_progress');
  s.data.checkpoints.push({ id: 3, session_group: 'B', end_conversation_id: 6 }); s.write();
  const tail = invoke(['fetch']);
  assert.equal(tail.ranges.length, 1); assert.equal(tail.inbound[0].id, 6);
});
test('product CLI reports legacy fallback and keeps compatibility arguments', t => {
  const s = setup(t); s.data.fail = true; s.write();
  fs.mkdirSync(s.env.ZYLOS_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(s.env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify({ ...s.config, min_conversations: 1 }));
  fs.writeFileSync(path.join(s.env.ZYLOS_DATA_DIR, 'policy.md'), '## Target\nPatterns file: /tmp/patterns.md\n## Sources\nChannels: all\n');
  const result = spawnSync(process.execPath, ['scripts/extract.js', 'fetch', '--lookback', '24h', '--task', 'daily'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: s.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'legacy_time_window');
  assert.match(output.fallback_reason, /checkpoints/);
});
