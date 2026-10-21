/**
 * A node's effective output ports.
 *
 * Most nodes have a fixed port list declared on the definition. Switch does not:
 * the candidate writes the routing rules, and each rule names the branch it
 * sends to, so the ports only exist once the node is configured. Rendering four
 * anonymous ports labelled 0–3 would be the easy way out and it teaches nothing
 * — the whole point of Switch over a chain of Ifs is that the branches have
 * names you can read off the canvas.
 *
 * Written as ESM and `require()`d by the CommonJS engine, for the same reason as
 * `summarise.mjs`: the ports the candidate drags a wire from and the ports the
 * scheduler routes items to must be the same list, computed once. A mismatch
 * would silently drop items into a port the engine does not believe exists.
 *
 * Keyed by node type rather than carried as a function on the definition,
 * because the palette payload is JSON — a function cannot cross to the browser.
 */

const PORTS = {
  /**
   * One port per rule, named by the rule, plus an optional fallback.
   *
   * Duplicate names are left alone rather than de-duplicated: two rules with the
   * same name are two ports, which is what the candidate wrote, and quietly
   * collapsing them would move items to a branch they did not wire.
   */
  switch: (p) => {
    const rules = Array.isArray(p.rules) ? p.rules : [];
    const ports = rules.map((rule, index) => ({
      name: rule && rule.output ? String(rule.output) : `rule ${index + 1}`,
    }));
    if (!ports.length) ports.push({ name: 'rule 1' });
    if (p.fallback === 'extra') ports.push({ name: 'fallback' });
    return ports;
  },
};

export function effectiveOutputs(definition, node) {
  if (!definition) return [{ name: 'main' }];
  const fn = PORTS[definition.type];
  if (!fn) return definition.outputs || [{ name: 'main' }];
  try {
    const ports = fn((node && node.parameters) || {});
    return ports.length ? ports : (definition.outputs || [{ name: 'main' }]);
  } catch {
    return definition.outputs || [{ name: 'main' }];
  }
}

/** True when this node type's ports depend on how it is configured. */
export function hasDynamicOutputs(type) {
  return Object.prototype.hasOwnProperty.call(PORTS, type);
}

/**
 * The ports an agent takes sub-nodes on: Tools is the input after the data
 * inputs, Output Parser the one after that. Plain integers, like every port.
 */
export function subPortOf(definition, kind) {
  const inputs = (definition && definition.inputs) || 0;
  if (kind === 'tool') return definition && definition.toolInput ? inputs : null;
  if (kind === 'parser') {
    return definition && definition.parserInput ? inputs + (definition.toolInput ? 1 : 0) : null;
  }
  return null;
}

/** Which kind of sub-node input port `port` is — 'tool', 'parser' — or null. */
export function subPortKind(definition, port) {
  if (subPortOf(definition, 'tool') === port) return 'tool';
  if (subPortOf(definition, 'parser') === port) return 'parser';
  return null;
}

/** Whether a node type is one that attaches to an agent rather than joining the flow. */
export function isSubNodeType(definition) {
  return Boolean(definition && (definition.toolOutput || definition.parserOutput));
}
