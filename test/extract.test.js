import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTRACT = path.join(ROOT, 'scripts/extract.js');
const POST_INSTALL = path.join(ROOT, 'hooks/post-install.js');
const POST_UPGRADE = path.join(ROOT, 'hooks/post-upgrade.js');
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

// Fake comm-bridge CLI driven by a JSON fixture file. The fake `recent N`
// mirrors the real c4-db.js: the N newest rows by timestamp, returned oldest
// first, with content. This is the only C4 primitive the component uses.
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
const newest = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b.id - a.id)).slice(0, limit);
newest.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id - b.id));
console.log(JSON.stringify(newest, null, 2));
`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  return dbPath;
}

function c4Timestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Rows are described by their age in minutes relative to now (UTC), so the
// fixture matches whatever wall-clock the test runs at.
function makeRows(agesMinutes, { channel = 'telegram' } = {}) {
  const now = Date.now();
  return agesMinutes.map((age, i) => ({
    id: i + 1,
    timestamp: c4Timestamp(now - age * 60_000),
    direction: i % 2 === 0 ? 'in' : 'out',
    channel,
    endpoint_id: '1',
    content: `message ${i + 1} (age ${age}m)`
  }));
}

function writeConfig(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

// A filled-in owner policy. The target file lives in the policy (## Target), not in config.
function policyText(patternsFile, extra = '') {
  return `# Policy\n\nSubject: the owner\n\n## Target\n\nPatterns file: ${patternsFile}\n\n## Sources\n\n${extra}\nConfirmation: record and notify me\n`;
}

function writeConfiguredPolicy(dataDir, patternsFile, extra = '', name = 'policy.md') {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, name), policyText(patternsFile, extra));
}

function readState(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
}

function setup(rows, config = {}) {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  const dbPath = createFakeC4(dir, rows);
  const patternsFile = path.join(dir, 'patterns.md');
  writeConfig(dataDir, { min_conversations: 2, c4_db_cli: dbPath, ...config });
  writeConfiguredPolicy(dataDir, patternsFile);
  return { dir, dataDir, patternsFile, env: { ZYLOS_DATA_DIR: dataDir } };
}

test('fetch skips below threshold without touching state', () => {
  const { dataDir, env } = setup(makeRows([10]));

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'below_threshold');
  assert.equal(result.count, 1);
  assert.equal(result.task, 'default');
  assert.equal(result.window.lookback, '24h');
  assert.equal(result.conversations, undefined);
  assert.equal(fs.existsSync(path.join(dataDir, 'state.json')), false);
});

test('fetch returns ready envelope with transcript at threshold', () => {
  const { env } = setup(makeRows([30, 10]));

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'ready');
  assert.equal(result.count, 2);
  assert.equal(result.min_conversations, 2);
  assert.equal(result.truncated, false);
  assert.match(result.window.begin, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(result.conversations, /\[Conversations\] \(window .* UTC, lookback 24h, 2 messages\)/);
  assert.match(result.conversations, /IN \(telegram:1\):\nmessage 1 \(age 30m\)/);
  assert.match(result.conversations, /OUT \(telegram:1\):\nmessage 2 \(age 10m\)/);
  assert.ok(result.conversations.indexOf('message 1') < result.conversations.indexOf('message 2'), 'oldest first');
  assert.equal(result.patterns.exists, false);
  assert.equal(result.patterns.next_number, 1);
  assert.equal(result.policy, 'default');
  assert.ok(result.policy_file.endsWith('policy.md'));
  assert.deepEqual(result.filters, { channels: null, exclude_channels: ['system', 'void'] });
  assert.equal(result.filtered_out, 0);
  assert.ok(result.methodology_file.endsWith('references/methodology.md'));
});

test('fetch writes a large transcript completely through a pipe', () => {
  // Regression: process.stdout.write + process.exit truncated payloads larger
  // than the pipe buffer. 200 rows × 4KB ≈ 800KB must arrive intact.
  const rows = makeRows(Array.from({ length: 200 }, (_, i) => 200 - i));
  for (const row of rows) row.content = `${row.content} ${'x'.repeat(4000)}`;
  const { env } = setup(rows, { min_conversations: 1 });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'ready');
  assert.equal(result.count, 200);
  assert.ok(result.conversations.length > 800_000);
  assert.match(result.conversations, /message 200 \(age 1m\) x{4000}\n/);
});

