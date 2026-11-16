import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function parts(text) {
  const headings = [...text.matchAll(/^## (\d+)\.\s+.+$/gm)];
  return { prefix: text.slice(0, headings[0]?.index ?? text.length), entries: headings.map((match, i) => ({
    number: Number(match[1]), text: text.slice(match.index, headings[i + 1]?.index ?? text.length)
  })) };
}
function body(text) {
  const content = text.replace(/(?:\r?\n)?[ \t\r\n]*---[ \t\r\n]*$|[ \t\r\n]+$/, '');
  return { content, tail: text.slice(content.length) };
}
export function validatePatternChanges(original, proposed) {
  const before = parts(original), after = parts(proposed);
  if (original && before.prefix !== after.prefix) throw new Error('Existing pattern preamble cannot change');
  if (after.entries.length < before.entries.length) throw new Error('Existing pattern entries cannot be removed');
  for (let i = 0; i < before.entries.length; i++) {
    const previous = body(before.entries[i].text), next = after.entries[i].text;
    if (!next.startsWith(previous.content)) throw new Error('Existing pattern entries cannot be rewritten or renumbered');
    let added = next.slice(previous.content.length);
    if (previous.tail) {
      const end = added.lastIndexOf(previous.tail);
      if (end < 0 || added.slice(end + previous.tail.length).trim()) throw new Error('Existing pattern separators and whitespace cannot be removed');
      added = added.slice(0, end);
    }
    added = added.trim();
    if (added && !/^\*\*Reinforced \(\d{4}-\d{2}-\d{2}\)\*\*: /.test(added)) throw new Error('Only canonical Reinforced blocks may extend an existing entry');
  }
  let number = Math.max(0, ...before.entries.map(entry => entry.number)) + 1;
  for (const entry of after.entries.slice(before.entries.length)) {
    if (entry.number !== number++) throw new Error('New patterns must use consecutive next entry numbers');
  }
  if (!after.entries.length && original !== proposed) throw new Error('New content requires a numbered pattern entry');
}

export function writePatterns({ target, file, sha256, writer, memoryRoot }) {
  const exists = fs.existsSync(target), original = exists ? fs.readFileSync(target) : Buffer.alloc(0);
  if (hash(original) !== sha256) return { status: 'write_deferred', reason: 'MEMORY_CONFLICT', retry: 'Read the current file and merge again; use its raw-byte SHA256' };
  const replacement = fs.readFileSync(file);
  validatePatternChanges(original.toString('utf8'), replacement.toString('utf8'));
  const relative = path.relative(memoryRoot, target);
  const inside = relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  const reason = !exists ? 'file_missing' : !inside ? 'outside_memory' : !fs.existsSync(writer) ? 'writer_unavailable' : null;
  if (!reason) {
    const child = spawnSync(process.execPath, [writer, '--path', relative, '--sha256', sha256], {
      input: replacement, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
    });
    let response;
    try { response = JSON.parse(child.stdout || ''); } catch { /* Report the failed writer without advancing. */ }
    if (child.status !== 0 || child.error || response?.ok !== true) return {
      status: 'write_deferred', mode: 'locked', reason: response?.error?.code || 'WRITER_FAILED',
      error: child.error?.message || response?.error?.message || (child.stderr || '').trim(),
      retry: response?.error?.code === 'MEMORY_CONFLICT' ? 'Read the current file and merge again; use its raw-byte SHA256' : 'Retry after the writer is available'
    };
    return { status: 'updated', mode: 'locked', path: target, sha256: hash(replacement) };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (exists) {
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, replacement, { mode: fs.statSync(target).mode });
    fs.renameSync(temporary, target);
  } else fs.writeFileSync(target, replacement, { flag: 'wx', mode: 0o600 });
  return { status: 'updated', mode: 'direct', reason, path: target, sha256: hash(replacement) };
}
