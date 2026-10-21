import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../ui/Modal.jsx';
import { Button, IconButton } from '../ui/primitives.jsx';
import { Icon } from '../ui/Icon.jsx';
import { CodeField } from './CodeField.jsx';
import { ItemPanel } from './ItemPanel.jsx';
import { Result } from './ExpressionInput.jsx';
import { resolveExpression, spliceAt } from './expression.mjs';

/**
 * The expression editor, full screen: the input fields on the left, the
 * expression in the middle with what it can use, and on the right what it
 * resolves to — for any item, not only the first, since an expression that is
 * right for item 1 and `[undefined]` for item 4 is the usual surprise.
 *
 * It edits the field it was opened from, live: there is nothing to apply, and
 * closing it leaves the expression as it is.
 */
export function ExpressionEditor({
  title, value, onChange, onClose, items, nodeOutputs,
}) {
  const [index, setIndex] = useState(0);
  const editorRef = useRef(null);
  const pendingCaret = useRef(null);
  const count = items.length;
  const at = Math.min(index, Math.max(count - 1, 0));

  const resolved = useMemo(() => resolveExpression(value, {
    sampleItem: items[at] || null, sampleIndex: at, itemCount: count, nodeOutputs,
  }), [value, items, at, count, nodeOutputs]);

  // Opened: the caret starts at the end of the expression.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el || pendingCaret.current === null) return;
    el.focus();
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  /**
   * Put `code` at the caret. Outside a `{{ }}` span it gets one of its own, so
   * a reference or function can be clicked in anywhere and still be code.
   */
  const insert = (code) => {
    const el = editorRef.current;
    const start = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const before = value.slice(0, start);
    const insideSpan = before.lastIndexOf('{{') > before.lastIndexOf('}}');
    const next = spliceAt(value, start, end, insideSpan ? code : `{{ ${code} }}`);
    pendingCaret.current = next.caret;
    onChange(next.text);
  };

  const earlier = Object.keys(nodeOutputs || {});

  return (
    <Modal open onClose={onClose} title={`Edit expression · ${title}`} size="xlarge" layout="full">
      <div className="ca-xed">
        <div role="group" className="ca-xed-col ca-xed-input" aria-label="Input fields">
          <ItemPanel
            side="input"
            title={count > 1 ? `Input · item ${at + 1}` : 'Input'}
            items={items[at] ? [items[at]] : []}
            onInsertPath={(path) => insert(path)}
            listHint={false}
            empty={{
              title: 'No input data yet',
              text: 'Execute the previous nodes to see the fields you can use here.',
            }}
          />
        </div>

        <div role="group" className="ca-xed-col ca-xed-main" aria-label="Expression">
          <div className="ca-xed-head">
            <span className="ca-xed-title body-xsmall">Expression</span>
            <span className="ca-xed-hint body-xxsmall">
              {'Text with '}
              <code className="ca-mono">{'{{ }}'}</code>
              {' spans, worked out for each item'}
            </span>
          </div>
          <CodeField
            ref={editorRef}
            className="ca-xed-editor"
            autosize={false}
            parts={resolved.parts}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={`${title} expression`}
            placeholder="{{ $json.field }}"
          />

          <div className="ca-xed-ref">
            <RefGroup title="Data" onInsert={insert} entries={[
              { code: '$json', text: 'the item being processed' },
              { code: '$itemIndex', text: 'its position, from 0' },
              ...earlier.slice(0, 6).map((name) => ({
                code: `$('${name.replace(/'/g, "\\'")}').item.json`,
                text: `the matching item from "${name}"`,
              })),
              { code: '$now', text: 'the current time, ISO 8601' },
              { code: '$today', text: 'today\'s date' },
            ]} />
            <RefGroup title="Functions" onInsert={insert} functions entries={[
              { code: '.toUpperCase()', text: 'text in capitals' },
              { code: '.toLowerCase()', text: 'text in lower case' },
              { code: '.trim()', text: 'without surrounding spaces' },
              { code: '.includes(\'\')', text: 'whether it contains a text' },
              { code: '.split(\',\')', text: 'text into a list' },
              { code: '.join(\', \')', text: 'a list into text' },
              { code: '.length', text: 'how long a text or list is' },
              { code: '.toFixed(2)', text: 'a number with 2 decimals' },
              { code: 'Math.round()', text: 'the nearest whole number' },
              { code: 'JSON.stringify()', text: 'any value as JSON text' },
            ]} />
          </div>
        </div>

        <div role="group" className="ca-xed-col ca-xed-result" aria-label="Result">
          <div className="ca-xed-head">
            <span className="ca-xed-title body-xsmall">Result</span>
            {count > 1 ? (
              <span className="ca-xed-step">
                <IconButton label="Previous item" size="small" disabled={at === 0} onClick={() => setIndex(at - 1)}>
                  <Icon name="chevron-left" size={14} />
                </IconButton>
                <span className="body-xxsmall">{`Item ${at + 1} of ${count}`}</span>
                <IconButton label="Next item" size="small" disabled={at >= count - 1} onClick={() => setIndex(at + 1)}>
                  <Icon name="chevron-right" size={14} />
                </IconButton>
              </span>
            ) : null}
          </div>
          <Result resolved={resolved} className="ca-xed-resolved" />
          {resolved.parts.some((p) => p.kind === 'code') ? (
            <ol className="ca-xed-spans">
              {resolved.parts.filter((p) => p.kind === 'code').map((part, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={i} className="ca-xed-span body-xxsmall">
                  <code className="ca-mono ca-xed-span-code">{part.source.trim() || '(empty)'}</code>
                  <span className={`ca-mono ca-xed-span-value${part.error ? ' is-error' : ''}${part.undefined ? ' is-undefined' : ''}`}>
                    {part.error || (part.value !== undefined ? part.value : '—')}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          <div className="ca-xed-foot">
            <Button variant="primary" size="xsmall" onClick={onClose}>Done</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RefGroup({ title, entries, onInsert, functions }) {
  return (
    <div className="ca-xed-ref-group">
      <span className="ca-xed-ref-title body-xxsmall">{title}</span>
      <div className="ca-xed-ref-list">
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.code}
            className={`ca-xed-chip${functions ? ' is-function' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onInsert(entry.code)}
            title={`Insert ${entry.code} — ${entry.text}`}
          >
            <code className="ca-mono">{entry.code}</code>
            <span className="body-xxsmall">{entry.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
