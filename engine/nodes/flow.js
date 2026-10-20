'use strict';

const { makeItem, deepClone } = require('../items');
const { getPath, numeric, looseCompare } = require('../values');

const OPERATORS = {
  equals: (l, r) => looseCompare(l, r) === 0,
  notEquals: (l, r) => looseCompare(l, r) !== 0,
  gt: (l, r) => numeric(l) > numeric(r),
  gte: (l, r) => numeric(l) >= numeric(r),
  lt: (l, r) => numeric(l) < numeric(r),
  lte: (l, r) => numeric(l) <= numeric(r),
  contains: (l, r) => String(l ?? '').includes(String(r ?? '')),
  notContains: (l, r) => !String(l ?? '').includes(String(r ?? '')),
  startsWith: (l, r) => String(l ?? '').startsWith(String(r ?? '')),
  endsWith: (l, r) => String(l ?? '').endsWith(String(r ?? '')),
  isEmpty: (l) => l === undefined || l === null || l === '' || (Array.isArray(l) && !l.length),
  isNotEmpty: (l) => !OPERATORS.isEmpty(l),
  isTrue: (l) => l === true || l === 'true',
  isFalse: (l) => l === false || l === 'false',
};

const OPERATOR_NAMES = Object.keys(OPERATORS);

/**
 * Evaluate a condition group against already-resolved parameters.
 * Returns { pass, detail } where detail explains each clause for the run log.
 */
function evaluateConditions(params) {
  const conditions = params.conditions || [];
  const combinator = (params.combinator || 'and').toLowerCase();
  if (!conditions.length) return { pass: true, detail: [] };

  const detail = conditions.map((c) => {
    const op = OPERATORS[c.op];
    if (!op) {
      return { ...c, pass: false, error: `Unknown operator "${c.op}"` };
    }
    let pass;
    try {
      pass = Boolean(op(c.left, c.right));
    } catch (err) {
      return { ...c, pass: false, error: err.message };
    }
    return { left: c.left, op: c.op, right: c.right, pass };
  });

  const firstError = detail.find((d) => d.error);
  if (firstError) {
    const err = new Error(firstError.error);
    err.detail = detail;
    throw err;
  }

  const pass = combinator === 'or'
    ? detail.some((d) => d.pass)
    : detail.every((d) => d.pass);
  return { pass, detail };
}

const CONDITION_PARAM = {
  name: 'conditions',
  label: 'Conditions',
  type: 'conditions',
  operators: OPERATOR_NAMES,
};

const COMBINATOR_PARAM = {
  name: 'combinator', label: 'Combine', type: 'options', options: ['and', 'or'],
};

