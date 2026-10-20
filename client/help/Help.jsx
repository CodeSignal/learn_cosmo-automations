import { useEffect, useMemo, useRef, useState } from 'react';
import { DsIcon, Icon } from '../ui/Icon.jsx';
import { NodeGlyph } from '../canvas/NodeIcon.jsx';
import { CONCEPTS } from './concepts.jsx';
import { Landing } from './Landing.jsx';
import { NodePage } from './NodePage.jsx';
import { GROUP_LABELS, GROUP_SINGULAR, nodeGroups } from './groups.js';
import { describeMode } from '../../shared/node-mode.mjs';

/**
 * Help: how the product works, plus a reference page for every node.
 *
 * Deliberately contains no task content — the task statement is delivered by
 * Learn, outside the simulation. This explains Cosmo Automations itself, which
 * is knowledge a candidate should be able to look up without it being a hint.
 *
 *   ┌ contents ──────┬ page ─────────────────────────────────┐
 *   │ search         │ eyebrow · title · how it runs         │
 *   │ Guides         │ lead                                  │
 *   │ Node reference │ body                                  │
 *   │   by group     │ ← previous            next →          │
 *   └────────────────┴───────────────────────────────────────┘
 *
 * Every page — guide or node — has the same header and the same previous/next
 * footer, so the whole panel reads as one document you can page through.
 *
 * `initialTopic` opens straight to a page (`node:splitOut`), which is what the
 * book button in a node's settings uses.
 */
export function Help({ palette, initialTopic }) {
  const [topic, setTopic] = useState(initialTopic || CONCEPTS[0].id);
  const [query, setQuery] = useState('');
  const bodyRef = useRef(null);

  useEffect(() => {
    if (initialTopic) setTopic(initialTopic);
  }, [initialTopic]);

  // Reset the reading position when the page changes, or a long node page opens
  // scrolled to wherever the previous one was.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [topic]);

  /** Every page in reading order: guides, then nodes in node-panel order. */
  const pages = useMemo(() => [
    ...CONCEPTS.map((c) => ({ id: c.id, title: c.heading || c.title })),
    ...nodeGroups(palette).flatMap((g) => g.items)
      .map((n) => ({ id: `node:${n.type}`, title: n.label })),
  ], [palette]);

  const needle = query.trim().toLowerCase();

  const concepts = useMemo(() => CONCEPTS.filter((c) => !needle
    || c.title.toLowerCase().includes(needle)
    || (c.summary || '').toLowerCase().includes(needle)
    || c.keywords.some((k) => k.includes(needle))), [needle]);

  const groups = useMemo(() => nodeGroups(palette.filter((n) => !needle
    || n.label.toLowerCase().includes(needle)
    || n.type.toLowerCase().includes(needle)
    || (n.docs?.summary || '').toLowerCase().includes(needle))), [palette, needle]);

  const go = (id) => setTopic(id);

  const activeNode = topic.startsWith('node:')
    ? palette.find((n) => n.type === topic.slice(5))
    : null;
  const activeConcept = activeNode ? null : (CONCEPTS.find((c) => c.id === topic) || CONCEPTS[0]);
  const activeId = activeNode ? topic : activeConcept.id;

  const index = pages.findIndex((p) => p.id === activeId);
  const previous = index > 0 ? pages[index - 1] : null;
  const next = index >= 0 && index < pages.length - 1 ? pages[index + 1] : null;

  return (
    <div className="ca-help">
      <nav className="ca-help-nav" aria-label="Help contents">
        <div className="ca-help-search">
          <label className="ca-search">
            <DsIcon name="search" className="ca-search-icon" />
            <input
              className="input ca-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
              placeholder="Search help"
              aria-label="Search help"
            />
          </label>
        </div>

        <div className="ca-help-nav-scroll">
          {concepts.length ? (
            <div className="ca-help-nav-section">
              <h3 className="ca-help-nav-heading label-small">Guides</h3>
              {concepts.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`ca-help-nav-item body-xsmall${activeId === c.id ? ' is-active' : ''}`}
                  onClick={() => go(c.id)}
                  aria-current={activeId === c.id ? 'page' : undefined}
                >
                  <span className="ca-help-nav-icon" aria-hidden="true"><Icon name={c.icon} size={15} /></span>
                  <span className="ca-help-nav-label">{c.title}</span>
                </button>
              ))}
            </div>
          ) : null}

          {groups.map(({ group, items }) => (
            <div className="ca-help-nav-section" key={group}>
              <h3 className="ca-help-nav-heading label-small">{GROUP_LABELS[group]}</h3>
              {items.map((n) => (
                <button
                  type="button"
                  key={n.type}
                  className={`ca-help-nav-item body-xsmall${activeId === `node:${n.type}` ? ' is-active' : ''}`}
                  onClick={() => go(`node:${n.type}`)}
                  aria-current={activeId === `node:${n.type}` ? 'page' : undefined}
                >
                  <NodeGlyph group={n.group} icon={n.icon} size="sm" />
                  <span className="ca-help-nav-label">{n.label}</span>
                </button>
              ))}
            </div>
          ))}

          {!concepts.length && !groups.length ? (
            <div className="ca-help-empty">
              <p className="body-xsmall">{`Nothing matches “${query}”.`}</p>
              <button type="button" className="ca-help-link body-xsmall" onClick={() => setQuery('')}>
                Clear search
              </button>
            </div>
          ) : null}
        </div>
      </nav>

      <article className="ca-help-body" ref={bodyRef} tabIndex={-1} aria-labelledby="ca-help-title">
        <div className="ca-help-page">
          <PageHeader concept={activeConcept} node={activeNode} />

          <div className="ca-help-prose">
            {activeNode ? <NodePage node={activeNode} palette={palette} onOpen={go} /> : null}
            {activeConcept && activeConcept.landing ? <Landing palette={palette} onOpen={go} /> : null}
            {activeConcept && !activeConcept.landing ? (
              <>
                <p className="ca-help-lead body-medium">{activeConcept.summary}</p>
                {activeConcept.body}
              </>
            ) : null}
          </div>

          {previous || next ? (
            <nav className="ca-help-pager" aria-label="More help">
              {previous ? (
                <button type="button" className="ca-help-pager-link" onClick={() => go(previous.id)}>
                  <span className="ca-help-pager-dir body-xxsmall">
                    <Icon name="arrow-left" size={13} />
                    Previous
                  </span>
                  <span className="ca-help-pager-title body-small">{previous.title}</span>
                </button>
              ) : <span />}
              {next ? (
                <button type="button" className="ca-help-pager-link is-next" onClick={() => go(next.id)}>
                  <span className="ca-help-pager-dir body-xxsmall">
                    Next
                    <Icon name="arrow-right" size={13} />
                  </span>
                  <span className="ca-help-pager-title body-small">{next.title}</span>
                </button>
              ) : null}
            </nav>
          ) : null}
        </div>
      </article>
    </div>
  );
}

