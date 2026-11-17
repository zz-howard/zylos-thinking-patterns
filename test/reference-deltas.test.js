import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectMaterials, traceMaterials, commitMaterials } from '../scripts/materials.js';
import { captureReferences, referenceChanges } from '../scripts/reference-deltas.js';

// Boundary: real collector/commit and product CLI with fixture C4 responses only.
// Run for reference collection or commit changes; no live Core/database needed.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'));
  const original = { ...process.env };
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'zylos'), ZYLOS_DATA_DIR: path.join(root, 'data'), PM2_HOME: path.join(root, 'pm2'), TMPDIR: root, MATERIAL_FIXTURE: path.join(root, 'fixture.json'), MATERIAL_CALLS: path.join(root, 'calls.jsonl') };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); fs.rmSync(root, { recursive: true, force: true }); });
  const fixture = fileURLToPath(new URL('./fixtures/material-cli.js', import.meta.url));
  const config = { c4_db_cli: fixture, c4_fetch_cli: fixture };
  const data = { groups: ['A', 'B'], checkpoints: ['A', 'B'].map((session_group, i) => ({ id: i + 1, session_group, end_conversation_id: 2 })), rows: [] };
  fs.writeFileSync(env.MATERIAL_FIXTURE, JSON.stringify(data));
  const write = (name, content) => { const file = path.join(env.ZYLOS_DIR, 'memory/reference', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const collect = state => collectMaterials(config, state, { zylos_dir: env.ZYLOS_DIR });
  return { root, env, config, data, write, collect };
}

test('reference baseline initializes only after every range commits and captures fetch contents', t => {
  const s = setup(t);
  s.write('preferences.md', 'before\n');
  const run = s.collect({});
  assert.equal(run.reference_changes.length, 0);
  assert.match(run.reference_baseline_note, /Initial reference baseline/);
  traceMaterials(s.config, {}, run, []);
  const partial = commitMaterials({}, run, ['A']);
  assert.equal(partial.reference_baseline, undefined);
  s.write('preferences.md', 'after fetch\n');
  const committed = commitMaterials(partial, run, ['B']);
  assert.equal(committed.reference_baseline['memory/reference/preferences.md'], 'before\n');
  assert.throws(() => commitMaterials(committed, run, ['A']), /Stale/);
  assert.equal(committed.reference_baseline['memory/reference/preferences.md'], 'before\n');
  s.data.checkpoints.forEach(c => { c.id += 2; c.end_conversation_id += 2; });
  fs.writeFileSync(s.env.MATERIAL_FIXTURE, JSON.stringify(s.data));
  assert.match(s.collect(committed).reference_changes[0].content, /after fetch/);
  assert.equal(s.collect({}).reference_changes.length, 0);
});

test('reference fragments omit unchanged and deleted files and contain only nearby changed content', t => {
  const s = setup(t);
  const lines = Array.from({ length: 12000 }, (_, i) => `unchanged section line ${i}`);
  lines[0] = '## Preferences';
  s.write('preferences.md', lines.join('\n'));
  const touched = s.write('decisions/touched.md', 'unchanged');
  const removed = s.write('decisions/removed.md', 'removed');
  const baseline = captureReferences(s.env.ZYLOS_DIR);
  lines[20] = 'changed line'; lines.splice(11000, 0, 'new paragraph 😀');
  s.write('preferences.md', lines.join('\n'));
  s.write('decisions/new.md', 'whole new page\n');
  fs.utimesSync(touched, new Date(), new Date()); fs.unlinkSync(removed);
  const run = s.collect({ reference_baseline: baseline });
  assert.equal(run.reference_changes.length, 3);
  assert.equal(run.reference_files.length, 2);
  assert.ok(run.reference_changes.every(c => !c.file.includes('touched') && !c.file.includes('removed')));
  const preferences = run.reference_changes.filter(c => c.file.endsWith('preferences.md'));
  assert.equal(preferences.length, 2);
  assert.ok(preferences.every(c => c.section === '## Preferences'));
  assert.ok(preferences.reduce((n, c) => n + c.content.length, 0) < 500);
  assert.ok(preferences.every(c => !c.content.includes('unchanged section line 6000')));
  assert.equal(run.report.references.characters, run.reference_changes.reduce((n, c) => n + [...c.content].length, 0));
  assert.equal(run.report.references.count, run.reference_changes.length);
  assert.equal(s.collect({ reference_baseline: baseline }).reference_changes.map(c => c.content).join('|'), run.reference_changes.map(c => c.content).join('|'));
  assert.equal(referenceChanges(s.env.ZYLOS_DIR, captureReferences(s.env.ZYLOS_DIR), captureReferences(s.env.ZYLOS_DIR)).length, 0);
});

test('deletion-only edits emit no content and reused runs do not consume reference changes', t => {
  const s = setup(t);
  s.write('preferences.md', 'one\ntwo\nthree\n');
  const baseline = captureReferences(s.env.ZYLOS_DIR);
  s.write('preferences.md', 'one\nthree\n');
  assert.equal(s.collect({ reference_baseline: baseline }).reference_changes.length, 0);
  const source = s.collect({}); source.trace_complete = true;
  const reused = collectMaterials(s.config, { reference_baseline: baseline }, { zylos_dir: s.env.ZYLOS_DIR, reuse_artifacts: [source] });
  assert.equal(reused.reference_snapshot, undefined);
  assert.equal(reused.reference_changes.length, 0);
  traceMaterials(s.config, {}, reused, []);
  assert.equal(commitMaterials({ reference_baseline: baseline }, reused, ['A', 'B']).reference_baseline, baseline);
});

test('product fetch hides snapshots and skipped or rejected commits preserve the reference baseline', t => {
  const s = setup(t);
  fs.mkdirSync(s.env.ZYLOS_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(s.env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify(s.config));
  fs.writeFileSync(path.join(s.env.ZYLOS_DATA_DIR, 'policy.md'), `## Target\nPatterns file: ${path.join(s.root, 'patterns.md')}\n## Sources\nChannels: all\n`);
  s.write('preferences.md', 'private baseline body\n');
  const invoke = (args, status = 0) => {
    const child = spawnSync(process.execPath, ['scripts/extract.js', ...args, '--task', 'daily'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: s.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, status, child.stdout + child.stderr);
    return JSON.parse(child.stdout);
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(s.env.ZYLOS_DATA_DIR, 'state.json'), 'utf8'));
  const first = invoke(['fetch']);
  assert.equal(first.reference_snapshot, undefined);
  assert.ok(!JSON.stringify(first).includes('private baseline body'));
  invoke(['commit', '--run', first.run_id, '--result', 'no_change'], 1);
  assert.equal(state().material_scopes['default:daily'].reference_baseline, undefined);
  invoke(['commit', '--run', first.run_id, '--result', 'skip']);
  const fresh = invoke(['fetch']);
  invoke(['trace', '--run', fresh.run_id]);
  invoke(['commit', '--run', fresh.run_id, '--result', 'no_change']);
  assert.equal(state().material_scopes['default:daily'].reference_baseline['memory/reference/preferences.md'], 'private baseline body\n');
  // The baseline copies private memory: state stays owner-only and status reports size only.
  assert.equal(fs.statSync(path.join(s.env.ZYLOS_DATA_DIR, 'state.json')).mode & 0o777, 0o600);
  const status = invoke(['status']);
  assert.ok(!JSON.stringify(status).includes('private baseline body'));
  assert.deepEqual(status.state.material_scopes['default:daily'].reference_baseline, { files: 1, characters: 22 });
});

test('global checkpoints and independent baselines preserve separate reference progress', t => {
  const s = setup(t);
  s.data.checkpoints = [{ id: 1, session_group: '*', end_conversation_id: 2 }];
  fs.writeFileSync(s.env.MATERIAL_FIXTURE, JSON.stringify(s.data));
  s.write('preferences.md', 'first\n');
  const first = s.collect({});
  assert.equal(first.ranges[0].session_group, '*');
  traceMaterials(s.config, {}, first, []);
  const state = commitMaterials({}, first, ['*']);
  s.write('preferences.md', 'second\n');
  s.data.checkpoints = [{ id: 2, session_group: '*', end_conversation_id: 4 }];
  fs.writeFileSync(s.env.MATERIAL_FIXTURE, JSON.stringify(s.data));
  const next = s.collect(state);
  assert.match(next.reference_changes[0].content, /second/);
  assert.equal(s.collect({}).reference_changes.length, 0);
  assert.equal(state.reference_baseline['memory/reference/preferences.md'], 'first\n');
});

test('fragments name the section above the change, ignore fenced comments and mark changed lines', t => {
  const s = setup(t);
  const body = ['# Prefs', '', '## Alpha', 'a1', 'a2', '', '## Beta', 'b1', '```bash', '# install deps', 'run it', '```', 'b2', 'b3', ''];
  s.write('preferences.md', body.join('\n'));
  const baseline = captureReferences(s.env.ZYLOS_DIR);
  const next = [...body]; next.splice(7, 0, 'beta first'); next[13] = 'b2 changed';
  s.write('preferences.md', next.join('\n'));
  const changes = referenceChanges(s.env.ZYLOS_DIR, baseline, captureReferences(s.env.ZYLOS_DIR));
  assert.equal(changes.length, 2);
  assert.equal(changes[0].section, '## Beta');
  assert.deepEqual(changes[0].changed_lines, [8]);
  assert.equal(changes[1].section, '## Beta');
  assert.deepEqual(changes[1].changed_lines, [14]);
  for (const change of changes) for (const line of change.changed_lines) assert.equal(change.content.split('\n')[line - change.start_line], next[line - 1]);
});
