/**
 * Undo / redo over whole-graph snapshots.
 *
 * Snapshots rather than inverse operations: a graph is small (tens of nodes) and
 * every mutation in lib/graph.js is already a pure whole-graph replacement, so
 * storing the document is both simpler and impossible to get subtly wrong.
 *
 * Not every state change belongs in history. A drag produces a position update
 * per animation frame; those coalesce into ONE entry, pushed at drag end from
 * the snapshot taken at drag start. Selection is not part of the document at
 * all, so it never lands here.
 */

const LIMIT = 50;

export function createHistory() {
  return { past: [], future: [] };
}

/** Record `snapshot` as the state to return to. Clears the redo branch. */
export function push(history, snapshot) {
  const past = [...history.past, snapshot];
  return {
    past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past,
    future: [],
  };
}

export function canUndo(history) {
  return history.past.length > 0;
}

export function canRedo(history) {
  return history.future.length > 0;
}

/**
 * @returns {{ history, graph }|null} null when there is nothing to undo.
 */
export function undo(history, current) {
  if (!history.past.length) return null;
  const graph = history.past[history.past.length - 1];
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, LIMIT),
    },
    graph,
  };
}

export function redo(history, current) {
  if (!history.future.length) return null;
  const graph = history.future[0];
  return {
    history: {
      past: [...history.past, current].slice(-LIMIT),
      future: history.future.slice(1),
    },
    graph,
  };
}
