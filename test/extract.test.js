import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTRACT = path.join(ROOT, 'scripts/extract.js');
const POST_INSTALL = path.join(ROOT, 'hooks/post-install.js');
const UNCONFIGURED_MARKER = '<!-- thinking-patterns: UNCONFIGURED -->';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-patterns-test-'));
}

function runNode(script, args = [], env = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function runNodeFailure(script, args = [], env = {}) {
  try {
    runNode(script, args, env);
  } catch (err) {
    return {
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
      status: err.status
    };
  }
  throw new Error('Expected command to fail');
}

// Fake comm-bridge CLIs driven by a JSON fixture file. The fake `recent N`
// mirrors the real c4-db.js: newest N rows ordered by timestamp (not id).
// The fake fetch prints the real c4-fetch.js header format for ids in range.
function createFakeC4(dir, rows) {
  const fixturePath = path.join(dir, 'c4-rows.json');
  fs.writeFileSync(fixturePath, JSON.stringify(rows));

  const dbPath = path.join(dir, 'c4-db.js');
  fs.writeFileSync(dbPath, `
import fs from 'node:fs';
const rows = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
const [command, limitArg] = process.argv.slice(2);
if (command !== 'recent') { console.error('unsupported: ' + command); process.exit(2); }
const limit = Number(limitArg || 10);
const sorted = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.id - a.id));
console.log(JSON.stringify(sorted.slice(0, limit), null, 2));
`);

  const fetchPath = path.join(dir, 'c4-fetch.js');
  fs.writeFileSync(fetchPath, `
import fs from 'node:fs';
const rows = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
const args = process.argv.slice(2);
const begin = Number(args[args.indexOf('--begin') + 1]);
const end = Number(args[args.indexOf('--end') + 1]);
console.log('[Conversations] (id ' + begin + ' ~ ' + end + ')');
for (const row of rows.filter(r => r.id >= begin && r.id <= end).sort((a, b) => a.id - b.id)) {
  console.log('[' + row.timestamp + '] ' + row.direction.toUpperCase() + ' (' + row.channel + ':' + row.endpoint_id + '):');
  console.log(row.content);
  console.log('');
}
`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return { dbPath, fetchPath };
}

function makeRows(count, { startId = 1, channel = 'telegram' } = {}) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const id = startId + i;
    const minute = String(i % 60).padStart(2, '0');
    const hour = String(Math.floor(i / 60) % 24).padStart(2, '0');
    rows.push({
      id,
      timestamp: `2026-09-01 ${hour}:${minute}:00`,
      direction: i % 2 === 0 ? 'in' : 'out',
      channel,
      endpoint_id: '1',
      content: `message ${id}`
    });
  }
  return rows;
}

function writeConfig(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function writeConfiguredPolicy(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'policy.md'), '# Policy\n\nSubject: the owner\nConfirmation: record and notify me\n');
}

function writeState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

function readState(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
}

function setup(rows, config = {}) {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  const { dbPath, fetchPath } = createFakeC4(dir, rows);
  const patternsFile = path.join(dir, 'patterns.md');
  writeConfig(dataDir, { min_conversations: 2, c4_db_cli: dbPath, c4_fetch_script: fetchPath, patterns_file: patternsFile, ...config });
  writeConfiguredPolicy(dataDir);
  return { dir, dataDir, patternsFile, env: { ZYLOS_DATA_DIR: dataDir } };
}

test('fetch skips below threshold without advancing state', () => {
  const { dataDir, env } = setup(makeRows(1));

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'below_threshold');
  assert.equal(result.begin_id, 1);
  assert.equal(result.end_id, 1);
  assert.equal(result.count, 1);
  assert.equal(result.conversations, undefined);
  assert.equal(fs.existsSync(path.join(dataDir, 'state.json')), false);
});

