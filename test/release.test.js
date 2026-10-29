'use strict';

/**
 * The release tarball.
 *
 * A release is packed, not tarred from the tree: scripts/pack-release.js bundles
 * each entry point a session runs into one file, with no node_modules. That only
 * works if those entry points are all listed, and if the code they reach never
 * finds its files relative to its own directory — in a bundle, `__dirname` is
 * the bundle's directory, not the module's. Both are checked here, on every
 * `npm test`; `npm run verify:release` boots a real tarball.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { ENTRY_POINTS, FILES } = require('../scripts/pack-release');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'build-release.yml');
const SESSION = path.join(ROOT, '.codesignal');

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

test('every script a session or the task generator runs is packed', () => {
  // What setup.sh, run_solution.sh, grader.sh and the generator invoke.
  for (const entry of ['server.js', 'parse_automation_solution.js', 'grading/score.js', 'scripts/validate-scenario.js']) {
    assert.ok(ENTRY_POINTS.includes(entry), `${entry} must be bundled into the release`);
  }
  for (const file of ['dist', 'scenarios', 'scenario.example.jsonc', 'README.md']) {
    assert.ok(FILES.includes(file), `${file} must be copied into the release`);
  }
  // grader.sh runs the standalone scorer instead; see the test on it below.
  const body = fs.readFileSync(path.join(SESSION, 'run_solution.sh'), 'utf8');
  const invoked = [...body.matchAll(/node\s+"?(?:\$\S*\/)?([\w./-]+\.js)/g)].map((m) => m[1]);
  for (const file of invoked) assert.ok(ENTRY_POINTS.includes(file), `run_solution.sh runs ${file}, which is not packed`);
});

test('no solution travels with the release', () => {
  const { shipped } = require('../scripts/pack-release');
  const at = (...p) => path.join(ROOT, 'scenarios', ...p);
  assert.ok(shipped(at('eu-orders', 'scenario.json')), 'scenarios themselves are shipped');
  assert.ok(!shipped(at('eu-orders', 'reference_solution.json')), 'a reference solution is the answer');
  assert.ok(!shipped(at('eu-orders', 'variants')), 'graded variants include correct solutions');
  assert.ok(!shipped(at('eu-orders', 'variants', 'correct-1.json')));
  assert.ok(!shipped(at('eu-orders', 'out', 'report.txt')));
});

test('code a bundle carries finds its files through packageRoot, not its own directory', () => {
  // These read a path next to themselves on purpose, and sit where their bundle does.
  const ALLOWED = new Set(['server.js', 'scripts/validate-scenario.js', 'engine/package-root.js']);
  const offenders = requireClosure(ENTRY_POINTS)
    .filter((file) => !ALLOWED.has(file))
    .filter((file) => /__dirname/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  assert.deepStrictEqual(offenders, [],
    'these files resolve paths from __dirname, which is the bundle\'s directory once packed — '
    + 'use packageRoot() from engine/package-root.js, or require() the file');
});

test('every node in engine/nodes/library is registered', () => {
  const { getNode } = require('../engine');
  const dir = path.join(ROOT, 'engine', 'nodes', 'library');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'))) {
    const { type } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(getNode(type), `${file} is not in the LIBRARY list in engine/nodes/index.js`);
  }
});

test('the release is gated on tests and the grading experiment, and packed after them', () => {
  // A build that grades wrongly is worse than no build.
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  const order = ['run: npm run build', 'run: npm test', 'run: npm run experiment', 'run: npm run pack',
    'run: node scripts/verify-release.js'];
  let cursor = -1;
  for (const marker of order) {
    const at = yaml.indexOf(marker);
    assert.ok(at > cursor, `${marker} should come after the previous step`);
    cursor = at;
  }
});

test('a build from main is a pre-release, and the floating prerelease tag follows it', () => {
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yaml, /prerelease: true/, 'a main build must not reach production by itself');
  assert.match(yaml, /makeLatest: false/);
  assert.match(yaml, /git tag -f prerelease/, 'staging downloads the floating prerelease tag');
  assert.match(yaml, /gh release upload prerelease release\.tar\.gz scorer\/score\.js --clobber/);
});

test('each release carries the standalone scorer, and the command grader downloads only that', () => {
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yaml, /artifacts: release\.tar\.gz,scorer\/score\.js/);
  assert.match(yaml, /artifactErrorsFailBuild: true/, 'a release without its scorer must fail, not ship');
  assert.match(yaml, /verify-release\.js release\.tar\.gz scorer\/score\.js/);
  const grader = fs.readFileSync(path.join(SESSION, 'grader', 'grader.sh'), 'utf8');
  assert.match(grader, /releases\/latest\/download\/score\.js/);
  assert.match(grader, /releases\/download\/prerelease\/score\.js/);
  assert.doesNotMatch(grader, /release\.tar\.gz|tar -x/, 'the grader never unpacks the tarball');
});

test('only the standalone scorer carries the WASM inside it', () => {
  const sandbox = fs.readFileSync(path.join(ROOT, 'engine', 'sandbox.js'), 'utf8');
  assert.match(sandbox, /typeof __QUICKJS_WASM_BASE64__ !== 'undefined'/);
  const pack = fs.readFileSync(path.join(ROOT, 'scripts', 'pack-release.js'), 'utf8');
  assert.strictEqual(pack.match(/__QUICKJS_WASM_BASE64__/g).length, 1, 'defined for one bundle only');
  assert.match(pack, /bundle\('grading\/score\.js', SCORER/);
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
