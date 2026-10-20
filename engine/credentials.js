'use strict';

const { fill } = require('./template');

/**
 * Credentials.
 *
 * WHO OWNS WHAT
 *
 * The scenario declares credential TYPES — what a Slack credential is called,
 * which fields it has, and how those fields become an HTTP header. It does not
 * declare credential INSTANCES: the candidate creates those, types the secret in,
 * and attaches one to a node. That is the change from the first cut, where a
 * ready-made credential sat in a dropdown with one obvious answer.
 *
 * It matters because picking the only item in a list tests nothing. Creating a
 * credential tests three things a person actually has to know: which credential
 * type a given node needs, that the secret goes in a specific named field, and
 * what a 401 means when they get it wrong. All three are the daily reality of
 * wiring up an automation, and all three were previously done for them.
 *
 * WHERE THE SECRET LIVES
 *
 * In the candidate's `solution.json`, alongside their nodes — it is their work.
 * The expected value stays in `mockApi.hosts[…].requireAuth`, server-side, which
 * is what makes a wrong value a real 401 rather than a hint. Neither is ever sent
 * to the browser as a whole, and `grading/format.js` redacts both from STDOUT.
 *
 * WHY `auth` IS A TEMPLATE
 *
 * There used to be two hardcoded kinds, `httpHeaderAuth` and `bearerAuth`, and a
 * switch statement mapping each to a header. A bearer token IS a header with a
 * prefix, so that switch was two cases of one idea. Expressed as data, a scenario
 * can describe an API-key header, a bearer token, or a service that wants two
 * headers at once, without anybody editing the engine.
 */

/** The default type list, so a scenario that declares none still works sensibly. */
const BUILT_IN_TYPES = {
  httpHeaderAuth: {
    name: 'httpHeaderAuth',
    label: 'Header Auth',
    auth: [{ in: 'header', name: '{name}', value: '{value}' }],
    fields: [
      { name: 'name', label: 'Header Name', type: 'string', placeholder: 'X-Api-Key' },
      { name: 'value', label: 'Header Value', type: 'password' },
    ],
  },
  bearerAuth: {
    name: 'bearerAuth',
    label: 'Bearer Token',
    auth: [{ in: 'header', name: 'Authorization', value: 'Bearer {token}' }],
    fields: [
      { name: 'token', label: 'Token', type: 'password' },
    ],
  },
};

/** name -> type definition, scenario types winning over the built-in two. */
function credentialTypes(scenario) {
  const types = new Map(Object.entries(BUILT_IN_TYPES));
  for (const type of (scenario && scenario.credentialTypes) || []) {
    if (type && typeof type.name === 'string' && type.name) types.set(type.name, type);
  }
  return types;
}

/**
 * The credentials the candidate created, from their own graph.
 *
 * A scenario may still ship `credentials` — a task that is not ABOUT credentials
 * can hand them over rather than making every candidate retype a token to reach
 * the part being taught. The candidate's own always wins on an id clash.
 */
function credentialsFor(scenario, graph) {
  const map = new Map();
  for (const c of (scenario && scenario.credentials) || []) if (c && c.id) map.set(c.id, c);
  for (const c of (graph && graph.credentials) || []) if (c && c.id) map.set(c.id, c);
  return map;
}

/**
 * Apply a credential to a request's headers.
 *
 * An unknown type, or a credential whose fields are blank, applies nothing — and
 * the service answers 401, which is the feedback that teaches. Throwing here would
 * replace a lesson with a stack trace.
 */
function applyCredential(credential, types, headers = {}) {
  if (!credential) return headers;
  const type = types.get(credential.type);
  if (!type) return headers;

  const fields = credential.fields || {};
  const out = { ...headers };

  for (const rule of type.auth || []) {
    if (!rule || rule.in !== 'header') continue;

    /**
     * Every field the rule mentions has to be filled in, or the rule contributes
     * nothing. A half-formed header — `Authorization: Bearer ` from an empty
     * token, or literally `Bearer {token}` from a missing one — is worse than no
     * header: the service rejects it in a way that looks like a bug in the
     * simulation rather than a field the candidate left blank. No header at all
     * produces the same 401 for a reason they can act on.
     */
    const referenced = [...String(`${rule.name} ${rule.value}`).matchAll(/\{([A-Za-z_$][\w$]*)\}/g)]
      .map((m) => m[1]);
    const complete = referenced.every((field) => {
      const value = fields[field];
      return value !== undefined && value !== null && String(value).trim() !== '';
    });
    if (!complete) continue;

    const name = String(fill(rule.name, fields) ?? '').trim();
    const value = fill(rule.value, fields);
    if (!name || value === undefined || value === null || String(value).trim() === '') continue;

    out[name] = String(value);
  }
  return out;
}

/** Every secret this run could expose, so STDOUT can redact all of them. */
function secretsIn(scenario, graph) {
  const secrets = new Set();

  const add = (value) => {
    if (typeof value === 'string' && value.trim().length >= 4) secrets.add(value);
  };

  for (const credential of credentialsFor(scenario, graph).values()) {
    for (const value of Object.values(credential.fields || {})) add(value);
  }
  // The expected values too: a report that echoed one back would hand over the
  // answer to anybody reading a failed submission.
  for (const host of Object.values((scenario && scenario.mockApi && scenario.mockApi.hosts) || {})) {
    if (host && host.requireAuth) add(host.requireAuth.equals);
  }
  return secrets;
}

module.exports = {
  BUILT_IN_TYPES, credentialTypes, credentialsFor, applyCredential, secretsIn,
};
