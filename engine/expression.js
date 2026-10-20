'use strict';

/**
 * Expression engine.
 *
 * A parameter whose string value starts with "=" is an expression parameter.
 * Inside it, every `{{ ... }}` span is evaluated and the results are spliced
 * back into the surrounding literal text.
 *
 *   "=EU order {{ $json.id }}"        -> "EU order 4821"      (string splice)
 *   "={{ $json.total }}"              -> 1420                 (raw value passthrough)
 *
 * The raw-value passthrough matters: a lone span must yield a number/boolean/
 * object, not "1420", or comparison operators and downstream nodes misbehave.
 *
 * Evaluation happens inside the QuickJS-WASM isolate (`engine/sandbox.js`) —
 * a separate VM with no bindings back into Node. `initSandbox()` must be awaited
 * once before any evaluation; `executeWorkflow` does that at the top of a run,
 * which is why this module's own API stays synchronous.
 */

const {
  initSandbox, isSandboxReady, evaluateInIsolate, DEFAULT_TIMEOUT_MS,
} = require('./sandbox');

const SPAN = /\{\{([\s\S]*?)\}\}/g;

/** Marker returned for a span that resolved to undefined, for UI display. */
const UNDEFINED_DISPLAY = '[undefined]';

function isExpression(value) {
  return typeof value === 'string' && value.startsWith('=');
}

/**
 * Flatten the evaluation context into the JSON-safe payload the isolate takes.
 *
 * Only strings cross the realm boundary, so no host object can be reachable from
 * candidate code by construction rather than by care. `nodeOutputs` arrives as
 * name -> Item[] and is reduced to name -> json[], since the helpers inside the
 * isolate rebuild the `{ json }` wrappers themselves.
 *
 * @param {object} ctx
 * @param {object}   ctx.json         current item's json ($json)
 * @param {number}   ctx.itemIndex    index of current item ($itemIndex)
 * @param {Array}    ctx.items        all items on the current input ($items())
 * @param {object}   ctx.nodeOutputs  node name -> Item[] already produced
 * @param {object}   ctx.vars         $vars
 * @param {object}   ctx.env          $env
 * @param {Date}     ctx.now          fixed run clock ($now / $today, and the
 *                                    clock the isolate's Date is pinned to)
 */
function buildData(ctx) {
  const nodeOutputs = {};
  for (const name of Object.keys(ctx.nodeOutputs || {})) {
    nodeOutputs[name] = (ctx.nodeOutputs[name] || []).map((item) => item.json);
  }

  const now = ctx.now || new Date(0);
  const iso = now.toISOString();

  return {
    json: ctx.json,
    itemIndex: ctx.itemIndex || 0,
    items: (ctx.items || []).map((item) => item.json),
    nodeOutputs,
    vars: ctx.vars || {},
    env: ctx.env || {},
    now: iso,
    today: iso.slice(0, 10),
    seedMs: now.getTime(),
  };
}

/** Evaluate one `{{ ... }}` inner expression. */
function evaluateSpan(source, data, timeoutMs) {
  return evaluateInIsolate(source, data, { timeoutMs });
}

function displayOf(value) {
  if (value === undefined) return UNDEFINED_DISPLAY;
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/**
 * Evaluate a full expression parameter (with or without the leading "=").
 *
 * @returns {{ value: *, ok: boolean, error: ?string,
 *             spans: Array<{source: string, display: string, error: ?string}> }}
 */
function evaluateExpressionString(raw, ctx) {
  const body = isExpression(raw) ? raw.slice(1) : raw;
  const spans = [];

  SPAN.lastIndex = 0;
  const matches = [...body.matchAll(SPAN)];

  if (matches.length === 0) {
    // An expression parameter with no spans is just a literal.
    return { value: body, ok: true, error: null, spans: [] };
  }

  const data = buildData(ctx);
  const timeoutMs = ctx.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : ctx.timeoutMs;

  // Lone span covering the whole parameter: pass the raw value through.
  const lone = matches.length === 1 && matches[0][0].length === body.length;

  let firstError = null;
  const parts = [];
  let cursor = 0;

  for (const m of matches) {
    parts.push(body.slice(cursor, m.index));
    cursor = m.index + m[0].length;

    const source = m[1].trim();
    const result = source === ''
      ? { ok: false, error: 'Empty expression' }
      : evaluateSpan(source, data, timeoutMs);

    if (result.ok) {
      spans.push({ source, display: displayOf(result.value), error: null });
      if (lone) return { value: result.value, ok: true, error: null, spans };
      parts.push(result.value === undefined || result.value === null
        ? ''
        : displayOf(result.value));
    } else {
      spans.push({ source, display: UNDEFINED_DISPLAY, error: result.error });
      if (!firstError) firstError = result.error;
      if (lone) return { value: undefined, ok: false, error: result.error, spans };
      parts.push(UNDEFINED_DISPLAY);
    }
  }
  parts.push(body.slice(cursor));

  return { value: parts.join(''), ok: !firstError, error: firstError, spans };
}

/**
 * Walk a parameter tree and resolve every expression string in it.
 * Returns the resolved copy plus diagnostics keyed by dotted path, which is
 * what the node detail view renders next to each field.
 */
function resolveParameters(params, ctx) {
  const diagnostics = [];

  function walk(value, path) {
    if (isExpression(value)) {
      const res = evaluateExpressionString(value, ctx);
      diagnostics.push({
        path, raw: value, display: displayOf(res.value),
        spans: res.spans, error: res.error,
      });
      return res.value;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = walk(value[k], path ? `${path}.${k}` : k);
      return out;
    }
    return value;
  }

  return { value: walk(params, ''), diagnostics };
}

module.exports = {
  isExpression,
  evaluateExpressionString,
  resolveParameters,
  buildData,
  displayOf,
  UNDEFINED_DISPLAY,
  // Re-exported so callers need only one import to get a working evaluator.
  initSandbox,
  isSandboxReady,
};
