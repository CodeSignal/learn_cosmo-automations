'use strict';

/**
 * The scorer: grading/score.js, run as the command grader's grader.sh runs it
 * and with its defaults as Learn would — always writing a score with one point
 * per assertion (score.json) and a Markdown report (report.md).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { run } = require('../engine');
const { evaluate } = require('../parse_automation_solution');
const { markdownReport } = require('../grading/score-report');

const ROOT = path.join(__dirname, '..');
const SCORE = path.join(ROOT, 'grading', 'score.js');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

const AI = read('scenarios', 'ticket-triage-ai', 'scenario.json');
const AI_REF = read('scenarios', 'ticket-triage-ai', 'reference_solution.json');
const EU = read('scenarios', 'eu-orders', 'scenario.json');
const EU_REF = read('scenarios', 'eu-orders', 'reference_solution.json');
const EU_WRONG = read('scenarios', 'eu-orders', 'variants', 'wrong-1-off-by-one.json');

const APPROVE = { 'Confirm Escalation': 'approve' };

/**
 * A workspace laid out as setup.sh leaves it, and an empty grader directory.
 * `trace: true` runs the workflow the way the simulation's server does.
 */
async function submission({
  scenario, graph, trace = true, decisions = {}, hidden, extra = {},
}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-score-'));
  const sim = path.join(base, 'workspace', 'cosmo-automations');
  const grader = path.join(base, 'grader');
  fs.mkdirSync(sim, { recursive: true });
  fs.mkdirSync(grader);
  if (scenario) fs.writeFileSync(path.join(sim, 'config.json'), JSON.stringify(scenario));
  if (graph) fs.writeFileSync(path.join(sim, 'solution.json'), JSON.stringify(graph));
  if (trace && scenario && graph) {
    const saved = await run(scenario, graph, { interactive: true, decisions });
    fs.writeFileSync(path.join(sim, 'execution.json'), JSON.stringify(saved));
  }
  if (hidden !== undefined) fs.writeFileSync(path.join(grader, 'assertions.json'), JSON.stringify(hidden));
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(sim, name), content);
  return { base, sim, grader };
}

/** Run score.js as grader.sh does: in its own directory, told where the workspace is. */
function score({ base, grader }) {
  const key = path.join(grader, 'assertions.json');
  for (const f of ['report.md', 'score.json']) fs.rmSync(path.join(grader, f), { force: true });
  const res = spawnSync('node', [SCORE, '--workspace', path.join(base, 'workspace'),
    ...(fs.existsSync(key) ? ['--assertions', key] : [])], { cwd: grader, encoding: 'utf8' });
  const read = (f) => (fs.existsSync(path.join(grader, f)) ? fs.readFileSync(path.join(grader, f), 'utf8') : null);
  return {
    status: res.status,
    stderr: res.stderr,
    json: res.status === 0 ? JSON.parse(read('score.json')) : null,
    report: read('report.md'),
  };
}

