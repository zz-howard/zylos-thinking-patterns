import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function captureReferences(root) {
  const files = {};
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) files[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
    }
  }
  walk(path.join(root, 'memory/reference/decisions'));
  const preferences = 'memory/reference/preferences.md';
  if (fs.existsSync(path.join(root, preferences))) files[preferences] = fs.readFileSync(path.join(root, preferences), 'utf8');
  return files;
}

// Nearest Markdown heading above a 1-based line, ignoring fenced code blocks.
function sectionBefore(lines, lineNumber) {
  let heading = null, fence = null;
  for (const line of lines.slice(0, lineNumber - 1)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) { fence = fence ? null : marker; continue; }
    if (!fence && /^#{1,6} /.test(line)) heading = line;
  }
  return heading;
}

export function referenceChanges(root, baseline, snapshot) {
  if (baseline === undefined) return [];
  const changes = [];
  for (const [name, content] of Object.entries(snapshot)) {
    if (baseline[name] === content) continue;
    const file = path.join(root, name);
    if (!Object.hasOwn(baseline, name)) {
      changes.push({ file, kind: 'new', start_line: 1, content });
      continue;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
    try {
      const before = path.join(directory, 'before'), after = path.join(directory, 'after');
      fs.writeFileSync(before, baseline[name], { mode: 0o600 });
      fs.writeFileSync(after, content, { mode: 0o600 });
      // User git config (e.g. diff.suppressBlankEmpty) must not change line accounting.
      const result = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '--diff-algorithm=myers', '--unified=2', '--inter-hunk-context=0', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ', '--', before, after], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }, encoding: 'utf8', timeout: 60000, maxBuffer: Math.max(1048576, Buffer.byteLength(content) * 4 + Buffer.byteLength(baseline[name]) * 4) });
      if (result.error) throw result.error;
      if (![0, 1].includes(result.status)) throw new Error(`Reference diff failed: ${result.stderr}`);
      const lines = content.split('\n');
      let hunk;
      const flush = () => {
        if (!hunk?.changed.length) return;
        changes.push({ file, kind: 'modified', start_line: hunk.start, changed_lines: hunk.changed, section: sectionBefore(lines, hunk.changed[0]), content: hunk.lines.join('\n') });
      };
      for (const line of result.stdout.split('\n')) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (header) { flush(); hunk = { start: Number(header[1]), lines: [], changed: [] }; }
        else if (hunk && (line.startsWith(' ') || line.startsWith('+'))) {
          if (line.startsWith('+')) hunk.changed.push(hunk.start + hunk.lines.length);
          hunk.lines.push(line.slice(1));
        }
      }
      flush();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  return changes;
}
