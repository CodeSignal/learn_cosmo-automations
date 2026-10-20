'use strict';

const { makeItem } = require('../items');
const { applyCredential } = require('../credentials');

/**
 * HTTP Request — the one transport node that stays in code.
 *
 * Every integration that used to live here (Slack, Gmail, Google Sheets,
 * Postgres, Airtable) is now JSON in `library/`, because each was the same shape:
 * fill in a URL and a body, call it, unwrap the response. HTTP Request is not
 * that shape. Its method is free, its query and body are toggled on and off by
 * the candidate rather than fixed by an author, and `neverError` changes how a
 * failure is handled — it is the escape hatch for a service nobody wrote a node
 * for, so it cannot itself be one of those nodes.
 *
 * It goes through `ctx.request()` — the in-process mock resolver. HTTP semantics
 * are real: real methods, headers, query strings, status codes and JSON parsing.
 * Only the far end is a fixture.
 */

/** The credential the candidate attached, as headers. See ../credentials.js. */
const authHeaders = (ctx, headers) => applyCredential(ctx.credential, ctx.credentialTypes, headers);

/** Turn a resolved response into items, matching how real nodes behave. */
function responseToItems(res, item) {
  const body = res.body;
  if (Array.isArray(body)) {
    return body.map((entry) => makeItem(
      entry !== null && typeof entry === 'object' ? entry : { data: entry },
      { pairedItem: item ? item.pairedItem : undefined },
    ));
  }
  return [makeItem(
    body !== null && typeof body === 'object' ? body : { data: body },
    { pairedItem: item ? item.pairedItem : undefined },
  )];
}

module.exports = (register) => {
  register({
    type: 'httpRequest',
    label: 'HTTP Request',
    group: 'transport',
    icon: 'globe',
    description: 'Calls an HTTP API. Status codes, headers and JSON parsing are real.',
    mode: 'runOncePerItem',
    usesCredential: true,
    // One request per item, so the cost visibly scales with the item count.
    latency: { base: 260, perItem: 90 },
    defaults: {
      method: 'GET',
      url: '',
      sendQuery: false,
      query: [],
      sendBody: false,
      body: [],
      neverError: false,
    },
    params: [
      { name: 'method', label: 'Method', type: 'options', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      {
        name: 'url', label: 'URL', type: 'string', mono: true,
        placeholder: 'https://api.example.test/v1/resource',
      },
      { name: 'sendQuery', label: 'Send Query Parameters', type: 'boolean' },
      { name: 'query', label: 'Query Parameters', type: 'fields', showFor: { sendQuery: true } },
      { name: 'sendBody', label: 'Send Body', type: 'boolean' },
      { name: 'body', label: 'Body Parameters', type: 'fields', showFor: { sendBody: true } },
      {
        name: 'neverError', label: 'Never Error On Failed Status', type: 'boolean',
        hint: 'When on, a 4xx/5xx becomes an item you can inspect instead of failing the node.',
      },
    ],
    run: async (ctx, input) => {
      const item = input[0][0];
      const p = ctx.params;

      let url = String(p.url || '');
      if (p.sendQuery && Array.isArray(p.query) && p.query.length) {
        const qs = p.query
          .filter((q) => q && q.name)
          .map((q) => `${encodeURIComponent(q.name)}=${encodeURIComponent(q.value ?? '')}`)
          .join('&');
        if (qs) url += (url.includes('?') ? '&' : '?') + qs;
      }

      let body;
      if (p.sendBody && Array.isArray(p.body) && p.body.length) {
        body = {};
        for (const f of p.body) if (f && f.name) body[f.name] = f.value;
      }

      const headers = authHeaders(ctx, body ? { 'content-type': 'application/json' } : {});
      const res = await ctx.request({ method: p.method || 'GET', url, headers, body });

      const failed = res.status >= 400;
      if (failed && !p.neverError) {
        const detail = res.body && res.body.error ? ` — ${res.body.error}` : '';
        const err = new Error(`The service responded with ${res.status}${detail}`);
        err.httpStatus = res.status;
        throw err;
      }

      return [responseToItems(res, item)];
    },
  });

};
