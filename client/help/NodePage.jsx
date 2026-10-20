import { Icon } from '../ui/Icon.jsx';
import { NodeGlyph } from '../canvas/NodeIcon.jsx';
import { rich } from './rich.jsx';

/**
 * A node's reference page: what it does and how it treats items, then its
 * parameters (in the design system's table), examples, the mistakes people
 * make with it, and the nodes it is usually confused with or paired with.
 *
 * The header — glyph, name, how it runs — is drawn by Help, like every page.
 */
export function NodePage({ node, palette, onOpen }) {
  const docs = node.docs || {};
  const related = (docs.seeAlso || [])
    .map((type) => palette.find((n) => n.type === type))
    .filter(Boolean);

  return (
    <>
      <p className="ca-help-lead body-medium">{rich(docs.summary || node.description)}</p>

      {docs.mode ? (
        <div className="ca-help-callout ca-help-callout-info body-xsmall">
          <Icon name="stack" />
          <span><strong>Items: </strong>{rich(docs.mode)}</span>
        </div>
      ) : null}

      {docs.when ? (
        <>
          <h3 className="heading-xsmall">When to use it</h3>
          <p className="body-small">{rich(docs.when)}</p>
        </>
      ) : null}

      {node.usesCredential ? (
        <>
          <h3 className="heading-xsmall">Credential</h3>
          <p className="body-small">
            This node can carry a credential. Create one under{' '}
            <strong>Credentials</strong> in the header and pick it in the
            node&apos;s settings. Values are held with your workflow and sent to the
            service — never shown in the report. A service that needs
            authentication answers <code>401</code> until the right credential is
            attached.
          </p>
        </>
      ) : null}

      {(node.params || []).length ? (
        <>
          <h3 className="heading-xsmall">Parameters</h3>
          <div className="table-scroll ca-help-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>What it does</th>
                </tr>
              </thead>
              <tbody>
                {node.params.map((param) => {
                  const extra = (docs.params || []).find((p) => p.name === param.name);
                  return (
                    <tr key={param.name}>
                      <td className="ca-help-table-name">
                        <span className="body-xsmall">{param.label}</span>
                        <span className="ca-help-param-type body-xxsmall ca-mono">{param.type}</span>
                      </td>
                      <td className="body-xsmall">{rich(extra ? extra.text : (param.hint || '—'))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {(docs.examples || []).length ? (
        <>
          <h3 className="heading-xsmall">Examples</h3>
          {docs.examples.map((example) => (
            <figure className="ca-help-example" key={example.label}>
              <figcaption className="body-xxsmall">{example.label}</figcaption>
              <pre className="ca-json body-xxsmall">{example.code}</pre>
            </figure>
          ))}
        </>
      ) : null}

      {(docs.gotchas || []).length ? (
        <>
          <h3 className="heading-xsmall">Common mistakes</h3>
          <ul className="ca-help-gotchas">
            {docs.gotchas.map((gotcha) => (
              <li key={gotcha} className="body-small">
                <span className="ca-help-gotcha-icon" aria-hidden="true"><Icon name="alert" size={14} /></span>
                <span>{rich(gotcha)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {related.length ? (
        <>
          <h3 className="heading-xsmall">See also</h3>
          <div className="ca-help-node-grid">
            {related.map((other) => (
              <button
                type="button"
                key={other.type}
                className="ca-help-node-tile"
                onClick={() => onOpen(`node:${other.type}`)}
                title={other.description}
              >
                <NodeGlyph group={other.group} icon={other.icon} size="sm" />
                <span className="ca-help-node-tile-label body-xsmall">{other.label}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
