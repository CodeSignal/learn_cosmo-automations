import { useState } from 'react';
import { Button, Segmented } from '../ui/primitives.jsx';
import { Icon } from '../ui/Icon.jsx';
import { PATH_MIME } from './ExpressionInput.jsx';

/**
 * Input / output item panel, in three views.
 *
 *  · Schema — every leaf path of the first item, with its type and value.
 *    Clicking one inserts it into the focused expression field and dragging
 *    one drops it onto any field — that is what makes "discover a field path,
 *    then write an expression against it" possible without documentation.
 *  · Table  — every item as a row, top-level fields as columns, in the design
 *    system's table. The quickest way to compare items.
 *  · JSON   — the raw payload of every item.
 */
export function ItemPanel({
  side, title, items, empty, onInsertPath, error, note, listHint = true,
}) {
  const [view, setView] = useState('schema');
  const list = items || [];

  return (
    <div className={`ca-pane ca-pane-${side}`}>
      <div className="ca-pane-head">
        <span className="ca-pane-title body-xsmall">{title}</span>
        {list.length ? (
          <span className="ca-pane-count body-xxsmall">
            {`${list.length} ${list.length === 1 ? 'item' : 'items'}`}
          </span>
        ) : null}

        {list.length ? (
          <div className="ca-pane-head-end">
            <Segmented
              value={view}
              onChange={setView}
              label={`${title} view`}
              options={[
                { value: 'schema', label: 'Schema' },
                { value: 'table', label: 'Table' },
                { value: 'json', label: 'JSON' },
              ]}
            />
          </div>
        ) : null}
      </div>

      {note ? <p className="ca-pane-note body-xxsmall">{note}</p> : null}

      <div className="ca-pane-scroll">
        {error ? (
          <div className="ca-alert ca-alert-error body-xsmall" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        ) : null}

        {list.length === 0 ? (
          error ? null : <EmptyState {...empty} />
        ) : null}

        {list.length && view === 'schema' ? (
          <SchemaView items={list} onInsertPath={onInsertPath} draggable={side === 'input'} listHint={listHint} />
        ) : null}
        {list.length && view === 'table' ? <TableView items={list} /> : null}
        {list.length && view === 'json' ? <JsonView items={list} /> : null}
      </div>
    </div>
  );
}

function EmptyState({ title, text, action }) {
  return (
    <div className="ca-pane-empty-state">
      {title ? <p className="ca-pane-empty-title body-small">{title}</p> : null}
      {text ? <p className="ca-pane-empty-text body-xsmall">{text}</p> : null}
      {action ? (
        <Button variant="secondary" size="xsmall" onClick={action.onClick}>
          <Icon name="play" size={12} />
          <span>{action.label}</span>
        </Button>
      ) : null}
    </div>
  );
}

function SchemaView({ items, onInsertPath, draggable, listHint }) {
  const leaves = collectLeaves(items[0] ? items[0].json : {});
  const list = draggable && listHint && items.length === 1 ? listInside(items[0].json) : null;

  return (
    <div className="ca-schema">
      {/*
        On the input side, say what `$json` is. The paths below are written as
        `$json.…`, and without this it is not obvious that `$json` means the one
        item the node is working on — each of them in turn, not all of them.
      */}
      <p className="ca-schema-caption body-xxsmall">
        {draggable
          ? (items.length > 1
            ? `$json is the item being processed · fields of item 1 of ${items.length}`
            : '$json is this item · fields')
          : (items.length > 1 ? `Fields of item 1 of ${items.length}` : 'Fields')}
        {draggable && onInsertPath ? ' · click to insert, or drag onto a field' : ''}
      </p>
      {/*
        One item holding a list is the usual first stumble: the schema shows the
        list's first entry as `list[0].field`, and dragging that inserts a path
        that reads the first entry for ever. Say so, and name the fix.
      */}
      {list ? (
        <p className="ca-schema-hint body-xxsmall">
          {`This is one item holding a list: ${list.field} has ${list.length} ${list.length === 1 ? 'entry' : 'entries'}. `}
          {`A path like ${list.field}[0]${list.example ? `.${list.example}` : ''} always reads the first entry. `}
          {`To handle each entry on its own, add a Split Out node on ${list.field} before this one: `}
          {`every entry becomes its own item, and $json${list.example ? `.${list.example}` : ''} reads the current one.`}
        </p>
      ) : null}
      {leaves.length === 0 ? (
        <p className="ca-pane-empty body-xxsmall">This item has no fields.</p>
      ) : leaves.map((leaf) => {
        const path = `$json.${leaf.path}`;
        const Tag = onInsertPath ? 'button' : 'div';
        return (
          <Tag
            type={onInsertPath ? 'button' : undefined}
            className={`ca-schema-row${onInsertPath ? ' is-interactive' : ''}`}
            key={leaf.path}
            onClick={onInsertPath ? () => onInsertPath(path) : undefined}
            draggable={draggable || undefined}
            onDragStart={draggable ? (event) => {
              event.dataTransfer.setData(PATH_MIME, path);
              event.dataTransfer.setData('text/plain', `{{ ${path} }}`);
              event.dataTransfer.effectAllowed = 'copy';
            } : undefined}
            title={onInsertPath
              ? `Insert {{ ${path} }}${/\[\d+\]/.test(leaf.path) ? ' — reads only that one entry of the list' : ''}`
              : leaf.path}
          >
            <span className={`ca-schema-type ca-schema-type-${leaf.kind} ca-mono`} aria-label={leaf.type}>
              {TYPE_MARK[leaf.kind] || '·'}
            </span>
            <span className="ca-schema-path ca-mono body-xxsmall">{leaf.path}</span>
            <span className="ca-schema-value ca-mono body-xxsmall">{leaf.preview}</span>
          </Tag>
        );
      })}
    </div>
  );
}

