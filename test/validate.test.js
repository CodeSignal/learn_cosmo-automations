'use strict';

/**
 * Every shipped scenario must validate, and the validator must actually catch
 * things. A validator that only ever passes is worse than none — it produces
 * false confidence in exactly the place where a mistake is expensive.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validateScenario } = require('../engine/validate');

const SCENARIOS = path.join(__dirname, '..', 'scenarios');

function shipped() {
  return fs.readdirSync(SCENARIOS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, dir: path.join(SCENARIOS, d.name) }))
    .filter((s) => fs.existsSync(path.join(s.dir, 'scenario.json')));
}

const load = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

test('every shipped scenario validates, and is provably solvable', async () => {
  const all = shipped();
  assert.ok(all.length > 0, 'expected at least one scenario');

  for (const { name, dir } of all) {
    const scenario = load(dir, 'scenario.json');
    const referencePath = path.join(dir, 'reference_solution.json');
    assert.ok(fs.existsSync(referencePath),
      `${name} has no reference_solution.json, so it cannot be proved solvable`);

    const { ok, errors } = await validateScenario(scenario, {
      referenceSolution: load(dir, 'reference_solution.json'),
    });
    assert.ok(ok, `${name} does not validate:\n  ${errors.join('\n  ')}`);
  }
});

/* ── the validator has to bite ──────────────────────────────────────── */

const base = () => load(path.join(SCENARIOS, 'eu-orders'), 'scenario.json');
const reference = () => load(path.join(SCENARIOS, 'eu-orders'), 'reference_solution.json');

