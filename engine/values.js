'use strict';

/**
 * Value plumbing shared by the nodes: reading and writing dotted paths, and
 * comparing two values the way a candidate expects.
 *
 * Extracted here when Sort and Merge needed both — a node file importing
 * another node file works, but it makes the import graph say something untrue
 * about which node depends on which. Nothing in this module knows what a node
 * is.
 */

/** Read a dotted path out of an object: 'a.b[0].c' */
function getPath(obj, path) {
  if (!path) return undefined;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function numeric(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined || v === '') return NaN;
  return Number(v);
}

/**
 * Numeric where both sides are numeric, string otherwise. Undefined never equals
 * anything — a condition on a field that does not exist must not match.
 *
 * Returns -1 / 0 / 1, or NaN when the two are not comparable, so the same
 * function serves both the comparison operators and Sort's ordering.
 */
function looseCompare(l, r) {
  if (l === undefined || r === undefined) return l === r ? 0 : NaN;
  const ln = numeric(l);
  const rn = numeric(r);
  if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln === rn ? 0 : (ln < rn ? -1 : 1);
  const ls = String(l);
  const rs = String(r);
  return ls === rs ? 0 : (ls < rs ? -1 : 1);
}

module.exports = { getPath, setPath, numeric, looseCompare };
