'use strict';

/**
 * Assertion DSL.
 *
 * Content engineers author JSON, not prompts. Every assertion resolves to a
 * boolean computed here in JavaScript — Cosmo reads booleans and never
 * reasons about graph structure. The `expected`/`actual` strings exist only so
 * a rejection can be explained back to the learner.
 *
 * Targeting: an assertion picks its node with either
 *   "node":     "Filter EU"        exact node name
 *   "nodeType": "filter|if"        any node of one of these types
 * Prefer nodeType — candidates rename nodes freely and a name-based assertion
 * then fails for the wrong reason.
 */

const { getNode } = require('../engine');

/**
 * Human-readable targeting prose.
 *
 * These strings end up in FAIL details, which Cosmo is instructed to turn into
 * feedback for the learner — so they must read as English and must not leak DSL
 * syntax. `nodeType: "filter|if"` became "no a filter|if node references …",
 * which is both ungrammatical and meaningless to a student.
 */
function labelFor(type, scenario) {
  const def = getNode(type, scenario);
  return def ? def.label : type;
}

/** "Filter or If node" — no article, for use after "no". */
function targetPlain(a, scenario) {
  if (a.node) return `"${a.node}"`;
  if (!a.nodeType) return 'node';
  const labels = String(a.nodeType).split('|').map((t) => labelFor(t.trim(), scenario));
  const list = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
  return `${list} node`;
}

/** "an Aggregate node" — with the right article. */
function describeTarget(a, scenario) {
  if (a.node) return `"${a.node}"`;
  const plain = targetPlain(a, scenario);
  return `${/^[aeiou]/i.test(plain) ? 'an' : 'a'} ${plain}`;
}

const TYPES = {
  nodeExists, connected, paramEquals, expressionContains,
  itemCount, sinkPayloadMatches, noNodeErrors, httpCalled, aiCalled,
};

/**
 * Whether a FAIL may explain itself.
 *
 * A FAIL detail names the expected value — "expected exactly 4, got 3". In Learn
 * that is the lesson; in Hire it is the answer key, printed to a report the
 * candidate can be shown. `grading.private` makes a whole scenario withhold it,
 * and an assertion's own `private` overrides that either way. The verdict never
 * changes — only what the FAIL line says about why.
 */
function isPrivate(a, scenario) {
  if (typeof a.private === 'boolean') return a.private;
  return Boolean(scenario.grading && scenario.grading.private === true);
}

function evaluateAssertions(scenario, graph, trace) {
  return (scenario.assertions || []).map((a) => {
    const base = { id: a.id, message: a.message || '', private: isPrivate(a, scenario) };
    const fn = TYPES[a.type];
    if (!fn) {
      return { ...base, pass: false, detail: `unknown assertion type "${a.type}"` };
    }
    try {
      const res = fn(a, { scenario, graph, trace });
      return { ...base, pass: Boolean(res.pass), detail: res.detail || '' };
    } catch (err) {
      return { ...base, pass: false, detail: `assertion error: ${err.message}` };
    }
  });
}

/* ── targeting helpers ─────────────────────────────────────────────── */

function typeMatcher(spec) {
  const types = String(spec).split('|').map((s) => s.trim()).filter(Boolean);
  return (type) => types.includes(type);
}

function findNodes(a, graph) {
  const nodes = graph.nodes || [];
  if (a.node) return nodes.filter((n) => n.name === a.node);
  if (a.nodeType) {
    const match = typeMatcher(a.nodeType);
    return nodes.filter((n) => match(n.type));
  }
  return [];
}

function findRecords(a, trace) {
  const records = trace.nodes || [];
  if (a.node) return records.filter((r) => r.name === a.node);
  if (a.nodeType) {
    const match = typeMatcher(a.nodeType);
    return records.filter((r) => match(r.type));
  }
  return [];
}



/* ── the eight types ───────────────────────────────────────────────── */

