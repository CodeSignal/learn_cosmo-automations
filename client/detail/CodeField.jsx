import { useLayoutEffect, useRef } from 'react';
import { cx } from '../ui/primitives.jsx';
import { tokenize } from './expression.mjs';

/**
 * The text area of an expression: a plain textarea, with its text drawn again
 * underneath in colour.
 *
 * The textarea's own text is transparent and the layer behind it carries the
 * colour, at exactly the same metrics, so typing, selection, undo and native
 * drag-and-drop all stay the browser's. Each `{{ }}` span is marked by what it
 * resolved to — fine, empty or failing — so a wrong path shows where it is, not
 * only in the result line under the field.
 *
 * `parts` is the resolved split of `value` (see expression.js); it must be of
 * this exact text, or the layers drift apart.
 */
export function CodeField({
  ref, value, parts, onChange, onKeyDown, autosize = true, singleLine = false, className, ...rest
}) {
  const inputRef = useRef(null);
  const backRef = useRef(null);

  const setRef = (el) => {
    inputRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || !autosize) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border; without it the last line is clipped.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value, autosize]);

  return (
    <div className={cx('ca-code', className)}>
      <div className="ca-code-box ca-code-back ca-mono" ref={backRef} aria-hidden="true">
        {(parts || [{ kind: 'text', text: value }]).map((part, index) => (
          // eslint-disable-next-line react/no-array-index-key
          <Part part={part} key={index} />
        ))}
        {/* A trailing newline needs something after it to take up its line. */}
        {' '}
      </div>
      <textarea
        ref={setRef}
        className="ca-code-box ca-code-input ca-mono"
        value={value}
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onChange={onChange}
        onScroll={(event) => {
          if (backRef.current) backRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onKeyDown={(event) => {
          // A one-line parameter stays one line: Enter would put a newline in a URL.
          if (singleLine && event.key === 'Enter') event.preventDefault();
          onKeyDown?.(event);
        }}
        {...rest}
      />
    </div>
  );
}

function Part({ part }) {
  if (part.kind === 'text') return <span className="ca-code-text">{part.text}</span>;
  const state = part.error ? 'is-error' : (part.undefined ? 'is-undefined' : (part.value !== undefined ? 'is-ok' : ''));
  return (
    <span className={cx('ca-code-span', state, !part.closed && 'is-open')} title={part.error || part.value}>
      <span className="ca-tok-brace">{'{{'}</span>
      {tokenize(part.source).map((token, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={index} className={`ca-tok-${token.type}`}>{token.text}</span>
      ))}
      {part.closed ? <span className="ca-tok-brace">{'}}'}</span> : null}
    </span>
  );
}