test('fetch only includes rows inside the lookback window', () => {
  // ages: 30h, 25h, 23h, 1h — a 24h window keeps the last two.
  const { env } = setup(makeRows([30 * 60, 25 * 60, 23 * 60, 60]));

  const result = JSON.parse(runNode(EXTRACT, ['fetch', '--lookback', '24h'], env));

  assert.equal(result.status, 'ready');
  assert.equal(result.count, 2);
  assert.doesNotMatch(result.conversations, /age 1800m/);
  assert.doesNotMatch(result.conversations, /age 1500m/);
  assert.match(result.conversations, /age 1380m/);
  assert.match(result.conversations, /age 60m/);
});

test('fetch --lookback overrides default_lookback from config', () => {
  const { env } = setup(makeRows([30 * 60, 25 * 60, 60]), { default_lookback: '24h' });

  const narrow = JSON.parse(runNode(EXTRACT, ['fetch'], env));
  const wide = JSON.parse(runNode(EXTRACT, ['fetch', '--lookback', '2d', '--task', 'weekly'], env));

  assert.equal(narrow.status, 'skip');
  assert.equal(narrow.count, 1);
  assert.equal(wide.status, 'ready');
  assert.equal(wide.count, 3);
  assert.equal(wide.task, 'weekly');
  assert.equal(wide.window.lookback, '2d');
});

test('two tasks with different lookbacks see different windows of the same data', () => {
  const { env } = setup(makeRows([6 * 24 * 60, 3 * 24 * 60, 20 * 60, 30]), { min_conversations: 1 });

  const daily = JSON.parse(runNode(EXTRACT, ['fetch', '--lookback', '24h', '--task', 'daily'], env));
  const weekly = JSON.parse(runNode(EXTRACT, ['fetch', '--lookback', '7d', '--task', 'weekly'], env));

  assert.equal(daily.count, 2);
  assert.equal(weekly.count, 4);
});

test('fetch flags truncation when the cap hides older in-window rows', () => {
  const { env } = setup(makeRows([50, 40, 30, 20, 10]), { max_conversations: 3, min_conversations: 1 });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.count, 3);
  assert.equal(result.truncated, true);
  assert.match(result.conversations, /age 10m/);
  assert.doesNotMatch(result.conversations, /age 50m/);
});

test('fetch does not flag truncation when the cap returns rows outside the window', () => {
  const { env } = setup(makeRows([30 * 60, 20, 10]), { max_conversations: 3, min_conversations: 1 });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.count, 2);
  assert.equal(result.truncated, false);
});

test('fetch rejects an invalid lookback or task name as a JSON error', () => {
  const { env } = setup(makeRows([10, 5]));

  const bad = JSON.parse(runNodeFailure(EXTRACT, ['fetch', '--lookback', 'yesterday'], env).stdout);
  const zero = JSON.parse(runNodeFailure(EXTRACT, ['fetch', '--lookback', '0h'], env).stdout);
  const name = JSON.parse(runNodeFailure(EXTRACT, ['fetch', '--task', 'no spaces'], env).stdout);

  assert.match(bad.error, /Invalid lookback/);
  assert.match(zero.error, /Invalid lookback/);
  assert.match(name.error, /Invalid task name/);
});

test('fetch skips with reason unconfigured while policy carries the marker', () => {
  const { dataDir, env } = setup(makeRows([10, 5]));
  fs.writeFileSync(path.join(dataDir, 'policy.md'), `${UNCONFIGURED_MARKER}\n# Policy\n`);

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'unconfigured');
  assert.match(result.owner_action, /policy\.md/);
  assert.equal(result.conversations, undefined);
});

test('fetch skips with reason unconfigured when policy is missing', () => {
  const { dataDir, env } = setup(makeRows([10, 5]));
  fs.unlinkSync(path.join(dataDir, 'policy.md'));

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'unconfigured');
});

test('fetch skips when disabled', () => {
  const { env } = setup(makeRows([10, 5]), { enabled: false });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'disabled');
});