function nodeExists(a, { graph, scenario }) {
  const spec = a.nodeType || a.type_;
  const match = typeMatcher(spec);
  const found = (graph.nodes || []).filter((n) => match(n.type) && (!a.name || n.name === a.name));
  const enabled = found.filter((n) => !n.disabled);
  return {
    pass: enabled.length > 0,
    detail: enabled.length
      ? `found ${enabled.map((n) => `"${n.name}"`).join(', ')}`
      // `${spec}` here would print the raw DSL — "no enabled filter|if node" —
      // which is both ungrammatical and meaningless to a learner reading Cosmo's
      // feedback. Every other assertion routes its prose through describeTarget;
      // this one was missed.
      : `no enabled ${targetPlain({ ...a, nodeType: spec }, scenario)} in the workflow`,
  };
}

function connected(a, { graph }) {
  const nodes = graph.nodes || [];
  const from = nodes.filter((n) => (a.fromType ? typeMatcher(a.fromType)(n.type) : n.name === a.from));
  const to = nodes.filter((n) => (a.toType ? typeMatcher(a.toType)(n.type) : n.name === a.to));
  const hit = (graph.connections || []).some((c) => from.some((f) => f.id === c.from)
    && to.some((t) => t.id === c.to)
    && (a.fromOutput === undefined || (c.fromOutput || 0) === a.fromOutput)
    && (a.toInput === undefined || (c.toInput || 0) === a.toInput));
  return {
    pass: hit,
    detail: hit ? 'connection present' : `no connection ${a.from || a.fromType} → ${a.to || a.toType}`,
  };
}

function paramEquals(a, { graph, scenario }) {
  const nodes = findNodes(a, graph);
  if (!nodes.length) return { pass: false, detail: `${describeTarget(a, scenario)} is not in the workflow` };
  const hit = nodes.find((n) => deepEqual(getParam(n.parameters, a.param), a.value));
  return {
    pass: Boolean(hit),
    detail: hit
      ? `${a.param} = ${JSON.stringify(a.value)}`
      : `expected ${a.param} = ${JSON.stringify(a.value)}, got `
        + nodes.map((n) => JSON.stringify(getParam(n.parameters, a.param))).join(' / '),
  };
}

function expressionContains(a, { graph, scenario }) {
  const nodes = findNodes(a, graph);
  if (!nodes.length) return { pass: false, detail: `${describeTarget(a, scenario)} is not in the workflow` };
  const needle = a.substring;
  const hit = nodes.find((n) => {
    const value = a.param ? getParam(n.parameters, a.param) : n.parameters;
    return JSON.stringify(value === undefined ? null : value).includes(needle);
  });
  return {
    pass: Boolean(hit),
    detail: hit
      ? `${a.param || 'parameters'} references ${needle}`
      : `no ${targetPlain(a, scenario)} references ${needle} in ${a.param || 'parameters'}`,
  };
}

function itemCount(a, { trace, scenario }) {
  const records = findRecords(a, trace);
  if (!records.length) return { pass: false, detail: `${describeTarget(a, scenario)} did not run` };
  const port = a.port === 'in' ? 'itemsIn' : 'itemsOut';
  const comparison = a.comparison || 'exactly';
  const hit = records.find((r) => compare(r[port], comparison, a.count));
  const actual = records.map((r) => `${r.name}=${r[port]}`).join(', ');
  return {
    pass: Boolean(hit),
    detail: hit
      ? `${a.port || 'out'} ${comparison} ${a.count}`
      : `expected ${a.port || 'out'} ${comparison} ${a.count}, got ${actual}`,
  };
}

function compare(actual, comparison, expected) {
  if (comparison === 'atLeast') return actual >= expected;
  if (comparison === 'atMost') return actual <= expected;
  return actual === expected;
}

function sinkPayloadMatches(a, { trace, graph, scenario }) {
  const names = a.node
    ? [a.node]
    : findNodes(a, graph).map((n) => n.name);
  const payloads = names.flatMap((n) => trace.sinks[n] || []);
  if (!payloads.length) {
    return { pass: false, detail: `${describeTarget(a, scenario)} sent nothing` };
  }
  const hit = payloads.find((p) => partialMatch(p, a.match));
  return {
    pass: Boolean(hit),
    detail: hit
      ? 'payload matches'
      : `expected ${JSON.stringify(a.match)}, got ${JSON.stringify(payloads.length === 1 ? payloads[0] : payloads)}`,
  };
}

