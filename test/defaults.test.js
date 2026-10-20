'use strict';

/**
 * Node defaults must not leak a task's answer.
 *
 * A default URL, channel or field name that happens to be the one the task
 * expects hands the candidate a free pass. This suite derives the forbidden
 * strings from every shipped scenario — hosts, credential names, expected sink
 * payloads, assertion literals — and asserts that no node default contains any
 * of them. Add a scenario and it is covered automatically.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { allNodes, paletteFor } = require('../engine');
const { answerStrings } = require('../engine/validate');
const { NODE_DOCS } = require('../shared/node-docs.mjs');

const SCENARIOS_DIR = path.join(__dirname, '..', 'scenarios');

function loadScenarios() {
  return fs.readdirSync(SCENARIOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(SCENARIOS_DIR, d.name, 'scenario.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ name: path.basename(path.dirname(f)), scenario: JSON.parse(fs.readFileSync(f, 'utf8')) }));
}

/** Every string a candidate would otherwise have to work out for themselves. */
/**
 * What this scenario treats as the answer.
 *
 * Delegates to the validator rather than keeping a second copy. There WAS a
 * second copy, and the two drifted the moment one of them learned that `$json.`
 * is expression syntax rather than a giveaway: the validator stopped reporting
 * it and this test carried on, so the same scenario passed `npm run validate`
 * and failed `npm test`.
 */
function secretsOf(scenario) {
  return answerStrings(scenario);
}

function collectStrings(value, into) {
  if (typeof value === 'string') { into.add(value); return; }
  if (Array.isArray(value)) { value.forEach((v) => collectStrings(v, into)); return; }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectStrings(v, into));
  }
}

