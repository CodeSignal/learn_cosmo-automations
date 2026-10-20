'use strict';

/**
 * Mock transport.
 *
 * Every request the engine makes is resolved against `scenario.mockApi.hosts`
 * in-process. There is deliberately NO `fetch` / `http` / `https` / `net`
 * import anywhere under engine/ — real egress is impossible by construction,
 * not by a conditional. `test/no-egress.test.js` asserts this and will fail
 * the build if anyone adds one.
 *
 * A candidate-facing URL like
 *     https://api.acme-crm.test/v1/orders?since=2026-01-01
 * is reported in the trace as its loopback form
 *     /__mock/api.acme-crm.test/v1/orders?since=2026-01-01
 * and the server mounts this same resolver at that path, so the rewrite is
 * real and curl-able rather than a story we tell.
 *
 * Hosts use RFC 2606 / 6761 reserved TLDs (.test / .invalid), which are
 * guaranteed non-resolvable — so even a resolver misconfiguration plus a bug
 * in the rewriter cannot reach a real host.
 */

const METHOD_ALLOWLIST = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** Parse a candidate-typed URL without using the WHATWG URL's network side. */
function parseUrl(raw) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/.exec(String(raw).trim());
  if (!m) return { ok: false, error: `Not a valid absolute URL: ${raw}` };
  const [, protocol, authority, rawPath, rawQuery] = m;
  const host = authority.replace(/^[^@]*@/, '').toLowerCase();
  return {
    ok: true,
    protocol: protocol.toLowerCase(),
    host,
    path: normalisePath(rawPath || '/'),
    query: parseQuery(rawQuery || ''),
    queryString: rawQuery || '',
  };
}

/**
 * Collapse `.` and `..` segments before fixture matching, so a path can never
 * traverse out of the host's route table.
 */
function normalisePath(path) {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

function parseQuery(qs) {
  const out = {};
  for (const pair of qs.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const k = decodeURIComponent(idx === -1 ? pair : pair.slice(0, idx));
    const v = idx === -1 ? '' : decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

function lowerKeys(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) out[k.toLowerCase()] = headers[k];
  return out;
}

/** `/v1/orders/:id/flag` vs `/v1/orders/4821/flag` -> { id: '4821' } */
function matchPath(pattern, actual) {
  const p = normalisePath(pattern).split('/');
  const a = actual.split('/');
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) { params[p[i].slice(1)] = a[i]; continue; }
    if (p[i] !== a[i]) return null;
  }
  return params;
}

/** Route `query` constraints: `"*"` means "present with any value". */
function matchQuery(constraint, actual) {
  if (!constraint) return true;
  for (const k of Object.keys(constraint)) {
    if (!(k in actual)) return false;
    if (constraint[k] !== '*' && String(constraint[k]) !== String(actual[k])) return false;
  }
  return true;
}

function isAuthenticated(hostCfg, headers) {
  const req = hostCfg.requireAuth;
  if (!req) return true;
  const got = lowerKeys(headers)[String(req.header).toLowerCase()];
  if (got === undefined) return false;
  if (req.equals !== undefined) return String(got) === String(req.equals);
  if (req.startsWith !== undefined) return String(got).startsWith(req.startsWith);
  return true;
}

/**
 * @param {object} scenario the loaded scenario.json
 * @param {object} req { method, url, headers, body }
 * @returns {{ status, headers, body, loopbackPath, denied?: true, explanation?: string }}
 */
function resolveRequest(scenario, req) {
  const method = String(req.method || 'GET').toUpperCase();
  const headers = req.headers || {};

  if (!METHOD_ALLOWLIST.has(method)) {
    return deny(405, `Method ${method} is not permitted by the simulation.`, '');
  }

  const parsed = parseUrl(req.url);
  if (!parsed.ok) return deny(400, parsed.error, '');

  const loopbackPath = `/__mock/${parsed.host}${parsed.path}${parsed.queryString}`;
  const hosts = (scenario.mockApi && scenario.mockApi.hosts) || {};
  const hostCfg = hosts[parsed.host];

  if (!hostCfg) {
    return deny(
      403,
      `This simulation has no mock API for host "${parsed.host}". `
      + `Available hosts: ${Object.keys(hosts).join(', ') || '(none)'}. `
      + 'No request leaves the sandbox.',
      loopbackPath,
    );
  }

  const authed = isAuthenticated(hostCfg, headers);
  const candidates = (hostCfg.routes || []).filter((r) => {
    if (String(r.method || 'GET').toUpperCase() !== method) return false;
    if (!matchPath(r.path, parsed.path)) return false;
    if (!matchQuery(r.query, parsed.query)) return false;
    if (r.when === 'unauthenticated' && authed) return false;
    if (r.when === 'authenticated' && !authed) return false;
    return true;
  });

  // Prefer a route that explicitly declares the current auth state, so an
  // authored 401 fixture wins over the generic 200 one.
  const route = candidates.find((r) => r.when) || candidates[0];

  if (!route) {
    if (!authed) {
      return {
        status: 401,
        headers: { 'content-type': 'application/json' },
        body: { error: 'unauthorized' },
        loopbackPath,
      };
    }
    return deny(
      404,
      `No mock route matches ${method} ${parsed.path} on ${parsed.host}.`,
      loopbackPath,
    );
  }

  const pathParams = matchPath(route.path, parsed.path) || {};
  return {
    status: route.status === undefined ? 200 : route.status,
    headers: { 'content-type': 'application/json', ...(route.headers || {}) },
    body: typeof route.body === 'function' ? route.body({ pathParams }) : route.body,
    loopbackPath,
    matchedRoute: `${method} ${route.path}`,
  };
}

function deny(status, explanation, loopbackPath) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: { error: explanation },
    loopbackPath,
    denied: true,
    explanation,
  };
}

module.exports = { resolveRequest, parseUrl, normalisePath, matchPath, METHOD_ALLOWLIST };
