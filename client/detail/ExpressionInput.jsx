import { useEffect, useId, useState } from 'react';
import { cx } from '../ui/primitives.jsx';
import { Icon } from '../ui/Icon.jsx';

/** The drag payload an input/output field carries: a path like `$json.email`. */
export const PATH_MIME = 'application/cosmo-path';

/**
 * A parameter field that is either a fixed value or an expression.
 *
 * The `=` prefix is the whole model — it is what the engine reads — and the
 * `fx` button in the corner flips it, so nobody has to know the convention to
 * switch modes. An expression field looks different (code font, tinted) and
 * shows what it resolves to underneath.
 *
 * The preview is the teaching feature, not polish: half of learning
 * expressions is seeing what they resolve to, and seeing `[undefined]` the
 * moment a path is wrong. Resolution happens against the last run's input
 * items, held client-side, so typing gives instant feedback. The engine
 * remains the authority — this preview mirrors it, never a second
 * implementation of the semantics.
 *
 * Fields from the input panel can be dropped onto it; the path is inserted as
 * `{{ $json.path }}` and the field becomes an expression.
 */
export function ExpressionInput({
  value, onChange, placeholder, multiline, sampleItem, sampleIndex = 0, itemCount = 0,
  nodeOutputs, ariaLabel, id,
}) {
  const raw = value === undefined || value === null ? '' : String(value);
  const isExpression = raw.startsWith('=');
  const [preview, setPreview] = useState(null);
  const [dropping, setDropping] = useState(false);
  const previewId = useId();

  useEffect(() => {
    if (!isExpression) { setPreview(null); return; }
    setPreview(resolvePreview(raw, { sampleItem, sampleIndex, itemCount, nodeOutputs }));
  }, [raw, isExpression, sampleItem, sampleIndex, itemCount, nodeOutputs]);

  const InputTag = multiline ? 'textarea' : 'input';

  const toggleMode = () => {
    if (isExpression) onChange(raw.slice(1));
    else onChange(`=${raw}`);
  };

  const onDrop = (event) => {
    const path = event.dataTransfer.getData(PATH_MIME);
    setDropping(false);
    if (!path) return;
    event.preventDefault();
    const snippet = `{{ ${path} }}`;
    onChange(isExpression ? `${raw}${snippet}` : `=${snippet}`);
  };

  return (
    <div className={cx('ca-expression', isExpression && 'is-expression', dropping && 'is-dropping')}>
      <div className="ca-expression-field">
        <InputTag
          id={id}
          className={cx('input', 'ca-expression-input', isExpression && 'ca-mono')}
          value={raw}
          rows={multiline ? 3 : undefined}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          aria-label={ariaLabel}
          aria-describedby={preview ? previewId : undefined}
          onDragOver={(event) => {
            if ([...event.dataTransfer.types].includes(PATH_MIME)) {
              event.preventDefault();
              setDropping(true);
            }
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        />
        <button
          type="button"
          className="ca-expression-mode"
          onClick={toggleMode}
          aria-pressed={isExpression}
          aria-label={isExpression ? 'Switch to a fixed value' : 'Switch to an expression'}
          title={isExpression
            ? 'Expression — {{ }} is evaluated for each item. Click for a fixed value.'
            : 'Fixed value. Click to make it an expression.'}
        >
          <Icon name="fx" size={14} />
        </button>
      </div>

      {preview ? (
        <div
          id={previewId}
          className={cx(
            'ca-resolved',
            'body-xxsmall',
            preview.error && 'ca-resolved-error',
            !preview.error && preview.display === '[undefined]' && 'ca-resolved-undefined',
            preview.pending && 'ca-resolved-pending',
          )}
          role="status"
        >
          <span className="ca-resolved-label">{preview.error ? 'Error' : 'Result'}</span>
          <span className={cx('ca-resolved-value', !preview.pending && 'ca-mono')}>
            {preview.error || preview.display}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Put `{{ path }}` into an expression field element, turning a fixed value into
 * an expression if it was not one already. Drives React's onChange through the
 * native setter so controlled state updates.
 */
export function insertExpression(target, path) {
  const current = target.value || '';
  const snippet = `{{ ${path} }}`;
  const next = current.startsWith('=') ? `${current}${snippet}` : `=${snippet}`;
  const setter = Object.getOwnPropertyDescriptor(
    target.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    'value',
  ).set;
  setter.call(target, next);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.focus();
}

const SPAN = /\{\{([\s\S]*?)\}\}/g;

/**
 * Client-side mirror of engine/expression.js. Kept deliberately small: it only
 * has to render a preview, and the engine's result is what grading sees.
 */
function resolvePreview(rawValue, ctx) {
  const body = rawValue.slice(1);
  const matches = [...body.matchAll(SPAN)];
  if (!matches.length) return { display: body, error: null };
  if (!ctx.sampleItem) {
    return { display: 'Execute the previous nodes to see what this resolves to', error: null, pending: true };
  }

  const scope = buildScope(ctx);
  const lone = matches.length === 1 && matches[0][0].length === body.length;
  const parts = [];
  let cursor = 0;

  for (const match of matches) {
    parts.push(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const source = match[1].trim();
    if (!source) return { display: null, error: 'Empty expression' };

    let result;
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(...Object.keys(scope), `'use strict'; return (${source});`);
      result = fn(...Object.values(scope));
    } catch (err) {
      return { display: null, error: err.message };
    }

    if (lone) return { display: display(result), error: null };
    parts.push(result === undefined || result === null ? '' : display(result));
  }
  parts.push(body.slice(cursor));
  return { display: parts.join(''), error: null };
}

function buildScope(ctx) {
  const nodeOutputs = ctx.nodeOutputs || {};
  const $node = {};
  for (const name of Object.keys(nodeOutputs)) {
    const items = nodeOutputs[name] || [];
    const at = items[ctx.sampleIndex] !== undefined ? items[ctx.sampleIndex] : items[0];
    $node[name] = { json: at ? at.json : undefined, all: items.map((i) => i.json) };
  }
  const $ = (name) => {
    const items = nodeOutputs[name] || [];
    const at = items[ctx.sampleIndex] !== undefined ? items[ctx.sampleIndex] : items[0];
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

function display(value) {
  if (value === undefined) return '[undefined]';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}
