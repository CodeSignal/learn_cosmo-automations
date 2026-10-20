'use strict';

/**
 * The `{placeholder}` template language, and nothing else.
 *
 * One feature wide on purpose. It is how a JSON-defined node puts a parameter
 * into a URL or a body, and how a credential type turns its fields into a header.
 * It is deliberately NOT the `{{ }}` expression language: expressions belong to
 * the candidate, and the engine resolves those before any node or credential runs.
 *
 * Lives here rather than in `nodes/declarative.js` because credentials need it
 * too, and a node module importing credentials while credentials imported the node
 * module was a cycle — with `fill` arriving undefined at load time.
 */

/**
 * Turn the name/value rows a `fields` parameter produces into a plain object.
 *
 * `[{name:'Region',value:'EU'}]` → `{Region:'EU'}`. Detected by shape rather than
 * declared, because that shape is the only thing a `fields` parameter can hold,
 * and making authors say so twice is a rule nobody would remember.
 */
function isFieldRows(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((row) => row && typeof row === 'object' && !Array.isArray(row) && 'name' in row);
}

function rowsToObject(rows) {
  const out = {};
  for (const row of rows || []) if (row && row.name) out[row.name] = row.value;
  return out;
}

/**
 * `{param}` alone keeps the value's type; inside a longer string it interpolates.
 *
 * @param encode  percent-encode substituted values. On for URLs, where a sheet
 *                name with a space would otherwise produce a malformed request;
 *                off for bodies, where the value is JSON and must stay itself.
 */
function fill(template, params, { encode = false } = {}) {
  if (typeof template !== 'string') return template;

  const whole = /^\{([A-Za-z_$][\w$]*)\}$/.exec(template);
  if (whole) {
    const value = params[whole[1]];
    return isFieldRows(value) ? rowsToObject(value) : value;
  }

  return template.replace(/\{([A-Za-z_$][\w$]*)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const text = String(params[name] ?? '');
    return encode ? encodeURIComponent(text) : text;
  });
}

/** Recursively fill a body/query/header template. */
function fillDeep(value, params, options) {
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, params, options));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = fillDeep(value[key], params, options);
    return out;
  }
  return fill(value, params, options);
}

module.exports = { fill, fillDeep, isFieldRows, rowsToObject };
