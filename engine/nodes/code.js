'use strict';

const { makeItem } = require('../items');
const { runCodeInIsolate } = require('../sandbox');

const ALL_ITEMS = 'runOnceForAllItems';
const PER_ITEM = 'runOncePerItem';

/**
 * The Code node.
 *
 * The one node that runs candidate-authored JavaScript, and therefore the reason
 * the QuickJS isolate exists.
 *
 * Its execution mode is a *parameter* rather than a fixed property, because that
 * is how the tools candidates know behave — "Run Once for All Items" versus "Run
 * Once for Each Item" is the choice that teaches the item model.
 */
module.exports = (register) => {
  register({
    type: 'code',
    label: 'Code',
    group: 'data',
    icon: 'code',
    description: 'Runs JavaScript. Choose whether it sees every item at once, or one at a time.',
    // The `mode` parameter IS the mode; resolved by shared/node-mode.mjs.
    mode: 'dynamic',
    dynamicModeParam: 'mode',
    defaultMode: ALL_ITEMS,
    latency: { base: 80, perItem: 8 },
    defaults: {
      mode: ALL_ITEMS,
      jsCode: '',
    },
    params: [
      {
        name: 'mode', label: 'Mode', type: 'options', options: [ALL_ITEMS, PER_ITEM],
        hint: 'runOnceForAllItems: your code sees the whole list in `items` and returns a list. '
          + 'runOncePerItem: it runs once per item, sees `item`, and returns one item.',
      },
      {
        name: 'jsCode', label: 'JavaScript', type: 'string', multiline: true, mono: true,
        rows: 10,
        placeholder: 'return items;',
        hint: 'Plain JavaScript. `return` your result. No network, no filesystem, no imports.',
      },
    ],

    run: (ctx, input) => {
      const items = input[0] || [];
      const perItem = ctx.params.mode === PER_ITEM;
      const code = String(ctx.params.jsCode || '').trim();

      if (!code) {
        throw new Error('This Code node has no JavaScript in it yet.');
      }

      const result = runCodeInIsolate(code, {
        json: perItem && items[0] ? items[0].json : (items[0] ? items[0].json : null),
        itemIndex: perItem ? ctx.itemIndex : 0,
        items: items.map((i) => i.json),
        nodeOutputs: ctx.nodeOutputs || {},
        vars: ctx.vars || {},
        env: ctx.env || {},
        now: ctx.now.toISOString(),
        today: ctx.now.toISOString().slice(0, 10),
        seedMs: ctx.now.getTime(),
      }, { timeoutMs: ctx.codeTimeoutMs });

      if (!result.ok) throw new Error(result.error);

      return [normalise(result.value, perItem)];
    },
  });
};

/**
 * Accept the shapes people actually write, and reject the ones that would fail
 * silently later.
 *
 * Real tools are lenient here — returning bare objects rather than `{json: …}`
 * wrappers is the most common thing a candidate does, and failing on it teaches
 * nothing useful. What is *not* accepted is a scalar or null, because an item has
 * to be an object for `$json.field` to mean anything downstream.
 */
function normalise(value, perItem) {
  if (value === undefined || value === null) {
    throw new Error('Your code returned nothing. Return an item, or a list of items.');
  }

  const list = Array.isArray(value) ? value : [value];

  if (perItem && list.length > 1) {
    throw new Error(
      'In runOncePerItem mode your code must return a single item, not a list of '
      + `${list.length}. Switch to runOnceForAllItems to return several.`,
    );
  }

  return list.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `Item ${index + 1} of your result is a ${describe(entry)}, not an object. `
        + 'Each item needs to be an object, optionally wrapped as { json: … }.',
      );
    }
    // Both `{json: {...}}` and a bare `{...}` are accepted.
    const json = Object.prototype.hasOwnProperty.call(entry, 'json') ? entry.json : entry;
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error(`Item ${index + 1} has a "json" property that is not an object.`);
    }
    return makeItem(json);
  });
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'list';
  return typeof value;
}
