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