test('fetch returns ready envelope with transcript at threshold', () => {
  const { env } = setup(makeRows(2));

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'ready');
  assert.equal(result.begin_id, 1);
  assert.equal(result.end_id, 2);
  assert.equal(result.count, 2);
  assert.equal(result.min_conversations, 2);
  assert.match(result.conversations, /\[Conversations\] \(id 1 ~ 2\)/);
  assert.match(result.conversations, /IN \(telegram:1\):\nmessage 1/);
  assert.match(result.conversations, /OUT \(telegram:1\):\nmessage 2/);
  assert.equal(result.patterns.exists, false);
  assert.equal(result.patterns.next_number, 1);
  assert.ok(result.policy_file.endsWith('policy.md'));
  assert.ok(result.methodology_file.endsWith('references/methodology.md'));
});

test('fetch resumes from last_processed_id and only counts newer rows', () => {
  const { dataDir, env } = setup(makeRows(6));
  writeState(dataDir, { last_processed_id: 4 });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'ready');
  assert.equal(result.begin_id, 5);
  assert.equal(result.end_id, 6);
  assert.equal(result.count, 2);
  assert.doesNotMatch(result.conversations, /message 4\n/);
});

test('fetch caps a first-run backlog to the max_conversations window', () => {
  const { env } = setup(makeRows(10), { max_conversations: 4 });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'ready');
  assert.equal(result.begin_id, 7);
  assert.equal(result.end_id, 10);
  assert.equal(result.count, 4);
});

test('fetch does not cap when the backlog fits inside the window', () => {
  const { dataDir, env } = setup(makeRows(10), { max_conversations: 20 });
  writeState(dataDir, { last_processed_id: 3 });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.begin_id, 4);
  assert.equal(result.end_id, 10);
  assert.equal(result.count, 7);
});

test('fetch skips with reason unconfigured while policy carries the marker', () => {
  const { dataDir, env } = setup(makeRows(5));
  fs.writeFileSync(path.join(dataDir, 'policy.md'), `${UNCONFIGURED_MARKER}\n# Policy\n`);

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'unconfigured');
  assert.match(result.owner_action, /policy\.md/);
  assert.equal(result.conversations, undefined);
});

test('fetch skips with reason unconfigured when policy is missing', () => {
  const { dataDir, env } = setup(makeRows(5));
  fs.unlinkSync(path.join(dataDir, 'policy.md'));

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'unconfigured');
});

test('fetch skips when disabled', () => {
  const { env } = setup(makeRows(5), { enabled: false });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'disabled');
});

test('fetch reports a missing comm-bridge CLI as a JSON error', () => {
  const { dataDir, env } = setup(makeRows(5));
  writeConfig(dataDir, { min_conversations: 1, c4_db_cli: path.join(dataDir, 'missing-c4-db.js') });

  const failure = runNodeFailure(EXTRACT, ['fetch'], env);
  const result = JSON.parse(failure.stdout);

  assert.equal(failure.status, 1);
  assert.equal(result.status, 'error');
  assert.match(result.error, /c4-db\.js not found/);
});

test('fetch reports an unparsable c4-db.js output as a JSON error', () => {
  const { dir, dataDir, env } = setup(makeRows(5));
  const brokenDb = path.join(dir, 'broken-c4-db.js');
  fs.writeFileSync(brokenDb, "console.log('not json');\n");
  const { fetchPath } = createFakeC4(dir, makeRows(5));
  writeConfig(dataDir, { min_conversations: 1, c4_db_cli: brokenDb, c4_fetch_script: fetchPath });

  const failure = runNodeFailure(EXTRACT, ['fetch'], env);
  const result = JSON.parse(failure.stdout);

  assert.equal(failure.status, 1);
  assert.equal(result.status, 'error');
});

