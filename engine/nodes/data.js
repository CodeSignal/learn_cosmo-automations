'use strict';

const { makeItem, deepClone } = require('../items');
const { getPath, setPath, looseCompare } = require('../values');

const SUMMARY_OPS = {
  count: (values) => values.length,
  sum: (values) => values.reduce((a, v) => a + toNumber(v), 0),
  avg: (values) => (values.length ? values.reduce((a, v) => a + toNumber(v), 0) / values.length : 0),
  min: (values) => (values.length ? Math.min(...values.map(toNumber)) : null),
  max: (values) => (values.length ? Math.max(...values.map(toNumber)) : null),
  concat: (values) => values.map((v) => String(v)).join(', '),
};

function toNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? 0 : n;
}

module.exports = (register) => {
  register({
    type: 'set',
    label: 'Edit Fields',
    group: 'data',
    icon: 'pencil',
    description: 'Sets, renames or removes fields on each item.',
    latency: { base: 40, perItem: 4 },
    mode: 'runOncePerItem',
    defaults: {
      keepOnlySet: false,
      fields: [{ name: '', value: '' }],
    },
    params: [
      {
        name: 'keepOnlySet', label: 'Keep Only Set Fields', type: 'boolean',
        hint: 'Discard every incoming field that this node does not set.',
      },
      { name: 'fields', label: 'Fields to Set', type: 'fields' },
    ],
    run: (ctx, input) => {
      const item = input[0][0];
      const base = ctx.params.keepOnlySet ? {} : deepClone(item.json);
      for (const field of ctx.params.fields || []) {
        if (!field || !field.name) continue;
        setPath(base, field.name, field.value);
      }
      return [[makeItem(base, { pairedItem: item.pairedItem, binary: item.binary })]];
    },
  });

  register({
    type: 'splitOut',
    label: 'Split Out',
    group: 'data',
    icon: 'split',
    description: 'Turns an array field on one item into one item per array element.',
    latency: { base: 70, perItem: 6 },
    mode: 'runOncePerItem',
    defaults: { field: '', include: 'noOtherFields' },
    params: [
      {
        name: 'field', label: 'Field to Split Out', type: 'string',
        placeholder: 'fieldName',
        hint: 'A field name or dotted path, e.g. orders or body.orders. Not an expression.',
      },
      {
        name: 'include', label: 'Include', type: 'options',
        options: ['noOtherFields', 'allOtherFields'],
      },
    ],
    run: (ctx, input) => {
      const item = input[0][0];
      const path = ctx.params.field;
      const value = getPath(item.json, path);

      if (value === undefined) {
        throw new Error(
          `Field "${path}" does not exist on the incoming item. `
          + `Available top-level fields: ${Object.keys(item.json || {}).join(', ') || '(none)'}`,
        );
      }
      if (!Array.isArray(value)) {
        throw new Error(`Field "${path}" is a ${typeof value}, not an array — nothing to split out.`);
      }

      const others = ctx.params.include === 'allOtherFields' ? deepClone(item.json) : null;
      if (others) delete others[String(path).split('.')[0]];

      const out = value.map((entry) => {
        const json = (entry !== null && typeof entry === 'object' && !Array.isArray(entry))
          ? deepClone(entry)
          : { [String(path).split('.').pop()]: entry };
        return makeItem(others ? { ...others, ...json } : json,
          { pairedItem: item.pairedItem });
      });

      ctx.note({ splitField: path, produced: out.length });
      return [out];
    },
  });

  register({
    type: 'aggregate',
    label: 'Aggregate',
    group: 'data',
    icon: 'merge',
    description: 'Combines many items into one. The fan-in counterpart to Split Out.',
    latency: { base: 90 },
    mode: 'runOnceForAllItems',
    defaults: {
      mode: 'summarize',
      outputs: [{ as: '', op: 'count' }],
      field: 'data',
    },
    params: [
      {
        name: 'mode', label: 'Aggregate', type: 'options',
        options: ['summarize', 'individualFields', 'allItemData'],
        hint: 'summarize: counts and sums. individualFields: each field becomes an array. '
          + 'allItemData: every item into one field.',
      },
      { name: 'outputs', label: 'Outputs', type: 'aggregations', showFor: { mode: 'summarize' } },
      { name: 'fields', label: 'Fields to Aggregate', type: 'fieldNames', showFor: { mode: 'individualFields' } },
      { name: 'field', label: 'Output Field Name', type: 'string', showFor: { mode: 'allItemData' } },
    ],
    run: (ctx, input) => {
      const items = input[0] || [];
      const mode = ctx.params.mode || 'summarize';

      if (mode === 'allItemData') {
        const field = ctx.params.field || 'data';
        return [[makeItem({ [field]: items.map((i) => deepClone(i.json)) })]];
      }

      if (mode === 'individualFields') {
        const json = {};
        for (const name of ctx.params.fields || []) {
          json[name] = items.map((i) => getPath(i.json, name));
        }
        return [[makeItem(json)]];
      }

      const json = {};
      for (const out of ctx.params.outputs || []) {
        if (!out || !out.as) continue;
        const op = SUMMARY_OPS[out.op];
        if (!op) throw new Error(`Unknown aggregation "${out.op}". Use one of: ${Object.keys(SUMMARY_OPS).join(', ')}`);
        const values = out.op === 'count'
          ? items
          : items.map((i) => getPath(i.json, out.field)).filter((v) => v !== undefined);
        json[out.as] = op(values);
      }
      ctx.note({ aggregatedFrom: items.length });
      return [[makeItem(json)]];
    },
  });

  register({
    type: 'sort',
    label: 'Sort',
    group: 'data',
    icon: 'sort',
    description: 'Reorders the items by one or more fields.',
    latency: { base: 45 },
    mode: 'runOnceForAllItems',
    defaults: {
      type: 'fields',
      fields: [{ field: '', order: 'ascending' }],
    },
    params: [
      {
        name: 'type', label: 'Sort By', type: 'options', options: ['fields', 'random'],
        hint: 'random shuffles the items. It is seeded, so the same input always '
          + 'shuffles the same way — grading has to be reproducible.',
      },
      {
        name: 'fields', label: 'Fields To Sort By', type: 'sortFields',
        showFor: { type: 'fields' },
        hint: 'Sorted by the first field; later fields break ties.',
      },
    ],
    run: (ctx, input) => {
      const items = [...(input[0] || [])];

      if (ctx.params.type === 'random') {
        // Seeded from the item count alone: no clock, no Math.random, so two runs
        // of the same workflow produce the same order. A "random" that changed
        // between runs would make every downstream assertion flaky.
        const rand = mulberry32(items.length * 2654435761);
        for (let i = items.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [items[i], items[j]] = [items[j], items[i]];
        }
        ctx.note({ shuffled: items.length, seeded: true });
        return [items];
      }

      const fields = (ctx.params.fields || []).filter((f) => f && f.field);
      if (!fields.length) {
        throw new Error('Sort has no fields to sort by. Add one, or switch Sort By to random.');
      }

      const unknown = fields.find((f) => items.every((i) => getPath(i.json, f.field) === undefined));
      if (unknown) {
        throw new Error(
          `No item has a field "${unknown.field}" — there is nothing to sort by. `
          + `Available top-level fields: ${Object.keys(items[0].json || {}).join(', ') || '(none)'}`,
        );
      }

      // Decorated with the original index so equal items keep their input order:
      // a sort that reshuffles ties would make the graded output depend on the
      // engine's sort implementation.
      const decorated = items.map((item, index) => ({ item, index }));
      decorated.sort((a, b) => {
        for (const f of fields) {
          const cmp = looseCompare(getPath(a.item.json, f.field), getPath(b.item.json, f.field));
          if (Number.isNaN(cmp)) continue;
          if (cmp !== 0) return f.order === 'descending' ? -cmp : cmp;
        }
        return a.index - b.index;
      });

      ctx.note({ sortedBy: fields.map((f) => `${f.field} ${f.order || 'ascending'}`) });
      return [decorated.map((d) => d.item)];
    },
  });

  register({
    type: 'limit',
    label: 'Limit',
    group: 'data',
    icon: 'limit',
    description: 'Keeps at most a set number of items and discards the rest.',
    latency: { base: 30 },
    mode: 'runOnceForAllItems',
    defaults: { maxItems: 10, keep: 'firstItems' },
    params: [
      { name: 'maxItems', label: 'Max Items', type: 'number' },
      {
        name: 'keep', label: 'Keep', type: 'options', options: ['firstItems', 'lastItems'],
      },
    ],
    run: (ctx, input) => {
      const items = input[0] || [];
      const max = Number(ctx.params.maxItems);
      if (!Number.isFinite(max) || max < 0) {
        throw new Error(`Max Items must be a number of 0 or more, not "${ctx.params.maxItems}".`);
      }
      const kept = ctx.params.keep === 'lastItems'
        ? items.slice(Math.max(0, items.length - max))
        : items.slice(0, max);
      ctx.note({ received: items.length, kept: kept.length, dropped: items.length - kept.length });
      return [kept];
    },
  });

  register({
    type: 'removeDuplicates',
    label: 'Remove Duplicates',
    group: 'data',
    icon: 'dedupe',
    description: 'Drops items that repeat an earlier item. The first occurrence is kept.',
    latency: { base: 50 },
    mode: 'runOnceForAllItems',
    defaults: { compare: 'allFields', fields: [] },
    params: [
      {
        name: 'compare', label: 'Compare', type: 'options',
        options: ['allFields', 'selectedFields', 'allFieldsExcept'],
      },
      {
        name: 'fields', label: 'Fields', type: 'fieldNames',
        showFor: { compare: ['selectedFields', 'allFieldsExcept'] },
      },
    ],
    run: (ctx, input) => {
      const items = input[0] || [];
      const compare = ctx.params.compare || 'allFields';
      const named = (ctx.params.fields || []).filter(Boolean);

      if (compare !== 'allFields' && !named.length) {
        throw new Error(`Compare is "${compare}" but no fields are listed — nothing to compare on.`);
      }

      const keyOf = (item) => {
        if (compare === 'selectedFields') {
          return JSON.stringify(named.map((f) => getPath(item.json, f) ?? null));
        }
        const json = item.json || {};
        const keys = Object.keys(json)
          .filter((k) => (compare === 'allFieldsExcept' ? !named.includes(k) : true))
          .sort();
        return JSON.stringify(keys.map((k) => [k, json[k]]));
      };

      const seen = new Set();
      const kept = [];
      for (const item of items) {
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(item);
      }

      ctx.note({ received: items.length, kept: kept.length, removed: items.length - kept.length });
      return [kept];
    },
  });
};

/** Small, fast, fully deterministic PRNG. Only used for the seeded shuffle. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports.SUMMARY_OPS = SUMMARY_OPS;