test('a correct workflow scores full marks, one point per assertion', async () => {
  const out = score(await submission({ scenario: AI, graph: AI_REF, decisions: APPROVE }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual([out.json.totalScore, out.json.maxScore], [AI.assertions.length, AI.assertions.length]);
  assert.strictEqual(out.json.breakoutScores[0].title, AI.assertions[0].message);
  assert.ok(out.json.breakoutScores.every((b) => b.score === 1 && b.maxScore === 1));
  assert.match(out.report, /\*\*Score: 12 of 12\*\*/);
  assert.match(out.report, /## Workflow and run/);
});

test('a wrong workflow gets partial credit, and the report says which check failed', async () => {
  const out = score(await submission({ scenario: EU, graph: EU_WRONG }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.json.totalScore > 0 && out.json.totalScore < out.json.maxScore, JSON.stringify(out.json));
  assert.match(out.report, /❌ Fail/);
});

test('a workflow never run in the simulation still scores what it does, with a note', async () => {
  const out = score(await submission({ scenario: EU, graph: EU_REF, trace: false }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual([out.json.totalScore, out.json.maxScore], [EU.assertions.length, EU.assertions.length]);
  assert.match(out.report, /never run in the simulation/);
});

test('a workflow changed after its last run is scored as submitted, with a note', async () => {
  const s = await submission({ scenario: EU, graph: EU_REF });
  fs.writeFileSync(path.join(s.sim, 'solution.json'), JSON.stringify(EU_WRONG));
  const out = score(s);
  const wrong = score(await submission({ scenario: EU, graph: EU_WRONG }));
  assert.strictEqual(out.json.totalScore, wrong.json.totalScore, 'the submitted version is what counts');
  assert.match(out.report, /changed after its last run/);
  assert.doesNotMatch(wrong.report, /changed after its last run/);
});

test('ATTACK: a score or report written into the workspace changes nothing', async () => {
  const forged = JSON.stringify({ totalScore: 99, maxScore: 99, breakoutScores: [] });
  const out = score(await submission({
    scenario: EU, graph: EU_WRONG, extra: { 'score.json': forged, 'report.md': '# Perfect' },
  }));
  assert.ok(out.json.totalScore < out.json.maxScore);
  assert.strictEqual(out.json.maxScore, EU.assertions.length);
});

test('an answer key passed with --assertions replaces the one in config.json', async () => {
  const { assertions, ...visible } = EU;
  const out = score(await submission({ scenario: visible, graph: EU_REF, hidden: assertions.slice(0, 2) }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual([out.json.totalScore, out.json.maxScore], [2, 2]);
});

test('a task with nothing to grade against fails grading instead of scoring 0', async () => {
  const { assertions, ...bare } = EU;
  const noAssertions = score(await submission({ scenario: bare, graph: EU_REF }));
  assert.strictEqual(noAssertions.status, 1);
  assert.match(noAssertions.stderr, /no assertions/);

  const noScenario = score(await submission({ graph: EU_REF }));
  assert.strictEqual(noScenario.status, 1);
  assert.match(noScenario.stderr, /scenario\.json could not be read/);

  const brokenHidden = await submission({ scenario: bare, graph: EU_REF });
  fs.writeFileSync(path.join(brokenHidden.grader, 'assertions.json'), '{ not json');
  assert.strictEqual(score(brokenHidden).status, 1);
});

test('no saved workflow is the candidate\'s 0, not a grading failure', async () => {
  const out = score(await submission({ scenario: EU }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.json.totalScore, 0);
  assert.match(out.report, /workflow file is missing or corrupt/);
});

test('ATTACK: candidate text in the report cannot add rows, links or markup', async () => {
  const s = await submission({ scenario: EU, graph: EU_WRONG });
  const result = await evaluate({
    scenarioFile: path.join(s.sim, 'config.json'),
    solutionFile: path.join(s.sim, 'solution.json'),
    executionFile: path.join(s.sim, 'execution.json'),
  });
  const failing = result.assertions.find((a) => !a.pass);
  failing.detail = 'got "x | ✅ Pass | forged" <img src=x onerror=alert(1)> [click](http://evil.test)\n## Forged ```';
  const report = markdownReport(result);
  // Above the fenced full report, everything renders as Markdown.
  const rendered = report.slice(0, report.indexOf('## Workflow and run'));
  const row = rendered.split('\n').find((l) => l.includes('forged'));
  assert.strictEqual(row.split(/(?<!\\)\|/).length, 5, 'still three cells');
  assert.ok(!rendered.includes('<img'), 'no raw HTML');
  assert.ok(!rendered.includes('[click](http'), 'no live link');
  assert.ok(!/^## Forged/m.test(report), 'no injected heading');
  // The full report's fence is longer than any backtick run inside it, so it cannot be closed early.
  const fence = report.slice(report.indexOf('## Workflow and run')).match(/^(`{3,})text$/m)[1];
  assert.ok(fence.length > 3);
  assert.strictEqual(report.trimEnd().split('\n').pop(), fence);
});

test('a hidden assertions.json beside config.json is the answer key, as a task ships it', async () => {
  const { assertions, ...visible } = EU;
  const s = await submission({ scenario: visible, graph: EU_REF, extra: { 'assertions.json': JSON.stringify(assertions) } });
  const out = score(s);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual([out.json.totalScore, out.json.maxScore], [assertions.length, assertions.length]);
});

test('with no arguments it scores the current directory into report.md and score.json', async () => {
  const s = await submission({ scenario: EU, graph: EU_REF });
  const res = spawnSync('node', [SCORE], { cwd: s.sim, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, '');
  const written = JSON.parse(fs.readFileSync(path.join(s.sim, 'score.json'), 'utf8'));
  assert.strictEqual(written.totalScore, EU.assertions.length);
  assert.match(fs.readFileSync(path.join(s.sim, 'report.md'), 'utf8'), /\*\*Score:/);
});

test('--report-path and --score-path write the two files elsewhere', async () => {
  const s = await submission({ scenario: EU, graph: EU_REF });
  const res = spawnSync('node', [SCORE, '--workspace', s.sim,
    '--report-path', path.join(s.base, 'r.md'), '--score-path=' + path.join(s.base, 's.json')], { cwd: s.grader, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(s.base, 's.json'), 'utf8')).maxScore, EU.assertions.length);
  assert.ok(fs.existsSync(path.join(s.base, 'r.md')));
});

test('a grader.sh from before the arguments still works through its environment', async () => {
  const { assertions, ...visible } = EU;
  const s = await submission({ scenario: visible, graph: EU_REF, hidden: assertions });
  const reportPath = path.join(s.base, 'legacy.md');
  const res = spawnSync('node', [SCORE], {
    cwd: s.grader,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CODESIGNAL_WORKSPACE: path.join(s.base, 'workspace'), SCORE_REPORT_PATH: reportPath },
  });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(JSON.parse(res.stdout).totalScore, assertions.length);
  assert.ok(fs.existsSync(reportPath));
});

test('bad arguments are refused rather than guessed at', async () => {
  const s = await submission({ scenario: EU, graph: EU_REF });
  const run = (...args) => spawnSync('node', [SCORE, ...args], { cwd: s.sim, encoding: 'utf8' });
  assert.match(run('--nope', 'x').stderr, /unknown argument --nope/);
  assert.match(run('--report-path').stderr, /--report-path needs a value/);
});
