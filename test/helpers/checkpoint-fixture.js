import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function checkpointFixture(t) {
  assert.ok(process.env.ZYLOS_PACKAGE_ROOT, 'Set ZYLOS_PACKAGE_ROOT to a real Core checkout');
  const core = fs.realpathSync(process.env.ZYLOS_PACKAGE_ROOT);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c4-material-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, TZ: 'UTC', ZYLOS_PACKAGE_ROOT: core };
  for (const [key, name] of Object.entries({ HOME: 'home', ZYLOS_DIR: 'instance', ZYLOS_DATA_DIR: 'data', PM2_HOME: 'pm2', TMPDIR: 'tmp', TMUX_TMPDIR: 'tmux' })) {
    env[key] = path.join(root, name);
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep), key);
  }
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'));
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), '{"runtime":"codex","session_mode":"multi"}');
  const scripts = path.join(core, 'skills/comm-bridge/scripts');
  const config = { c4_db_cli: path.join(scripts, 'c4-db.js'), c4_fetch_cli: path.join(scripts, 'c4-fetch.js'), max_page_bytes: 4 * 1024 * 1024, trace_context: 1, trace_max_clues: 2, trace_max_bytes: 1024 * 1024 };
  const database = path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db');
  assert.ok(path.resolve(database).startsWith(root + path.sep));
  function invoke(script, args) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 });
    assert.equal(result.status, 0, (result.stdout + result.stderr).slice(0, 1000));
    return result.stdout;
  }
  invoke(config.c4_db_cli, ['init']);
  function sql(text) { return execFileSync('sqlite3', [database], { env, input: text, encoding: 'utf8', timeout: 5000 }); }
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  function row(id, group, content, channel = 'telegram', direction = 'in') {
    sql(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,status,session_group) VALUES(${id},'2026-11-16 01:00:00',${quote(direction)},${quote(channel)},'room',${quote(content)},'delivered',${quote(group)});
      INSERT INTO group_heads(session_group,head_id) VALUES(${quote(group)},${id}) ON CONFLICT(session_group) DO UPDATE SET head_id=excluded.head_id;`);
  }
  function checkpoint(id, group, start, end) {
    sql(`INSERT INTO checkpoints(id,summary,start_conversation_id,end_conversation_id,session_group,no_content) VALUES(${id + 10},'digested',${start},${end},${quote(group)},0);`);
  }
  return { root, env, config, row, checkpoint, invoke, sql };
}