test('fetch reports a missing comm-bridge CLI as a JSON error', () => {
  const { dataDir, env } = setup(makeRows([10, 5]));
  writeConfig(dataDir, { min_conversations: 1, c4_db_cli: path.join(dataDir, 'missing-c4-db.js') });

  const failure = runNodeFailure(EXTRACT, ['fetch'], env);
  const result = JSON.parse(failure.stdout);

  assert.equal(failure.status, 1);
  assert.equal(result.status, 'error');
  assert.match(result.error, /c4-db\.js not found/);
});

test('fetch reports unparsable c4-db.js output and bad timestamps as JSON errors', () => {
  const { dir, dataDir, env } = setup(makeRows([10, 5]));
  const brokenDb = path.join(dir, 'broken-c4-db.js');
  fs.writeFileSync(brokenDb, "console.log('not json');\n");
  writeConfig(dataDir, { min_conversations: 1, c4_db_cli: brokenDb });
  const broken = JSON.parse(runNodeFailure(EXTRACT, ['fetch'], env).stdout);
  assert.equal(broken.status, 'error');

  const badTs = createFakeC4(dir, [{ id: 1, timestamp: 'not a time', direction: 'in', channel: 'x', endpoint_id: '1', content: 'y' }]);
  writeConfig(dataDir, { min_conversations: 1, c4_db_cli: badTs });
  const ts = JSON.parse(runNodeFailure(EXTRACT, ['fetch'], env).stdout);
  assert.match(ts.error, /Invalid C4 timestamp/);
});

test('commit records the run, task and window without marking an update', () => {
  const { dataDir, env } = setup(makeRows([10]));

  const result = JSON.parse(runNode(EXTRACT, ['commit', '--result', 'skip', '--task', 'daily', '--lookback', '24h', '--window-end', '2026-09-05 00:00:00'], env));
  const state = readState(dataDir);

  assert.equal(result.status, 'committed');
  assert.equal(result.task, 'daily');
  assert.equal(state.schema_version, 2);
  assert.equal(state.last_result, 'skip');
  assert.equal(state.last_update_at, null);
  assert.deepEqual(state.last_window, { task: 'daily', policy: 'default', lookback: '24h', end: '2026-09-05 00:00:00' });
  const log = fs.readFileSync(path.join(dataDir, 'logs/runs.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).result, 'skip');
  assert.equal(JSON.parse(log[0]).task, 'daily');
});

test('commit no_change does not mark an update; updated records the update time', () => {
  const { dataDir, env } = setup(makeRows([10]));

  runNode(EXTRACT, ['commit', '--result', 'no_change'], env);
  assert.equal(readState(dataDir).last_update_at, null);
  assert.equal(readState(dataDir).last_window.task, 'default');

  runNode(EXTRACT, ['commit', '--result', 'updated'], env);
  const state = readState(dataDir);
  assert.equal(state.last_result, 'updated');
  assert.ok(state.last_update_at);
  assert.equal(fs.readFileSync(path.join(dataDir, 'logs/runs.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('commit rejects an unknown result', () => {
  const { env } = setup(makeRows([10]));

  const failure = runNodeFailure(EXTRACT, ['commit', '--result', 'bogus'], env);

  assert.equal(failure.status, 1);
  assert.match(JSON.parse(failure.stdout).error, /commit requires --result/);
});

test('state written by schema 1 is migrated: id cursors dropped, schema 2', () => {
  const { dataDir, env } = setup(makeRows([10]));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ schema_version: 1, last_processed_id: 49611, last_observed_id: 49611, last_result: 'updated' }));

  const status = JSON.parse(runNode(EXTRACT, ['status'], env));
  assert.equal(status.state.schema_version, 2);
  assert.equal(status.state.last_processed_id, undefined);
  assert.equal(status.state.last_result, 'updated');

  runNode(POST_UPGRADE, [], env);
  const migrated = readState(dataDir);
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.last_processed_id, undefined);
  assert.equal(migrated.last_result, 'updated');
});

test('inspect reports entry count, max number and next number from the pattern file', () => {
  const { patternsFile, env } = setup(makeRows([10]));
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
    '`[Domain: Architecture | Type: Constraint]`',
    '',
    '### 3. Not an entry heading',
    'Prose mentioning `[Domain: Nope | Type: Nope]` mid-line is not a tag line',
    '',
    '## 4. Fourth',
    '`[Domain: Process | Type: Heuristic]`',
    ''
  ].join('\n'));

  const result = JSON.parse(runNode(EXTRACT, ['inspect'], env));

  assert.equal(result.status, 'ok');
  assert.equal(result.patterns.exists, true);
  assert.equal(result.patterns.entry_count, 3);
  assert.equal(result.patterns.max_number, 7);
  assert.equal(result.patterns.next_number, 8);
  assert.equal(result.patterns.reinforced_count, 1);
  assert.deepEqual(result.patterns.domains, { Process: 2, Architecture: 1 });
  assert.deepEqual(result.patterns.types, { Constraint: 2, Heuristic: 1 });
  assert.equal(result.policy_unconfigured, false);
});