function flattenDefaults(defaults) {
  const out = [];
  const walk = (value, at) => {
    if (typeof value === 'string') { out.push({ at, value }); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${at}[${i}]`)); return; }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([k, v]) => walk(v, at ? `${at}.${k}` : k));
    }
  };
  walk(defaults, '');
  return out;
}

test('no node default contains a string any scenario treats as the answer', () => {
  const scenarios = loadScenarios();
  assert.ok(scenarios.length > 0, 'expected at least one scenario to check against');

  const offences = [];
  for (const { name, scenario } of scenarios) {
    const secrets = secretsOf(scenario);
    for (const node of allNodes()) {
      for (const { at, value } of flattenDefaults(node.defaults || {})) {
        for (const secret of secrets) {
          if (value.includes(secret)) {
            offences.push(`${node.type}.${at} = ${JSON.stringify(value)} leaks "${secret}" from ${name}`);
          }
        }
      }
    }
  }
  assert.deepStrictEqual(offences, []);
});

test('placeholders do not leak the answer either', () => {
  const scenarios = loadScenarios();
  const offences = [];
  for (const { name, scenario } of scenarios) {
    const secrets = secretsOf(scenario);
    for (const node of allNodes()) {
      for (const param of node.params || []) {
        const text = `${param.placeholder || ''} ${param.hint || ''}`;
        for (const secret of secrets) {
          if (text.includes(secret)) {
            offences.push(`${node.type}.${param.name} placeholder/hint leaks "${secret}" from ${name}`);
          }
        }
      }
    }
  }
  assert.deepStrictEqual(offences, []);
});

test('a scenario can still deliberately pre-fill defaults', () => {
  const palette = paletteFor({
    palette: {
      include: ['httpRequest'],
      defaults: { httpRequest: { url: 'https://api.acme-crm.test/v1/' } },
    },
  });
  assert.strictEqual(palette.length, 1);
  assert.strictEqual(palette[0].defaults.url, 'https://api.acme-crm.test/v1/');
  // The override must not wipe the other defaults.
  assert.strictEqual(palette[0].defaults.method, 'GET');
});

test('overriding defaults never mutates the shared node definition', () => {
  paletteFor({
    palette: { include: ['slack'], defaults: { slack: { channel: '#leaked' } } },
  });
  const fresh = paletteFor({ palette: { include: ['slack'] } });
  assert.strictEqual(fresh[0].defaults.channel, '', 'the registry was mutated by an override');
});

/**
 * Docs resolve the way the palette resolves them: a JSON-defined node carries its
 * own page, a coded one looks its up in NODE_DOCS. Checking only NODE_DOCS would
 * report the whole library as undocumented while the help panel showed full pages.
 */
const docsFor = (node) => node.docs || NODE_DOCS[node.type];

test('every palette node ships documentation, and it is complete enough to be useful', () => {
  const missing = [];
  for (const node of allNodes()) {
    const docs = docsFor(node);
    if (!docs) { missing.push(`${node.type}: no docs`); continue; }
    if (!docs.summary || docs.summary.length < 40) missing.push(`${node.type}: summary too thin`);
    if (!docs.mode) missing.push(`${node.type}: no mode explanation`);
    if (!docs.when) missing.push(`${node.type}: no guidance on when to use it`);
  }
  assert.deepStrictEqual(missing, []);
});

test('docs cross-references point at nodes that exist', () => {
  const nodes = allNodes();
  const types = new Set(nodes.map((n) => n.type));
  const broken = [];

  // Both sources: NODE_DOCS for the coded nodes, and each library node's own page.
  const entries = [
    ...Object.entries(NODE_DOCS),
    ...nodes.filter((n) => n.docs).map((n) => [n.type, n.docs]),
  ];

  for (const [type, docs] of entries) {
    if (!types.has(type)) broken.push(`docs for unknown node "${type}"`);
    for (const ref of docs.seeAlso || []) {
      if (!types.has(ref)) broken.push(`${type} seeAlso → unknown "${ref}"`);
    }
    for (const param of docs.params || []) {
      const node = nodes.find((n) => n.type === type);
      if (node && !(node.params || []).some((p) => p.name === param.name)) {
        broken.push(`${type} documents unknown parameter "${param.name}"`);
      }
    }
  }
  assert.deepStrictEqual(broken, []);
});

test('the palette carries docs through to the client', () => {
  const palette = paletteFor({ palette: { include: ['splitOut'] } });
  assert.ok(palette[0].docs, 'docs missing from the palette payload');
  assert.match(palette[0].docs.summary, /list/i);
});

/**
 * Palette / assertion consistency.
 *
 * Found by adding the Code node to a scenario: a legitimate Code-based solution
 * produced the exactly-correct Slack payload and was REJECTED, because three
 * assertions name the mechanism (a Filter must exist, an Aggregate must run)
 * rather than the outcome. Widening a palette can silently invalidate an
 * assertion set, and the failure direction is the dangerous one — a right answer
 * marked wrong.
 */

test('every node type an assertion requires is actually offered in the palette', () => {
  const offences = [];
  for (const { name, scenario } of loadScenarios()) {
    const offered = new Set(paletteFor(scenario).map((n) => n.type));

    for (const a of scenario.assertions || []) {
      const spec = a.nodeType || a.fromType || a.toType;
      if (!spec) continue;
      // `filter|if` is satisfied by either, so only flag it when NONE is offered.
      const alternatives = String(spec).split('|').map((t) => t.trim());
      if (!alternatives.some((t) => offered.has(t))) {
        offences.push(`${name}/${a.id}: requires ${spec}, none of which is in the palette`);
      }
    }
  }
  assert.deepStrictEqual(offences, [],
    'an assertion requiring a node the candidate cannot add makes the task impossible');
});

test('a scenario with mechanism-based assertions does not also offer Code', () => {
  // Not a general rule — an outcome-based scenario may offer Code freely. This
  // guards the specific trap: mechanism assertions plus a general-purpose escape
  // hatch invites a solution the grader then rejects.
  const mechanismTypes = ['aggregate', 'splitOut', 'filter', 'if', 'set'];

  for (const { name, scenario } of loadScenarios()) {
    const offered = new Set(paletteFor(scenario).map((n) => n.type));
    if (!offered.has('code')) continue;

    const mechanism = (scenario.assertions || []).filter((a) => {
      const spec = String(a.nodeType || '');
      return spec && spec.split('|').some((t) => mechanismTypes.includes(t.trim()));
    });

    assert.strictEqual(mechanism.length, 0,
      `${name} asserts on specific node types (${mechanism.map((a) => a.id).join(', ')}) `
      + 'but also offers the Code node, which can satisfy the task without them. Either '
      + 'drop Code from the palette, or restate those assertions as outcomes '
      + '(sinkPayloadMatches / httpCalled / itemCount on the sink).');
  }
});
