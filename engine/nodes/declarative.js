'use strict';

const { makeItem } = require('../items');
const { getPath } = require('../values');
const { applyCredential } = require('../credentials');
const { fill, fillDeep } = require('../template');

/**
 * Nodes defined in `scenario.json`, with no code change.
 *
 * WHAT THIS COVERS, AND WHY THAT IS THE USEFUL PART
 *
 * A node is five things: metadata, ports, execution mode, a parameter form, and
 * behaviour. The first four were always data. Only behaviour needed code — and
 * for the nodes that actually vary from task to task, the behaviour is always the
 * same shape: take the candidate's parameters, call a service, turn the response
 * into items. Zendesk, HubSpot, Jira, Stripe, an internal API — they differ in
 * URL, method, body and how the response is wrapped, and in nothing else.
 *
 * So that shape is what this expresses. A task author writes:
 *
 *   "nodes": [{
 *     "type": "zendesk",
 *     "label": "Zendesk",
 *     "operations": {
 *       "list":    { "mode": "runOnceForAllItems",
 *                    "request": { "method": "GET", "url": "https://zendesk.test/api/v2/tickets" },
 *                    "itemsFrom": "tickets" },
 *       "comment": { "mode": "runOncePerItem",
 *                    "request": { "method": "POST",
 *                                 "url": "https://zendesk.test/api/v2/tickets/{ticketId}/comments",
 *                                 "body": { "body": "{text}" } },
 *                    "sink": true }
 *     },
 *     "params": [ … ]
 *   }]
 *
 * WHAT IT DELIBERATELY DOES NOT COVER
 *
 * Flow control (If, Switch, Merge, Loop) and item algebra (Split Out, Aggregate,
 * Sort, Remove Duplicates) stay in code. Those are not configuration — they are
 * the semantics of the item model, the thing the grader's mechanism assertions
 * name, and the thing every task shares. A JSON dialect expressive enough to
 * write them would be a programming language with none of a language's tools, and
 * every task author would be debugging it.
 *
 * The line is therefore: **JSON adds services; code adds semantics.**
 *
 * THE TEMPLATE LANGUAGE IS ONE FEATURE WIDE
 *
 * `{paramName}` in a URL, header or body value is replaced with that parameter's
 * value. That is all. It is deliberately not the `{{ }}` expression language,
 * because expressions belong to the CANDIDATE: they type `={{ $json.id }}` into
 * the Ticket ID field and the scheduler resolves it before this node ever runs.
 * Keeping the two apart means the engine still owns expression evaluation and no
 * node ever sees a raw `={{ }}` string — the invariant the whole engine rests on.
 */

const DEFAULT_LATENCY = { base: 240, perItem: 80 };

/** A sensible starting value per field type, so authors need not spell them out. */
function defaultForParam(param) {
  if (param.default !== undefined) return param.default;
  switch (param.type) {
    case 'boolean': return false;
    case 'number': return 0;
    case 'options': return (param.options || [])[0] ?? '';
    case 'fields': return [{ name: '', value: '' }];
    case 'fieldNames': return [];
    default: return '';
  }
}

/** The credential the candidate attached, as headers. See ../credentials.js. */
const authHeaders = (ctx, headers) => applyCredential(ctx.credential, ctx.credentialTypes, headers);

/**
 * Compile one spec into a node definition the engine can run.
 *
 * Total by design: it never throws. A half-written spec produces a node that
 * fails with a clear message when someone runs it, and `engine/validate.js` is
 * what tells the AUTHOR about it — before a candidate ever sees the task. Throwing
 * here would take down the whole scenario for one typo in one node.
 */