test('inspect on a missing pattern file starts numbering at 1', () => {
  const { env } = setup(makeRows([10]));

  const result = JSON.parse(runNode(EXTRACT, ['inspect'], env));

  assert.equal(result.patterns.exists, false);
  assert.equal(result.patterns.entry_count, 0);
  assert.equal(result.patterns.next_number, 1);
  assert.deepEqual(result.patterns.domains, {});
});

test('status exposes config, state, policy and pattern-file summary', () => {
  const { env } = setup(makeRows([10]));

  const result = JSON.parse(runNode(EXTRACT, ['status'], env));

  assert.equal(result.status, 'ok');
  assert.equal(result.config.min_conversations, 2);
  assert.equal(result.config.default_lookback, '24h');
  assert.equal(result.state.schema_version, 2);
  assert.equal(result.state.last_run_at, null);
  assert.equal(result.policy_unconfigured, false);
  assert.equal(result.patterns.next_number, 1);
});

test('template prints the owner questions and a scheduler command carrying lookback and task', () => {
  const { env } = setup(makeRows([10]));

  const text = runNode(EXTRACT, ['template', '--lookback', '7d', '--task', 'weekly', '--cron', '0 22 * * 0'], env);

  assert.match(text, /ask the owner/i);
  assert.match(text, /1\. How often should it run\?/);
  assert.match(text, /2\. How far back should each run look\?/);
  assert.match(text, /3\. A short task name/);
  assert.match(text, /scheduler\/scripts\/cli\.js add "/);
  assert.match(text, /--cron "0 22 \* \* 0"/);
  assert.match(text, /--name thinking-patterns-weekly/);
  assert.match(text, /fetch --lookback 7d --task weekly/);
  assert.match(text, /skills\/thinking-patterns\/SKILL\.md/);
  assert.match(text, /background-subagent/);
});

test('template defaults name the task thinking-patterns and use default_lookback', () => {
  const { env } = setup(makeRows([10]), { default_lookback: '36h' });

  const text = runNode(EXTRACT, ['template'], env);

  assert.match(text, /--name thinking-patterns\b/);
  assert.doesNotMatch(text, /--name thinking-patterns-default/);
  assert.match(text, /fetch --lookback 36h --task default/);
});

test('template --json parses and carries the same prompt and questions', () => {
  const { env } = setup(makeRows([10]));

  const result = JSON.parse(runNode(EXTRACT, ['template', '--json', '--lookback', '24h', '--task', 'daily'], env));

  assert.equal(result.status, 'ok');
  assert.equal(result.task, 'daily');
  assert.equal(result.lookback, '24h');
  assert.equal(result.scheduler_task_name, 'thinking-patterns-daily');
  assert.equal(result.questions.length, 3);
  assert.match(result.scheduler_prompt, /--lookback 24h --task daily/);
  assert.ok(result.template.includes(result.scheduler_prompt));
});

test('template rejects an invalid lookback', () => {
  const { env } = setup(makeRows([10]));

  const failure = runNodeFailure(EXTRACT, ['template', '--lookback', 'soon'], env);

  assert.match(JSON.parse(failure.stdout).error, /Invalid lookback/);
});

test('template --policy prints the policy template with the UNCONFIGURED marker first', () => {
  const { env } = setup(makeRows([10]));

  const text = runNode(EXTRACT, ['template', '--policy'], env);

  assert.ok(text.startsWith(UNCONFIGURED_MARKER));
  for (const section of ['## Subject', '## Sources', '## Domains', '## Confirmation', '## Notification']) {
    assert.ok(text.includes(section), `missing ${section}`);
  }
});

test('unknown command prints usage as a JSON error', () => {
  const { env } = setup(makeRows([10]));

  const failure = runNodeFailure(EXTRACT, ['nonsense'], env);

  assert.equal(failure.status, 1);
  assert.match(JSON.parse(failure.stdout).error, /Usage: extract\.js/);
});

test('post-install creates config, policy template, state and logs dir without touching the scheduler', () => {
  const dir = tmpDir();
  const dataDir = path.join(dir, 'data');
  // Make any scheduler invocation observable by planting a trap script named cli.js.
  const trapDir = path.join(dir, 'trap');
  fs.mkdirSync(trapDir, { recursive: true });
  const trapMarker = path.join(dir, 'scheduler-was-called');
  fs.writeFileSync(path.join(trapDir, 'cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(trapMarker)}, '1');\n`);

  const output = runNode(POST_INSTALL, [], { ZYLOS_DATA_DIR: dataDir, ZYLOS_DIR: dir });

  assert.match(output, /OWNER ACTION REQUIRED/);
  assert.match(output, /Created config\.json/);
  assert.match(output, /Created policy\.md/);
  assert.match(output, /Created state\.json/);
  assert.match(output, /How far back should each run look/);
  assert.ok(fs.existsSync(path.join(dataDir, 'config.json')));
  assert.ok(fs.readFileSync(path.join(dataDir, 'policy.md'), 'utf8').startsWith(UNCONFIGURED_MARKER));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).schema_version, 2);
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
  assert.equal(config.default_lookback, '24h');
  assert.equal(config.patterns_file, undefined, 'target file belongs to the policy, not config');
});

test('fetch skips as unconfigured when the policy has no Patterns file line', () => {
  const { dataDir, env } = setup(makeRows([10, 5]));
  fs.writeFileSync(path.join(dataDir, 'policy.md'), '# Policy\n\nSubject: the owner\n\n## Target\n\nPatterns file: (fill in, e.g. ~/x.md)\n');

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'unconfigured');
  assert.match(result.owner_action, /Patterns file/);
  assert.equal(result.patterns.patterns_file, null);
  assert.equal(result.conversations, undefined);
});

