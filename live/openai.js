'use strict';

/**
 * Live AI answers through an OpenAI-compatible endpoint — in a session, the
 * platform's LLM Proxy.
 *
 * This is the only code in the simulation that talks to a model. It lives outside
 * `engine/` on purpose: the engine cannot import a network module (enforced by
 * test/transport.test.js), so it never calls this directly. The server builds a
 * `liveAgent` here and passes it to `run()` as an option; nothing else does, so
 * run.js, the validator, the tests and the grader always replay recorded answers.
 *
 * WHAT IT RETURNS
 *
 * Never throws for anything a model or the network can do. Every failure is a
 * `{ ok: false, reason, message }` the scheduler turns into a visible fallback to
 * the recorded answer, so a task keeps working when the proxy does not:
 *
 *   no-model    the scenario maps no model id to the label the node picked
 *   rate-limit  the proxy refused for this minute (HTTP 429)
 *   budget      the session's spend cap is used up
 *   timeout     no answer within the scenario's per-call limit
 *   bad-answer  the model did not finish with the declared fields
 *   error       anything else — network, 5xx, an unexpected body
 *
 * HOW A STRUCTURED ANSWER IS ASKED FOR
 *
 * The node's expected output fields become a `respond` function the model must
 * finish with (`tool_choice: "required"`). Attached subagents are offered as the
 * other functions; when the model calls one, `runTool` runs it — through the
 * engine, which resolves the subagent's prompt from the model's arguments — and
 * the answer goes back as the tool result. One mechanism for both, and it works
 * with any model that supports function calling.
 */

const MAX_TURNS = 8;
const RESPOND = 'respond';

/**
 * @param {object} opts
 * @param {string} opts.apiKey    the session's proxy key (OPENAI_API_KEY)
 * @param {string} opts.baseUrl   the proxy (OPENAI_BASE_URL)
 * @param {Function} [opts.fetchImpl]  injectable for tests
 * @returns {Function|null} liveAgent, or null when the session has no proxy
 */
function createLiveAgent({ apiKey, baseUrl, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey || !baseUrl) return null;
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  /**
   * An identical question within the session gets the same answer without a
   * second call: "Execute Node" on one node five times costs one call. Only
   * successful answers are kept, and only for the life of the server process.
   */
  const cache = new Map();

  /**
   * @param call
   *   model        the dropdown label the node picked
   *   systemPrompt, userPrompt, input, outputFields (empty: answer in text)
   *   tools        [{ name, description }] — attached subagents
   *   runTool      async (name, args) => answer (text or fields) | { error }
   *   live         the scenario's ai.live block (models map, timeoutMs)
   */
  async function liveAgent(call) {
    const live = call.live || {};
    const modelId = live.models && typeof live.models === 'object' ? live.models[call.model] : undefined;
    if (!modelId) {
      return fail('no-model', `No live model is configured for "${call.model || '(none)'}".`);
    }

    const fields = (call.outputFields || []).filter(Boolean);
    const tools = (call.tools || []).filter((t) => t && t.name && t.name !== RESPOND);

    const key = JSON.stringify([modelId, call.systemPrompt, call.userPrompt, call.input,
      fields, call.schema || null, tools.map((t) => [t.name, t.description])]);
    if (cache.has(key)) return { ...cache.get(key), cached: true, usage: { prompt: 0, completion: 0 } };

    const messages = [];
    if (call.systemPrompt) messages.push({ role: 'system', content: String(call.systemPrompt) });
    messages.push({ role: 'user', content: String(call.userPrompt || '') });

    // With fields (an output parser), the answer comes through a `respond`
    // function the model must call; without, it is the model's final text.
    const structured = fields.length > 0;
    const functions = [
      ...tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || t.name,
          parameters: { type: 'object', additionalProperties: true },
        },
      })),
      ...(structured ? [{
        type: 'function',
        function: {
          name: RESPOND,
          description: 'Give your final answer. Call this exactly once, when you are done.',
          // The parser's schema when it has one (from a JSON example or schema),
          // otherwise every field, untyped.
          parameters: call.schema || {
            type: 'object',
            properties: Object.fromEntries(fields.map((f) => [f, { description: f }])),
            required: fields,
          },
        },
      }] : []),
    ];

    const usage = { prompt: 0, completion: 0 };
    const deadline = Date.now() + (Number(live.timeoutMs) > 0 ? Number(live.timeoutMs) : 20000);

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return fail('timeout', 'The live model did not answer in time.', usage);

      let body;
      try {
        body = await post(fetchImpl, endpoint, apiKey, {
          model: modelId,
          messages,
          ...(functions.length ? { tools: functions, tool_choice: structured ? 'required' : 'auto' } : {}),
        }, remaining);
      } catch (err) {
        return { ...err.failure, usage };
      }

      usage.prompt += Number(body.usage && body.usage.prompt_tokens) || 0;
      usage.completion += Number(body.usage && body.usage.completion_tokens) || 0;

      const message = body.choices && body.choices[0] && body.choices[0].message;
      const toolCalls = (message && message.tool_calls) || [];
      if (!toolCalls.length) {
        if (structured) return fail('bad-answer', 'The live model answered without the requested fields.', usage);
        const text = message && typeof message.content === 'string' ? message.content.trim() : '';
        if (!text) return fail('bad-answer', 'The live model gave an empty answer.', usage);
        const answer = { ok: true, output: text, model: modelId };
        cache.set(key, answer);
        return { ...answer, usage };
      }

      const final = toolCalls.find((t) => t.function && t.function.name === RESPOND);
      if (final) {
        const args = parseArgs(final.function.arguments);
        if (!args || fields.every((f) => args[f] === undefined)) {
          return fail('bad-answer', 'The live model did not return any of the requested fields.', usage);
        }
        const output = Object.fromEntries(fields.filter((f) => args[f] !== undefined).map((f) => [f, args[f]]));
        const answer = { ok: true, output, model: modelId };
        cache.set(key, answer);
        return { ...answer, usage };
      }

      messages.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls });
      for (const toolCall of toolCalls) {
        const name = toolCall.function && toolCall.function.name;
        const args = parseArgs(toolCall.function && toolCall.function.arguments) || {};
        let result;
        try {
          result = call.runTool ? await call.runTool(name, args) : { error: `no tool named ${name}` };
        } catch (err) {
          result = { error: err.message };
        }
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          // A subagent that answers in text hands back the text itself.
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }
    return fail('bad-answer', `The live model gave no final answer within ${MAX_TURNS} turns.`, usage);
  }

  return liveAgent;
}

async function post(fetchImpl, url, apiKey, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw wrap(err.name === 'AbortError'
      ? fail('timeout', 'The live model did not answer in time.')
      : fail('error', 'The live model could not be reached.'));
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) throw wrap(fail('rate-limit', 'The live model is rate-limited for this minute.'));
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // The proxy reports a spent key budget as a 400 whose body says so.
    if (/budget/i.test(text)) throw wrap(fail('budget', 'The live model budget for this session is used up.'));
    throw wrap(fail('error', `The live model returned HTTP ${res.status}.`));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw wrap(fail('error', 'The live model returned an unreadable response.'));
  }
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fail(reason, message, usage) {
  return { ok: false, reason, message, ...(usage ? { usage } : {}) };
}

function wrap(failure) {
  const err = new Error(failure.message);
  err.failure = failure;
  return err;
}

module.exports = { createLiveAgent };
