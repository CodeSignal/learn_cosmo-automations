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
