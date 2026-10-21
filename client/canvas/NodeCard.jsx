import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { NodeGlyph } from './NodeIcon.jsx';
import { DsIcon, Icon, Spinner } from '../ui/Icon.jsx';
import { effectiveOutputs } from '../../shared/node-ports.mjs';

/** The tile is square until it needs more height for its ports. */
const TILE = 80;
const PORT_PITCH = 24;

/**
 * A node on the canvas: a square tile carrying the type's glyph, with its name
 * and a one-line summary captioned underneath.
 *
 * The caption sits OUTSIDE the tile so a long, candidate-typed name never
 * changes the tile's size, and the tile size never changes between runs —
 * run state is a border, a corner badge and a caption line, all fixed-size.
 *
 * State is never conveyed by colour alone. Success adds a check, an error adds
 * a "!" and the error caption, running adds a spinner, and the quieter states
 * (disabled, skipped, no items, waiting) replace the summary line with a word.
 */
export const NodeCard = memo(({ data, selected }) => {
  const {
    definition, node, record, summary, live, connectedOutputs, connectedInputs, offers, outputCounts,
    onOpen, onExecute, onToggleDisabled, onDelete, onAddAfter, onAddSubNode, running,
  } = data;
  const status = live === 'running' ? 'running' : (record ? record.status : null);
  const inputs = definition.inputs;
  // Switch names its ports from its own rules, so the ports are a function of
  // this node's parameters rather than of its type.
  const outputs = effectiveOutputs(definition, node);
  const ports = Math.max(inputs, outputs.length);
  const height = Math.max(TILE, ports * PORT_PITCH + 16);
  // Subagents: an agent takes tools on a Tools port, and a tool
  // offers itself from its top edge. Port numbers stay plain integers — the
  // Tools input is simply the one after the data inputs — so the connection
  // format, the engine and the report need no special case to read them.
  const toolInput = Boolean(definition.toolInput);
  const toolOutput = Boolean(definition.toolOutput);
  // Output parsers work like tools: an agent takes one on the port after Tools,
  // and a parser offers itself from its top edge.
  const parserInput = Boolean(definition.parserInput);
  const subOutput = toolOutput || Boolean(definition.parserOutput);
  const parserPort = inputs + (toolInput ? 1 : 0);
  const isTrigger = (definition.group === 'trigger' || inputs === 0) && !subOutput;
  // A sub-node port the task has nothing for is left off entirely — no label,
  // nothing to drag from — unless something is already wired into it.
  const toolsConnected = toolInput && connectedInputs.has(inputs);
  const parserConnected = parserInput && connectedInputs.has(parserPort);
  const showTools = toolInput && (offers.tool || toolsConnected);
  const showParser = parserInput && (offers.parser || parserConnected);

  /**
   * A node in a loop body shows the totals across every pass, and a node that
   * ran three times looks identical to one that ran once unless the passes are
   * named. That is the loop's entire visible effect, so it goes on the tile.
   */
  const passes = record ? (record.batches || record.runs) : 0;
  const caption = captionFor(node, status, record);

  return (
    <div
      className={[
        'ca-node-wrap',
        isTrigger && 'is-trigger',
        subOutput && 'is-tool',
        selected && 'is-selected',
        node.disabled && 'is-disabled',
        status && `is-${status}`,
      ].filter(Boolean).join(' ')}
      style={{ '--ca-node-height': `${height}px` }}
      title={tooltipFor(node, definition, summary, record)}
    >
      {/* Hover toolbar. `nodrag` so pressing a button never starts a drag. */}
      <div className="ca-node-toolbar nodrag" role="toolbar" aria-label={`${node.name} actions`}>
        <button
          type="button"
          className="ca-node-tool"
          onClick={onExecute}
          disabled={running || subOutput}
          aria-label={`Execute ${node.name}`}
          title={toolOutput
            ? 'A tool runs when its agent calls it — execute the agent instead'
            : 'Execute Node — runs this node and everything before it'}
        >
          <Icon name="play" size={13} />
        </button>
        <button
          type="button"
          className="ca-node-tool"
          onClick={onToggleDisabled}
          aria-label={node.disabled ? `Enable ${node.name}` : `Disable ${node.name}`}
          title={node.disabled ? 'Enable' : 'Disable — items pass straight through'}
        >
          <Icon name="power" size={13} />
        </button>
        <button
          type="button"
          className="ca-node-tool"
          onClick={onOpen}
          aria-label={`Open ${node.name} settings`}
          title="Open settings (Enter)"
        >
          <Icon name="settings" size={13} />
        </button>
        <button
          type="button"
          className="ca-node-tool ca-node-tool-danger"
          onClick={onDelete}
          aria-label={`Delete ${node.name}`}
          title="Delete (⌫)"
        >
          <DsIcon name="trash" />
        </button>
      </div>

      {Array.from({ length: inputs }, (_, index) => (
        <Handle
          key={`in-${index}`}
          type="target"
          position={Position.Left}
          id={`in-${index}`}
          style={{ top: portOffset(index, inputs, height) }}
          aria-label={inputs > 1 ? `${node.name} input ${index + 1}` : `${node.name} input`}
        />
      ))}

      {inputs > 1 ? Array.from({ length: inputs }, (_, index) => (
        <span
          key={`in-label-${index}`}
          className="ca-node-port-label ca-node-port-label-in body-xxsmall"
          style={{ top: portOffset(index, inputs, height) }}
        >
          {index + 1}
        </span>
      )) : null}

      <div
        className="ca-node"
        onDoubleClick={onOpen}
        role="button"
        tabIndex={-1}
        aria-label={`${node.name}, ${definition.label}${status ? `, ${statusWord(status)}` : ''}`}
      >
        <NodeGlyph group={definition.group} icon={definition.icon} size="lg" tile={false} />
        <StatusBadge status={status} />
        {passes > 1 ? (
          <span className="ca-node-passes body-xxsmall" title={`Ran in ${passes} passes`}>
            {`${passes}×`}
          </span>
        ) : null}
      </div>

      {subOutput ? (
        <Handle
          type="source"
          position={Position.Top}
          id="out-0"
          className="ca-handle-tool"
          aria-label={`${node.name} ${toolOutput ? 'tool' : 'output parser'} output`}
        />
      ) : outputs.map((out, index) => {
        const top = portOffset(index, outputs.length, height);
        const free = !connectedOutputs.has(index);
        const count = outputCounts ? outputCounts[index] : null;
        return (
          // Keyed by index, not name: two Switch rules may share an output name,
          // and a duplicate key would collapse two real ports into one handle.
          // eslint-disable-next-line react/no-array-index-key
          <div key={`out-${index}`}>
            <Handle
              type="source"
              position={Position.Right}
              id={`out-${index}`}
              style={{ top }}
              aria-label={`${node.name} ${out.name} output`}
            />
            {/*
              Everything about an output sits on ONE row, centred on its handle:

                ○ name ── 3 items ── [+]

              The name (multi-output nodes only) rides on the wire, which runs
              behind it. An unconnected output continues into a "+" stub — the
              shortest path from "this node is done" to "what happens next" — and
              carries its item count, since there is no connection to label.
              Stacking these instead put the count of one port on the name of
              the next.
            */}
            {outputs.length > 1 || free ? (
              <div className="ca-node-port nodrag" style={{ top }}>
                {outputs.length > 1 ? (
                  <span className="ca-node-port-label body-xxsmall" title={out.name}>{out.name}</span>
                ) : null}
                {free ? (
                  <>
                    <span className="ca-node-stub-line" aria-hidden="true" />
                    {count !== null && count !== undefined ? (
                      <>
                        <span className="ca-node-stub-count body-xxsmall">
                          {`${count} ${count === 1 ? 'item' : 'items'}`}
                        </span>
                        <span className="ca-node-stub-line ca-node-stub-line-short" aria-hidden="true" />
                      </>
                    ) : null}
                    {/*
                      The "+" is also a handle for this output: drag from it to
                      pull a connection to another node (or onto empty canvas,
                      to add one there), click it to pick the next node.
                    */}
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={`out-${index}-plus`}
                      className="ca-node-stub-handle"
                    >
                      <button
                        type="button"
                        className="ca-node-stub-add"
                        onClick={(event) => { event.stopPropagation(); onAddAfter(index); }}
                        aria-label={`Add a node after ${node.name}${outputs.length > 1 ? ` (${out.name})` : ''}`}
                        title="Click to add the next step, or drag to connect"
                      >
                        <Icon name="plus" size={12} />
                      </button>
                    </Handle>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="ca-node-caption">
        <span className="ca-node-name body-xsmall">{node.name}</span>
        {caption ? (
          <span className={`ca-node-sub body-xxsmall ca-node-sub-${caption.tone}`}>
            {caption.text}
          </span>
        ) : null}
        {!caption && summary ? (
          <span className="ca-node-sub ca-node-summary body-xxsmall ca-mono">{summary}</span>
        ) : null}
        {/*
          The Tools port sits at the foot of the caption rather than on the
          tile's bottom edge, so a tool's wire comes up to it without running
          through this node's name.
        */}
        {showTools || showParser ? (
          <div className="ca-node-subports">
            {showTools ? (
              <SubPort
                label="Tools"
                handleId={`in-${inputs}`}
                nodeName={node.name}
                connected={toolsConnected}
                // An agent takes any number of tools, so its "+" stays.
                many
                onAdd={offers.tool ? () => onAddSubNode('tool') : null}
                what="a tool"
              />
            ) : null}
            {showParser ? (
              <SubPort
                label="Output Parser"
                handleId={`in-${parserPort}`}
                nodeName={node.name}
                connected={parserConnected}
                onAdd={offers.parser ? () => onAddSubNode('parser') : null}
                what="an output parser"
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

/**
 * A port an agent takes sub-nodes on, under its caption: the label, the handle
 * a sub-node's wire comes up to, and a "+" to pick one. Free, the "+" hangs
 * below on a short stub, the way an output's does to the right. Taken, a port
 * that holds one parser shows nothing more; the Tools port keeps a small "+"
 * beside its label, since an agent can have many tools. A port the task offers
 * nothing for is not drawn at all (see `showTools`), unless something is already
 * wired into it — then it keeps its handle but has no "+" (`onAdd` null).
 */
function SubPort({
  label, handleId, nodeName, connected, many = false, onAdd, what,
}) {
  const add = (event) => { event.stopPropagation(); onAdd(); };
  return (
    <div className={`ca-node-tools${connected ? ' is-connected' : ''}`}>
      <span className="ca-node-tools-label body-xxsmall">
        {label}
        {connected && many && onAdd ? (
          <button
            type="button"
            className="ca-node-sub-add ca-node-sub-add-inline nodrag"
            onClick={add}
            aria-label={`Add ${what} to ${nodeName}`}
            title={`Add ${what}`}
          >
            <Icon name="plus" size={10} />
          </button>
        ) : null}
      </span>
      <Handle
        type="target"
        position={Position.Bottom}
        id={handleId}
        className="ca-handle-tool"
        aria-label={`${nodeName} ${label.toLowerCase()} input`}
      />
      {connected || !onAdd ? null : (
        <div className="ca-node-sub-stub nodrag">
          <span className="ca-node-sub-line" aria-hidden="true" />
          <button
            type="button"
            className="ca-node-sub-add"
            onClick={add}
            aria-label={`Add ${what} to ${nodeName}`}
            title={`Add ${what} — or drag from the port to place it`}
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Evenly spaced down the tile's height, so N ports never bunch up. */
function portOffset(index, count, height) {
  if (count <= 1) return `${height / 2}px`;
  return `${((index + 1) / (count + 1)) * height}px`;
}

function StatusBadge({ status }) {
  if (status === 'running') {
    return <span className="ca-node-badge ca-node-badge-running" aria-hidden="true"><Spinner size={12} /></span>;
  }
  if (status === 'success') {
    return <span className="ca-node-badge ca-node-badge-success" aria-hidden="true"><Icon name="check" size={11} /></span>;
  }
  if (status === 'error') {
    return <span className="ca-node-badge ca-node-badge-error" aria-hidden="true"><Icon name="alert" size={12} /></span>;
  }
  if (status === 'paused') {
    return <span className="ca-node-badge ca-node-badge-paused" aria-hidden="true"><Icon name="pause" size={10} /></span>;
  }
  return null;
}

/**
 * The line under the name. A state that needs explaining takes the line over;
 * otherwise it carries the node's configuration summary.
 */
function captionFor(node, status, record) {
  if (node.disabled) return { tone: 'muted', text: 'Disabled' };
  if (status === 'running') return { tone: 'primary', text: 'Running…' };
  if (status === 'error') return { tone: 'error', text: record?.error || 'Error' };
  if (status === 'paused') return { tone: 'warning', text: 'Waiting for approval' };
  if (status === 'noItems') return { tone: 'warning', text: 'No items reached this node' };
  if (status === 'skipped') return { tone: 'muted', text: 'Skipped' };
  return null;
}

function statusWord(status) {
  return {
    running: 'running',
    success: 'completed',
    error: 'error',
    paused: 'waiting for approval',
    noItems: 'no items',
    skipped: 'skipped',
    disabled: 'disabled',
  }[status] || status;
}

/**
 * The full story on hover: what the summary line had to truncate, and the item
 * counts with a two-input node's inputs spelled out — otherwise `12 in, 7 out`
 * on a correct join reads as items vanishing.
 */
function tooltipFor(node, definition, summary, record) {
  const lines = [`${node.name} · ${definition.label}`];
  if (summary) lines.push(summary);
  if (record && record.status !== 'notRun') {
    const inText = record.inputsByPort && record.inputsByPort.length > 1
      ? `${record.itemsIn} in (${record.inputsByPort.map((p) => `${p.count} on input ${p.port + 1}`).join(' + ')})`
      : `${record.itemsIn} in`;
    const passes = record.batches || record.runs;
    // A subagent receives calls, not items.
    if (definition.toolOutput) {
      lines.push(`${record.itemsIn} ${record.itemsIn === 1 ? 'call' : 'calls'}`);
      return lines.join('\n');
    }
    // A parser shapes answers; it has no items of its own.
    if (definition.parserOutput) {
      lines.push(`shaped ${record.itemsIn} ${record.itemsIn === 1 ? 'answer' : 'answers'}`);
      return lines.join('\n');
    }
    lines.push(definition.inputs === 0
      ? `${record.itemsOut} out`
      : `${inText} · ${record.itemsOut} out${passes > 1 ? ` · ${passes} passes` : ''}`);
  }
  return lines.join('\n');
}
