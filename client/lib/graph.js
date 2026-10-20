/**
 * Graph mutations.
 *
 * All of these are pure: (graph, …args) -> new graph. The canvas holds the
 * graph in one piece of state and persists it after every change, which is what
 * makes reload-survival and the trace/graph correspondence trivially correct.
 */

let counter = 0;

export function nextNodeId(graph) {
  const used = new Set((graph.nodes || []).map((n) => n.id));
  let id;
  do {
    counter += 1;
    id = `n${counter}`;
  } while (used.has(id));
  return id;
}

/** Node names must be unique — expressions address nodes by name. */
export function uniqueName(graph, base) {
  const taken = new Set((graph.nodes || []).map((n) => n.name));
  if (!taken.has(base)) return base;
  for (let i = 1; i < 500; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function addNode(graph, paletteEntry, position) {
  const node = {
    id: nextNodeId(graph),
    name: uniqueName(graph, paletteEntry.label),
    type: paletteEntry.type,
    position: [Math.round(position.x), Math.round(position.y)],
    parameters: structuredClone(paletteEntry.defaults || {}),
    ...(paletteEntry.usesCredential ? { credentialId: null } : {}),
  };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
}

export function updateNode(graph, id, patch) {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  };
}

export function setNodeParameter(graph, id, name, value) {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id
      ? { ...n, parameters: { ...n.parameters, [name]: value } }
      : n)),
  };
}

export function renameNode(graph, id, rawName) {
  const name = rawName.trim();
  if (!name) return graph;
  const clashes = graph.nodes.some((n) => n.id !== id && n.name === name);
  if (clashes) return graph;

  const previous = graph.nodes.find((n) => n.id === id);
  if (!previous || previous.name === name) return graph;

  // Rewrite $node["Old Name"] and $("Old Name") references so a rename does not
  // silently break every downstream expression.
  const rewrite = (value) => {
    if (typeof value === 'string') {
      return value
        .split(`$node["${previous.name}"]`).join(`$node["${name}"]`)
        .split(`$node['${previous.name}']`).join(`$node['${name}']`)
        .split(`$("${previous.name}")`).join(`$("${name}")`)
        .split(`$('${previous.name}')`).join(`$('${name}')`);
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    }
    return value;
  };

  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id
      ? { ...n, name }
      : { ...n, parameters: rewrite(n.parameters) })),
  };
}

export function removeNodes(graph, ids) {
  const doomed = new Set(ids);
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !doomed.has(n.id)),
    connections: graph.connections.filter((c) => !doomed.has(c.from) && !doomed.has(c.to)),
  };
}

/**
 * Fan-out and fan-in are both allowed.
 *
 * One output may feed many nodes (the same items go down each branch), and one
 * input may be fed by many nodes (their items are concatenated, in the engine's
 * authoring order — see `concatPort` in engine/items.js). Only an exact
 * duplicate of an existing connection is rejected.
 */
export function addConnection(graph, { from, fromOutput = 0, to, toInput = 0 }) {
  if (from === to) return graph;
  const exists = graph.connections.some((c) => c.from === from
    && (c.fromOutput || 0) === fromOutput
    && c.to === to
    && (c.toInput || 0) === toInput);
  if (exists) return graph;

  return {
    ...graph,
    connections: [...graph.connections, { from, fromOutput, to, toInput }],
  };
}

export function removeConnection(graph, { from, fromOutput = 0, to, toInput = 0 }) {
  return {
    ...graph,
    connections: graph.connections.filter((c) => !(c.from === from
      && (c.fromOutput || 0) === fromOutput
      && c.to === to
      && (c.toInput || 0) === toInput)),
  };
}

export function moveNode(graph, id, position) {
  return moveNodes(graph, [{ id, position }]);
}

/**
 * Batch move. React Flow emits one position change per node per animation frame,
 * and a multi-node drag emits several per frame, so applying them one at a time
 * would rebuild the node array repeatedly for a single visual update.
 */
