'use strict';

/**
 * The expression field's preview: how its text splits into fixed text and
 * `{{ }}` spans, how a span's code is coloured, what each span resolves to,
 * and where an inserted field goes.
 */

const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../client/detail/expression.mjs');

const ITEM = { json: { subject: 'Card declined', customer: 'Nordwind', total: 12 } };
const ctx = (extra = {}) => ({ sampleItem: ITEM, sampleIndex: 0, itemCount: 1, nodeOutputs: {}, ...extra });

test('text and spans come apart in order, and put back together exactly', async () => {
  const { splitSpans } = await load();
  const body = 'Re: {{ $json.subject }} for {{ $json.customer }}!';
  const parts = splitSpans(body);
  assert.deepStrictEqual(parts.map((p) => p.kind), ['text', 'code', 'text', 'code', 'text']);
  assert.strictEqual(parts.map((p) => p.text).join(''), body);
});

test('a span still being typed runs to the end and is marked open', async () => {
  const { splitSpans } = await load();
  const parts = splitSpans('Hi {{ $json.cust');
  assert.strictEqual(parts.length, 2);
  assert.deepStrictEqual([parts[1].closed, parts[1].text], [false, '{{ $json.cust']);
});

test('code is coloured by what each piece is, covering every character', async () => {
  const { tokenize } = await load();
  const source = " $json.subject.toUpperCase() + 'x' + 2 ";
  const tokens = tokenize(source);
  assert.strictEqual(tokens.map((t) => t.text).join(''), source);
  const typeOf = (text) => tokens.find((t) => t.text === text)?.type;
  assert.strictEqual(typeOf('$json'), 'variable');
  assert.strictEqual(typeOf('subject'), 'property');
  assert.strictEqual(typeOf('toUpperCase'), 'call');
  assert.strictEqual(typeOf("'x'"), 'string');
  assert.strictEqual(typeOf('2'), 'number');
});

test('each span carries its own result, and the text joins them', async () => {
  const { resolveExpression } = await load();
  const r = resolveExpression('{{ $json.customer }}: {{ $json.missing }}', ctx());
  const code = r.parts.filter((p) => p.kind === 'code');
  assert.deepStrictEqual(code.map((p) => p.value), ['Nordwind', '[undefined]']);
  assert.strictEqual(code[1].undefined, true);
  assert.strictEqual(r.display, 'Nordwind: ');
});

test('a lone span keeps its value, a failing one names the error', async () => {
  const { resolveExpression } = await load();
  assert.strictEqual(resolveExpression('{{ $json.total * 2 }}', ctx()).display, '24');
  const bad = resolveExpression('{{ $json.subject.nope() }}', ctx());
  assert.match(bad.error, /not a function/);
  assert.ok(bad.parts[0].error);
});

test('without input yet, $json waits for a run, but other code still resolves', async () => {
  const { resolveExpression } = await load();
  assert.strictEqual(resolveExpression('{{ $json.subject }}', ctx({ sampleItem: null })).pending, true);
  assert.strictEqual(resolveExpression('{{ 1 + 1 }}', ctx({ sampleItem: null })).display, '2');
});

test('an inserted field replaces the selection and the caret lands after it', async () => {
  const { spliceAt } = await load();
  assert.deepStrictEqual(spliceAt('Hello world', 6, 11, '{{ $json.x }}'), { text: 'Hello {{ $json.x }}', caret: 19 });
  assert.deepStrictEqual(spliceAt('abc', 99, 99, 'Z'), { text: 'abcZ', caret: 4 });
});
