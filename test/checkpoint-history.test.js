import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkpointFixture } from './helpers/checkpoint-fixture.js';

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/materials.js')).href;
function execute(f, source) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as materials from ${JSON.stringify(moduleUrl)};\n${source}`], { env: f.env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.status, 0, (child.stderr + child.stdout).slice(0, 2000));
  return JSON.parse(child.stdout);
}

// Integration boundary: real component material code -> installed Core CLI ->
// private SQLite only. Run when checkpoint/range/trace ingestion changes; skip
// unrelated methodology/lint. HOME, ZYLOS_DIR, PM2_HOME, TMPDIR and tmux directory
// are checked before init; no server, tmux, PM2, model or network is started.
test('real Core checkpoints bound each group and preserve the unprocessed tail', t => {
  const f = checkpointFixture(t);
  f.row(1, 'telegram:a', 'A first');
  f.row(2, 'telegram:b', 'B first');
  f.row(3, 'telegram:a', '<smart-mode>routing instruction</smart-mode>\n<current-message>Alex said: change this</current-message>');
  f.row(4, 'telegram:b', 'B unsummarized');
  f.row(5, 'telegram:c', 'C unsummarized');
  f.row(6, 'telegram:a', 'Agent reply', 'telegram', 'out');
  f.row(7, 'telegram:a', 'excluded internal', 'internal');
  f.row(8, 'telegram:a', 'excluded multica', 'multica');
  f.checkpoint(1, 'telegram:a', 1, 8);
  f.checkpoint(2, 'telegram:b', 2, 2);
  const logDir = path.join(f.env.ZYLOS_DIR, 'memory/session-groups/telegram:a/sessions');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, '2026-11-16.md'), 'digested session');
  const input = `const config=${JSON.stringify(f.config)}; const options={zylos_dir:process.env.ZYLOS_DIR,time_zone:'UTC',now:Date.parse('2026-11-16T02:00:00Z')};`;
  const first = execute(f, `${input} const run=materials.collectMaterials(config,{},options); materials.traceMaterials(config,{},run,[{session_group:'telegram:a',c4_id:3,kind:'correction'}]); console.log(JSON.stringify(run));`);
  assert.equal(first.mode, 'checkpoints');
  assert.equal(first.ranges.length, 2);
  assert.equal(first.ranges.find(r => r.session_group === 'telegram:a').end, 8);
  assert.equal(first.ranges.find(r => r.session_group === 'telegram:b').end, 2);
  assert.equal(first.inbound.length, 3);
  assert.equal(first.inbound.find(r => r.id === 3).content, 'Alex said: change this');
  assert.ok(first.session_files.includes(path.join(logDir, '2026-11-16.md')));
  assert.ok(first.traces[0].rows.every(r => r.session_group === 'telegram:a'));
  assert.ok(first.traces[0].rows.some(r => r.id === 6 && r.direction === 'out'));
  f.checkpoint(3, 'telegram:b', 3, 4);
  const state = { groups: { 'telegram:a': { end_conversation_id: 8, checkpoint_id: 11 }, 'telegram:b': { end_conversation_id: 2, checkpoint_id: 12 } } };
  const next = execute(f, `${input} console.log(JSON.stringify(materials.collectMaterials(config,${JSON.stringify(state)},options)));`);
  assert.equal(next.ranges.length, 1);
  assert.equal(next.ranges[0].session_group, 'telegram:b');
  assert.equal(next.ranges[0].after, 2);
  assert.equal(next.inbound.length, 1);
  assert.equal(next.inbound[0].id, 4);
});

// Same private Core/DB boundary. Run for single-session group discovery or log
// path changes; skip unrelated identity/scheduler work.
test('real Core single-session checkpoints select the legacy session log directory', t => {
  const f = checkpointFixture(t);
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), '{"runtime":"codex","session_mode":"single"}');
  fs.mkdirSync(path.join(f.env.ZYLOS_DIR, '.claude/skills/telegram'), { recursive: true });
  const dbModule = pathToFileURL(f.config.c4_db_cli).href;
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as db from ${JSON.stringify(dbModule)};
    const row=db.insertConversation('in','telegram','room','single-session human');
    db.claimConversation(row.id); db.markDelivered(row.id);
    db.createCheckpoint('*',row.id,'digested');
    console.log(JSON.stringify(row)); db.close();`], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(writer.status, 0, writer.stderr);
  assert.equal(JSON.parse(writer.stdout).session_group, 'telegram');
  const today = new Date().toISOString().slice(0, 10);
  const log = path.join(f.env.ZYLOS_DIR, 'memory/sessions', `${today}.md`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'legacy session log');
  const result = execute(f, `const config=${JSON.stringify(f.config)};
    const run=materials.collectMaterials(config, {}, {zylos_dir:process.env.ZYLOS_DIR,time_zone:'UTC'});
    materials.traceMaterials(config, {}, run, [{session_group:run.inbound[0].session_group,c4_id:run.inbound[0].id,kind:'correction'}]);
    console.log(JSON.stringify(run));`);
  assert.equal(result.ranges.length, 1);
  assert.equal(result.ranges[0].session_group, '*');
  assert.equal(result.inbound.length, 1);
  assert.equal(result.inbound[0].session_group, 'telegram');
  assert.ok(result.session_files.includes(log));
  assert.equal(result.traces.length, 1);
  assert.equal(result.traces[0].clue.session_group, '*');
  assert.equal(result.traces[0].rows[0].session_group, 'telegram');
});
