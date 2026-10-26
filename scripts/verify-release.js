#!/usr/bin/env node
'use strict';

/**
 * Prove a release tarball can actually run a session.
 *
 *   node scripts/verify-release.js release.tar.gz
 *
 * The template's tarball line ships `dist/ package.json server.js node_modules/`,
 * which is right for a vanilla-JS sim and dead on arrival for this one: the server
 * requires `engine/` and `shared/`, the parse script requires `grading/`, and the
 * server falls back to a bundled scenario. A missing directory would not show up
 * until a candidate opened the task.
 *
 * So this extracts the tarball somewhere clean, boots it exactly as `setup.sh`
 * would, drives a real workflow through the HTTP API, and grades the result. If
 * this passes, the release works.
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.VERIFY_PORT || 3399);

const tarball = path.resolve(process.argv[2] || 'release.tar.gz');
if (!fs.existsSync(tarball)) {
  fail(`tarball not found: ${tarball}\nBuild one with:\n  npm run build && npm run pack`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-release-'));
let child = null;

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n`);
  cleanup();
  process.exit(1);
}

function cleanup() {
  if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}

const step = (label) => process.stdout.write(`  ${label}\n`);

async function main() {
  step(`extracting ${path.basename(tarball)}`);
  execFileSync('tar', ['-xzf', tarball, '-C', work]);

  // A tarball built on macOS without COPYFILE_DISABLE=1 carries AppleDouble `._*`
  // metadata files, which a session then unpacks next to the real ones.
  const appleDouble = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter((entry) => /(^|\/)\._/.test(entry));
  if (appleDouble.length) {
    fail(`the tarball carries ${appleDouble.length} macOS metadata file(s), e.g. ${appleDouble[0]}. `
      + 'Rebuild with COPYFILE_DISABLE=1 tar --no-mac-metadata …');
  }

  // Every entry point, bundled, and what they read at runtime. See scripts/pack-release.js.
  const required = [
    'dist/index.html', 'package.json', 'server.js', 'parse_automation_solution.js', 'run.js',
    'grading/score.js', 'quickjs.wasm',
    // a bundled dev scenario for the server's local fallback
    'scenarios',
    // the task generator's toolkit
    'scripts/validate-scenario.js', 'scenario.example.jsonc', 'README.md',
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(work, f)));
  if (missing.length) fail(`the tarball is missing runtime files:\n    ${missing.join('\n    ')}`);
  // Every entry point carries its dependencies; a node_modules here means the pack regressed.
  if (fs.existsSync(path.join(work, 'node_modules'))) fail('the tarball ships node_modules; build it with `npm run pack`');
  step(`all ${required.length} runtime paths present`);

  // A session gets scenario.json in the working directory; mimic that with
  // whichever scenario the packaged build bundles.
  const bundled = fs.readdirSync(path.join(work, 'scenarios'))
    .map((name) => path.join(work, 'scenarios', name, 'scenario.json'))
    .find((f) => fs.existsSync(f));
  if (!bundled) fail('the tarball bundles no scenario for the server to fall back to');
  fs.copyFileSync(bundled, path.join(work, 'scenario.json'));
  // The release carries no solutions (see pack-release.js); the repository's is the reference.
  const scenarioName = path.basename(path.dirname(bundled));
  const referenceFile = path.join(ROOT, 'scenarios', scenarioName, 'reference_solution.json');
  const answers = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter((entry) => /(^|\/)(reference_solution\.json|variants\/)/.test(entry));
  if (answers.length) fail(`the tarball carries solutions a candidate could read, e.g. ${answers[0]}`);

  step(`booting: IS_PRODUCTION=true node server.js (port ${PORT})`);
  child = spawn('node', ['server.js'], {
    cwd: work,
    // HOST pinned to loopback: production binds all interfaces (see server.js),
    // and verifying a release on a laptop should not expose a port.
    env: { ...process.env, IS_PRODUCTION: 'true', PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) fail(`the server exited with code ${code}:\n${log}`);
  });

  await waitForServer();
  step('server is answering');

  const scenario = await get('/api/scenario');
  if (!scenario.scenario || !Array.isArray(scenario.scenario.palette)) {
    fail(`/api/scenario returned nothing usable:\n${JSON.stringify(scenario).slice(0, 300)}`);
  }
  if ('assertions' in scenario.scenario) fail('the answer key leaked to the client');
  step(`/api/scenario served ${scenario.scenario.palette.length} palette nodes, no assertions`);

  const reference = JSON.parse(fs.readFileSync(referenceFile, 'utf8'));
  const { trace } = await post('/api/execute', reference);
  if (trace.status !== 'completed') {
    fail(`executing the reference solution failed: ${JSON.stringify(trace.errors)}`);
  }
  step(`executed the reference workflow: ${trace.nodes.length} nodes, status ${trace.status}`);

  // The expression isolate has to work from the packaged node_modules, which is
  // the thing most likely to be missing from a tarball.
  const slack = (trace.sinks['Notify Ops'] || [])[0];
  if (!slack || slack.text !== '3 EU orders over $1000 — total $4700') {
    fail(`the isolate produced the wrong result — expected the reference payload, got ${JSON.stringify(slack)}`);
  }
  step('expressions evaluated correctly inside the packaged isolate');

  child.kill('SIGINT');

  const stdout = execFileSync('node', ['parse_automation_solution.js'], {
    cwd: work, encoding: 'utf8',
  });
  if (!/^RESULT: PASS/m.test(stdout)) {
    fail(`grading the reference solution did not pass:\n${stdout}`);
  }
  if (!/^VALID$/m.test(stdout)) fail(`trace signature was not VALID:\n${stdout}`);
  step('graded the reference solution: RESULT: PASS, signature VALID');

  // The command grader, as Submit runs it: from a directory of its own, with the
  // session's files at $CODESIGNAL_WORKSPACE.
  const graderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-grader-'));
  const reportPath = path.join(graderDir, 'report.md');
  const scored = JSON.parse(execFileSync('node', [path.join(work, 'grading', 'score.js')], {
    cwd: graderDir,
    encoding: 'utf8',
    env: { ...process.env, CODESIGNAL_WORKSPACE: work, SCORE_REPORT_PATH: reportPath },
  }));
  if (!scored.maxScore || scored.totalScore !== scored.maxScore) {
    fail(`the command grader did not give the reference solution full marks: ${JSON.stringify(scored)}`);
  }
  if (!fs.existsSync(reportPath)) fail('the command grader wrote no report to $SCORE_REPORT_PATH');
  fs.rmSync(graderDir, { recursive: true, force: true });
  step(`command grader scored the reference solution ${scored.totalScore}/${scored.maxScore}, report written`);

  /**
   * The platform reads `activity.log` to see inside a bespoke UI, so a release
   * that does not write one is broken in a way nothing else here would catch —
   * the task still works, and the platform sees nothing.
   */
  const activityPath = path.join(work, 'activity.log');
  if (!fs.existsSync(activityPath)) fail('the packaged session wrote no activity.log');
  const events = fs.readFileSync(activityPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return fail(`activity.log is not valid JSONL: ${line}`); }
    });
  if (!events.length) fail('activity.log is empty');
  for (const event of events) {
    if (!event.seq || !event.ts || !event.type) {
      fail(`an activity event is missing seq/ts/type: ${JSON.stringify(event)}`);
    }
  }
  if (!events.some((e) => e.type === 'session.start')) {
    fail('activity.log has no session.start');
  }
  step(`activity.log: ${events.length} events, ${events.map((e) => e.type).join(', ')}`);

  /*
   * The task generator runs in this same unpacked release and proves what it
   * wrote is solvable before anyone sees it. If `npm run validate` cannot run
   * from the tarball, generation silently loses its only correctness check.
   */
  // As the generator does: its own scenario and reference solution, side by side, outside the release.
  const proof = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-proof-'));
  fs.copyFileSync(bundled, path.join(proof, 'config.json'));
  fs.copyFileSync(referenceFile, path.join(proof, 'reference_solution.json'));
  const validated = execFileSync('npm', ['run', '--silent', 'validate', path.join(proof, 'config.json')], {
    cwd: work, encoding: 'utf8',
  });
  fs.rmSync(proof, { recursive: true, force: true });
  if (!/solvable|✓/.test(validated)) fail(`npm run validate did not prove the bundled scenario:\n${validated}`);
  step(`npm run validate works from the tarball (${path.basename(path.dirname(bundled))})`);

  process.stdout.write('\n✓ the release tarball runs a session end to end\n');
  cleanup();
}

async function waitForServer(attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await get('/api/scenario');
      return;
    } catch {
      await new Promise((r) => { setTimeout(r, 100); });
    }
  }
  fail('the server never started answering');
}

async function get(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  return res.json();
}

async function post(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

process.on('uncaughtException', (err) => fail(err.stack));
main().catch((err) => fail(err.stack));
