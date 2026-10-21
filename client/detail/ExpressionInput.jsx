import {
  createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { cx } from '../ui/primitives.jsx';
import { Icon } from '../ui/Icon.jsx';
import { CodeField } from './CodeField.jsx';
import { ExpressionEditor } from './ExpressionEditor.jsx';
import { PATH_MIME, resolveExpression, spliceAt } from './expression.mjs';

export { PATH_MIME };

/**
 * A parameter field that is either a fixed value or an expression.
 *
 * The `=` prefix is the whole model — it is what the engine reads — and the
 * `fx` button in the corner flips it, so nobody has to know the convention to
 * switch modes. The `=` itself is not shown: an expression field looks
 * different instead (code font, tinted, its `{{ }}` spans coloured and marked
 * by what they resolve to) and shows its result underneath.
 *
 * The preview is the teaching feature, not polish: half of learning
 * expressions is seeing what they resolve to, and seeing `[undefined]` the
 * moment a path is wrong. Resolution happens against the last run's input
 * items, held client-side, so typing gives instant feedback. The engine
 * remains the authority — this preview mirrors it, never a second
 * implementation of the semantics.
 *
 * A field from the input panel goes in at the caret, by click (into the field
 * last worked in) or by dropping it where it should go. A fixed value keeps its
 * text and becomes an expression around it.
 */
export function ExpressionInput({
  value, onChange, placeholder, multiline, sampleItem, sampleIndex = 0, itemCount = 0,
  items, nodeOutputs, ariaLabel, id, label,
}) {
  const raw = value === undefined || value === null ? '' : String(value);
  const isExpression = raw.startsWith('=');
  // What the field shows: an expression without its `=`.
  const shown = isExpression ? raw.slice(1) : raw;
  const [dropping, setDropping] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const fieldRef = useRef(null);
  const pendingCaret = useRef(null);
  const worked = useRef(false);
  const droppedPath = useRef(false);
  const previewId = `${id || ariaLabel || 'expr'}-result`.replace(/\s+/g, '-');

  const resolved = useMemo(() => (isExpression
    ? resolveExpression(shown, { sampleItem, sampleIndex, itemCount, nodeOutputs })
    : null), [isExpression, shown, sampleItem, sampleIndex, itemCount, nodeOutputs]);

  const commit = (text, asExpression = isExpression) => onChange(asExpression ? `=${text}` : text);

  /**
   * Put `{{ path }}` at the caret — or at the end, if this field has not been
   * worked in yet — and make it an expression if it was not one.
   */
  const insert = (path) => {
    const el = fieldRef.current;
    const atCaret = worked.current && el;
    const next = spliceAt(
      shown,
      atCaret ? el.selectionStart : shown.length,
      atCaret ? el.selectionEnd : shown.length,
      `{{ ${path} }}`,
    );
    pendingCaret.current = next.caret;
    commit(next.text, true);
  };

  // The caret goes after what was inserted, in the element now on screen (a
  // fixed one-line field turns into the expression editor as it switches).
  // A fixed multi-line field grows with its text, like the expression editor,
  // so it never shows a scrollbar under the buttons in its corner.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (isExpression || !multiline || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [isExpression, multiline, shown]);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const el = fieldRef.current;
    if (caret === null || !el) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  });

  const targets = useContext(ExpressionTargets);
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const target = useMemo(() => ({
    insert: (path) => insertRef.current(path),
    element: () => fieldRef.current,
  }), []);
  useEffect(() => targets?.register(target), [targets, target]);

  const handleChange = (event) => {
    // A field dropped from the input panel lands where the browser puts it;
    // all that is left is to make the text an expression.
    const asExpression = isExpression || droppedPath.current;
    // A fixed field becomes the expression editor as it switches: keep the
    // caret after what was dropped.
    if (droppedPath.current && !isExpression) pendingCaret.current = event.target.selectionEnd;
    droppedPath.current = false;
    commit(event.target.value, asExpression);
  };

  const fieldProps = {
    id,
    value: shown,
    placeholder,
    'aria-label': ariaLabel,
    'aria-describedby': resolved ? previewId : undefined,
    onChange: handleChange,
    onFocus: () => { worked.current = true; targets?.focus(target); },
    onDragOver: (event) => {
      if ([...event.dataTransfer.types].includes(PATH_MIME)) setDropping(true);
    },
    onDragLeave: () => setDropping(false),
    onDrop: (event) => {
      setDropping(false);
      if (!event.dataTransfer.getData(PATH_MIME)) return;
      worked.current = true;
      droppedPath.current = true;
    },
  };

  const InputTag = multiline ? 'textarea' : 'input';

  return (
    <div className={cx('ca-expression', isExpression && 'is-expression', dropping && 'is-dropping')}>
      <div className="ca-expression-field">
        {isExpression ? (
          <CodeField
            ref={fieldRef}
            parts={resolved.parts}
            singleLine={!multiline}
            className={multiline ? 'is-multiline' : undefined}
            {...fieldProps}
          />
        ) : (
          <InputTag
            ref={fieldRef}
            className="input ca-expression-input"
            rows={multiline ? 3 : undefined}
            spellCheck={false}
            {...fieldProps}
          />
        )}
        <span className="ca-expression-actions">
          {isExpression ? (
            <button
              type="button"
              className="ca-expression-mode"
              onClick={() => setFullscreen(true)}
              aria-label="Open the expression editor"
              title="Open the expression editor — more room, every input field, the result for each item"
            >
              <Icon name="expand" size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="ca-expression-mode ca-expression-fx"
            onClick={() => commit(shown, !isExpression)}
            aria-pressed={isExpression}
            aria-label={isExpression ? 'Switch to a fixed value' : 'Switch to an expression'}
            title={isExpression
              ? 'Expression — {{ }} is worked out for each item. Click for a fixed value.'
              : 'Fixed value. Click to make it an expression.'}
          >
            <Icon name="fx" size={14} />
          </button>
        </span>
      </div>

      {resolved ? <Result id={previewId} resolved={resolved} /> : null}

      {fullscreen ? (
        <ExpressionEditor
          title={label || ariaLabel || 'Expression'}
          value={shown}
          onChange={(text) => commit(text, true)}
          onClose={() => setFullscreen(false)}
          items={items || (sampleItem ? [sampleItem] : [])}
          nodeOutputs={nodeOutputs}
        />
      ) : null}
    </div>
  );
}

/**
 * What an expression resolves to. Text that came from a `{{ }}` span is marked,
 * so in `Order {{ $json.id }} shipped` it is plain which part was worked out.
 */
export function Result({ id, resolved, className }) {
  const { parts, error, pending, display } = resolved;
  const undefinedLone = !error && !pending && display === '[undefined]';
  const mixed = !error && !pending && parts.length > 1;
  return (
    <div
      id={id}
      className={cx(
        'ca-resolved',
        'body-xxsmall',
        error && 'ca-resolved-error',
        undefinedLone && 'ca-resolved-undefined',
        pending && 'ca-resolved-pending',
        className,
      )}
      role="status"
    >
      <span className="ca-resolved-label">{error ? 'Error' : 'Result'}</span>
      <span className={cx('ca-resolved-value', !pending && !error && 'ca-mono')}>
        {mixed ? parts.map((part, index) => (part.kind === 'text'
          // eslint-disable-next-line react/no-array-index-key
          ? <span key={index}>{part.text}</span>
          : (
            <span
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              className={cx('ca-resolved-part', part.undefined && 'is-undefined')}
              title={part.source.trim()}
            >
              {part.raw === undefined || part.raw === null ? (part.undefined ? '[undefined]' : '') : part.value}
            </span>
          ))) : (error || display)}
      </span>
    </div>
  );
}

/**
 * The expression fields of one node, so a field clicked in the input panel goes
 * into the one last worked in — or, before any has been, the first on screen.
 */
export const ExpressionTargets = createContext(null);

export function useExpressionTargets() {
  return useMemo(() => {
    const all = new Set();
    let last = null;
    return {
      register(target) {
        all.add(target);
        return () => { all.delete(target); if (last === target) last = null; };
      },
      focus(target) { last = target; },
      insert(path) {
        const alive = [...all].filter((t) => t.element()?.isConnected);
        const chosen = alive.includes(last) ? last : alive.sort((a, b) => (
          // eslint-disable-next-line no-bitwise
          a.element().compareDocumentPosition(b.element()) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
        ))[0];
        chosen?.insert(path);
      },
    };
  }, []);
}