test('fetch ignores a patterns_file left in config: the policy owns the target', () => {
  const { dataDir, env } = setup(makeRows([10, 5]));
  writeConfig(dataDir, { min_conversations: 1, c4_db_cli: path.join(dataDir, '../c4-db.js'), patterns_file: '/should/not/be/used.md' });
  fs.writeFileSync(path.join(dataDir, 'policy.md'), '# Policy\n\nSubject: the owner\n');

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'unconfigured');
  assert.equal(result.patterns.patterns_file, null);
});

test('fetch --policy <name> reads policy-<name>.md with its own target file', () => {
  const { dir, dataDir, patternsFile, env } = setup(makeRows([10, 5]));
  const secondFile = path.join(dir, 'work-patterns.md');
  writeConfiguredPolicy(dataDir, secondFile, '', 'policy-work.md');
  fs.writeFileSync(secondFile, '# Work\n\n## 1. One\n\n## 2. Two\n');

  const main = JSON.parse(runNode(EXTRACT, ['fetch'], env));
  const work = JSON.parse(runNode(EXTRACT, ['fetch', '--policy', 'work'], env));

  assert.equal(main.policy, 'default');
  assert.equal(main.patterns.patterns_file, patternsFile);
  assert.equal(main.patterns.next_number, 1);
  assert.equal(work.status, 'ready');
  assert.equal(work.policy, 'work');
  assert.ok(work.policy_file.endsWith('policy-work.md'));
  assert.equal(work.patterns.patterns_file, secondFile);
  assert.equal(work.patterns.next_number, 3);
});

test('fetch --policy for a missing policy file skips with an owner action naming that file', () => {
  const { env } = setup(makeRows([10, 5]));

  const result = JSON.parse(runNode(EXTRACT, ['fetch', '--policy', 'nope'], env));
  const bad = JSON.parse(runNodeFailure(EXTRACT, ['fetch', '--policy', 'no spaces'], env).stdout);

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'unconfigured');
  assert.match(result.owner_action, /policy-nope\.md does not exist/);
  assert.match(bad.error, /Invalid policy name/);
});