module.exports = (register) => {
  register({
    type: 'filter',
    label: 'Filter',
    group: 'flow',
    icon: 'filter',
    description: 'Keeps only the items that match every condition. Discards the rest.',
    latency: { base: 45, perItem: 5 },
    mode: 'runOncePerItem',
    defaults: {
      combinator: 'and',
      conditions: [{ left: '', op: 'equals', right: '' }],
    },
    params: [COMBINATOR_PARAM, CONDITION_PARAM],
    run: (ctx, input) => {
      const item = input[0][0];
      const { pass, detail } = evaluateConditions(ctx.params);
      ctx.note({ conditions: detail, kept: pass });
      return [pass ? [item] : []];
    },
  });

  register({
    type: 'if',
    label: 'If',
    group: 'flow',
    icon: 'branch',
    description: 'Routes each item to the true or the false output.',
    latency: { base: 45, perItem: 5 },
    mode: 'runOncePerItem',
    outputs: [{ name: 'true' }, { name: 'false' }],
    defaults: {
      combinator: 'and',
      conditions: [{ left: '', op: 'equals', right: '' }],
    },
    params: [COMBINATOR_PARAM, CONDITION_PARAM],
    run: (ctx, input) => {
      const item = input[0][0];
      const { pass, detail } = evaluateConditions(ctx.params);
      ctx.note({ conditions: detail, branch: pass ? 'true' : 'false' });
      return pass ? [[item], []] : [[], [item]];
    },
  });

  register({
    type: 'switch',
    label: 'Switch',
    group: 'flow',
    icon: 'switch',
    description: 'Routes each item to one of several named outputs, by rule.',
    latency: { base: 50, perItem: 5 },
    mode: 'runOncePerItem',
    // The real port list comes from the rules — see shared/node-ports.mjs. This
    // is the fallback for an unconfigured node and the arity the palette shows.
    outputs: [{ name: 'rule 1' }],
    defaults: {
      rules: [{ left: '', op: 'equals', right: '', output: '' }],
      fallback: 'none',
      allMatches: false,
    },
    params: [
      {
        name: 'rules', label: 'Routing Rules', type: 'rules', operators: OPERATOR_NAMES,
        hint: 'Each rule gets its own output, named by whatever you type in Output Name.',
      },
      {
        name: 'fallback', label: 'Fallback Output', type: 'options',
        options: ['none', 'extra'],
        hint: 'none: an item matching no rule is dropped. extra: it leaves on an '
          + 'additional "fallback" output.',
      },
      {
        name: 'allMatches', label: 'Send To All Matching Outputs', type: 'boolean',
        hint: 'Off: the first matching rule wins. On: the item is copied to every '
          + 'rule it matches.',
      },
    ],
    run: (ctx, input) => {
      const item = input[0][0];
      const rules = ctx.params.rules || [];
      const matched = [];

      rules.forEach((rule, index) => {
        if (!rule) return;
        const op = OPERATORS[rule.op];
        if (!op) throw new Error(`Unknown operator "${rule.op}" on rule ${index + 1}.`);
        if (op(rule.left, rule.right)) matched.push(index);
      });

      const chosen = ctx.params.allMatches ? matched : matched.slice(0, 1);
      const out = rules.map(() => []);

      if (!chosen.length && ctx.params.fallback === 'extra') {
        out[rules.length] = [item];
        ctx.note({ routedTo: 'fallback' });
        return out;
      }

      for (const index of chosen) out[index] = [item];
      ctx.note({
        routedTo: chosen.length
          ? chosen.map((i) => (rules[i].output || `rule ${i + 1}`))
          : 'nothing — dropped',
      });
      return out;
    },
  });

  register({
    type: 'merge',
    label: 'Merge',
    group: 'flow',
    icon: 'merge',
    description: 'Brings two branches back together — appended, paired up, or joined on a field.',
    latency: { base: 60 },
    mode: 'runOnceForAllItems',
    inputs: 2,
    defaults: {
      mode: 'append',
      matchField: '',
      joinMode: 'keepMatches',
      includeUnpaired: false,
      useDataOf: 'input1',
    },
    params: [
      {
        name: 'mode', label: 'Mode', type: 'options',
        options: ['append', 'combineByPosition', 'combineByFields', 'chooseBranch'],
        hint: 'append: one list after the other. combineByPosition: 1st with 1st, '
          + '2nd with 2nd. combineByFields: join on a shared field, like a database '
          + 'join. chooseBranch: wait for both, then continue with one.',
      },
      {
        name: 'matchField', label: 'Field To Match On', type: 'string',
        placeholder: 'id',
        showFor: { mode: 'combineByFields' },
        hint: 'A field name present on both inputs. Not an expression.',
      },
      {
        name: 'joinMode', label: 'Join', type: 'options',
        options: ['keepMatches', 'enrichInput1'],
        showFor: { mode: 'combineByFields' },
        hint: 'keepMatches: only items that paired up. enrichInput1: every input 1 '
          + 'item, with input 2 fields added where they matched.',
      },
      {
        name: 'includeUnpaired', label: 'Include Unpaired Items', type: 'boolean',
        showFor: { mode: 'combineByPosition' },
        hint: 'When the two inputs are different lengths, pass the leftovers through '
          + 'unchanged instead of discarding them.',
      },
      {
        name: 'useDataOf', label: 'Continue With', type: 'options',
        options: ['input1', 'input2', 'empty'],
        showFor: { mode: 'chooseBranch' },
      },
    ],
    run: (ctx, input) => {
      const a = input[0] || [];
      const b = input[1] || [];
      const mode = ctx.params.mode || 'append';

      if (mode === 'append') {
        ctx.note({ merged: `${a.length} + ${b.length}` });
        return [[...a, ...b]];
      }

      if (mode === 'chooseBranch') {
        const which = ctx.params.useDataOf || 'input1';
        ctx.note({ waitedFor: `${a.length} + ${b.length}`, continuedWith: which });
        if (which === 'empty') return [[makeItem({})]];
        return [which === 'input2' ? b : a];
      }

      if (mode === 'combineByPosition') {
        const paired = Math.min(a.length, b.length);
        const out = [];
        for (let i = 0; i < paired; i++) {
          out.push(makeItem({ ...deepClone(a[i].json), ...deepClone(b[i].json) },
            { pairedItem: i }));
        }
        if (ctx.params.includeUnpaired) {
          for (let i = paired; i < a.length; i++) out.push(a[i]);
          for (let i = paired; i < b.length; i++) out.push(b[i]);
        }
        ctx.note({ paired, unpaired: Math.abs(a.length - b.length) });
        return [out];
      }

      // combineByFields — a join, and it fails loudly rather than silently
      // producing nothing when the field is missing or misspelled.
      const field = ctx.params.matchField;
      if (!field) throw new Error('Field To Match On is empty — Merge needs to know which field to join on.');

      const missingOn = (items, label) => {
        if (!items.length) return null;
        return items.every((i) => getPath(i.json, field) === undefined) ? label : null;
      };
      const missing = missingOn(a, 'input 1') || missingOn(b, 'input 2');
      if (missing) {
        throw new Error(`No item on ${missing} has a field "${field}" — nothing could ever match.`);
      }

      const index = new Map();
      for (const item of b) {
        const key = JSON.stringify(getPath(item.json, field) ?? null);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(item);
      }

      const out = [];
      let matchedCount = 0;
      a.forEach((item, i) => {
        const key = JSON.stringify(getPath(item.json, field) ?? null);
        const partners = index.get(key) || [];
        if (partners.length) {
          matchedCount++;
          for (const partner of partners) {
            out.push(makeItem({ ...deepClone(item.json), ...deepClone(partner.json) },
              { pairedItem: i }));
          }
        } else if (ctx.params.joinMode === 'enrichInput1') {
          out.push(item);
        }
      });

      ctx.note({ joinedOn: field, input1Matched: matchedCount, input1Total: a.length });
      return [out];
    },
  });

  register({
    type: 'loopOverItems',
    label: 'Loop Over Items',
    group: 'flow',
    icon: 'loop',
    description: 'Sends items through the nodes wired to its loop output a batch '
      + 'at a time, then continues on done.',
    latency: { base: 30 },
    mode: 'runOnceForAllItems',
    outputs: [{ name: 'done' }, { name: 'loop' }],
    /**
     * The one node the scheduler executes itself rather than calling `run`.
     *
     * Everything else in the engine is a pure function of its input items; this
     * node is a control-flow instruction — "run those nodes again with the next
     * batch" — which only the thing that owns the walk can carry out. Pretending
     * otherwise would mean handing a node the scheduler's internals.
     */
    loop: true,
    defaults: { batchSize: 1 },
    params: [
      {
        name: 'batchSize', label: 'Batch Size', type: 'number',
        hint: 'How many items go round on each pass. 1 means one item at a time.',
      },
    ],
    // Never called: `loop: true` is handled in the scheduler. Present so the node
    // definition is still complete on its own terms.
    run: () => { throw new Error('Loop Over Items is executed by the scheduler.'); },
  });

  register({
    type: 'noOp',
    label: 'No Operation',
    group: 'flow',
    icon: 'dot',
    description: 'Passes items through unchanged. Useful for tidying a layout.',
    mode: 'runOnceForAllItems',
    params: [],
    run: (ctx, input) => [input[0]],
  });

  register({
    type: 'stopAndError',
    label: 'Stop And Error',
    group: 'flow',
    icon: 'stop',
    description: 'Fails the workflow deliberately with a message.',
    mode: 'runOnceForAllItems',
    outputs: [],
    defaults: { message: 'Workflow stopped' },
    params: [{ name: 'message', label: 'Error Message', type: 'string' }],
    run: (ctx) => { throw new Error(String(ctx.params.message || 'Workflow stopped')); },
  });
};



module.exports.evaluateConditions = evaluateConditions;
module.exports.OPERATORS = OPERATORS;