/** One header for every page: where it sits, what it is, and — for a node — how it runs. */
function PageHeader({ concept, node }) {
  if (node) {
    return (
      <header className="ca-help-header">
        <span className="ca-help-header-glyph">
          <NodeGlyph group={node.group} icon={node.icon} size="md" />
        </span>
        <div className="ca-help-header-text">
          <span className="ca-help-eyebrow body-xxsmall">{GROUP_SINGULAR[node.group] || 'Node'}</span>
          <h2 id="ca-help-title" className="heading-small">{node.label}</h2>
          <div className="ca-help-chips">
            <span className="ca-help-chip body-xxsmall">
              <Icon name="stack" size={12} />
              {node.mode === 'dynamic' ? 'You choose how it runs' : `Runs ${describeMode(node.mode)}`}
            </span>
            {node.usesCredential ? (
              <span className="ca-help-chip body-xxsmall">
                <Icon name="key" size={12} />
                Uses a credential
              </span>
            ) : null}
          </div>
        </div>
      </header>
    );
  }
  return (
    <header className="ca-help-header">
      <span className="ca-help-header-icon" aria-hidden="true"><Icon name={concept.icon} size={20} /></span>
      <div className="ca-help-header-text">
        <span className="ca-help-eyebrow body-xxsmall">{concept.landing ? 'Help' : 'Guide'}</span>
        <h2 id="ca-help-title" className="heading-small">{concept.heading || concept.title}</h2>
      </div>
    </header>
  );
}