function mixedChannelRows() {
  return [
    ...makeRows([50, 40], { channel: 'telegram' }),
    ...makeRows([30], { channel: 'lark' }).map(r => ({ ...r, id: 3 })),
    ...makeRows([20], { channel: 'system' }).map(r => ({ ...r, id: 4 })),
    ...makeRows([10], { channel: 'void' }).map(r => ({ ...r, id: 5 }))
  ];
}

test('fetch excludes system and void channels by default and reports filtered_out', () => {
  const { env } = setup(mixedChannelRows(), { min_conversations: 1 });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'ready');
  assert.equal(result.count, 3);
  assert.equal(result.filtered_out, 2);
  assert.deepEqual(result.filters, { channels: null, exclude_channels: ['system', 'void'] });
  assert.match(result.conversations, /\(telegram:1\)/);
  assert.match(result.conversations, /\(lark:1\)/);
  assert.doesNotMatch(result.conversations, /\(system:1\)/);
  assert.doesNotMatch(result.conversations, /\(void:1\)/);
});

test('fetch applies the policy Channels include list', () => {
  const { dataDir, patternsFile, env } = setup(mixedChannelRows(), { min_conversations: 1 });
  writeConfiguredPolicy(dataDir, patternsFile, 'Channels: telegram\nExclude channels: system, void\n');

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.count, 2);
  assert.equal(result.filtered_out, 3);
  assert.deepEqual(result.filters.channels, ['telegram']);
  assert.doesNotMatch(result.conversations, /\(lark:1\)/);
});

test('fetch honours "Exclude channels: none" and an explicit exclude list', () => {
  const { dataDir, patternsFile, env } = setup(mixedChannelRows(), { min_conversations: 1 });

  writeConfiguredPolicy(dataDir, patternsFile, 'Channels: all\nExclude channels: none\n');
  const none = JSON.parse(runNode(EXTRACT, ['fetch'], env));
  assert.equal(none.count, 5);
  assert.equal(none.filtered_out, 0);
  assert.deepEqual(none.filters.exclude_channels, []);
  assert.match(none.conversations, /\(void:1\)/);

  writeConfiguredPolicy(dataDir, patternsFile, 'Exclude channels: lark\n');
  const lark = JSON.parse(runNode(EXTRACT, ['fetch'], env));
  assert.equal(lark.count, 4);
  assert.deepEqual(lark.filters.exclude_channels, ['lark']);
  assert.doesNotMatch(lark.conversations, /\(lark:1\)/);
  assert.match(lark.conversations, /\(system:1\)/);
});

test('channel filtering happens before the threshold check', () => {
  const { env } = setup(mixedChannelRows(), { min_conversations: 4 });

  const result = JSON.parse(runNode(EXTRACT, ['fetch'], env));

  assert.equal(result.status, 'skip');
  assert.equal(result.reason, 'below_threshold');
  assert.equal(result.count, 3);
  assert.equal(result.filtered_out, 2);
});

test('commit records the policy in state and the run log', () => {
  const { dataDir, env } = setup(makeRows([10]));

  const result = JSON.parse(runNode(EXTRACT, ['commit', '--result', 'no_change', '--policy', 'work', '--task', 'weekly'], env));

  assert.equal(result.policy, 'work');
  assert.equal(readState(dataDir).last_window.policy, 'work');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'logs/runs.jsonl'), 'utf8').trim()).policy, 'work');
});