/** The design system's table: one row per item, top-level fields as columns. */
function TableView({ items }) {
  const columns = [];
  for (const item of items) {
    for (const key of Object.keys(item.json || {})) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  return (
    <div className="table-scroll ca-table">
      <table className="table body-xxsmall">
        <thead>
          <tr>
            <th className="ca-table-index">#</th>
            {columns.map((column) => <th key={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={index}>
              <td className="ca-table-index">{index + 1}</td>
              {columns.map((column) => (
                <td key={column} className="ca-mono" title={cellTitle(item.json?.[column])}>
                  {cell(item.json?.[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonView({ items }) {
  return items.map((item, index) => (
    // eslint-disable-next-line react/no-array-index-key
    <div className="ca-item" key={index}>
      <div className="ca-item-head body-xxsmall">{`Item ${index + 1}`}</div>
      <pre className="ca-json body-xxsmall">{JSON.stringify(item.json, null, 2)}</pre>
    </div>
  ));
}

/**
 * The first top-level field holding a list of objects, with a field name from
 * its first entry to use in an example — or null.
 */
function listInside(json) {
  if (!json || typeof json !== 'object') return null;
  for (const [field, value] of Object.entries(json)) {
    if (Array.isArray(value) && value.length && value[0] !== null && typeof value[0] === 'object') {
      const example = Object.keys(value[0]).find((k) => value[0][k] === null || typeof value[0][k] !== 'object');
      return { field, length: value.length, example: example || null };
    }
  }
  return null;
}

const TYPE_MARK = {
  string: 'T', number: '#', boolean: '◐', array: '[ ]', null: '∅', object: '{ }',
};

/** Flatten an object into leaf paths, stopping at array boundaries. */
function collectLeaves(json, prefix = '', depth = 0) {
  if (depth > 4 || json === null || typeof json !== 'object') return [];
  const out = [];

  for (const key of Object.keys(json)) {
    const value = json[key];
    const path = prefix ? `${prefix}.${key}` : key;

    if (Array.isArray(value)) {
      out.push({
        path, kind: 'array', type: `array[${value.length}]`, preview: previewOf(value),
      });
      // Surface the first element's shape: this is how a candidate discovers
      // what Split Out will produce.
      if (value.length && value[0] !== null && typeof value[0] === 'object') {
        out.push(...collectLeaves(value[0], `${path}[0]`, depth + 1));
      }
    } else if (value !== null && typeof value === 'object') {
      out.push(...collectLeaves(value, path, depth + 1));
    } else {
      const kind = value === null ? 'null' : typeof value;
      out.push({ path, kind, type: kind, preview: previewOf(value) });
    }
  }
  return out;
}

function previewOf(value) {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'object') return '{…}';
  return String(value);
}

function cell(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function cellTitle(value) {
  const text = cell(value);
  return text.length > 40 ? text : undefined;
}