test('commit skip records the run and keeps the processed cursor', () => {
  const { dataDir, env } = setup(makeRows(1));
  writeState(dataDir, { last_processed_id: 3 });

  const result = JSON.parse(runNode(EXTRACT, ['commit', '--result', 'skip', '--observed-end-id', '9'], env));
  const state = readState(dataDir);

  assert.equal(result.status, 'committed');
  assert.equal(state.last_processed_id, 3);
  assert.equal(state.last_observed_id, 9);
  assert.equal(state.last_result, 'skip');
  assert.equal(state.last_update_at, null);
  const log = fs.readFileSync(path.join(dataDir, 'logs/runs.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).result, 'skip');
});

test('commit no_change advances the processed cursor without marking an update', () => {
  const { dataDir, env } = setup(makeRows(1));

  runNode(EXTRACT, ['commit', '--result', 'no_change', '--end-id', '12'], env);
  const state = readState(dataDir);

  assert.equal(state.last_processed_id, 12);
  assert.equal(state.last_observed_id, 12);
  assert.equal(state.last_result, 'no_change');
  assert.equal(state.last_update_at, null);
});

test('commit updated advances the cursor and records the update time', () => {
  const { dataDir, env } = setup(makeRows(1));

  runNode(EXTRACT, ['commit', '--result', 'updated', '--end-id', '15'], env);
  const state = readState(dataDir);

  assert.equal(state.last_processed_id, 15);
  assert.equal(state.last_result, 'updated');
  assert.ok(state.last_update_at);
});

test('commit refuses to move the processed cursor backward', () => {
  const { dataDir, env } = setup(makeRows(1));
  writeState(dataDir, { last_processed_id: 20 });

  const failure = runNodeFailure(EXTRACT, ['commit', '--result', 'no_change', '--end-id', '10'], env);
  const result = JSON.parse(failure.stdout);

  assert.equal(failure.status, 1);
  assert.match(result.error, /Refusing to move last_processed_id backward/);
  assert.equal(readState(dataDir).last_processed_id, 20);
});

test('commit rejects an unknown result and a missing end id', () => {
  const { env } = setup(makeRows(1));

  assert.match(JSON.parse(runNodeFailure(EXTRACT, ['commit', '--result', 'bogus'], env).stdout).error, /commit requires --result/);
  assert.match(JSON.parse(runNodeFailure(EXTRACT, ['commit', '--result', 'updated'], env).stdout).error, /requires --end-id/);
});

test('fetch → commit round trip: second fetch starts after the committed end id', () => {
  const { env } = setup(makeRows(4));

  const first = JSON.parse(runNode(EXTRACT, ['fetch'], env));
  assert.equal(first.status, 'ready');
  runNode(EXTRACT, ['commit', '--result', 'no_change', '--end-id', String(first.end_id)], env);

  const second = JSON.parse(runNode(EXTRACT, ['fetch'], env));
  assert.equal(second.status, 'skip');
  assert.equal(second.reason, 'below_threshold');
  assert.equal(second.begin_id, 5);
  assert.equal(second.count, 0);
});

test('inspect reports entry count, max number and next number from the pattern file', () => {
  const { patternsFile, env } = setup(makeRows(1));
  fs.writeFileSync(patternsFile, [
    '# Patterns',
    '',
    '## 1. First',
    '`[Domain: Process | Type: Constraint]`',
    '',
    '**Reinforced (2026-09-01)**: again',
    '',
    '---',
    '',
    '## 7. Seventh',
    '',
    '### 3. Not an entry heading',
    '',
    '## 4. Fourth',
    ''
  ].join('\n'));

  const result = JSON.parse(runNode(EXTRACT, ['inspect'], env));

  assert.equal(result.status, 'ok');
  assert.equal(result.exists, true);
  assert.equal(result.entry_count, 3);
  assert.equal(result.max_number, 7);
  assert.equal(result.next_number, 8);
  assert.equal(result.reinforced_count, 1);
  assert.equal(result.policy_unconfigured, false);
});

test('inspect on a missing pattern file starts numbering at 1', () => {
  const { env } = setup(makeRows(1));

  const result = JSON.parse(runNode(EXTRACT, ['inspect'], env));

  assert.equal(result.exists, false);
  assert.equal(result.entry_count, 0);
  assert.equal(result.next_number, 1);
});

test('status exposes config, state, policy and pattern-file summary', () => {
  const { dataDir, env } = setup(makeRows(1));
  writeState(dataDir, { last_processed_id: 5 });

  const result = JSON.parse(runNode(EXTRACT, ['status'], env));

  assert.equal(result.status, 'ok');
  assert.equal(result.config.min_conversations, 2);
  assert.equal(result.state.last_processed_id, 5);
  assert.equal(result.state.schema_version, 1);
  assert.equal(result.policy_unconfigured, false);
  assert.equal(result.patterns.next_number, 1);
});

test('template prints a scheduler command whose prompt points at the installed SKILL.md', () => {
  const { env } = setup(makeRows(1));

  const text = runNode(EXTRACT, ['template'], env);

  assert.match(text, /scheduler\/scripts\/cli\.js add "/);
  assert.match(text, /--cron "/);
  assert.match(text, /--name thinking-patterns/);
  assert.match(text, /skills\/thinking-patterns\/SKILL\.md/);
  assert.match(text, /background-subagent/);
});

test('template --json parses and carries the same prompt', () => {
  const { env } = setup(makeRows(1));

  const result = JSON.parse(runNode(EXTRACT, ['template', '--json'], env));

  assert.equal(result.status, 'ok');
  assert.match(result.scheduler_prompt, /thinking-patterns\/SKILL\.md/);
  assert.ok(result.template.includes(result.scheduler_prompt));
});

test('template --policy prints the policy template with the UNCONFIGURED marker first', () => {
  const { env } = setup(makeRows(1));

  const text = runNode(EXTRACT, ['template', '--policy'], env);

  assert.ok(text.startsWith(UNCONFIGURED_MARKER));
  for (const section of ['## Subject', '## Sources', '## Domains', '## Confirmation', '## Notification']) {
    assert.ok(text.includes(section), `missing ${section}`);
  }
});

test('unknown command prints usage as a JSON error', () => {
  const { env } = setup(makeRows(1));

  const failure = runNodeFailure(EXTRACT, ['nonsense'], env);

  assert.equal(failure.status, 1);
  assert.match(JSON.parse(failure.stdout).error, /Usage: extract\.js/);
});

test('post-install creates config, policy template, state and logs dir without touching the scheduler', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  // A PATH without node's directory would break the hook itself; instead make
  // any scheduler invocation observable by planting a trap script named cli.js.
  const trapDir = path.join(dir, 'trap');
  fs.mkdirSync(trapDir, { recursive: true });
  const trapMarker = path.join(dir, 'scheduler-was-called');
  fs.writeFileSync(path.join(trapDir, 'cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(trapMarker)}, '1');\n`);

  const output = runNode(POST_INSTALL, [], { ZYLOS_DATA_DIR: dataDir, ZYLOS_DIR: dir });

  assert.match(output, /OWNER ACTION REQUIRED/);
  assert.match(output, /Created config\.json/);
  assert.match(output, /Created policy\.md/);
  assert.match(output, /Created state\.json/);
  assert.ok(fs.existsSync(path.join(dataDir, 'config.json')));
  assert.ok(fs.readFileSync(path.join(dataDir, 'policy.md'), 'utf8').startsWith(UNCONFIGURED_MARKER));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).last_processed_id, 0);
  assert.ok(fs.statSync(path.join(dataDir, 'logs')).isDirectory());
  assert.equal(fs.existsSync(trapMarker), false);
});

test('post-install preserves an existing policy and merges defaults into config', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  writeConfig(dataDir, { min_conversations: 7 });
  fs.writeFileSync(path.join(dataDir, 'policy.md'), '# Owner policy\n');

  const output = runNode(POST_INSTALL, [], { ZYLOS_DATA_DIR: dataDir, ZYLOS_DIR: dir });
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));

  assert.match(output, /Policy exists; preserving owner edits/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'policy.md'), 'utf8'), '# Owner policy\n');
  assert.equal(config.min_conversations, 7);
  assert.equal(config.enabled, true);
  assert.ok(config.patterns_file);
});

test('countMessages positive control: counts one header per message, ignores checkpoint prose', async () => {
  const { countMessages } = await import('../scripts/lib.js');
  const transcript = [
    '[Last Checkpoint Summary] something that mentions [2026-09-01 10:00:00] inside prose',
    '',
    '[Conversations] (id 1 ~ 3)',
    '[2026-09-01 10:00:00] IN (telegram:1):',
    'hello',
    '',
    '[2026-09-01 10:01:00] OUT (telegram:1):',
    'hi',
    '',
    '[2026-09-01 10:02:00] IN (lark:group x):',
    'again',
    ''
  ].join('\n');

  assert.equal(countMessages(transcript), 3);
  assert.equal(countMessages(''), 0);
  // Known limitation (documented, out of scope): a header-shaped line at the
  // start of a message body would be counted as a message.
});