function compileNodeSpec(spec = {}) {
  const operations = spec.operations && typeof spec.operations === 'object' ? spec.operations : {};
  const names = Object.keys(operations);
  const firstOp = names[0] || null;

  // The operation picker is generated, not authored — one less thing to get wrong,
  // and it guarantees the values match the operation keys exactly.
  const operationParam = names.length > 1
    ? [{
      name: 'operation',
      label: 'Operation',
      type: 'options',
      options: names,
      hint: spec.operationHint || undefined,
    }]
    : [];

  const authored = Array.isArray(spec.params) ? spec.params : [];
  const params = [...operationParam, ...authored];

  const defaults = {};
  if (firstOp) defaults.operation = firstOp;
  for (const param of authored) defaults[param.name] = defaultForParam(param);
  Object.assign(defaults, spec.defaults || {});

  // Mode per operation, resolved by shared/node-mode.mjs so the canvas and the
  // scheduler agree — the same mechanism the built-in integrations use.
  const operationModes = {};
  for (const name of names) {
    operationModes[name] = operations[name].mode === 'runOncePerItem'
      ? 'runOncePerItem'
      : 'runOnceForAllItems';
  }
  const singleMode = names.length === 1 ? operationModes[firstOp] : 'dynamic';

  return {
    type: spec.type,
    label: spec.label || spec.type,
    group: spec.group || 'integration',
    icon: spec.icon || 'globe',
    description: spec.description || '',
    inputs: spec.inputs === 0 ? 0 : 1,
    // One output. Routing items to different ports is flow control, which is the
    // side of the line that stays in code.
    outputs: [{ name: 'main' }],
    mode: singleMode,
    operationModes,
    dynamicModeParam: names.length > 1 ? 'operation' : null,
    usesCredential: spec.credential !== false,
    /**
     * Which credential TYPE this node wants. The detail view offers only matching
     * credentials, so a Slack node cannot be handed the database password — and
     * "which credential does this node need" becomes a thing the candidate has to
     * know rather than a list with one entry. Null means any, which is right for
     * HTTP Request: it calls services nobody wrote a node for.
     */
    credentialType: spec.credentialType || null,
    latency: spec.latency || DEFAULT_LATENCY,
    defaults,
    params,
    docs: spec.docs || null,
    // Marks it as scenario-defined, for the palette payload and the validator.
    declarative: true,

    run: async (ctx, input) => {
      const p = ctx.params;
      const opName = names.length > 1 ? p.operation : firstOp;

      if (!opName) {
        throw new Error(`"${spec.label || spec.type}" declares no operations, so there is nothing for it to do. This is a task-authoring error, not something you can fix here.`);
      }
      const op = operations[opName];
      if (!op || !op.request || !op.request.url) {
        throw new Error(`Operation "${opName}" on "${spec.label || spec.type}" has no request URL. This is a task-authoring error, not something you can fix here.`);
      }

      for (const required of op.require || []) {
        const value = p[required];
        const empty = value === undefined || value === null || String(value).trim() === ''
          || (Array.isArray(value) && !value.length);
        if (empty) {
          const label = (spec.params || []).find((d) => d.name === required);
          throw new Error(`${(label && label.label) || required} is empty — ${spec.label || spec.type} needs it to ${opName}.`);
        }
      }

      const item = input[0] && input[0][0] ? input[0][0] : null;
      const req = op.request;

      let url = String(fill(req.url, p, { encode: true }) ?? '');
      const query = req.query ? fillDeep(req.query, p) : null;
      if (query && Object.keys(query).length) {
        const qs = Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&');
        if (qs) url += (url.includes('?') ? '&' : '?') + qs;
      }

      const body = req.body === undefined ? undefined : fillDeep(req.body, p);
      const headers = authHeaders(ctx, {
        ...(req.headers ? fillDeep(req.headers, p) : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      });

      const res = await ctx.request({ method: req.method || 'GET', url, headers, body });

      if (res.status >= 400) {
        const detail = res.body && res.body.error ? ` — ${res.body.error}` : '';
        const err = new Error(`${spec.label || spec.type} responded with ${res.status}${detail}`);
        err.httpStatus = res.status;
        throw err;
      }

      /**
       * What was SENT is what `sinkPayloadMatches` reads, so a write can be
       * asserted on. `sink: true` records the whole request body; a string
       * records one path inside it, for an API that wraps what you send in an
       * envelope the assertion should not have to know about.
       */
      if (op.sink) {
        const sent = body === undefined ? {} : body;
        ctx.sink(op.sink === true ? sent : (getPath(sent, op.sink) ?? {}));
      }

      const paired = item ? { pairedItem: item.pairedItem } : {};

      /**
       * A write emits what it wrote, not what the API replied.
       *
       * `{"ok": true}` is not a useful item to carry onward; the row you just
       * created is. So `emit.from: "sent"` echoes the request back as the item,
       * `merge` stamps a marker on it, and `mergeFromResponse` lifts across the
       * one or two fields the API did return that matter — an assigned id, most
       * often. Without this every write would end the chain.
       */
      if (op.emit) {
        const source = op.emit.from === 'sent' ? (body === undefined ? {} : body) : res.body;
        const base = op.emit.path ? getPath(source, op.emit.path) : source;
        const json = (base !== null && typeof base === 'object' && !Array.isArray(base))
          ? { ...base }
          : { value: base };

        // Response fields first, then the literal markers. Arbitrary either way,
        // but it puts the id an API assigned next to the data it belongs to, and
        // the "created: true" style flag last where it reads as an annotation.
        for (const [key, path] of Object.entries(op.emit.mergeFromResponse || {})) {
          json[key] = getPath(res.body, path);
        }
        for (const [key, value] of Object.entries(op.emit.merge || {})) {
          // One token, because one node needed it: Slack stamps the run clock.
          json[key] = value === '$now' ? ctx.now.toISOString() : value;
        }

        ctx.note({ operation: opName });
        return [[makeItem(json, paired)]];
      }

      if (op.itemsFrom) {
        const list = getPath(res.body, op.itemsFrom);
        if (list === undefined) {
          throw new Error(`The response has no "${op.itemsFrom}" field to read items from. Available top-level fields: ${Object.keys(res.body || {}).join(', ') || '(none)'}`);
        }
        if (!Array.isArray(list)) {
          throw new Error(`"${op.itemsFrom}" in the response is a ${typeof list}, not a list.`);
        }
        ctx.note({ operation: opName, itemsFrom: op.itemsFrom, produced: list.length });
        return [list.map((entry) => makeItem(
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
            ? unwrap(entry, op.flatten)
            : { value: entry },
          paired,
        ))];
      }

      ctx.note({ operation: opName });

      const payload = res.body;
      if (Array.isArray(payload)) {
        return [payload.map((entry) => makeItem(
          entry !== null && typeof entry === 'object' ? entry : { value: entry }, paired,
        ))];
      }
      return [[makeItem(
        payload !== null && typeof payload === 'object' ? payload : { value: payload }, paired,
      )]];
    },
  };
}

/**
 * Lift a nested field onto the item — the Airtable `{id, fields: {…}}` shape,
 * which is common enough across SaaS APIs to be worth one option. Without it
 * every expression downstream carries a `.fields.` nobody wants to type.
 */
function unwrap(entry, flatten) {
  if (!flatten) return entry;
  const nested = entry[flatten];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return entry;
  const rest = { ...entry };
  delete rest[flatten];
  return { ...rest, ...nested };
}

module.exports = { compileNodeSpec };
