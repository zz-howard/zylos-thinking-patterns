import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Release rule (AGENTS.md, "Release Process"): a release bumps four files in
// the same commit. This gate enforces the final-tree half only — the version
// faces below must agree in the working tree; the dedicated-PR / same-commit
// discipline is a process gate, not provable here. Parsers + checker are pure
// so the suite also runs permanent negative controls against known-bad
// fixtures — the gate itself is tested and provably able to fail.

function parseSkillVersion(skillMd) {
  const fm = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^version:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function parseChangelogVersion(changelogMd) {
  // First released header; "## [Unreleased]" never matches the digit pattern.
  const m = changelogMd.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  return m ? m[1] : null;
}

function collectFaces({ pkgJson, lockJson, skillMd, changelogMd }) {
  return {
    'package.json version': JSON.parse(pkgJson).version ?? null,
    'package-lock.json root version': JSON.parse(lockJson).version ?? null,
    'package-lock.json packages[""] version':
      JSON.parse(lockJson).packages?.['']?.version ?? null,
    'SKILL.md frontmatter version': parseSkillVersion(skillMd),
    'CHANGELOG.md latest released version': parseChangelogVersion(changelogMd),
  };
}

function findMismatches(faces) {
  const expected = faces['package.json version'];
  return Object.entries(faces)
    .filter(([, v]) => v !== expected)
    .map(([k, v]) => `${k} = ${v}, expected ${expected}`);
}

function realFiles() {
  const lockPath = path.join(root, 'package-lock.json');
  assert.ok(
    fs.existsSync(lockPath),
    'package-lock.json is missing — run `npm install` once; the lock file is part of the release contract'
  );
  return {
    pkgJson: fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    lockJson: fs.readFileSync(lockPath, 'utf8'),
    skillMd: fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8'),
    changelogMd: fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
  };
}

test('all four release version faces agree in the working tree', () => {
  const faces = collectFaces(realFiles());
  for (const [face, value] of Object.entries(faces)) {
    assert.ok(value, `${face} could not be parsed`);
  }
  assert.deepEqual(findMismatches(faces), []);
});

test('negative control: a stale SKILL.md frontmatter version is caught', () => {
  const files = realFiles();
  files.skillMd = files.skillMd.replace(
    /^(version:)\s*\S+\s*$/m,
    '$1 0.0.0-stale'
  );
  const mismatches = findMismatches(collectFaces(files));
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /SKILL\.md frontmatter version = 0\.0\.0-stale/);
});

test('negative control: stale package-lock (root and packages[""]) is caught', () => {
  const files = realFiles();
  const lock = JSON.parse(files.lockJson);
  lock.version = '0.0.1-stale';
  lock.packages[''].version = '0.0.2-stale';
  files.lockJson = JSON.stringify(lock);
  const mismatches = findMismatches(collectFaces(files));
  assert.equal(mismatches.length, 2);
});

test('negative control: CHANGELOG missing the released entry is caught', () => {
  const files = realFiles();
  const pkgVersion = JSON.parse(files.pkgJson).version;
  files.changelogMd = files.changelogMd.replace(
    new RegExp(`^## \\[${pkgVersion.replace(/\./g, '\\.')}\\][^\n]*\n`, 'm'),
    ''
  );
  const mismatches = findMismatches(collectFaces(files));
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /CHANGELOG\.md/);
});

test('an [Unreleased] section above the released entry does not confuse the parser', () => {
  const changelogMd = '# Changelog\n\n## [Unreleased]\n\n- pending\n\n## [1.2.3] - 2026-01-01\n';
  assert.equal(parseChangelogVersion(changelogMd), '1.2.3');
});
