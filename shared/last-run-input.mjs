/**
 * What would arrive at a node, read from the last run of the nodes before it.
 *
 * The input panel shows a node's own trace record, so a node added or wired up
 * after a run showed "No input data yet" although every node feeding it had
 * already run and its items were sitting in the trace. This rebuilds the input
 * from those records instead: for each connection into the node's first input,
 * the items on the port the connection leaves from.
 *
 * Returns null when it cannot know — nothing has run, nothing is connected, or a
 * node feeding this one has no record — so the panel keeps its empty state
 * rather than showing a partial list as if it were complete.
 *
 * Written as ESM and `require()`d by the tests, like the other shared modules.
 */
export function lastRunInput(graph, trace, nodeId) {
  if (!trace || !Array.isArray(trace.nodes) || !graph) return null;
  const incoming = (graph.connections || [])
    .filter((c) => c.to === nodeId && (c.toInput || 0) === 0);
  if (!incoming.length) return null;

  const items = [];
  for (const connection of incoming) {
    const record = trace.nodes.find((r) => r.id === connection.from);
    if (!record) return null;
    const port = connection.fromOutput || 0;
    const sample = Array.isArray(record.outputSamples)
      ? record.outputSamples[port]
      : (port === 0 ? record.output : undefined);
    if (!Array.isArray(sample)) return null;
    items.push(...sample);
  }
  return items.slice(0, 50);
}

/**
 * How many nodes "Execute previous nodes" will run for this node, as far as the
 * client can tell: the nodes directly before it, plus any node further up that
 * has no result in the current run. Used to label the button in the singular
 * when only the one node before it still has to run.
 *
 * `isSubNode(type)` says which node types attach to a port rather than feed
 * data (tools, output parsers); those never run as steps and are not counted.
 * An edited node can still have a result here, so the engine, which compares
 * fingerprints, may run more than this says; it is a label, not a promise.
 */
export function nodesBefore(graph, trace, nodeId, isSubNode = () => false) {
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const ran = new Set(((trace && trace.nodes) || [])
    .filter((r) => ['success', 'disabled', 'noItems'].includes(r.status))
    .map((r) => r.id));
  const feeding = (id) => (graph.connections || [])
    .filter((c) => c.to === id && byId.has(c.from) && !isSubNode(byId.get(c.from).type))
    .map((c) => c.from);

  const toRun = new Set();
  const visit = (id, force) => {
    if (toRun.has(id) || (!force && ran.has(id))) return;
    toRun.add(id);
    for (const from of feeding(id)) visit(from, false);
  };
  for (const from of feeding(nodeId)) visit(from, true);
  return toRun.size;
}
