'use strict';

/**
 * Scenario discovery.
 *
 * `scenarios/` holds development fixtures, not the tasks candidates get — a real
 * task carries its own `scenario.json`, which `setup.sh` drops into the working
 * directory. These are the ones we author, validate and regression-test against.
 *
 * Everything that used to hardcode `eu-orders` goes through here, so adding a
 * second scenario is dropping in a directory rather than editing seven files.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'scenarios');

/** @returns {Array<{name, dir, scenarioPath, referencePath, hasReference}>} */
function listScenarios() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(DIR, d.name);
      const referencePath = path.join(dir, 'reference_solution.json');
      return {
        name: d.name,
        dir,
        scenarioPath: path.join(dir, 'scenario.json'),
        referencePath,
        hasReference: fs.existsSync(referencePath),
      };
    })
    .filter((s) => fs.existsSync(s.scenarioPath))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The scenario the dev tooling defaults to: `COSMO_SCENARIO` if set, else the
 * only one, else the alphabetically first with a note that the choice was made.
 */
function defaultScenario() {
  const all = listScenarios();
  if (!all.length) return null;

  const wanted = process.env.COSMO_SCENARIO;
  if (wanted) {
    const found = all.find((s) => s.name === wanted);
    if (!found) {
      throw new Error(`COSMO_SCENARIO="${wanted}" not found. Available: ${all.map((s) => s.name).join(', ')}`);
    }
    return found;
  }
  return all[0];
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * A Hire task keeps its assertions out of the file the candidate can open.
 *
 * `config.json` is a visible project file — the simulation needs it to run — so
 * anything in it is readable from the session's file panel, the answer key
 * included. Engine's `hidden_` project files are invisible while the candidate
 * works and exist only during Submit, which is exactly when grading runs. So a
 * Hire task ships `hidden_cosmo-automations/assertions.json`, which lands beside
 * `config.json` as `assertions.json` at Submit, and nowhere before.
 *
 * Learn tasks keep them inline: there the FAIL detail is a teaching feature, and
 * a hidden file would be missing if a practice is ever graded on Run.
 *
 * The command grader (grading/score.js) passes `explicitFile` instead: its
 * hidden assertions sit in the grader's own directory, never in the workspace,
 * and a named file that is missing is an error rather than a fallback.
 *
 * The file is either an array of assertions or `{ "assertions": [...] }`. When
 * present it wins over anything inline. Returns where they came from, so the
 * caller can say so — or the error, so grading can fail loudly instead of
 * silently grading against nothing.
 */
const ASSERTIONS_FILE = 'assertions.json';

function attachAssertions(scenario, scenarioPath, explicitFile = null) {
  // The command grader brings its own file, from its private grader directory.
  const file = explicitFile
    ? path.resolve(explicitFile)
    : path.join(path.dirname(path.resolve(scenarioPath)), ASSERTIONS_FILE);
  if (!fs.existsSync(file)) {
    if (explicitFile) return { source: 'file', file, error: `${path.basename(file)} was not found` };
    return { source: scenario.assertions ? 'inline' : 'none' };
  }
  try {
    const raw = readJson(file);
    const list = Array.isArray(raw) ? raw : raw && raw.assertions;
    if (!Array.isArray(list)) return { source: 'file', file, error: `${ASSERTIONS_FILE} holds no assertions array` };
    scenario.assertions = list;
    return { source: 'file', file };
  } catch (err) {
    return { source: 'file', file, error: `${ASSERTIONS_FILE} could not be read (${err.message})` };
  }
}

module.exports = {
  listScenarios, defaultScenario, readJson, attachAssertions, ASSERTIONS_FILE, SCENARIOS_DIR: DIR,
};
