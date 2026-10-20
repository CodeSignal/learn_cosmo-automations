import { Icon } from '../ui/Icon.jsx';
import { NodeGlyph } from '../canvas/NodeIcon.jsx';
import { CONCEPTS } from './concepts.jsx';
import { GROUP_LABELS, nodeGroups } from './groups.js';

/**
 * The help panel's front page: what this is, the three ideas that explain most
 * of the rest, and a way into every guide and every node — so the first screen
 * of help is a map rather than a wall of text.
 */
export function Landing({ palette, onOpen }) {
  const guides = CONCEPTS.filter((c) => !c.landing);

  return (
    <>
      <p className="ca-help-lead body-medium">
        A workflow automation builder. You wire up <strong>nodes</strong> on a
        canvas, left to right; data flows along the connections; and pressing{' '}
        <strong>Execute Workflow</strong> runs the whole thing for real and shows
        you what every node produced.
      </p>
      <p className="body-small">
        It works the way workflow automation tools generally do: a node does one
        job, the connection carries its output to the next node, and expressions
        let one node read another&apos;s data.
      </p>

      <h3 className="heading-xsmall">Three things worth knowing first</h3>
      <ol className="ca-help-essentials">
        <Essential
          n={1}
          title="Data travels as a list of items"
          onOpen={() => onOpen('items')}
          link="Read about items"
        >
          Not a single blob. Most nodes run once for each item — the idea that
          explains most of the rest.
        </Essential>
        <Essential
          n={2}
          title="Any field can be an expression"
          onOpen={() => onOpen('expressions')}
          link="Read about expressions"
        >
          Start a field with <code>=</code>, or press its <strong>fx</strong>{' '}
          button, and it can read live data with <code>{'{{ }}'}</code>.
        </Essential>
        <Essential
          n={3}
          title="The APIs are real HTTP"
          onOpen={() => onOpen('apis')}
          link="Read about APIs"
        >
          Real methods, status codes and JSON. A <code>401</code> genuinely means
          the request was unauthorised.
        </Essential>
      </ol>

      <h3 className="heading-xsmall">Guides</h3>
      <div className="ca-help-cards">
        {guides.map((guide) => (
          <button
            type="button"
            key={guide.id}
            className="ca-help-card"
            onClick={() => onOpen(guide.id)}
          >
            <span className="ca-help-card-icon" aria-hidden="true"><Icon name={guide.icon} /></span>
            <span className="ca-help-card-text">
              <span className="ca-help-card-title body-small">{guide.heading || guide.title}</span>
              <span className="ca-help-card-desc body-xxsmall">{guide.summary}</span>
            </span>
          </button>
        ))}
      </div>

      <h3 className="heading-xsmall">Node reference</h3>
      <p className="body-small">
        Every node this task offers, with its parameters, examples and the
        mistakes people usually make. A node&apos;s settings open its page
        directly, from the book button next to its name.
      </p>
      {nodeGroups(palette).map(({ group, items }) => (
        <div className="ca-help-node-group" key={group}>
          <h4 className="ca-help-node-group-title label-small">{GROUP_LABELS[group] || group}</h4>
          <div className="ca-help-node-grid">
            {items.map((node) => (
              <button
                type="button"
                key={node.type}
                className="ca-help-node-tile"
                onClick={() => onOpen(`node:${node.type}`)}
                title={node.description}
              >
                <NodeGlyph group={node.group} icon={node.icon} size="sm" />
                <span className="ca-help-node-tile-label body-xsmall">{node.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function Essential({
  n, title, children, onOpen, link,
}) {
  return (
    <li className="ca-help-essential">
      <span className="ca-help-essential-n" aria-hidden="true">{n}</span>
      <div className="ca-help-essential-body">
        <span className="ca-help-essential-title body-small">{title}</span>
        <span className="body-xsmall">{children}</span>
        <button type="button" className="ca-help-link body-xsmall" onClick={onOpen}>
          {link}
          <Icon name="arrow-right" size={13} />
        </button>
      </div>
    </li>
  );
}
