#!/usr/bin/env node
'use strict';

/**
 * Reads scenario.json + solution.json + execution.json from the session
 * filesystem and prints the deterministic report Cosmo grades against.
 *
 * Invoked by .codesignal/run_solution.sh. Never throws: a missing or corrupt
 * file must still produce a well-formed report with FAIL lines, because an
 * empty STDOUT is the one thing that makes Cosmo improvise.
 */

const fs = require('fs');
const path = require('path');

const { hashGraph, run } = require('./engine');
const { defaultScenario, attachAssertions } = require('./engine/scenarios');
const { evaluateAssertions } = require('./grading/assertions');
const { formatReport, oneLine } = require('./grading/format');

const ROOT = process.cwd();

/** Must match CLIENT_SCENARIO_FIELDS' companion in server.js. */
const CONFIG_NAMES = ['config.json', 'scenario.json'];

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8')) };
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'not found' : err.message };
  }
}

/**
 * In a session, the task configuration sits in the working directory. Locally it
 * does not, so fall back to the bundled scenario the same way the server does —
 * otherwise `npm run grade` from a checkout reports a missing scenario, which
 * looks like a grading failure rather than a wrong path.
 *
 * BOTH names, in the server's order. This checked only `scenario.json`, so a
 * session that delivered `config.json` — the platform's own name for it — fell
 * through to the BUNDLED scenario and graded the candidate against a different
 * task entirely, silently and with a plausible-looking report. The two readers
 * have to agree about which file is the task.
 */
function defaultScenarioFile() {
  for (const name of CONFIG_NAMES) {
    if (fs.existsSync(path.join(ROOT, name))) return name;
  }
  try {
    const fallback = defaultScenario();
    return fallback ? fallback.scenarioPath : 'scenario.json';
  } catch {
    return 'scenario.json';
  }
}

async function main() {
  process.stdout.write(await grade({
    scenarioFile: process.argv[2] || defaultScenarioFile(),
    solutionFile: process.argv[3] || 'solution.json',
    executionFile: process.argv[4] || 'execution.json',
  }));
}

/**
 * Grade a fresh run, never the saved one.
 *
 * `execution.json` is a file in the candidate's workspace. Grading used to
 * trust it, checked only by a SHA-256 of the graph — a public algorithm over a
 * file they also hold — so anyone able to write that file could forge a passing
 * run. Signing it with a per-session secret would only move the
 * problem: the secret has to live in the same container.
 *
 * The engine is deterministic: a trace is a pure function of the scenario, the
 * graph, and the approval decisions, and all three are here. So grading runs
 * the workflow again and judges that. The saved run is no longer evidence of
 * what the workflow does — only that the candidate ran it, and it must agree
 * with the fresh run, or the signature is MISMATCH. There is nothing to forge
 * and no secret to keep.
 */
async function grade({ scenarioFile, solutionFile, executionFile }) {
  const scenario = readJson(scenarioFile);
  if (!scenario.ok) {
    // Nothing can be graded without a scenario. Fail loudly and structurally.
    return bareFailure(`scenario.json could not be read (${scenario.error})`);
  }
  const assertionSource = attachAssertions(scenario.value, path.resolve(ROOT, scenarioFile));

  const solution = readJson(solutionFile);
  const execution = readJson(executionFile);

  const graph = solution.ok ? solution.value : { nodes: [], connections: [] };

  let signature;
  let trace;
  const notes = [];
  if (!execution.ok) {
    signature = 'MISSING';
    trace = emptyTrace(`execution.json could not be read (${execution.error}). `
      + 'Run the workflow in the simulation before submitting.');
  } else {
    const saved = execution.value;
    try {
      // Reproduce the run the way it was made. The simulation's runs are
      // interactive and record their decisions; run.js's are headless and take
      // the scenario's. Dropping `decisions` from the file gains nothing: the
      // headless answers are the author's, and approving is the candidate's own
      // call either way.
      trace = await run(scenario.value, graph, {
        interactive: Boolean(saved.decisions),
        decisions: saved.decisions || {},
      });
    } catch (err) {
      trace = emptyTrace(`the workflow could not be re-run for grading (${err.message})`);
    }

    if (!saved.graphHash) {
      signature = 'MISSING';
    } else if (saved.graphHash !== hashGraph(graph)) {
      // Edited after the last run: what was run is not what was submitted.
      signature = 'MISMATCH';
    } else if (answeredLive(saved)) {
      /*
       * A live run's answers came from a real model and cannot be reproduced, so
       * there is nothing to compare it to — and nothing to gain by forging one:
       * the verdict below comes from the fresh run, which replays the recorded
       * answers. The graph hash still has to match.
       */
      signature = 'VALID';
      notes.push('Answers were live during the session; this report replays the recorded answers.');
    } else if (comparable(saved) !== comparable(trace)) {
      // Same graph, different run: the saved file is not what this workflow does.
      signature = 'MISMATCH';
    } else {
      signature = 'VALID';
    }
  }

  const assertions = evaluateAssertions(scenario.value, graph, trace);

  if (assertionSource.error) {
    assertions.unshift({
      id: 'assertions-readable',
      pass: false,
      detail: assertionSource.error,
      message: 'The grading checks for this task could not be loaded.',
    });
  }

  if (!solution.ok) {
    assertions.unshift({
      id: 'solution-readable',
      pass: false,
      detail: `solution.json could not be read (${solution.error})`,
      message: 'The workflow file is missing or corrupt.',
    });
  }

  return formatReport({
    scenario: scenario.value, graph, trace, assertions, signature, notes,
  });
}

/** Whether any answer in a saved run came from a live model. */
function answeredLive(saved) {
  return (saved.aiCalls || []).some((c) => c && c.source === 'live');
}

/**
 * A run with its wall-clock timings removed — the only part of a trace that
 * legitimately differs between two runs of the same workflow. Verified on every
 * bundled scenario: an interactive run with simulated latency and a headless
 * re-run agree on everything else, byte for byte.
 */
const TIMING_KEYS = new Set(['ms', 'durationMs', 'simulatedMs']);

function comparable(trace) {
  return JSON.stringify(trace, (key, value) => (TIMING_KEYS.has(key) ? undefined : value));
}

function emptyTrace(message) {
  return {
    status: 'not-run',
    nodes: [],
    httpCalls: [],
    sinks: {},
    finalPayloads: {},
    errors: [{ node: null, message }],
  };
}

function bareFailure(reason) {
  return [
    '## WORKFLOW STRUCTURE',
    'Nodes:',
    '  (unavailable)',
    'Connections:',
    '  (unavailable)',
    'Disabled: none',
    '',
    '## EXECUTION',
    'Status: not-run',
    `Errors:`,
    `  ${reason}`,
    '',
    '## ASSERTIONS',
    'RESULT: FAIL (0 PASS, 1 FAIL)',
    `FAIL  scenario-readable  ${reason}`,
    '',
    '## TRACE SIGNATURE',
    'MISSING',
    '',
  ].map(oneLine).join('\n');
}

if (require.main === module) main();

module.exports = { grade };
