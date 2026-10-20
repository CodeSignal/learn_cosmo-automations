import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Kbd } from '../ui/primitives.jsx';
import { DsIcon, Icon } from '../ui/Icon.jsx';
import { NodeGlyph } from './NodeIcon.jsx';
import { describeMode } from '../../shared/node-mode.mjs';

/**
 * The node panel: every node type this task offers, searchable, grouped.
 *
 * It docks on the left of the canvas and starts hidden, so the canvas gets the
 * room; "+ Add node" at the canvas's top-left opens it. Two other ways in:
 *
 *  · "/" from anywhere opens it with the search focused. Enter on a single
 *    match adds it — the fast path once the catalogue is too big to browse.
 *  · A node's "+" stub opens it in *connect mode*: whatever is picked next is
 *    placed after that node and wired to it, and the header says so.
 *
 * Built for a catalogue an order of magnitude larger than today's: rows are a
 * fixed height, search ranks label prefixes first, groups collapse, and every
 * row is a real button — draggable for the mouse, Enter/Space and arrow keys
 * for the keyboard.
 */

const GROUP_LABELS = {
  trigger: 'Triggers',
  flow: 'Flow',
  data: 'Data transformation',
  transport: 'Transport',
  ai: 'AI',
  integration: 'Integrations',
};

export const GROUP_ORDER = ['trigger', 'flow', 'data', 'ai', 'transport', 'integration'];

export function NodePanel({
  palette, open, onOpen, onClose, onAdd, connectFrom, onCancelConnect, focusToken,
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const searchRef = useRef(null);
  const listRef = useRef(null);

  // "/" opens the panel and focuses search from anywhere, but never while typing.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      const tag = event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) return;
      event.preventDefault();
      onOpen();
      requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpen]);

  // Anything that asks for the panel (an empty canvas, a "+" stub) focuses search.
  useEffect(() => {
    if (!focusToken || !open) return;
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [focusToken, open]);

  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const scored = palette
      .map((entry) => ({ entry, score: scoreMatch(entry, needle) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    return GROUP_ORDER
      .map((group) => ({
        group,
        items: scored.filter((row) => row.entry.group === group).map((row) => row.entry),
        total: palette.filter((e) => e.group === group).length,
      }))
      .filter((g) => g.items.length);
  }, [palette, needle]);

  const matchCount = groups.reduce((sum, g) => sum + g.items.length, 0);

  const toggleGroup = (group) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });

  /** Arrow keys move between rows across group boundaries. */
  const onListKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...listRef.current.querySelectorAll('.ca-nodes-item')];
    const index = rows.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    rows[(index + delta + rows.length) % rows.length].focus();
  };

  const add = (entry) => {
    onAdd(entry);
    setQuery('');
  };

  if (!open) return null;

  return (
    <aside className="ca-nodes-panel" aria-label="Node panel">
      <div className="ca-nodes-head">
        <h2 className="ca-nodes-title heading-xxxsmall">
          {connectFrom ? 'Add the next step' : 'Add nodes'}
        </h2>
        <IconButton label="Hide node panel" onClick={onClose} size="small">
          <Icon name="panel-left" />
        </IconButton>
      </div>

      {connectFrom ? (
        <div className="ca-nodes-connect body-xxsmall" role="status">
          <span>
            {'Connects after '}
            <strong>{connectFrom.name}</strong>
            {connectFrom.port ? ` · ${connectFrom.port}` : ''}
          </span>
          <Button variant="text" size="xsmall" onClick={onCancelConnect}>Cancel</Button>
        </div>
      ) : null}

      <div className="ca-nodes-search">
        <label className="ca-search">
          <DsIcon name="search" className="ca-search-icon" />
          <input
            ref={searchRef}
            className="input ca-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes"
            aria-label="Search nodes"
            aria-describedby="node-panel-match-count"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                if (query) setQuery('');
                else if (connectFrom) onCancelConnect();
                event.currentTarget.blur();
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                listRef.current?.querySelector('.ca-nodes-item')?.focus();
              }
              if (event.key === 'Enter' && matchCount === 1) {
                event.preventDefault();
                add(groups[0].items[0]);
              }
            }}
          />
          {query ? null : <Kbd>/</Kbd>}
        </label>
        <span id="node-panel-match-count" className="ca-sr-only">
          {matchCount} node{matchCount === 1 ? '' : 's'} match
        </span>
      </div>

      <div className="ca-nodes-list" ref={listRef} onKeyDown={onListKeyDown}>
        {groups.length === 0 ? (
          <div className="ca-nodes-empty">
            <p className="body-xsmall">No nodes match “{query}”.</p>
            <Button variant="text-primary" size="xsmall" onClick={() => setQuery('')}>
              Clear search
            </Button>
          </div>
        ) : null}

        {groups.map(({ group, items, total }) => {
          // While searching, a group with matches is always shown expanded.
          const isCollapsed = needle ? false : collapsed.has(group);
          return (
            <section className="ca-nodes-section" key={group}>
              <h3 className="ca-nodes-group-heading">
                <button
                  type="button"
                  className="ca-nodes-group-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(group)}
                  disabled={Boolean(needle)}
                >
                  <span className="ca-nodes-group-label label-small">{GROUP_LABELS[group] || group}</span>
                  <span className="ca-nodes-group-count body-xxsmall">
                    {needle ? `${items.length}/${total}` : total}
                  </span>
                  <span className="ca-nodes-chevron" aria-hidden="true">
                    <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} />
                  </span>
                </button>
              </h3>

              {isCollapsed ? null : items.map((entry) => (
                <button
                  type="button"
                  key={entry.type}
                  className="ca-nodes-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/cosmo-node', entry.type);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => add(entry)}
                  title={`${entry.description || entry.label}\n\nRuns ${entry.mode === 'dynamic'
                    ? `${describeMode(entry.defaultMode)} by default — you choose`
                    : describeMode(entry.mode)}`}
                  aria-label={`Add ${entry.label} node. ${entry.description || ''}`}
                >
                  <NodeGlyph group={entry.group} icon={entry.icon} size="md" />
                  <span className="ca-nodes-item-text">
                    <span className="ca-nodes-item-label body-small">{entry.label}</span>
                    <span className="ca-nodes-item-desc body-xxsmall">{entry.description}</span>
                  </span>
                  <span className="ca-nodes-item-add" aria-hidden="true"><Icon name="plus" size={14} /></span>
                </button>
              ))}
            </section>
          );
        })}
      </div>

      <p className="ca-nodes-foot body-xxsmall">
        Click to add, or drag onto the canvas.
      </p>
    </aside>
  );
}

/**
 * Higher is better, 0 excludes. Prefix matches on the label outrank substring
 * matches, so typing "ag" surfaces Aggregate before anything merely mentioning
 * "aggregate" in its description.
 */
function scoreMatch(entry, needle) {
  if (!needle) return 1;
  const label = entry.label.toLowerCase();
  const type = entry.type.toLowerCase();
  const description = (entry.description || '').toLowerCase();

  if (label === needle) return 100;
  if (label.startsWith(needle)) return 80;
  if (type.startsWith(needle)) return 70;
  if (label.includes(needle)) return 50;
  if (type.includes(needle)) return 40;
  if (entry.group.includes(needle)) return 20;
  if (description.includes(needle)) return 10;
  return 0;
}