export function moveNodes(graph, updates) {
  if (!updates.length) return graph;
  const byId = new Map(updates.map((u) => [u.id, u.position]));
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const position = byId.get(n.id);
      if (!position) return n;
      return { ...n, position: [Math.round(position.x), Math.round(position.y)] };
    }),
  };
}

export function setNodesDisabled(graph, ids, disabled) {
  const targets = new Set(ids);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (targets.has(n.id) ? { ...n, disabled } : n)),
  };
}

/**
 * Duplicate nodes, offset so the copies are visible, with connections *between*
 * the duplicated nodes preserved. Connections to nodes outside the selection are
 * intentionally dropped — a copy wired into the original's downstream would
 * silently double that branch's items.
 */
export function duplicateNodes(graph, ids) {
  const targets = (graph.nodes || []).filter((n) => ids.includes(n.id));
  if (!targets.length) return { graph, ids: [] };

  let next = graph;
  const idMap = new Map();

  for (const node of targets) {
    const id = nextNodeId(next);
    idMap.set(node.id, id);
    const copy = {
      ...structuredClone(node),
      id,
      name: uniqueName(next, node.name),
      position: [node.position[0] + 40, node.position[1] + 60],
    };
    next = { ...next, nodes: [...next.nodes, copy] };
  }

  const internal = (graph.connections || [])
    .filter((c) => idMap.has(c.from) && idMap.has(c.to))
    .map((c) => ({
      from: idMap.get(c.from),
      fromOutput: c.fromOutput || 0,
      to: idMap.get(c.to),
      toInput: c.toInput || 0,
    }));

  return {
    graph: { ...next, connections: [...next.connections, ...internal] },
    ids: [...idMap.values()],
  };
}

/** Cycle check used before committing a connection, mirroring the engine's rule. */
export function wouldCycle(graph, from, to) {
  const edges = new Map();
  for (const c of [...graph.connections, { from, to }]) {
    if (!edges.has(c.from)) edges.set(c.from, []);
    edges.get(c.from).push(c.to);
  }
  const seen = new Set();
  const stack = [to];
  while (stack.length) {
    const current = stack.pop();
    if (current === from) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(edges.get(current) || []));
  }
  return false;
}

/* ── credentials the candidate creates ───────────────────────────────────── */

/**
 * Credentials live in the graph, next to the nodes, because they are the
 * candidate's work — they created them and typed the secret in. That also means
 * they are saved, undone and redone by exactly the same machinery as everything
 * else on the canvas, rather than needing a second persistence path.
 */
export function credentialsOf(graph) {
  return graph.credentials || [];
}

export function nextCredentialId(graph) {
  const used = new Set(credentialsOf(graph).map((c) => c.id));
  for (let i = 1; i < 500; i += 1) {
    const id = `cred_${i}`;
    if (!used.has(id)) return id;
  }
  return `cred_${Date.now()}`;
}

export function addCredential(graph, { type, name, fields = {} }) {
  const credential = {
    id: nextCredentialId(graph),
    name: uniqueCredentialName(graph, name || 'New credential'),
    type,
    fields,
  };
  return { graph: { ...graph, credentials: [...credentialsOf(graph), credential] }, credential };
}

function uniqueCredentialName(graph, base) {
  const taken = new Set(credentialsOf(graph).map((c) => c.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function updateCredential(graph, id, patch) {
  return {
    ...graph,
    credentials: credentialsOf(graph).map((c) => (c.id === id ? { ...c, ...patch } : c)),
  };
}

/**
 * Deleting a credential also detaches it from every node using it. Leaving a
 * dangling `credentialId` would give the node a silent 401 with nothing in the
 * detail view to explain it — the dropdown would just look empty.
 */
export function removeCredential(graph, id) {
  return {
    ...graph,
    credentials: credentialsOf(graph).filter((c) => c.id !== id),
    nodes: (graph.nodes || []).map((n) => (n.credentialId === id ? { ...n, credentialId: null } : n)),
  };
}
