'use strict';

const crypto = require('crypto');
const { executeWorkflow } = require('./scheduler');
const { allNodes, getNode } = require('./nodes');
const { summariseNode } = require('../shared/summarise.mjs');
const { effectiveMode, hasDynamicMode } = require('../shared/node-mode.mjs');
const { docsFor } = require('../shared/node-docs.mjs');

/**
 * Canonical hash of a graph. `execution.json` records the hash of the graph it
 * was produced from; the parse script recomputes it from solution.json and
 * reports VALID / MISSING / MISMATCH.
 *
 * This is an integrity check, not an authenticity one: it stops a stale trace
 * being presented for an edited graph. A hand-written trace gains nothing
 * either, because grading re-runs the workflow and judges the fresh run — see
 * README "Grading".
 */
function hashGraph(graph) {
  const canonical = {
    nodes: [...(graph.nodes || [])]
      .map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        disabled: Boolean(n.disabled),
        credentialId: n.credentialId || null,
        parameters: sortKeys(n.parameters || {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    connections: [...(graph.connections || [])]
      .map((c) => ({ from: c.from, fromOutput: c.fromOutput || 0, to: c.to, toInput: c.toInput || 0 }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    // Credentials are part of the workflow now, so they are part of its identity.
    // Without this, correcting a mistyped API key would leave the previous run's
    // trace looking current — the canvas would still show the old 401.
    credentials: [...(graph.credentials || [])]
      .map((c) => ({ id: c.id, type: c.type, fields: sortKeys(c.fields || {}) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/** Run a graph and return the trace, stamped with the graph hash. */
async function run(scenario, graph, options = {}) {
  const trace = await executeWorkflow(scenario, graph, options);
  trace.graphHash = hashGraph(graph);
  return trace;
}

/**
 * Palette descriptors for the client, filtered by the scenario.
 *
 * Node defaults are deliberately empty of anything task-specific — a default
 * URL or channel would hand the candidate the answer. A task author who *wants*
 * a field pre-filled has two options, both explicit:
 *
 *   palette.defaults  per-node-type overrides, applied to every node of that
 *                     type the candidate drags out (e.g. give them the base URL
 *                     but not the path)
 *   initialWorkflow   a starting graph with fully configured nodes — the right
 *                     tool for "here is a broken workflow, fix it"
 */
function paletteFor(scenario) {
  const palette = scenario.palette || {};
  const include = palette.include;
  const exclude = new Set(palette.exclude || []);
  const overrides = palette.defaults || {};

  return allNodes(scenario)
    .filter((n) => (include ? include.includes(n.type) : true))
    .filter((n) => !exclude.has(n.type))
    .map((n) => ({
      type: n.type,
      label: n.label,
      group: n.group,
      icon: n.icon || 'dot',
      description: n.description || '',
      inputs: n.inputs,
      outputs: n.outputs,
      // Subagents: a Tools input sits after the data inputs (port index =
      // `inputs`) on the bottom edge; a tool's own output is on its top edge.
      toolInput: Boolean(n.toolInput),
      toolOutput: Boolean(n.toolOutput),
      // Output parsers: the agent's Output Parser port comes after Tools; a
      // parser offers itself from its top edge, like a tool.
      parserInput: Boolean(n.parserInput),
      parserOutput: Boolean(n.parserOutput),
      // A node whose mode depends on its configuration reports `dynamic`, plus
      // which parameter decides — the client resolves it per node through the
      // same shared function the engine uses.
      mode: hasDynamicMode(n) ? 'dynamic' : n.mode,
      defaultMode: effectiveMode(n, { parameters: n.defaults || {} }),
      dynamicModeParam: n.dynamicModeParam || null,
      // A scenario-defined node's mode map has to cross to the browser too, or the
      // canvas would fall back to "all items" while the engine looped per item.
      operationModes: n.operationModes || null,
      usesCredential: Boolean(n.usesCredential),
      credentialType: n.credentialType || null,
      defaults: { ...n.defaults, ...(overrides[n.type] || {}) },
      params: modelOptions(n.params, scenario),
      // A scenario-defined node carries its own wiki page; a built-in's lives in
      // shared/node-docs.mjs. Same shape either way, so the help panel and the
      // node's ? button do not care which kind it is.
      docs: n.docs || docsFor(n.type),
      declarative: Boolean(n.declarative),
    }));
}

/**
 * Fill the Agent's model dropdown from the scenario.
 *
 * Which models a task offers is content, not code — a task about cost might offer
 * a cheap one and an expensive one precisely so the choice matters. An empty list
 * means the task forgot to declare any, and the validator says so rather than
 * leaving a candidate with a dropdown they cannot open.
 */
function modelOptions(params, scenario) {
  const models = ((scenario || {}).ai || {}).models;
  if (!Array.isArray(models) || !models.length) return params;
  return (params || []).map((param) => (
    param.name === 'model' && param.type === 'options' && !(param.options || []).length
      ? { ...param, options: models.map((m) => (typeof m === 'string' ? m : m.id)) }
      : param
  ));
}

/**
 * One-line human summary of a node's configuration.
 *
 * Delegates to the shared ESM module so the canvas and the STDOUT report can
 * never drift apart.
 */
function summarise(node, scenario) {
  return summariseNode(node.type, node.parameters, getNode(node.type, scenario));
}

module.exports = { run, hashGraph, paletteFor, summarise, getNode, allNodes };
