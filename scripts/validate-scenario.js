#!/usr/bin/env node
'use strict';

/**
 * Check a scenario before a candidate ever sees it.
 *
 *   npm run validate                          # every scenario in scenarios/
 *   npm run validate path/to/scenario.json    # one, from anywhere
 *
 * A task is data, so this is the only place an authoring mistake can surface
 * early. If a `reference_solution.json` sits next to the scenario, the task is
 * also proved solvable — the intended answer is executed and graded.
 */

const fs = require('fs');
const path = require('path');
const { validateScenario } = require('../engine/validate');
const { attachAssertions } = require('../engine/scenarios');

const ROOT = path.join(__dirname, '..');
const SCENARIOS = path.join(ROOT, 'scenarios');

function discover() {
  const arg = process.argv[2];
  if (arg) {
    const target = path.resolve(arg);
    const file = fs.statSync(target).isDirectory() ? path.join(target, 'scenario.json') : target;
    return [{ name: path.basename(path.dirname(file)), file }];
  }
  if (!fs.existsSync(SCENARIOS)) return [];
  return fs.readdirSync(SCENARIOS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, file: path.join(SCENARIOS, d.name, 'scenario.json') }))
    .filter((s) => fs.existsSync(s.file));
}

async function main() {
  const targets = discover();
  if (!targets.length) {
    process.stderr.write('No scenarios found. Pass a path, or add one under scenarios/.\n');
    process.exit(1);
  }

  let failed = 0;

  for (const { name, file } of targets) {
    process.stdout.write(`\n${name}  ${dim(path.relative(process.cwd(), file))}\n`);

    let scenario;
    try {
      scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      process.stdout.write(`  ${red('✗')} not valid JSON: ${e.message}\n`);
      failed += 1;
      continue;
    }

    // A Hire task's assertions live in a hidden assertions.json beside it.
    // Validate what grading will see, not just the visible half.
    const assertionSource = attachAssertions(scenario, file);
    if (assertionSource.error) {
      process.stdout.write(`  ${red('✗')} ${assertionSource.error}\n`);
      failed += 1;
      continue;
    }
    if (assertionSource.source === 'file') {
      process.stdout.write(`  ${dim('·')} ${dim(`assertions from ${path.basename(assertionSource.file)}`)}\n`);
    }

    // The author's own intended answer, when they have written one.
    const referencePath = path.join(path.dirname(file), 'reference_solution.json');
    let referenceSolution = null;
    if (fs.existsSync(referencePath)) {
      try { referenceSolution = JSON.parse(fs.readFileSync(referencePath, 'utf8')); } catch { /* reported below */ }
    }

    const { ok, errors, warnings, notes } = await validateScenario(scenario, { referenceSolution });

    for (const note of notes) process.stdout.write(`  ${dim('·')} ${dim(note)}\n`);
    for (const w of warnings) process.stdout.write(`  ${yellow('!')} ${w}\n`);
    for (const e of errors) process.stdout.write(`  ${red('✗')} ${e}\n`);

    if (ok) {
      const suffix = warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : '';
      process.stdout.write(`  ${green('✓')} valid${suffix}\n`);
    } else {
      failed += 1;
    }
  }

  process.stdout.write(
    failed
      ? `\n${red(`${failed} of ${targets.length} scenario${targets.length === 1 ? '' : 's'} will not work as authored.`)}\n`
      : `\n${green(`${targets.length} scenario${targets.length === 1 ? '' : 's'} valid.`)}\n`,
  );
  process.exit(failed ? 1 : 0);
}

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (colour ? `[${code}m${s}[0m` : s);
const red = wrap(31);
const green = wrap(32);
const yellow = wrap(33);
const dim = wrap(2);

main().catch((err) => {
  process.stderr.write(`validator crashed: ${err.stack}\n`);
  process.exit(1);
});
