'use strict';

/**
 * `activity.log` — the platform's standardised view of a bespoke UI.
 *
 * Three properties matter, in this order:
 *
 *   1. NO SECRETS. The learner types a real credential value now, and a log that
 *      echoed it back would be the easiest place in the system to find one.
 *   2. The vocabulary is FIXED and documented — a log whose event types drift
 *      between releases cannot be consumed by anything downstream.
 *   3. It describes what HAPPENED, derived from what was saved, rather than what
 *      a client claimed. And it never lies about being complete.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  EVENTS, CLIENT_EVENTS, MAX_EVENTS, createActivityLog, diffGraphs, diffCredentials,
} = require('../engine/activity');

const tmpLog = () => path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'ca-activity-')), 'activity.log',
);

const readLines = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

/* ── 1. no secrets ─────────────────────────────────────────────────────── */

test('a created credential is logged by id and type, never by value', () => {
  const before = { nodes: [], connections: [], credentials: [] };
  const after = {
    nodes: [],
    connections: [],
    credentials: [{
      id: 'c1', name: 'Mine', type: 'slackApi', fields: { token: 'xoxb-SUPER-SECRET' },
    }],
  };

  const { created } = diffCredentials(before, after);
  assert.deepStrictEqual(created, [{ id: 'c1', credentialType: 'slackApi' }]);
  assert.ok(!JSON.stringify(created).includes('SUPER-SECRET'));
});

test('a full session log contains no credential value anywhere', () => {
  const file = tmpLog();
  const log = createActivityLog(file);
  const secret = 'hunter2-correcthorse';

  const before = { nodes: [], connections: [], credentials: [] };
  const after = {
    nodes: [{ id: 'n1', type: 'slack', name: 'Notify', parameters: { channel: '#ops' } }],
    connections: [],
    credentials: [{ id: 'c1', name: 'Mine', type: 'slackApi', fields: { token: secret } }],
  };

  log.record('session.start', { scenario: 'cosmo-automations', title: 'T', nodeCount: 0 });
  const delta = diffGraphs(before, after);
  log.record('workflow.edit', delta);
  for (const c of diffCredentials(before, after).created) log.record('credential.create', c);
  log.record('workflow.run', { status: 'completed', nodes: 1, errors: 0, durationMs: 12, itemsOut: 1 });

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secret), 'the log contains a credential value');
  assert.strictEqual(readLines(file).length, 4);
});

/* ── 2. the vocabulary is fixed and documented ─────────────────────────── */

test('an event type not in the vocabulary is refused', () => {
  const file = tmpLog();
  const log = createActivityLog(file);
  assert.strictEqual(log.record('something.invented', { a: 1 }), false);
  assert.strictEqual(readLines(file).length, 0);
});

test('every event type carries a description, and the docs list them all', () => {
  for (const [type, description] of Object.entries(EVENTS)) {
    assert.ok(description && description.length > 20, `${type} needs a real description`);
  }

  // The contract is a document as much as it is code: something downstream has to
  // read this log, and a vocabulary only the author knows is not a contract.
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'activity-log.md'), 'utf8');
  for (const type of Object.keys(EVENTS)) {
    assert.ok(doc.includes(`\`${type}\``), `docs/activity-log.md does not document "${type}"`);
  }
});

test('only the events the server cannot observe are client-reportable', () => {
  assert.deepStrictEqual([...CLIENT_EVENTS].sort(), ['help.open', 'node.open']);
  for (const type of CLIENT_EVENTS) {
    assert.ok(EVENTS[type], `${type} is reportable but not in the vocabulary`);
  }
});

/* ── 3. it describes what happened, and never lies ─────────────────────── */

test('every line is JSON with seq, ts and type, and seq increases', () => {
  const file = tmpLog();
  const log = createActivityLog(file);
  log.record('workflow.reset', {});
  log.record('workflow.reset', {});
  log.record('help.open', { topic: 'overview' });

  const lines = readLines(file);
  assert.deepStrictEqual(lines.map((l) => l.seq), [1, 2, 3]);
  for (const line of lines) {
    assert.ok(line.type && EVENTS[line.type]);
    assert.ok(!Number.isNaN(Date.parse(line.ts)), 'ts must be a real timestamp');
  }
});

test('moving a node is not an edit; renaming and reconfiguring are', () => {
  const base = {
    nodes: [{ id: 'n1', type: 'filter', name: 'F', parameters: { a: 1 }, position: [0, 0] }],
    connections: [],
  };
  const moved = JSON.parse(JSON.stringify(base));
  moved.nodes[0].position = [500, 500];
  assert.strictEqual(diffGraphs(base, moved), null, 'tidying the canvas is not behaviour');

  const renamed = JSON.parse(JSON.stringify(base));
  renamed.nodes[0].name = 'Keep EU';
  assert.deepStrictEqual(diffGraphs(base, renamed).renamed, ['Keep EU']);

  const configured = JSON.parse(JSON.stringify(base));
  configured.nodes[0].parameters.a = 2;
  assert.deepStrictEqual(diffGraphs(base, configured).reconfigured, ['F']);

  const credentialed = JSON.parse(JSON.stringify(base));
  credentialed.nodes[0].credentialId = 'c1';
  assert.deepStrictEqual(diffGraphs(base, credentialed).reconfigured, ['F'],
    'attaching a credential is a configuration change');
});

test('wiring and unwiring are counted', () => {
  const a = { nodes: [], connections: [{ from: 'x', to: 'y' }] };
  const b = { nodes: [], connections: [{ from: 'x', to: 'z' }, { from: 'z', to: 'y' }] };
  const delta = diffGraphs(a, b);
  assert.strictEqual(delta.connected, 2);
  assert.strictEqual(delta.disconnected, 1);
});

test('a truncated log says so rather than going quiet', () => {
  const file = tmpLog();
  const log = createActivityLog(file);
  for (let i = 0; i < MAX_EVENTS + 5; i += 1) log.record('workflow.reset', {});

  const lines = readLines(file);
  assert.strictEqual(lines.length, MAX_EVENTS + 1);
  assert.strictEqual(lines[lines.length - 1].type, 'log.truncated',
    'a log that stops silently looks like a session that stopped');
});

test('a log that cannot be written does not take the session down', () => {
  // A directory that does not exist: appendFileSync throws, and the learner's
  // task must not fail because telemetry did.
  const log = createActivityLog('/nonexistent-dir-ca/activity.log');
  assert.doesNotThrow(() => log.record('workflow.reset', {}));
});

/* ── the platform's file names ─────────────────────────────────────────── */

test('the server accepts config.json as well as scenario.json', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const CONFIG_NAMES = \['config\.json', 'scenario\.json'\]/,
    'the platform convention is config.json; ours is scenario.json; both must work');
  assert.match(src, /ACTIVITY_PATH/, 'activity.log must live in the session filesystem');
});