test('post-upgrade moves patterns_file from config.json into the policy Target section', () => {
  const { dir, dataDir, env } = setup(makeRows([10]));
  const target = path.join(dir, 'legacy-patterns.md');
  writeConfig(dataDir, { min_conversations: 2, patterns_file: target, c4_fetch_script: '/old/c4-fetch.js' });
  fs.writeFileSync(path.join(dataDir, 'policy.md'), '# Policy\n\nSubject: the owner\nConfirmation: record silently\n');

  const output = runNode(POST_UPGRADE, [], env);
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  const policy = fs.readFileSync(path.join(dataDir, 'policy.md'), 'utf8');

  assert.match(output, /Moved patterns_file/);
  assert.equal(config.patterns_file, undefined);
  assert.equal(config.c4_fetch_script, undefined);
  assert.equal(config.min_conversations, 2);
  assert.ok(policy.startsWith('# Policy\n\nSubject: the owner\nConfirmation: record silently\n'), 'owner prose untouched');
  assert.match(policy, new RegExp(`\\n## Target\\n\\nPatterns file: ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
  assert.equal(JSON.parse(runNode(EXTRACT, ['inspect'], env)).patterns.patterns_file, target);

  // Idempotent: a second run neither appends again nor changes the policy.
  runNode(POST_UPGRADE, [], env);
  assert.equal(fs.readFileSync(path.join(dataDir, 'policy.md'), 'utf8'), policy);
});

test('post-upgrade drops the config copy when the policy already names a Patterns file', () => {
  const { dataDir, patternsFile, env } = setup(makeRows([10]));
  writeConfig(dataDir, { patterns_file: '/stale/copy.md' });
  const before = fs.readFileSync(path.join(dataDir, 'policy.md'), 'utf8');

  const output = runNode(POST_UPGRADE, [], env);

  assert.match(output, /already names a Patterns file/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).patterns_file, undefined);
  assert.equal(fs.readFileSync(path.join(dataDir, 'policy.md'), 'utf8'), before);
  assert.equal(JSON.parse(runNode(EXTRACT, ['inspect'], env)).patterns.patterns_file, patternsFile);
});

test('template --policy <name> names the task after the policy and passes --policy through', () => {
  const { env } = setup(makeRows([10]));

  const text = runNode(EXTRACT, ['template', '--policy', 'work', '--task', 'weekly', '--lookback', '7d'], env);
  const plain = JSON.parse(runNode(EXTRACT, ['template', '--json', '--policy', 'work'], env));

  assert.match(text, /--name thinking-patterns-work-weekly/);
  assert.match(text, /fetch --lookback 7d --task weekly --policy work/);
  assert.match(text, /--task weekly --policy work`/);
  assert.equal(plain.scheduler_task_name, 'thinking-patterns-work');
  assert.match(plain.scheduler_prompt, /policy "work"/);
  assert.doesNotMatch(JSON.parse(runNode(EXTRACT, ['template', '--json'], env)).scheduler_prompt, /--policy/);
});

test('parsePolicy positive and negative controls', async () => {
  const { parsePolicy } = await import('../scripts/lib.js');

  const full = parsePolicy('## Target\nPatterns file: ~/a.md\n## Sources\nChannels: telegram, lark\nExclude channels: system\n');
  assert.deepEqual(full, { patterns_file: '~/a.md', channels: ['telegram', 'lark'], exclude_channels: ['system'] });

  const bare = parsePolicy('# Policy\nSubject: x\n');
  assert.deepEqual(bare, { patterns_file: null, channels: null, exclude_channels: ['system', 'void'] });

  const placeholders = parsePolicy('Patterns file: (fill in, e.g. ~/x.md)\nChannels: all\nExclude channels: none\n');
  assert.deepEqual(placeholders, { patterns_file: null, channels: null, exclude_channels: [] });

  // A blank Exclude line means "nothing excluded", not the default.
  assert.deepEqual(parsePolicy('Exclude channels:\n').exclude_channels, []);
  // Labels are matched at line start only; prose mentioning them does not count.
  assert.equal(parsePolicy('see the Patterns file: ~/b.md line\n').patterns_file, null);
});

test('parseDuration positive and negative controls', async () => {
  const { parseDuration } = await import('../scripts/lib.js');

  assert.equal(parseDuration('90m'), 90 * 60_000);
  assert.equal(parseDuration('24h'), 24 * 3_600_000);
  assert.equal(parseDuration('7d'), 7 * 86_400_000);
  assert.equal(parseDuration(' 2D '), 2 * 86_400_000);
  for (const bad of ['', '24', 'h', '1w', '0d', '-1h', 24]) {
    assert.throws(() => parseDuration(bad), /Invalid lookback/, `should reject ${JSON.stringify(bad)}`);
  }
});
