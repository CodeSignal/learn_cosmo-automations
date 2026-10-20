/**
 * A node's effective execution mode.
 *
 * Most nodes have a fixed mode. Some resolve it from their own parameters, and
 * they do it two different ways:
 *
 *   - the Code node's `mode` parameter IS the answer — the candidate picks
 *     "once for all items" or "once per item" directly, because that choice is
 *     the thing the node teaches
 *   - an integration's mode follows its operation: reading a sheet is one call
 *     for the whole sheet, appending a row is one call per item. Nobody should
 *     have to set that by hand, and getting it wrong would mean forty API calls
 *     where one was meant
 *
 * The engine's scheduler calls this too, so there is exactly one implementation.
 * A canvas that promised "runs once for all items" while the engine looped per
 * item would be a lie in the place candidates are learning the item model.
 *
 * Keyed by node type rather than carried as a function on the definition,
 * because the palette payload is JSON and a function cannot cross to the browser.
 */

const MODES = {
  gmail: (p) => (p.operation === 'getAll' ? 'runOnceForAllItems' : 'runOncePerItem'),
  googleSheets: (p) => (p.operation === 'read' ? 'runOnceForAllItems' : 'runOncePerItem'),
  postgres: (p) => (p.operation === 'insert' ? 'runOncePerItem' : 'runOnceForAllItems'),
  airtable: (p) => (p.operation === 'create' ? 'runOncePerItem' : 'runOnceForAllItems'),
};

export function effectiveMode(definition, node) {
  if (!definition) return 'runOnceForAllItems';

  /**
   * A node defined in `scenario.json` ships its own operation→mode map, because
   * there is nowhere in this file to hardcode a type nobody has written yet. Same
   * rule as the built-in integrations — reading is one call, writing is one per
   * item — just carried as data instead of code.
   */
  if (definition.operationModes) {
    const params = (node && node.parameters) || definition.defaults || {};
    const chosen = definition.operationModes[params.operation];
    if (chosen) return chosen;
    const only = Object.values(definition.operationModes);
    if (only.length === 1) return only[0];
  }

  const fromType = MODES[definition.type];
  if (fromType) {
    const params = (node && node.parameters) || definition.defaults || {};
    return fromType(params);
  }

  if (definition.mode !== 'dynamic') return definition.mode;

  // The value-is-the-mode case.
  const param = definition.dynamicModeParam;
  const chosen = param && node && node.parameters ? node.parameters[param] : null;
  return chosen || definition.defaultMode || 'runOnceForAllItems';
}

/** True when this node's mode depends on how it is configured. */
export function hasDynamicMode(definition) {
  if (!definition) return false;
  if (definition.operationModes && Object.keys(definition.operationModes).length > 1) return true;
  return definition.mode === 'dynamic'
    || Object.prototype.hasOwnProperty.call(MODES, definition.type);
}

/** Human phrasing, in item terms — for a sentence. */
export function describeMode(mode) {
  return mode === 'runOncePerItem' ? 'once per item' : 'once for all items';
}

/** The two-word form, for a cramped label. */
export function shortMode(mode) {
  if (mode === 'dynamic') return 'your choice';
  return mode === 'runOncePerItem' ? 'per item' : 'all items';
}
