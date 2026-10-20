#!/usr/bin/env node
'use strict';

/**
 * Stage a scenario into the session filesystem, so `npm run start:dev` opens on it.
 *
 * The server looks for `scenario.json` in the working directory before falling
 * back to a bundled one — the same contract as a session (README "In a session").
 * So staging a demo is not a special mode: it is putting the same two files a
 * session would put there, and what you see is what a candidate sees.
 *
 *   node scripts/stage-demo.js payment-recovery            # opens fully built
 *   node scripts/stage-demo.js payment-recovery --blank    # opens as the candidate starts
 *   node scripts/stage-demo.js --clear                     # back to the bundled default
 *
 * `--blank` is the one to use if you want to BUILD part of the workflow live;
 * the default gives you the finished thing to run and talk through.
 */

const fs = require('fs');
const path = require('path');

const { listScenarios, readJson } = require('../engine/scenarios');

const ROOT = path.join(__dirname, '..');
const STAGED = ['scenario.json', 'solution.json', 'execution.json']
  .map((f) => path.join(ROOT, f));

function clear() {
  for (const file of STAGED) fs.rmSync(file, { force: true });
  console.log('cleared: scenario.json, solution.json, execution.json');
  console.log('the app will fall back to the bundled default scenario.');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--clear')) return clear();

  const blank = args.includes('--blank');
  const wanted = args.find((a) => !a.startsWith('--'));
  const all = listScenarios();

  if (!wanted) {
    console.error('Which scenario? Available:\n'
      + all.map((s) => `  ${s.name}`).join('\n')
      + '\n\n  node scripts/stage-demo.js <name> [--blank]'
      + '\n  node scripts/stage-demo.js --clear');
    process.exit(1);
  }

  const found = all.find((s) => s.name === wanted);
  if (!found) {
    console.error(`No scenario "${wanted}". Available: ${all.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }

  const scenario = readJson(found.scenarioPath);
  const solutionPath = path.join(path.dirname(found.scenarioPath), 'reference_solution.json');

  let graph;
  if (blank) {
    graph = scenario.initialWorkflow || { version: 1, nodes: [], connections: [] };
  } else {
    if (!fs.existsSync(solutionPath)) {
      console.error(`"${wanted}" has no reference_solution.json, so there is nothing`
        + ' to open fully built. Use --blank.');
      process.exit(1);
    }
    graph = readJson(solutionPath);
  }

  fs.writeFileSync(path.join(ROOT, 'scenario.json'), JSON.stringify(scenario, null, 2));
  fs.writeFileSync(path.join(ROOT, 'solution.json'), JSON.stringify(graph, null, 2));
  // No stale trace: the canvas should open on "Not run yet".
  fs.rmSync(path.join(ROOT, 'execution.json'), { force: true });

  console.log(`staged "${wanted}" — ${scenario.title}`);
  console.log(`  ${graph.nodes.length} nodes on the canvas${blank ? ' (starting state)' : ''}`);
  console.log(`  ${(scenario.assertions || []).length} assertions`);
  console.log('');
  console.log('  npm run start:dev        then open http://127.0.0.1:3000');
  console.log('  node scripts/stage-demo.js --clear    when you are done');
}

main();
