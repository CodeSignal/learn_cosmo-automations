#!/usr/bin/env node
'use strict';

/**
 * Score a submission: a score with one point per assertion, and a Markdown report.
 *
 *   node grading/score.js [--workspace <dir>] [--assertions <file>]
 *                         [--report-path <file|STDOUT>] [--score-path <file|STDOUT>]
 *
 * Defaults suit running it beside the simulation, as Learn would: the workspace
 * is the current directory, the report goes to `report.md` and the score to
 * `score.json` there. A platform with its own contract passes its paths; the
 * CodeSignal command grader, for one, wants the report at $SCORE_REPORT_PATH
 * and the score on STDOUT — see .codesignal/grader/grader.sh. Nothing here
 * knows about any platform.
 *
 *   --workspace    the candidate's files: the simulation's directory, or a
 *                  directory holding it as `cosmo-automations/`
 *   --assertions   the answer key, when it is kept apart from the workspace;
 *                  otherwise `assertions.json` beside config.json, or the
 *                  assertions inside config.json
 *   --report-path  where the Markdown report goes, or STDOUT
 *   --score-path   where `{ totalScore, maxScore, breakoutScores }` goes, or STDOUT
 *
 * The score is worked out here, never read from a file the session wrote: the
 * workflow the candidate saved is run again and judged by the task's
 * assertions, exactly as parse_automation_solution.js does. The only thing a
 * candidate can influence is their workflow — which is what is graded. It
 * counts as submitted: one never run in the simulation, or changed after its
 * last run, still scores what it does, and the report notes it.
 *
 * A candidate's mistake is a score: no saved workflow scores 0, a broken one
 * what it earns, with a report saying why. A task's mistake is not: no
 * scenario, unreadable or missing assertions, or a crash exit non-zero, so a
 * platform can mark the submission for a person to score rather than give a
 * candidate 0 for something they did not do.
 */

const fs = require('fs');
const path = require('path');

const { evaluate } = require('../parse_automation_solution');
const { scoreOf, markdownReport } = require('./score-report');

/** The simulation's directory in a workspace; see .codesignal/README.md. */
const SIMULATION_DIR = 'cosmo-automations';
/** Must match parse_automation_solution.js and server.js. */
const CONFIG_NAMES = ['config.json', 'scenario.json'];
const STDOUT = 'STDOUT';

/** Where the files are: the workspace's simulation directory, or the workspace itself. */
function locate({ workspace, assertions = null }) {
  const nested = path.join(workspace, SIMULATION_DIR);
  const dir = fs.existsSync(nested) ? nested : workspace;
  const config = CONFIG_NAMES.map((name) => path.join(dir, name)).find((file) => fs.existsSync(file));
  return {
    scenarioFile: config || path.join(dir, CONFIG_NAMES[0]),
    solutionFile: path.join(dir, 'solution.json'),
    executionFile: path.join(dir, 'execution.json'),
    assertionsFile: assertions ? path.resolve(assertions) : null,
  };
}

/**
 * Score the workspace: `{ score, report }`, or `{ error }` when the task itself
 * cannot be graded.
 */
async function scoreSubmission({ workspace, assertions = null }) {
  // The submitted workflow is what counts, run now — even if it never ran in the simulation.
  const result = await evaluate({ ...locate({ workspace, assertions }), runUnsaved: true });
  if (!result.ok) return { error: result.reason };
  if (result.assertionSource && result.assertionSource.error) return { error: result.assertionSource.error };
  if (!(result.scenario.assertions || []).length) {
    return { error: 'the task defines no assertions, so there is nothing to score against' };
  }
  const score = scoreOf(result);
  return { score, report: markdownReport(result, score) };
}

const FLAGS = {
  '--workspace': 'workspace', '--assertions': 'assertions', '--report-path': 'reportPath', '--score-path': 'scorePath',
};

/** `--name value` and `--name=value` pairs; anything else is an error. */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const key = FLAGS[flag];
    if (!key) throw new Error(`unknown argument ${argv[i]}`);
    const value = inline !== undefined ? inline : argv[i += 1];
    if (value === undefined || value === '') throw new Error(`${flag} needs a value`);
    options[key] = value;
  }
  return options;
}

/**
 * The command grader's paths, from its environment, for a grader.sh copied
 * into a question before score.js took arguments: it runs score.js with none.
 * Only when no argument at all is given; remove once those copies pass theirs.
 */
function legacyGraderOptions(env) {
  if (!env.SCORE_REPORT_PATH) return null;
  // Those copies kept a hidden answer key in the grader directory, their working directory.
  const key = path.resolve('assertions.json');
  return {
    workspace: env.CODESIGNAL_WORKSPACE,
    assertions: fs.existsSync(key) ? key : null,
    reportPath: env.SCORE_REPORT_PATH,
    scorePath: STDOUT,
  };
}

function emit(target, text) {
  if (target === STDOUT) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  else fs.writeFileSync(target, text);
}

async function main() {
  const argv = process.argv.slice(2);
  const options = {
    workspace: process.cwd(),
    reportPath: 'report.md',
    scorePath: 'score.json',
    ...((argv.length === 0 && legacyGraderOptions(process.env)) || parseArgs(argv)),
  };
  if (options.reportPath === STDOUT && options.scorePath === STDOUT) {
    throw new Error('the report and the score cannot both go to STDOUT');
  }
  const graded = await scoreSubmission(options);
  if (graded.error) {
    process.stderr.write(`Cannot grade this task: ${graded.error}\n`);
    process.exit(1);
  }
  emit(options.reportPath, graded.report);
  emit(options.scorePath, JSON.stringify(graded.score));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Cannot grade this task: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { scoreSubmission, locate, parseArgs };
