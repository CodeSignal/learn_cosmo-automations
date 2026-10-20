'use strict';

/**
 * The release tarball's contents.
 *
 * Inherited from `learn_bespoke-template`, whose tarball line is
 * `dist/ package.json server.js node_modules/` — correct for a vanilla-JS sim and
 * dead on arrival for this one, which needs `engine/`, `shared/`, `grading/`, the
 * parse script and a fallback scenario. A missing directory would not surface
 * until a candidate opened the task.
 *
 * So the workflow's file list is checked against the code's actual require()
 * closure. Adding an engine directory and forgetting the workflow fails here
 * instead of in a session.
 *
 * `npm run verify:release` goes further and boots a real tarball; this is the
 * cheap check that runs on every `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'build-release.yml');

/** Top-level paths named in the workflow's `tar -czf` invocation. */
function tarredPaths() {
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  const start = yaml.indexOf('tar -czf release.tar.gz');
  assert.notStrictEqual(start, -1, 'the workflow no longer builds a tarball');

  // The command continues across backslash-escaped newlines.
  const command = yaml.slice(start).split('\n')
    .reduce((acc, line) => {
      if (acc.done) return acc;
      acc.parts.push(line.trim().replace(/\\$/, '').trim());
      if (!line.trim().endsWith('\\')) acc.done = true;
      return acc;
    }, { parts: [], done: false })
    .parts.join(' ');

  return command
    .replace('tar -czf release.tar.gz', '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.replace(/\/$/, ''));
}

/** Every first-party file the given entry points reach through require(). */
function requireClosure(entries) {
  const seen = new Set();
  const walk = (file) => {
    let resolved;
    try { resolved = require.resolve(file); } catch { return; }
    if (seen.has(resolved)) return;
    const rel = path.relative(ROOT, resolved);
    if (rel.startsWith('..') || rel.startsWith('node_modules')) return;
    seen.add(resolved);

    const src = fs.readFileSync(resolved, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      walk(path.resolve(path.dirname(resolved), m[1]));
    }
  };
  entries.forEach((e) => walk(path.join(ROOT, e)));
  return [...seen].map((f) => path.relative(ROOT, f));
}

test('the release tarball includes everything the server and grader require', () => {
  const tarred = new Set(tarredPaths());

  // The two entry points a session actually runs.
  const closure = requireClosure(['server.js', 'parse_automation_solution.js']);
  assert.ok(closure.length > 5, `expected a real dependency closure, found ${closure.length} files`);

  const uncovered = closure.filter((file) => {
    const top = file.split(path.sep)[0];
    return !tarred.has(top) && !tarred.has(file);
  });

  assert.deepStrictEqual(uncovered, [],
    'these files are required at runtime but not in the release tarball — '
    + `add them to the tar step in ${path.relative(ROOT, WORKFLOW)}`);
});

test('the tarball includes the non-code files the runtime reads', () => {
  const tarred = new Set(tarredPaths());
  for (const needed of ['dist', 'node_modules', 'package.json', 'scenarios']) {
    assert.ok(tarred.has(needed), `the tarball must include ${needed}`);
  }
});

test('the release is gated on tests and the grading experiment', () => {
  // A build that grades wrongly is worse than no build.
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yaml, /run: npm test/, 'the release must run the test suite');
  assert.match(yaml, /npm run experiment/, 'the release must run the grading experiment');
  assert.match(yaml, /verify-release\.js/, 'the release must verify the tarball boots');

  // Build first (production-mode tests serve dist/), then test, then package.
  const order = ['npm run build', 'npm test', 'tar -czf'];
  let cursor = -1;
  for (const marker of order) {
    const at = yaml.indexOf(marker);
    assert.ok(at > cursor, `${marker} should come after the previous step`);
    cursor = at;
  }
});

test('the declared licence matches the LICENSE file', () => {
  // Inherited inconsistency: the template's LICENSE is Elastic 2.0 while its
  // package.json says MIT. Ours states what the file actually is.
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).license;

  assert.match(license, /^Elastic License 2\.0/);
  assert.strictEqual(declared, 'Elastic-2.0',
    'package.json must not claim a different licence from the LICENSE file');
});