/** Break a copy of the good scenario and expect a specific complaint. */
async function expectError(mutate, pattern) {
  const scenario = base();
  mutate(scenario);
  const { ok, errors } = await validateScenario(scenario, { referenceSolution: reference() });
  assert.strictEqual(ok, false, `expected an error matching ${pattern}, got none`);
  assert.ok(errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got:\n  ${errors.join('\n  ')}`);
}

test('catches a typo in a node type', () => expectError(
  (s) => s.palette.include.push('spltOut'), /unknown node type "spltOut"/,
));

test('catches a palette with no trigger', () => expectError(
  (s) => { s.palette.include = s.palette.include.filter((t) => t !== 'manualTrigger' && t !== 'webhook'); },
  /offers no trigger/,
));

test('catches an assertion the palette makes unsatisfiable', () => expectError(
  (s) => { s.palette.include = s.palette.include.filter((t) => t !== 'aggregate'); },
  /impossible as authored/,
));

test('catches a host that is not a reserved TLD', () => expectError(
  (s) => { s.mockApi.hosts['api.acme.com'] = s.mockApi.hosts['api.acme-crm.test']; delete s.mockApi.hosts['api.acme-crm.test']; },
  /reserved TLD/,
));

test('catches the mechanism-assertions-plus-Code trap', () => expectError(
  (s) => s.palette.include.push('code'), /also offers the Code node/,
));

test('catches an unknown assertion type', () => expectError(
  (s) => { s.assertions[0].type = 'itemCountt'; }, /unknown type "itemCountt"/,
));

test('catches duplicate assertion ids', () => expectError(
  (s) => s.assertions.push({ ...s.assertions[0] }), /share the id/,
));

test('catches duplicate node names in the starting workflow', () => expectError(
  (s) => {
    s.initialWorkflow.nodes.push({ ...s.initialWorkflow.nodes[0], id: 'other' });
  },
  /two nodes named/,
));

test('catches a node referencing an undeclared credential', () => expectError(
  (s) => { s.initialWorkflow.nodes[0].credentialId = 'cred_nope'; },
  /undeclared credential/,
));

test('catches a cycle in the starting workflow', () => expectError(
  (s) => {
    s.initialWorkflow.nodes.push({ id: 'b', name: 'B', type: 'noOp', position: [0, 0], parameters: {} });
    s.initialWorkflow.connections = [
      { from: s.initialWorkflow.nodes[0].id, fromOutput: 0, to: 'b', toInput: 0 },
      { from: 'b', fromOutput: 0, to: s.initialWorkflow.nodes[0].id, toInput: 0 },
    ];
  },
  /cycle/,
));

/**
 * The check worth more than all the others: a scenario can be structurally
 * perfect and still not be solvable. Only running the intended answer finds it.
 */
test('catches a scenario that is structurally valid but unsolvable', () => expectError(
  (s) => { s.mockApi.hosts['api.acme-crm.test'].requireAuth.header = 'X-Nope'; },
  /not solvable as authored/,
));

test('catches an assertion that expects the wrong answer', () => expectError(
  (s) => { s.assertions.find((a) => a.id === 'keeps-three-orders').count = 4; },
  /not solvable as authored/,
));

test('warns rather than errors on things that might be deliberate', async () => {
  const scenario = base();
  delete scenario.title;
  const { ok, warnings } = await validateScenario(scenario, { referenceSolution: reference() });
  assert.strictEqual(ok, true, 'a missing title should not block a task');
  assert.ok(warnings.some((w) => /title/.test(w)));
});

/**
 * The template authors copy must itself be correct, or it teaches the mistake.
 * It already did once: it listed the Code node alongside mechanism assertions —
 * exactly the trap its own comments warn about — and the validator caught it.
 */
test('scenario.example.jsonc is a valid scenario once comments are stripped', async () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'scenario.example.jsonc'), 'utf8');
  const scenario = JSON.parse(stripJsonComments(raw));

  const { ok, errors } = await validateScenario(scenario);
  assert.ok(ok, `the template does not validate:\n  ${errors.join('\n  ')}`);
});

test('the template demonstrates every assertion type', () => {
  const { ASSERTION_FIELDS } = require('../engine/validate');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'scenario.example.jsonc'), 'utf8');
  const used = new Set(JSON.parse(stripJsonComments(raw)).assertions.map((a) => a.type));

  const missing = Object.keys(ASSERTION_FIELDS).filter((t) => !used.has(t));
  assert.deepStrictEqual(missing, [],
    'an assertion type nobody can see an example of will not get used');
});

/** Comments and trailing commas, so the template can be annotated. */
function stripJsonComments(text) {
  const out = text.split('\n').map((line) => {
    let result = '';
    let inString = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"' && line[i - 1] !== '\\') inString = !inString;
      if (!inString && line[i] === '/' && line[i + 1] === '/') break;
      result += line[i];
    }
    return result;
  }).join('\n');
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * `Item.meta` is reserved on the item type for engine-owned data (agent traces,
 * token counts): deliberately accepted, never written by candidate-facing node
 * parameters.
 */
test('Item.meta is reserved on the item type', () => {
  const { makeItem } = require('../engine/items');
  const item = makeItem({ a: 1 }, { meta: { tokens: 12 } });
  assert.deepStrictEqual(item.meta, { tokens: 12 });
  assert.deepStrictEqual(makeItem({ a: 1 }).meta, undefined, 'absent unless asked for');
});

/*
 * The scenario.ai block is live: shape-checked, never flagged as inert.
 * Behaviour lives in test/agent.test.js.
 */
test('the scenario.ai block is live and shape-checked', async () => {
  const scenario = base();
  scenario.ai = {
    mode: 'replay',
    models: ['pinned-model'],
    fixtures: [{ id: 'any', when: {}, respond: { label: 'x' } }],
  };

  const { ok, warnings } = await validateScenario(scenario, { referenceSolution: reference() });
  assert.strictEqual(ok, true, 'a well-formed ai block is valid');
  assert.ok(!warnings.some((w) => /reserved for the AI\/agent nodes/.test(w)),
    'it is no longer inert, so it must no longer say it is');

  // And it is shape-checked for real now.
  const bad = base();
  bad.ai = { mode: 'live', fixtures: [] };
  const report = await validateScenario(bad, { referenceSolution: reference() });
  assert.ok(!report.ok);
  assert.ok(report.errors.some((e) => /can only replay/.test(e)));
});

test('a malformed ai block is an error', async () => {
  await expectError((s) => { s.ai = { mode: 'nonsense' }; }, /ai\.mode must be/);
  await expectError((s) => { s.ai = []; }, /`ai` must be an object/);
});
