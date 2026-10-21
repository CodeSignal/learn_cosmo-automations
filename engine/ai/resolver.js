'use strict';

const { getPath } = require('../values');

/**
 * The AI boundary.
 *
 * An agent call is transport. It leaves the workflow, something outside answers,
 * and an answer comes back — exactly the shape of an HTTP call, so it is resolved
 * the same way: against fixtures the scenario declares, in-process, default-deny.
 *
 * THE ENGINE CAN ONLY REPLAY, AND THAT IS THE POINT
 *
 * `test/transport.test.js` walks `engine/` and fails the build if any file imports
 * a network module. That rule covers this file too, so a live model call cannot be
 * made from in here however anyone configures it. The consequences are worth
 * stating plainly, because they are the whole security argument for agent nodes:
 *
 *   - a candidate's session cannot reach a model. No API key in the container, no
 *     spend, no egress, and no path for a prompt-injection payload in the fixture
 *     data to reach a real model
 *   - two runs of the same workflow produce the same answer, so a grader can
 *     assert on what came out
 *   - the task costs nothing to run, however many candidates sit it
 *
 * `ai.mode: "live"` and `"record"` stay in the format because an AUTHOR needs them
 * — recording a fixture means calling a model once — but that belongs to a tool
 * outside `engine/`, and this resolver refuses them loudly rather than silently
 * behaving like replay.
 *
 * WHAT A FIXTURE MATCHES ON, AND WHAT IT MUST NOT
 *
 * Not the prompt. Never the prompt. The prompt is the candidate's work and the
 * thing being assessed; keying a fixture to it would mean a candidate who writes a
 * better prompt gets a fixture miss and fails for improving. Fixtures match on the
 * INPUT ITEM — data the author wrote and fully controls — and optionally on the
 * node's name when the task ships a fixed `initialWorkflow`.
 *
 * First match wins, like Switch rules and mock routes.
 */

/** Deep partial match: every key in `want` must be present and equal in `got`. */
function partialMatch(got, want) {
  if (want === null || typeof want !== 'object' || Array.isArray(want)) {
    return JSON.stringify(got) === JSON.stringify(want);
  }
  if (got === null || typeof got !== 'object') return false;
  return Object.keys(want).every((key) => partialMatch(got[key], want[key]));
}

/**
 * `when.tool` separates a subagent's fixtures from a top-level agent's. A
 * fixture without it answers top-level calls only, so a catch-all written for
 * the main agent can never answer a subagent with the wrong fields.
 */
function matches(fixture, { nodeName, input, tool }) {
  const when = fixture.when || {};
  if ((when.tool === undefined ? undefined : String(when.tool)) !== (tool || undefined)) return false;
  if (when.node !== undefined && when.node !== nodeName) return false;
  if (when.input !== undefined && !partialMatch(input, when.input)) return false;
  return true;
}

/**
 * @param scenario  carries `ai.mode` and `ai.fixtures`
 * @param call      { nodeName, input, outputFields, tool? } — empty outputFields means a text answer
 * @returns {{ ok: true, output, fixtureId, calls } | { ok: false, denied: true, explanation }}
 */
function resolveAgentCall(scenario, call) {
  const ai = (scenario && scenario.ai) || {};
  const mode = ai.mode || 'replay';

  if (mode !== 'replay') {
    return deny(
      `This task sets ai.mode to "${mode}". The engine only replays recorded fixtures — `
      + 'a live model call cannot be made from inside it, by design. Record fixtures with '
      + 'the authoring tool and set ai.mode to "replay".',
    );
  }

  const fixtures = Array.isArray(ai.fixtures) ? ai.fixtures : [];
  if (!fixtures.length) {
    return deny(
      'This task declares no AI fixtures, so an agent has nothing to answer with. '
      + 'That is a task-authoring gap, not something you can fix here.',
    );
  }

  const hit = fixtures.find((fixture) => fixture && matches(fixture, call));
  if (!hit) {
    return deny(
      `No AI fixture matches this call. The ${call.tool ? `subagent "${call.nodeName}" (tool ${call.tool})` : `agent "${call.nodeName}"`} was given an item `
      + `with ${describeItem(call.input)}, and nothing in ai.fixtures covers it.`,
    );
  }

  // Text for an agent that answers in text, an object of fields for one with a
  // Structured Output Parser, a list for one with an Item List Output Parser.
  const output = hit.respond === undefined ? {} : hit.respond;
  if (output === null || !['string', 'object'].includes(typeof output)) {
    return deny(`Fixture "${hit.id || '(unnamed)'}" responds with a ${output === null ? 'null' : typeof output}, not text, a list or an object of fields.`);
  }

  // The tool calls the model made before answering — replayed by the scheduler.
  const calls = Array.isArray(hit.calls) ? hit.calls : [];
  // `fixed`: what an Auto-fixing Output Parser's model turned a misshapen answer into.
  return { ok: true, output, fixtureId: hit.id || null, calls, ...(hit.fixed !== undefined ? { fixed: hit.fixed } : {}) };
}

/** A short, honest description of the item, for an error someone has to act on. */
function describeItem(input) {
  const keys = Object.keys(input || {});
  if (!keys.length) return 'no fields';
  const shown = keys.slice(0, 4).map((key) => `${key}=${JSON.stringify(getPath(input, key))}`);
  return shown.join(', ') + (keys.length > 4 ? `, +${keys.length - 4} more` : '');
}

function deny(explanation) {
  return { ok: false, denied: true, explanation };
}

module.exports = { resolveAgentCall, partialMatch };
