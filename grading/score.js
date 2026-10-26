#!/usr/bin/env node
'use strict';

/**
 * The command grader: scores a submission when the candidate presses Submit.
 *
 *   SCORE_REPORT_PATH=report.md CODESIGNAL_WORKSPACE=/usercode/FILESYSTEM \
 *     node cosmo-automations/grading/score.js
 *
 * The platform runs it from a private copy of the task's hidden grader
 * directory, with the candidate's files at $CODESIGNAL_WORKSPACE. It prints
 * `{ totalScore, maxScore, breakoutScores }` as JSON on STDOUT and writes a
 * Markdown report to $SCORE_REPORT_PATH.
 *
 * The score is worked out here, at Submit, never read from a file the session
 * wrote: the workflow the candidate saved is run again and judged by the
 * task's assertions, exactly as parse_automation_solution.js does. The only
 * thing a candidate can influence is their workflow — which is what is graded.
 * It counts as submitted: one never run in the simulation, or changed after its
 * last run, still scores what it does, and the report notes it.
 *
 * Assertions come from `assertions.json` in the grader's own directory when
 * there is one, so a task can keep them out of the candidate's workspace
 * altogether; otherwise from the task's config, as everywhere else.
 *
 * A candidate's mistake is a score: no saved workflow scores 0, a broken one
 * what it earns, with a report saying why. A task's mistake is not:
 * no scenario, unreadable or missing assertions, or a crash exit non-zero, and
 * the platform marks the submission "Grading failed" for a person to score,
 * rather than giving a candidate 0 for something they did not do.
 */

const fs = require('fs');
const path = require('path');

const { evaluate } = require('../parse_automation_solution');
const { scoreOf, markdownReport } = require('./score-report');

/** The simulation's directory in the workspace; see .codesignal/README.md. */
const SIMULATION_DIR = 'cosmo-automations';
/** Must match parse_automation_solution.js and server.js. */
const CONFIG_NAMES = ['config.json', 'scenario.json'];

/** Where the files are: the workspace's simulation directory, or the workspace itself. */
function locate({ workspace, graderDir }) {
  const nested = path.join(workspace, SIMULATION_DIR);
  const dir = fs.existsSync(nested) ? nested : workspace;
  const config = CONFIG_NAMES.map((name) => path.join(dir, name)).find((file) => fs.existsSync(file));
  const hidden = path.join(graderDir, 'assertions.json');
  return {
    scenarioFile: config || path.join(dir, CONFIG_NAMES[0]),
    solutionFile: path.join(dir, 'solution.json'),
    executionFile: path.join(dir, 'execution.json'),
    assertionsFile: fs.existsSync(hidden) ? hidden : null,
  };
}

/**
 * Score the workspace: `{ score, report }`, or `{ error }` when the task itself
 * cannot be graded.
 */
async function scoreSubmission({ workspace, graderDir }) {
  // The submitted workflow is what counts, run now — even if it never ran in the simulation.
  const result = await evaluate({ ...locate({ workspace, graderDir }), runUnsaved: true });
  if (!result.ok) return { error: result.reason };
  if (result.assertionSource && result.assertionSource.error) return { error: result.assertionSource.error };
  if (!(result.scenario.assertions || []).length) {
    return { error: 'the task defines no assertions, so there is nothing to score against' };
  }
  const score = scoreOf(result);
  return { score, report: markdownReport(result, score) };
}

async function main() {
  const graded = await scoreSubmission({
    workspace: process.env.CODESIGNAL_WORKSPACE || process.cwd(),
    graderDir: process.cwd(),
  });
  if (graded.error) {
    process.stderr.write(`Cannot grade this task: ${graded.error}\n`);
    process.exit(1);
  }
  if (process.env.SCORE_REPORT_PATH) fs.writeFileSync(process.env.SCORE_REPORT_PATH, graded.report);
  else process.stderr.write(graded.report);
  process.stdout.write(`${JSON.stringify(graded.score)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Cannot grade this task: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { scoreSubmission, locate };
