/**
 * One-line node summaries, shared by the canvas and the STDOUT report.
 *
 * Written as ESM and consumed by the CommonJS engine via `require()` (stable in
 * Node 22.12+; this project targets Node 22+). Having a single implementation
 * matters: the summary a candidate reads on the canvas and the summary a grader
 * reads in `## WORKFLOW STRUCTURE` must never disagree, and the canvas needs it
 * synchronously as they type.
 */

const strip = (value) => (typeof value === 'string' && value.startsWith('=')
  ? value.slice(1).trim()
  : value);

const SUMMARIES = {
  webhook: (p) => `${p.method || 'POST'} /${p.path || ''}`,

  scheduleTrigger: (p) => `every ${p.value || 1} ${p.interval || 'hours'}`,

  httpRequest: (p) => `${p.method || 'GET'} ${strip(p.url) || '(no url)'}`,

  slack: (p) => `post → ${p.channel || '(no channel)'}`,

  splitOut: (p) => String(p.field || '(unset)'),

  set: (p) => (p.fields || []).map((f) => f && f.name).filter(Boolean).join(', ') || 'no fields',

  stopAndError: (p) => String(p.message || 'Workflow stopped'),

  aggregate: (p) => {
    if (p.mode === 'allItemData') return `all item data → ${p.field || 'data'}`;
    if (p.mode === 'individualFields') return (p.fields || []).join(', ') || 'no fields';
    return (p.outputs || [])
      .map((o) => `${o.op}(${o.field || ''}) → ${o.as}`)
      .join(', ') || 'no outputs';
  },

  code: (p) => {
    const lines = String(p.jsCode || '').trim().split('\n').filter((l) => l.trim());
    if (!lines.length) return 'no code yet';
    const scope = p.mode === 'runOncePerItem' ? 'per item' : 'all items';
    return `${scope} · ${lines.length} line${lines.length === 1 ? '' : 's'}`;
  },

  agent: (p) => {
    const scope = p.mode === 'runOnceForAllItems' ? 'all items' : 'per item';
    return `${p.model || '(no model)'} · ${scope}`;
  },

  agentTool: (p) => {
    const name = String(p.toolName || '').trim() || '(unnamed tool)';
    return `${name} · ${p.model || '(no model)'}`;
  },

  outputParser: (p) => {
    const fields = (p.fields || []).filter(Boolean);
    return fields.length ? `→ ${fields.join(', ')}` : 'no fields';
  },

  filter: describeConditions,
  if: describeConditions,

  switch: (p) => {
    const rules = p.rules || [];
    if (!rules.length) return 'no rules';
    const names = rules.map((r, i) => (r && r.output ? r.output : `rule ${i + 1}`));
    const fallback = p.fallback === 'extra' ? ' + fallback' : '';
    return `→ ${names.join(', ')}${fallback}`;
  },

  merge: (p) => {
    const mode = p.mode || 'append';
    if (mode === 'combineByFields') return `join on ${p.matchField || '(unset)'}`;
    if (mode === 'chooseBranch') return `wait, then use ${p.useDataOf || 'input1'}`;
    if (mode === 'combineByPosition') return 'pair by position';
    return 'append';
  },

  sort: (p) => {
    if (p.type === 'random') return 'random (seeded)';
    const fields = (p.fields || []).filter((f) => f && f.field);
    if (!fields.length) return 'no fields';
    return fields.map((f) => `${f.field} ${f.order === 'descending' ? '↓' : '↑'}`).join(', ');
  },

  limit: (p) => `${p.keep === 'lastItems' ? 'last' : 'first'} ${p.maxItems ?? 10}`,

  removeDuplicates: (p) => {
    const compare = p.compare || 'allFields';
    if (compare === 'allFields') return 'all fields';
    const fields = (p.fields || []).filter(Boolean);
    const prefix = compare === 'allFieldsExcept' ? 'all except ' : '';
    return `${prefix}${fields.join(', ') || '(no fields)'}`;
  },
};

function describeConditions(p) {
  const conditions = p.conditions || [];
  if (!conditions.length) return 'no conditions';
  const join = (p.combinator || 'and').toUpperCase();
  return conditions
    .map((c) => `${strip(c.left)} ${c.op} ${JSON.stringify(strip(c.right))}`)
    .join(` ${join} `);
}

/**
 * Fallback for any node whose behaviour is chosen by an `operation` parameter.
 *
 * That covers every integration — the built-in ones and every node a scenario
 * defines for itself, which cannot have an entry in the table above because
 * nobody has written it yet. Without this their cards are blank, and a canvas of
 * blank cards is the difference between reading a workflow and opening every node
 * to find out what it does.
 */
function describeByOperation(p, definition) {
  if (typeof p.operation !== 'string' || !p.operation) return '';

  /**
   * Only fields the form is actually SHOWING for this operation are eligible.
   *
   * Without this the card quotes a value the user cannot see: an `addComment`
   * operation would show the `status` field belonging to `listTickets`, because
   * it happens to come first. A summary that names an invisible field is worse
   * than no summary — it sends someone looking for a control that is not there.
   */
  const visible = (key) => {
    const descriptor = (definition && definition.params || []).find((d) => d.name === key);
    if (!descriptor || !descriptor.showFor) return true;
    return Object.entries(descriptor.showFor).every(([field, expected]) => (
      Array.isArray(expected) ? expected.includes(p[field]) : p[field] === expected
    ));
  };

  // The first meaningful value after the operation. `resource` is skipped: it is
  // a grouping label, not information.
  const detail = Object.entries(p).find(([key, value]) => (
    key !== 'operation' && key !== 'resource'
    && (typeof value === 'string' || typeof value === 'number')
    && String(value).trim() !== ''
    && visible(key)
  ));
  if (!detail) return p.operation;

  const text = strip(String(detail[1])).replace(/\s+/g, ' ');
  const short = text.length > 38 ? `${text.slice(0, 37)}…` : text;
  return `${p.operation} · ${short}`;
}

/**
 * @param definition  optional; supply it and the generic fallback can tell which
 *                    fields this operation actually shows.
 * @returns {string} '' when a node type has nothing worth summarising.
 */
export function summariseNode(type, parameters, definition) {
  const fn = SUMMARIES[type];
  try {
    return fn ? fn(parameters || {}) : describeByOperation(parameters || {}, definition);
  } catch {
    return '';
  }
}
