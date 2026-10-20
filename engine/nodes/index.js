'use strict';

/**
 * Node registry.
 *
 * Each node declares:
 *   type          stable id used in solution.json
 *   label         display name in the palette
 *   group         'trigger' | 'flow' | 'data' | 'transport' | 'integration'
 *   inputs        number of input ports
 *   outputs       output port descriptors [{ name }]
 *   mode          'runOncePerItem' | 'runOnceForAllItems', or a function of the
 *                 node's own parameters for nodes whose mode the candidate picks
 *                 (the Code node). Resolve it with `modeOf(def, node)`.
 *   defaults      starting parameters when dragged onto the canvas
 *   params        field descriptors driving the auto-generated detail form
 *   run           (ctx, input) => Item[][]   input/output outer array = port index
 *
 * `run` receives parameters ALREADY resolved for the relevant item — the
 * scheduler owns expression evaluation so every node gets it for free.
 */

const fs = require('fs');
const path = require('path');

const registry = new Map();

function register(def) {
  if (registry.has(def.type)) throw new Error(`Duplicate node type: ${def.type}`);
  registry.set(def.type, {
    inputs: 1,
    outputs: [{ name: 'main' }],
    mode: 'runOncePerItem',
    group: 'data',
    defaults: {},
    params: [],
    ...def,
  });
  return def;
}

require('./triggers')(register);
require('./flow')(register);
require('./data')(register);
require('./code')(register);
require('./transport')(register);
require('./agent')(register);
require('./approval')(register);

const { compileNodeSpec } = require('./declarative');

/**
 * The node library: integrations written as JSON, in `engine/nodes/library/`.
 *
 * These are not a lesser kind of node — they are registered alongside the coded
 * ones and behave identically. They live in JSON for two reasons. It proves the
 * declarative format is expressive enough for real integrations rather than for a
 * toy, which is the only way to know it is worth offering to task authors. And it
 * makes each one a complete, copyable EXAMPLE: an author writing a Zendesk node
 * starts from `slack.json`, not from a specification.
 *
 * Because they are examples, a scenario MAY override one — see `scenarioNodes`.
 * The coded nodes it may not, and that distinction is the whole design: an
 * integration is a detail of one task, the item model is not.
 */
const LIBRARY_DIR = path.join(__dirname, 'library');
const libraryTypes = new Set();

// Dotfiles are skipped: a tarball built on macOS carries AppleDouble `._slack.json`
// metadata files beside the real ones, and parsing one as a node spec crashed the
// server at startup — seen in a local session, where nothing else was wrong.
const isNodeSpec = (f) => f.endsWith('.json') && !f.startsWith('.');

for (const file of fs.readdirSync(LIBRARY_DIR).filter(isNodeSpec).sort()) {
  const spec = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, file), 'utf8'));
  registry.set(spec.type, compileNodeSpec(spec));
  libraryTypes.add(spec.type);
}

/**
 * Nodes a scenario defines for itself, compiled once per scenario.
 *
 * Keyed by the scenario OBJECT rather than by name, in a WeakMap: a scenario is
 * loaded fresh from disk on most requests, so a name-keyed cache would go stale
 * the moment an author edited the file, and a plain Map would hold every version
 * ever loaded in memory.
 */
const compiledByScenario = new WeakMap();

function scenarioNodes(scenario) {
  if (!scenario || typeof scenario !== 'object') return null;
  const specs = scenario.nodes;
  if (!Array.isArray(specs) || !specs.length) return null;

  if (compiledByScenario.has(scenario)) return compiledByScenario.get(scenario);

  const map = new Map();
  for (const spec of specs) {
    if (!spec || typeof spec.type !== 'string' || !spec.type) continue;
    // A CODED node may never be replaced: the item model is what every task
    // shares and what mechanism assertions name, so `filter` has to mean the same
    // thing in every task. A LIBRARY node may be — it is an example integration,
    // and swapping Slack for your own Slack is exactly the point.
    if (registry.has(spec.type) && !libraryTypes.has(spec.type)) continue;
    map.set(spec.type, compileNodeSpec(spec));
  }

  compiledByScenario.set(scenario, map);
  return map;
}

/**
 * @param scenario  optional; supply it to see the nodes that scenario defines.
 *                  Omitting it gives the built-ins only, which is what the places
 *                  that genuinely have no scenario in hand should get.
 */
function getNode(type, scenario) {
  // A scenario's own definition wins over a library node, and loses to a coded
  // one — `scenarioNodes` never admits a coded type in the first place.
  const extra = scenarioNodes(scenario);
  if (extra && extra.has(type)) return extra.get(type);
  return registry.get(type);
}

function allNodes(scenario) {
  const extra = scenarioNodes(scenario);
  if (!extra) return [...registry.values()];
  // An override replaces its library node rather than appearing twice.
  const merged = new Map(registry);
  for (const [type, def] of extra) merged.set(type, def);
  return [...merged.values()];
}

/** True for an integration shipped as JSON in `library/`, which a scenario may replace. */
function isLibraryNode(type) {
  return libraryTypes.has(type);
}

module.exports = { getNode, allNodes, registry, scenarioNodes, isLibraryNode };
