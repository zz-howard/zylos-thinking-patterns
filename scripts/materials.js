// Shared, dependency-free material contract; copied verbatim by both components.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MATERIAL_DEFAULTS = {
  trace_max_clues: 15, trace_context: 10, trace_max_bytes: 512000,
  artifact_retention_days: 7, max_page_bytes: 67108864
};
const epoch = value => Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
const home = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
export function writeMaterialJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function cliJson(script, args, maxBytes = MATERIAL_DEFAULTS.max_page_bytes) {
  const result = spawnSync(process.execPath, [home(script), ...args, '--json'], {
    encoding: 'utf8', maxBuffer: maxBytes, timeout: 60000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw unsupported(args.includes('--checkpoints') ? 'checkpoints_unsupported' : args[0] === 'groups' ? 'groups_unsupported' : 'material_collection_failed', `C4 CLI failed: ${result.stderr || result.stdout}`);
  const value = JSON.parse(result.stdout);
  if (value.error) throw new Error(`C4 CLI failed: ${JSON.stringify(value.error)}`);
  return value.ok === true && Object.hasOwn(value, 'data') ? value.data : value;
}
export function stripWrappers(content) {
  const text = String(content ?? '');
  // Adapter headers/signatures precede structural context; human text is escaped.
  const header = text.match(/^(?:(?:\[OM-RUN [^\]\n]+\] )?\[OPENMAX (?:DM|GROUP[^\]\n]*|THREAD[^\]\n]*)\][^\n]*\n|\[TG (?:DM|GROUP:[^\]\n]*)\][^<\n]*\s*)/)?.[0] ?? '';
  const current = text.slice(header.length).match(/^(?:(?:<(smart-mode|group-context|thread-context|replying-to|openmax-instruction|quoted-excerpt|work-references|connector-preference)\b[^>]*>[\s\S]*?<\/\1>|<(?:org-context|message-context|sender-context|interaction-receipt|wf-context)\b[^>]*\/>)\s*)*<current-message>\s*([\s\S]*?)\s*<\/current-message>((?: ---- (?:file|image|artifact_id):[\s\S]*)?)$/);
  const decode = value => value.replace(/&(lt|gt|amp|quot|apos);/g, (_, key) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[key]);
  return current ? decode(header + current[2] + current[3]) : text;
}
function unsupported(code, message) { const error = new Error(message); error.code = code; return error; }
export function materialFailureReason(error) {
  if (['checkpoints_unsupported', 'groups_unsupported', 'group_metadata_missing', 'material_collection_failed'].includes(error.code)) return error.code;
  if (/checkpoints/i.test(error.message)) return 'checkpoints_unsupported';
  if (/groups/i.test(error.message)) return 'groups_unsupported';
  if (/session_group|metadata/i.test(error.message)) return 'group_metadata_missing';
  return 'material_collection_failed';
}
const measure = rows => ({ count: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)), characters: rows.reduce((n, row) => n + [...String(row.content ?? '')].length, 0) });
function allowed(row, options) {
  return !(options.exclude_channels ?? ['internal', 'system', 'void', 'multica']).includes(row.channel)
    && (!options.channels || options.channels.includes(row.channel));
}
function day(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function rangeRows(config, begin, end, group) {
  const rows = [];
  // Range has no group flag in Core. Bound each CLI page and verify the metadata.
  for (let start = begin; start <= end; start += 500) {
    const value = cliJson(config.c4_fetch_cli, ['--begin', String(start), '--end', String(Math.min(end, start + 499))], config.max_page_bytes);
    if (!Array.isArray(value.rows) || value.rows.some(row => typeof row.session_group !== 'string')) throw new Error('C4 rows lack session_group metadata');
    rows.push(...value.rows.filter(row => group === '*' || row.session_group === group));
  }
  return rows.sort((a, b) => a.id - b.id);
}
function memoryFiles(root, group, rows, zone) {
  if (group !== '*' && (!/^[A-Za-z0-9_.:-]+$/.test(group) || group === '..')) throw new Error('Unsafe session group memory path');
  const base = group === '*' ? path.join(root, 'memory/sessions') : path.join(root, 'memory/session-groups', group, 'sessions');
  // Include days between endpoints too: a session log may summarize a quiet day.
  const dates = new Set(rows.map(row => day(epoch(row.timestamp), zone)));
  if (rows.length) for (let ms = epoch(rows[0].timestamp); ms <= epoch(rows.at(-1).timestamp); ms += 3600000) dates.add(day(ms, zone));
  return [...dates].sort().map(date => path.join(base, `${date}.md`)).filter(file => fs.existsSync(file));
}
function changedFiles(root, since, now) {
  const directory = path.join(root, 'memory/reference/decisions');
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(dir, entry.name));
    }
  }
  walk(directory);
  files.push(path.join(root, 'memory/reference/preferences.md'));
  return files.filter(file => fs.existsSync(file) && fs.statSync(file).mtimeMs > since && fs.statSync(file).mtimeMs <= now);
}
export function collectMaterials(config, state = {}, options = {}) {
  const now = options.now ?? Date.now();
  const zone = options.time_zone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const root = options.zylos_dir ?? process.env.ZYLOS_DIR ?? path.join(os.homedir(), 'zylos');
  const singleCheckpoints = cliJson(config.c4_fetch_cli, ['--checkpoints', '--after', '0'], config.max_page_bytes);
  if (!Array.isArray(singleCheckpoints)) throw unsupported('checkpoints_unsupported', 'C4 checkpoints response unsupported');
  const coreConfig = path.join(root, '.zylos/config.json');
  const sessionMode = fs.existsSync(coreConfig) ? JSON.parse(fs.readFileSync(coreConfig, 'utf8')).session_mode : undefined;
  const groups = singleCheckpoints.length && sessionMode !== 'multi' ? ['*'] : cliJson(config.c4_db_cli, ['groups'], config.max_page_bytes);
  const list = Array.isArray(groups) ? groups : groups.groups;
  if (!Array.isArray(list)) throw unsupported('groups_unsupported', 'C4 groups response unsupported');
  const ranges = [], inbound = [], sessions = new Set(), reused = [], reuseMisses = [];
  let bootstrapRows;
  for (const entry of list) {
    const group = typeof entry === 'string' ? entry : entry.sessionGroup ?? entry.session_group;
    if (typeof group !== 'string') throw unsupported('group_metadata_missing', 'C4 group metadata missing');
    const previous = state.groups?.[group] ?? {};
    // Core variants interpret --after as checkpoint id or conversation end.
    const checkpointAfter = Math.min(previous.checkpoint_id ?? 0, previous.end_conversation_id ?? 0);
    const checkpoints = cliJson(config.c4_fetch_cli, ['--checkpoints', ...(group === '*' ? [] : ['--group', group]), '--after', String(checkpointAfter)], config.max_page_bytes);
    if (!Array.isArray(checkpoints) || checkpoints.some(c => c.session_group !== group)) throw new Error('C4 checkpoint metadata unsupported');
    if (!checkpoints.length) continue;
    const latest = checkpoints.reduce((a, b) => a.id > b.id ? a : b);
    const after = previous.end_conversation_id ?? 0;
    const end = latest.end_conversation_id;
    if (!Number.isSafeInteger(end)) throw new Error('C4 checkpoint end missing');
    if (end <= after) continue;
    const range = { session_group: group, after, end, checkpoint_id: latest.id };
    // Reuse only an exact range whose trace is complete and filters match.
    const cached = (options.reuse_artifacts ?? []).find(a => a.trace_complete && JSON.stringify(a.filters) === JSON.stringify({ channels: options.channels ?? null, exclude_channels: options.exclude_channels ?? ['internal', 'system', 'void', 'multica'] }) && a.ranges?.some(r => r.session_group === group && r.after === after && r.end === end));
    if (cached) { ranges.push(range); reused.push({ range, clues: cached.clues.filter(c => c.session_group === group && c.kind === 'correction'), traces: cached.traces.filter(t => t.clue.session_group === group && t.clue.kind === 'correction') }); continue; }
    if (options.reuse_artifacts) {
      const candidates = options.reuse_artifacts.filter(a => a.ranges?.some(r => r.session_group === group && r.after === after && r.end === end));
      reuseMisses.push({ session_group: group, reason: !candidates.length ? 'range_mismatch' : !candidates.some(a => a.trace_complete) ? 'thinking_patterns_incomplete' : 'filters_mismatch' });
    }
    let rows;
    if (previous.end_conversation_id === undefined) {
      // Bootstrap uses the CLI time query to avoid reading historical backlog.
      bootstrapRows ??= cliJson(config.c4_fetch_cli, ['--since', new Date(now - 86400000).toISOString()], config.max_page_bytes).rows;
      if (!Array.isArray(bootstrapRows) || bootstrapRows.some(row => typeof row.session_group !== 'string')) throw new Error('C4 rows lack session_group metadata');
      rows = bootstrapRows.filter(row => (group === '*' || row.session_group === group) && row.id > after && row.id <= end && epoch(row.timestamp) >= now - 86400000).sort((a, b) => a.id - b.id);
      range.bootstrap_since = new Date(now - 86400000).toISOString();
    } else rows = rangeRows(config, after + 1, end, group);
    range.begin_time = rows[0]?.timestamp ?? null;
    range.end_time = rows.at(-1)?.timestamp ?? null;
    ranges.push(range);
    for (const file of memoryFiles(root, group, rows, zone)) sessions.add(file);
    inbound.push(...rows.filter(row => row.direction === 'in' && allowed(row, options)).map(row => ({ ...row, content: stripWrappers(row.content) })));
  }
  const references = ranges.length && reused.length !== ranges.length ? changedFiles(root, Date.parse(state.last_material_at ?? new Date(now - 86400000).toISOString()), now) : [];
  const sessionFiles = [...sessions];
  const fileReport = files => ({ count: files.length, bytes: files.reduce((n, file) => n + fs.statSync(file).size, 0), characters: files.reduce((n, file) => n + [...fs.readFileSync(file, 'utf8')].length, 0) });
  return { schema_version: 1, run_id: crypto.randomUUID(), mode: 'checkpoints', created_at: new Date(now).toISOString(), time_zone: zone, ranges, session_files: sessionFiles, reference_files: references, inbound, reused,
    filters: { channels: options.channels ?? null, exclude_channels: options.exclude_channels ?? ['internal', 'system', 'void', 'multica'] },
    report: { inbound: measure(inbound), sessions: fileReport(sessionFiles), references: fileReport(references), reused_ranges: reused.length, reuse_misses: reuseMisses }, clues: [], traces: [], trace_complete: false };
}
export function traceMaterials(config, state, run, clues = []) {
  const settings = { ...MATERIAL_DEFAULTS, ...config };
  for (const key of ['trace_max_clues', 'trace_context', 'trace_max_bytes']) if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) throw new Error(`Invalid ${key}`);
  // Single-session rows retain component metadata, but trace scope is global.
  clues = clues.map(clue => run.ranges.some(range => range.session_group === '*' && clue.c4_id > range.after && clue.c4_id <= range.end)
    ? { ...clue, session_group: '*' } : clue);
  // Artifact-first recovery keeps a crash between artifact/state writes lossless.
  const pending = state.pending_clues ?? [];
  const key = c => `${c.session_group}:${c.c4_id}:${c.kind}`;
  const pendingKeys = new Set(pending.map(key));
  const recoveredKeys = new Set((run.clues ?? []).map(key));
  const all = [...pending, ...(run.clues ?? []), ...clues];
  const alreadyTraced = new Set((run.traces ?? []).map(t => `${t.clue.session_group}:${t.clue.c4_id}:${t.clue.kind}`));
  const queue = [...new Map(all.map(c => {
    const range = run.ranges.find(r => r.session_group === c.session_group && c.c4_id <= r.end && c.c4_id > r.after);
    if (!Number.isSafeInteger(c.c4_id) || c.c4_id < 1 || !['decision', 'correction'].includes(c.kind) || (!range && !pendingKeys.has(key(c)) && !recoveredKeys.has(key(c)))) throw new Error('Clue must identify a decision/correction in this run range');
    const retained = pending.find(item => key(item) === key(c)) ?? (run.clues ?? []).find(item => key(item) === key(c));
    return [key(c), { ...c, source_range: retained?.source_range ?? range }];
  })).values()].filter(c => !alreadyTraced.has(`${c.session_group}:${c.c4_id}:${c.kind}`));
  const traces = [], deferred = [];
  let bytes = run.trace_report?.bytes ?? (run.traces ?? []).reduce((n, trace) => n + Buffer.byteLength(JSON.stringify(trace)), 0);
  const existingCount = run.traces?.length ?? 0;
  for (const clue of queue) {
    if (existingCount + traces.length >= settings.trace_max_clues || (bytes >= settings.trace_max_bytes && existingCount + traces.length > 0)) { deferred.push(clue); continue; }
    const sourceRange = clue.source_range;
    const end = sourceRange.end;
    // Bound sparse-thread scans to two 500-id pages before the prior range,
    // and at most 2000 ids from the clue in either direction.
    const lower = Math.max(1, sourceRange.after - 1000, clue.c4_id - 2000);
    const upperBound = Math.min(end, clue.c4_id + 2000);
    let radius = settings.trace_context + 1, rows;
    for (;;) {
      const begin = Math.max(lower, clue.c4_id - radius), upper = Math.min(upperBound, clue.c4_id + radius);
      rows = rangeRows(config, begin, upper, clue.session_group).filter(row => allowed(row, run.filters));
      if ((rows.filter(r => r.id < clue.c4_id).length >= settings.trace_context || begin === lower) && (rows.filter(r => r.id > clue.c4_id).length >= settings.trace_context || upper === upperBound)) break;
      radius *= 2;
    }
    const source = rows.find(row => row.id === clue.c4_id);
    if (!source) throw new Error('Clue source is absent or excluded');
    const bootstrapSince = sourceRange.bootstrap_since;
    if (bootstrapSince && epoch(source.timestamp) < epoch(bootstrapSince)) throw new Error('Clue source predates the bootstrap cutoff');
    rows = [...rows.filter(r => r.id < clue.c4_id).slice(-settings.trace_context), ...rows.filter(r => r.id === clue.c4_id), ...rows.filter(r => r.id > clue.c4_id).slice(0, settings.trace_context)].map(row => ({ ...row, content: stripWrappers(row.content) }));
    const trace = { clue, rows, report: measure(rows) };
    const size = Buffer.byteLength(JSON.stringify(trace));
    // Always accept the first trace, even if its source alone exceeds the cap.
    if (bytes + size > settings.trace_max_bytes && existingCount + traces.length > 0) { deferred.push(clue); continue; }
    traces.push(trace); bytes += size;
  }
  state.pending_clues = deferred;
  run.deferred_clues = deferred;
  run.clues = [...new Map([...(run.clues ?? []), ...queue].map(c => [`${c.session_group}:${c.c4_id}:${c.kind}`, c])).values()];
  run.traces = [...(run.traces ?? []), ...traces];
  run.trace_complete = deferred.length === 0;
  run.trace_report = { clues: run.traces.length, deferred: deferred.length, bytes, characters: run.traces.reduce((n, t) => n + t.report.characters, 0), count: run.traces.reduce((n, t) => n + t.rows.length, 0) };
  return run;
}
export function commitMaterials(state, run, completedGroups) {
  const next = { ...state, groups: { ...(state.groups ?? {}) } };
  for (const group of completedGroups) {
    const range = run.ranges.find(r => r.session_group === group);
    if (!range || (!run.trace_complete && !run.trace_report)) throw new Error('Cannot commit an unfinished range');
    if ((next.groups[group]?.end_conversation_id ?? 0) > range.after) throw new Error('Stale material run');
    next.groups[group] = { end_conversation_id: range.end, checkpoint_id: range.checkpoint_id };
  }
  if (run.ranges.every(range => (next.groups[range.session_group]?.end_conversation_id ?? 0) >= range.end)) next.last_material_at = run.created_at;
  return next;
}
export function saveArtifact(directory, run, retentionDays = 7) {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    if ((previous.committed || previous.closed) && Date.parse(previous.created_at) < Date.now() - retentionDays * 86400000) fs.unlinkSync(file);
  }
  const file = path.join(directory, `${run.run_id}.json`);
  writeMaterialJson(file, run);
  return file;
}
export function readArtifacts(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(n => /^[a-f0-9-]+\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(directory, n), 'utf8')));
}
