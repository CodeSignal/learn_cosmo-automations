const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  loadScenario: () => request('/api/scenario'),

  saveGraph: (graph) => request('/api/graph', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(graph),
  }),

  /**
   * @param graph      the workflow to run
   * @param options    { untilNode, inputOnly, resumeFrom, runId } — `untilNode` runs only that
   *                   node and what it depends on, and is never saved as the
   *                   graded run; with `inputOnly` it stops before that node and
   *                   only records what would arrive there. `resumeFrom` names
   *                   the approval just answered, so the nodes before it replay
   *                   without being shown running.
   */
  execute: (graph, options = {}) => request('/api/execute', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...graph, ...options }),
  }),

  reset: () => request('/api/reset', { method: 'POST', headers: JSON_HEADERS }),

  /**
   * Report one of the two interactions the server cannot observe — opening the
   * help panel, and opening a node's settings. Everything else in `activity.log`
   * is derived server-side from what was actually saved or run, which is both
   * more trustworthy and less chatty.
   *
   * Deliberately fire-and-forget: telemetry must never make the canvas feel slow
   * or surface an error to someone doing a task.
   */
  activity: (type, payload = {}) => {
    request('/api/activity', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ type, payload }),
    }).catch(() => {});
  },
};

/**
 * Debounced writer so every keystroke in a parameter field does not become a
 * disk write, while still guaranteeing the graph survives a reload.
 */
export function makeGraphSaver(delay = 400) {
  let timer = null;
  let pending = null;
  let onState = () => {};

  const flush = async () => {
    timer = null;
    const graph = pending;
    pending = null;
    if (!graph) return;
    try {
      onState('saving');
      await api.saveGraph(graph);
      onState('saved');
    } catch (err) {
      onState('error', err.message);
    }
  };

  return {
    onState(fn) { onState = fn; },
    save(graph) {
      pending = graph;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flushNow() {
      if (timer) clearTimeout(timer);
      return flush();
    },
  };
}
