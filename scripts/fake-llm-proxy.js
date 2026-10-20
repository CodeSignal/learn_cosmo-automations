#!/usr/bin/env node
'use strict';

/**
 * A stand-in for the LLM Proxy: an OpenAI-compatible /chat/completions on
 * 127.0.0.1, so live answers can be exercised with no key and no network.
 *
 *   node scripts/fake-llm-proxy.js            # listens on 127.0.0.1:4010
 *   OPENAI_BASE_URL=http://127.0.0.1:4010/ OPENAI_API_KEY=fake npm run start:dev
 *
 * The tests start it in-process with their own `handler`, to script tool calls,
 * rate limits, spent budgets and malformed answers. Standalone, it answers every
 * `respond` call by filling each requested field with a short placeholder, so the
 * canvas shows live answers end to end.
 */

const http = require('http');

/**
 * @param {object} [opts]
 * @param {number} [opts.port]  0 for any free port (tests)
 * @param {Function} [opts.handler]  (requestBody, info) => { status?, body? } | message
 *   Return a bare assistant message ({ tool_calls: [...] }) for the common case,
 *   or { status, body } to control the HTTP response.
 * @returns {Promise<{ url, port, requests, close }>}
 */
function startFakeProxy({ port = 0, handler = defaultHandler } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
        return;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* answered below */ }
      requests.push({ body, authorization: req.headers.authorization });
      const out = await handler(body, { index: requests.length - 1 });
      const status = out && out.status ? out.status : 200;
      const payload = out && (out.status || out.body !== undefined) ? out.body : completion(out);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        port: actual,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Wrap an assistant message in a chat-completions response with token usage. */
function completion(message) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  };
}

/** An assistant message that calls `name` with `args`. */
function toolCall(name, args, id = `call_${name}`) {
  return { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

/** Fill every field the respond function requires with a placeholder. */
function defaultHandler(body) {
  const respond = (body.tools || []).find((t) => t.function && t.function.name === 'respond');
  const fields = (respond && respond.function.parameters && respond.function.parameters.required) || [];
  return toolCall('respond', Object.fromEntries(fields.map((f) => [f, `live ${f}`])));
}

if (require.main === module) {
  startFakeProxy({ port: Number(process.env.PORT || 4010) }).then(({ url }) => {
    console.log(`fake LLM proxy on ${url} — set OPENAI_BASE_URL=${url} OPENAI_API_KEY=fake`);
  });
}

module.exports = { startFakeProxy, toolCall, completion };