function noNodeErrors(a, { trace }) {
  const records = trace.nodes || [];
  const errored = records.filter((n) => n.status === 'error');

  // Deliberately NOT vacuously true: a workflow that never executed a node has
  // no errors, and would otherwise let a blank canvas pass a scenario whose
  // only assertion is this one.
  const ran = records.some((n) => n.status === 'success');
  if (!ran) {
    return {
      pass: false,
      detail: records.length
        ? 'no node completed successfully'
        : 'the workflow did not execute',
    };
  }

  return {
    pass: errored.length === 0 && trace.status !== 'error',
    detail: errored.length
      ? errored.map((n) => `${n.name}: ${n.error}`).join('; ')
      : (trace.status === 'error'
        ? (trace.errors || []).map((e) => e.message).join('; ')
        : 'no errors'),
  };
}

function httpCalled(a, { trace }) {
  const method = String(a.method || 'GET').toUpperCase();
  const calls = (trace.httpCalls || []).filter((c) => c.method === method
    && stripQuery(c.path) === stripQuery(a.path)
    && (a.status === undefined || c.status === a.status));
  const expected = a.times === undefined ? 1 : a.times;
  const comparison = a.comparison || 'exactly';
  return {
    pass: compare(calls.length, comparison, expected),
    detail: `${method} ${a.path} called ${calls.length}×, expected ${comparison} ${expected}`
      + (calls.length ? ` (status ${[...new Set(calls.map((c) => c.status))].join('/')})` : ''),
  };
}

/**
 * How many model calls the workflow made, and with which model.
 *
 * The assertion that makes an agent node worth grading. A workflow that classifies
 * forty tickets with forty calls and one that aggregates first and makes one are
 * both "working"; they differ by a factor of forty on the bill, and that is the
 * judgement the task is actually testing. Model choice is the same lesson — a
 * triage step does not need the expensive model.
 */
/**
 * `tool` narrows to a subagent by its tool name — the name the task gives, so
 * the assertion survives the candidate naming the node whatever they like.
 * `tool: false` means the top-level agents only, without their subagents.
 */
function aiCalled(a, { trace }) {
  const toolMatch = (c) => (a.tool === undefined ? true
    : a.tool === false ? !c.tool : c.tool === a.tool);
  const calls = (trace.aiCalls || []).filter((c) => (a.model === undefined || c.model === a.model)
    && (a.node === undefined || c.node === a.node) && toolMatch(c));
  const expected = a.times === undefined ? 1 : a.times;
  const comparison = a.comparison || 'exactly';

  const models = [...new Set((trace.aiCalls || []).map((c) => c.model || '(unset)'))];
  const target = [a.model ? `model "${a.model}"` : 'the model', a.node ? `from "${a.node}"` : '',
    typeof a.tool === 'string' ? `by the "${a.tool}" subagent` : (a.tool === false ? 'by top-level agents' : '')]
    .filter(Boolean).join(' ');

  return {
    pass: compare(calls.length, comparison, expected),
    detail: `${target} called ${calls.length}×, expected ${comparison} ${expected}`
      + (models.length ? ` (models used: ${models.join(', ')})` : ''),
  };
}

function stripQuery(path) {
  return String(path || '').split('?')[0];
}

/* ── matching utilities ────────────────────────────────────────────── */

function getParam(params, path) {
  if (!path) return params;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = params;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** `expected` is a partial shape; every key in it must deep-match `actual`. */
function partialMatch(actual, expected) {
  if (expected === null || typeof expected !== 'object') return deepEqual(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((e, i) => partialMatch(actual[i], e));
  }
  if (actual === null || typeof actual !== 'object') return false;
  return Object.keys(expected).every((k) => partialMatch(actual[k], expected[k]));
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (Array.isArray(a) !== Array.isArray(b) || ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

module.exports = { evaluateAssertions, partialMatch, TYPES };
