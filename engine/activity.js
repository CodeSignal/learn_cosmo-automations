'use strict';

const fs = require('fs');

/**
 * `activity.log` — the platform's view into a bespoke UI.
 *
 * A simulation is opaque from the outside: the platform can see that a session
 * happened and read the final `solution.json`, but not how the learner got there.
 * This is the standardised record of that — append-only JSONL in the session
 * filesystem, one event per line.
 *
 * THE VOCABULARY IS FIXED HERE, ON PURPOSE
 *
 * Defining event types as they are needed produces a log that only its author can
 * read, and that changes shape between releases. So every type this simulation
 * can emit is listed in `EVENTS` below with its payload, nothing else is
 * accepted, and a test asserts the two stay in step. Adding an event is a
 * deliberate act.
 *
 * EVERY EVENT CARRIES
 *   seq   monotonic within the session, so ordering survives equal timestamps
 *   ts    ISO 8601, wall clock
 *   type  one of EVENTS
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 *
 * Secrets. A `credential.create` records the id and the type; never the fields.
 * The whole point of the credential change is that the learner types a real
 * secret, and a log that echoed it back would be the easiest place in the system
 * to find one. `test/activity.test.js` pins this.
 *
 * Node positions, too. Dragging a node emits nothing: it is not learning
 * behaviour, it is tidying, and it would drown everything else.
 */

const EVENTS = {
  'session.start': 'The simulation booted. { scenario, title, nodeCount }',
  'workflow.edit': 'The workflow changed, as a delta. { added, removed, renamed, reconfigured, connected, disconnected }',
  'credential.create': 'A credential was created. { id, credentialType } — never the values',
  'credential.delete': 'A credential was deleted. { id }',
  'workflow.run': 'A full run finished. { status, nodes, errors, durationMs, itemsOut, liveCalls?, tokens? }',
  'node.run': 'One node was run with Execute Node. { node, nodeType, status }',
  'workflow.reset': 'The canvas was reset to the starting workflow. { }',
  'approval.pause': 'A run stopped at an approval and is waiting. { node }',
  'approval.decide': 'The learner approved or rejected. { node, decision }',
  'help.open': 'The help panel was opened. { topic }',
  'node.open': 'A node’s settings were opened. { node, nodeType }',
};

/** Events the CLIENT may report. The rest are the server's own observations. */
const CLIENT_EVENTS = new Set(['help.open', 'node.open']);

/**
 * A runaway client could otherwise fill the session disk. The cap is high enough
 * that no real session reaches it, and the log says when it stopped rather than
 * going quiet — a truncated log that looks complete is worse than one that admits
 * it is not.
 */
const MAX_EVENTS = 5000;

function createActivityLog(filePath, { enabled = true } = {}) {
  let seq = 0;
  let stopped = false;

  const write = (line) => {
    try {
      fs.appendFileSync(filePath, `${line}\n`);
    } catch {
      // A session that cannot write its log still has to run. Losing telemetry is
      // a bad outcome; failing the learner's task over it is a worse one.
    }
  };

  return {
    get count() { return seq; },

    /** @returns {boolean} whether it was recorded. */
    record(type, payload = {}) {
      if (!enabled || stopped) return false;
      if (!Object.prototype.hasOwnProperty.call(EVENTS, type)) return false;

      if (seq >= MAX_EVENTS) {
        stopped = true;
        write(JSON.stringify({
          seq: seq + 1,
          ts: new Date().toISOString(),
          type: 'log.truncated',
          reason: `more than ${MAX_EVENTS} events in one session`,
        }));
        return false;
      }

      seq += 1;
      write(JSON.stringify({ seq, ts: new Date().toISOString(), type, ...payload }));
      return true;
    },
  };
}

/**
 * What changed between two versions of a workflow.
 *
 * Computed server-side from the saved graph rather than reported by the client,
 * so the log describes what actually happened rather than what the UI claimed.
 * Returns null when nothing meaningful changed — a save triggered by a node drag
 * should not produce a line.
 */
function diffGraphs(before, after) {
  const byId = (g) => new Map(((g && g.nodes) || []).map((n) => [n.id, n]));
  const a = byId(before);
  const b = byId(after);

  const added = [...b.values()].filter((n) => !a.has(n.id)).map((n) => n.type);
  const removed = [...a.values()].filter((n) => !b.has(n.id)).map((n) => n.type);

  const renamed = [];
  const reconfigured = [];
  for (const [id, node] of b) {
    const was = a.get(id);
    if (!was) continue;
    if (was.name !== node.name) renamed.push(node.name);
    // Position is excluded deliberately: moving a node is not a change of intent.
    if (JSON.stringify(was.parameters) !== JSON.stringify(node.parameters)
      || (was.credentialId || null) !== (node.credentialId || null)
      || Boolean(was.disabled) !== Boolean(node.disabled)) {
      reconfigured.push(node.name);
    }
  }

  const wire = (g) => new Set(((g && g.connections) || [])
    .map((c) => `${c.from}:${c.fromOutput || 0}->${c.to}:${c.toInput || 0}`));
  const wa = wire(before);
  const wb = wire(after);
  const connected = [...wb].filter((w) => !wa.has(w)).length;
  const disconnected = [...wa].filter((w) => !wb.has(w)).length;

  const delta = {
    added, removed, renamed, reconfigured, connected, disconnected,
  };
  const empty = !added.length && !removed.length && !renamed.length
    && !reconfigured.length && !connected && !disconnected;
  return empty ? null : delta;
}

/** Credentials created or deleted between two versions, WITHOUT their values. */
function diffCredentials(before, after) {
  const ids = (g) => new Map(((g && g.credentials) || []).map((c) => [c.id, c]));
  const a = ids(before);
  const b = ids(after);
  return {
    created: [...b.values()].filter((c) => !a.has(c.id))
      .map((c) => ({ id: c.id, credentialType: c.type })),
    deleted: [...a.keys()].filter((id) => !b.has(id)).map((id) => ({ id })),
  };
}

module.exports = {
  EVENTS, CLIENT_EVENTS, MAX_EVENTS, createActivityLog, diffGraphs, diffCredentials,
};
