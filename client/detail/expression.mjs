/**
 * What an expression field shows: its text split into fixed text and `{{ }}`
 * spans, each span's code split into tokens to colour, and what each span
 * resolves to against a sample item.
 *
 * Client-side mirror of engine/expression.js. Kept deliberately small: it only
 * has to render a preview, and the engine's result is what grading sees.
 */

/** The drag payload an input/output field carries: a path like `$json.email`. */
export const PATH_MIME = 'application/cosmo-path';

const SPAN = /\{\{([\s\S]*?)(\}\}|$)/g;

/**
 * The body of an expression (without its `=`) as parts in order: fixed text,
 * and code spans with their `{{ … }}` source. A `{{` with no `}}` yet is an
 * open span running to the end, so it is marked while it is being typed.
 */
export function splitSpans(body) {
  const parts = [];
  let cursor = 0;
  for (const match of body.matchAll(SPAN)) {
    if (match.index > cursor) parts.push({ kind: 'text', text: body.slice(cursor, match.index) });
    parts.push({
      kind: 'code', text: match[0], source: match[1], closed: match[2] === '}}',
    });
    cursor = match.index + match[0].length;
    if (!match[0].length) break;
  }
  if (cursor < body.length) parts.push({ kind: 'text', text: body.slice(cursor) });
  return parts;
}

const TOKEN = new RegExp([
  /(?<string>'(?:\\.|[^'\\])*'?|"(?:\\.|[^"\\])*"?|`(?:\\.|[^`\\])*`?)/.source,
  /(?<variable>\$[A-Za-z_]\w*|\$(?=\s*\())/.source,
  /(?<number>\b\d+(?:\.\d+)?\b)/.source,
  /(?<literal>\b(?:true|false|null|undefined)\b)/.source,
  /(?<call>[A-Za-z_]\w*(?=\s*\())/.source,
  /(?<property>(?<=\.)[A-Za-z_]\w*)/.source,
  /(?<name>[A-Za-z_]\w*)/.source,
  /(?<space>\s+)/.source,
  /(?<punct>[\s\S])/.source,
].join('|'), 'g');

/** The code inside one `{{ }}` as tokens: `{ type, text }`, covering every character. */
export function tokenize(source) {
  const tokens = [];
  for (const match of source.matchAll(TOKEN)) {
    const type = Object.keys(match.groups).find((k) => match.groups[k] !== undefined);
    const last = tokens[tokens.length - 1];
    // Runs of punctuation and names read as one token; fewer elements to draw.
    if (last && last.type === type && (type === 'punct' || type === 'space')) last.text += match[0];
    else tokens.push({ type, text: match[0] });
  }
  return tokens;
}

/**
 * Resolve every span of `body` against `ctx`: `{ parts, display, error,
 * pending }`. Each code part gains `value` (a display string), `error` or
 * `undefined: true`, so the editor can mark spans and the result can show
 * which text came from code.
 */
export function resolveExpression(body, ctx) {
  const parts = splitSpans(body);
  const code = parts.filter((p) => p.kind === 'code');
  if (!code.length) return { parts, display: body, error: null };

  const scope = buildScope(ctx);
  const lone = parts.length === 1;
  let firstError = null;
  let missingInput = false;

  for (const part of code) {
    const source = part.source.trim();
    if (!part.closed) { part.error = 'Close it with }}'; firstError = firstError || part.error; continue; }
    if (!source) { part.error = 'Empty expression'; firstError = firstError || part.error; continue; }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(...Object.keys(scope), `'use strict'; return (${source});`);
      const result = fn(...Object.values(scope));
      part.raw = result;
      part.value = display(result);
      part.undefined = result === undefined;
    } catch (err) {
      // Without an input item, `$json.x` throws or reads nothing: that is not
      // the expression's fault, the input just is not there yet.
      if (!ctx.sampleItem && /\$json/.test(source)) { missingInput = true; continue; }
      part.error = err.message;
      firstError = firstError || err.message;
    }
    if (!ctx.sampleItem && part.undefined && /\$json/.test(source)) missingInput = true;
  }

  if (firstError) return { parts, display: null, error: firstError };
  if (missingInput) {
    return { parts, display: 'Execute the previous nodes to see what this resolves to', error: null, pending: true };
  }
  if (lone) return { parts, display: code[0].value, error: null };
  const text = parts.map((p) => {
    if (p.kind === 'text') return p.text;
    return p.raw === undefined || p.raw === null ? '' : p.value;
  }).join('');
  return { parts, display: text, error: null };
}

function buildScope(ctx) {
  const nodeOutputs = ctx.nodeOutputs || {};
  const pick = (items) => (items[ctx.sampleIndex] !== undefined ? items[ctx.sampleIndex] : items[0]);
  const $node = {};
  for (const name of Object.keys(nodeOutputs)) {
    const items = nodeOutputs[name] || [];
    const at = pick(items);
    $node[name] = { json: at ? at.json : undefined, all: items.map((i) => i.json) };
  }
  const $ = (name) => {
    const items = nodeOutputs[name] || [];
    const at = pick(items);
    return {
      item: at ? { json: at.json } : undefined,
      first: () => (items[0] ? { json: items[0].json } : undefined),
      last: () => (items.length ? { json: items[items.length - 1].json } : undefined),
      all: () => items.map((i) => ({ json: i.json })),
    };
  };
  return {
    $json: ctx.sampleItem ? ctx.sampleItem.json : undefined,
    $node,
    $,
    $itemIndex: ctx.sampleIndex,
    $items: () => new Array(ctx.itemCount).fill(null).map((_, i) => ({ json: {}, index: i })),
    $now: new Date().toISOString(),
    $today: new Date().toISOString().slice(0, 10),
    $vars: {},
    $env: {},
  };
}

export function display(value) {
  if (value === undefined) return '[undefined]';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/**
 * `text` with `snippet` put in place of the selection `start`–`end`, and where
 * the caret goes after it.
 */
export function spliceAt(text, start, end, snippet) {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: text.slice(0, from) + snippet + text.slice(to), caret: from + snippet.length };
}
