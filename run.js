#!/usr/bin/env node
'use strict';

/**
 * Headless runner — the clean contract boundary between the engine (P1–P3) and
 * the canvas (P4–P5).
 *
 *   node run.js <scenario.json> <solution.json> [execution.json]
 *
 * Writes the trace and prints a one-line-per-node summary to stderr so it is
 * usable by eye without polluting stdout.
 */

const fs = require('fs');
const path = require('path');
const { run } = require('./engine');

async function main() {
  const [scenarioFile, solutionFile, outFile = 'execution.json'] = process.argv.slice(2);
  if (!scenarioFile || !solutionFile) {
    process.stderr.write('usage: node run.js <scenario.json> <solution.json> [execution.json]\n');
    process.exit(2);
  }

  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const graph = JSON.parse(fs.readFileSync(solutionFile, 'utf8'));

  const trace = await run(scenario, graph);
  fs.writeFileSync(path.resolve(outFile), JSON.stringify(trace, null, 2));

  process.stderr.write(`status: ${trace.status}  (${trace.durationMs}ms)\n`);
  for (const n of trace.nodes) {
    const status = n.status === 'success' ? '' : ` [${n.status}]`;
    process.stderr.write(`  ${n.name}  in=${n.itemsIn} out=${n.itemsOut}${status}`
      + `${n.error ? `  ${n.error}` : ''}\n`);
  }
  process.stderr.write(`wrote ${outFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack}\n`);
  process.exit(1);
});
