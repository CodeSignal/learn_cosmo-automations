import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, IconButton, Tabs } from '../ui/primitives.jsx';
import { Icon, Spinner } from '../ui/Icon.jsx';
import { NodeGlyph } from '../canvas/NodeIcon.jsx';
import { describeMode, effectiveMode } from '../../shared/node-mode.mjs';
import { Select } from '../ui/Select.jsx';
import { SplitPanel } from '../ui/SplitPanel.jsx';
import { ItemPanel } from './ItemPanel.jsx';
import { ParamField } from './ParamField.jsx';
import { insertExpression } from './ExpressionInput.jsx';

/**
 * Node detail view: input items | parameters | output items, over the canvas.
 *
 * It opens as an overlay on a dimmed canvas rather than replacing it, so the
 * workflow you came from stays in view at the edges and "back" is obviously
 * where you return to. The parameters sit in the middle, raised, because that
 * is the column you work in; the item panels either side are what you read.
 *
 * SplitPanel is a two-panel component, so two are nested to get three columns
 *. The outer split separates input from "params + output"; the
 * inner split separates params from output.
 */
export function NodeDetail({
  node, definition, record, credentials, credentialTypes, trace,
  onClose, onRename, onParameterChange, onCredentialChange, onToggleDisabled,
  onExecuteNode, onExecutePrevious, canExecuteNode, onOpenDocs, onCreateCredential, running,
  inputFallback, previousCount = 0,
}) {
  const paramsHostRef = useRef(null);
  const [tab, setTab] = useState('parameters');

  /**
   * The name field keeps its own text. Every keystroke still renames the node
   * (trimmed, so expressions referring to it follow along), but the field must
   * not be redrawn from the committed name: that dropped a trailing space as it
   * was typed, and refused an empty or momentarily duplicate name, so names with
   * spaces could not be typed at all. On blur it falls back to the name in use.
   */
  const [draftName, setDraftName] = useState(node.name);
  useEffect(() => {
    if (node.name !== draftName.trim()) setDraftName(node.name);
    // Only an outside change (undo, redo) should overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.name]);

  // A record from "Execute previous nodes" holds the input but never ran.
  const hasRun = Boolean(record && record.status !== 'notRun');
  // A node wired up after the last run has no record, but the nodes feeding it
  // may have run: their output is what would arrive here.
  const fromLastRun = !(record && record.inputSample) && Boolean(inputFallback && inputFallback.length);
  const inputItems = record && record.inputSample ? record.inputSample : (inputFallback || []);
  const outputItems = hasRun ? (record.output || []) : [];
  // Tools and output parsers have no data input either, but they are not
  // triggers: they attach to an agent and work when it runs.
  const isSubNode = Boolean(definition.toolOutput || definition.parserOutput);
  const isTrigger = definition.inputs === 0 && !isSubNode;

  // Every node's output so far, so `$node["Name"]` previews resolve.
  const nodeOutputs = useMemo(() => {
    if (!trace) return {};
    return Object.fromEntries((trace.nodes || [])
      .filter((r) => r.output)
      .map((r) => [r.name, r.output]));
  }, [trace]);

  const exprContext = {
    sampleItem: inputItems[0] || null,
    sampleIndex: 0,
    itemCount: inputItems.length,
    nodeOutputs,
  };

  /**
   * Clicking a field in the input panel appends it to whichever expression
   * field was last focused, so field discovery flows straight into writing one.
   * (Dragging it onto a field does the same, handled by ExpressionInput.)
   */
  const insertPath = useCallback((path) => {
    const host = paramsHostRef.current;
    const active = host && host.querySelector('.ca-expression-input:focus');
    const target = active || (host && host.querySelector('.ca-expression-input'));
    if (!target) return;
    insertExpression(target, path);
  }, []);

  // `showFor: { mode: 'append' }` shows a field for one value; an array shows it
  // for any of several, which Remove Duplicates needs.
  // An unset parameter counts as its default, so a node saved before the
  // parameter existed still shows the fields for its default mode.
  const valueOf = (key) => (node.parameters[key] !== undefined
    ? node.parameters[key] : (definition.defaults || {})[key]);
  const visibleParams = (definition.params || []).filter((descriptor) => {
    if (!descriptor.showFor) return true;
    return Object.entries(descriptor.showFor).every(([key, expected]) => (
      Array.isArray(expected) ? expected.includes(valueOf(key)) : valueOf(key) === expected
    ));
  });

  const mode = describeMode(effectiveMode(definition, node));

  const centerPane = (
    <div className="ca-pane ca-pane-center" ref={paramsHostRef}>
      <div className="ca-detail-head">
        <NodeGlyph group={definition.group} icon={definition.icon} size="md" />
        <div className="ca-detail-titles">
          <input
            className="ca-detail-name"
            value={draftName}
            onChange={(e) => { setDraftName(e.target.value); onRename(e.target.value); }}
            onBlur={() => setDraftName(node.name)}
            aria-label="Node name"
            title="Rename this node"
            spellCheck={false}
          />
          <span className="ca-detail-type body-xxsmall">{`${definition.label} · runs ${mode}`}</span>
        </div>

        <IconButton label={`How ${definition.label} works`} onClick={onOpenDocs}>
          <Icon name="book" />
        </IconButton>

        {/*
          Execute Node is the primary action *here* — the fast loop while getting
          one node's configuration right. It needs somewhere for items to come
          from, so it is unavailable until the node has an input wired (triggers
          excepted: they make their own).
        */}
        <Button
          variant="primary"
          size="xsmall"
          className="ca-detail-execute"
          onClick={onExecuteNode}
          disabled={running || !canExecuteNode}
          title={canExecuteNode
            ? 'Run this node and everything it depends on'
            : 'Connect an input to this node first'}
        >
          {running ? <Spinner /> : <Icon name="play" size={14} />}
          <span>{running ? 'Executing…' : 'Execute Node'}</span>
        </Button>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        label="Node settings sections"
        options={[
          { value: 'parameters', label: 'Parameters' },
          { value: 'settings', label: 'Settings' },
        ]}
      />

      {record && record.error ? (
        <div className="ca-alert ca-alert-error body-xsmall" role="alert">
          <Icon name="alert" />
          <span>{record.error}</span>
        </div>
      ) : null}

      {node.disabled ? (
        <div className="ca-alert ca-alert-muted body-xsmall">
          <Icon name="power" size={14} />
          <span>This node is disabled — items pass straight through it.</span>
          <Button variant="text-primary" size="xsmall" onClick={() => onToggleDisabled(false)}>
            Enable
          </Button>
        </div>
      ) : null}

      <div className="ca-pane-scroll ca-params">
        {tab === 'parameters' ? (
          <>
            {definition.description ? (
              <p className="ca-params-intro body-xsmall">{definition.description}</p>
            ) : null}

            {definition.usesCredential ? (
              <CredentialField
                node={node}
                definition={definition}
                credentials={credentials}
                credentialTypes={credentialTypes || []}
                onCredentialChange={onCredentialChange}
                onCreateCredential={onCreateCredential}
              />
            ) : null}

            {visibleParams.map((descriptor) => (
              <ParamField
                key={descriptor.name}
                descriptor={descriptor}
                value={node.parameters[descriptor.name]}
                onChange={(value) => onParameterChange(descriptor.name, value)}
                exprContext={exprContext}
              />
            ))}

            {visibleParams.length === 0 && !definition.usesCredential ? (
              <p className="ca-pane-empty body-xsmall">This node has no parameters to configure.</p>
            ) : null}
          </>
        ) : (
          <SettingsTab
            node={node}
            definition={definition}
            mode={mode}
            onToggleDisabled={onToggleDisabled}
            onOpenDocs={onOpenDocs}
          />
        )}
      </div>
    </div>
  );

  /**
   * The output panel shows the FIRST output port. For a Switch that is one
   * branch out of several, and silently showing only "enterprise" would leave
   * someone debugging "why did nothing reach standard?" with no way to see that
   * it did. Name the port, and account for the others.
   */
  const ports = record && record.outputsByPort ? record.outputsByPort : [];
  const outputNote = ports.length > 1
    ? `Showing the "${ports[0].name}" output. Other outputs: `
      + ports.slice(1).map((p) => `${p.name} ${p.count}`).join(', ')
    : null;

  const outputPane = (
    <ItemPanel
      side="output"
      title={ports.length > 1 ? `Output · ${ports[0].name}` : 'Output'}
      items={outputItems}
      note={outputNote}
      error={record && record.status === 'error' ? record.error : null}
      empty={isSubNode
        ? {
          title: 'No items of its own',
          text: definition.toolOutput
            ? 'Its answers go back to the agent that called it, and show in that agent\'s run.'
            : 'What it shapes shows in the agent\'s output, as $json.output.',
        }
        : hasRun
        ? { title: 'No output', text: 'This node produced no items on its first output.' }
        : {
          title: 'No output yet',
          text: 'Execute this step to see what it produces.',
          action: canExecuteNode && !running
            ? { label: 'Execute Node', onClick: onExecuteNode }
            : null,
        }}
    />
  );

  // Same blind spot on the way in: Merge has two inputs and this panel samples
  // the first. Without the note, "Input 7 items" on a node whose tile says
  // "12 in" looks like a bug in the simulation rather than a second branch.
  const inPorts = record && record.inputsByPort ? record.inputsByPort : [];
  const inputNote = inPorts.length > 1
    ? 'Showing input 1. Also arriving: '
      + inPorts.slice(1)
        .map((p) => `input ${p.port + 1} (${p.count} ${p.count === 1 ? 'item' : 'items'})`)
        .join(', ')
    : (fromLastRun ? 'From the last run of the nodes before this one. This node has not run yet.' : null);

  const inputPane = (
    <ItemPanel
      side="input"
      title={inPorts.length > 1 ? 'Input · 1' : 'Input'}
      items={inputItems}
      note={inputNote}
      onInsertPath={insertPath}
      // Split Out is the answer the hint points to, so it would be advice to add itself.
      listHint={node.type !== 'splitOut'}
      empty={isSubNode
        ? {
          title: definition.toolOutput ? 'Called by an agent' : 'Attached to an agent',
          text: definition.toolOutput
            ? 'No items arrive here. It runs when the agent it is attached to calls it; its $json is what the agent passes in.'
            : 'No items arrive here. It shapes the answers of the agent it is attached to, every time that agent runs.',
        }
        : isTrigger
        ? {
          title: 'This is a trigger',
          text: 'Triggers start the workflow, so nothing arrives here. Its output is what every later node works with.',
        }
        : (record
          ? { title: 'No input', text: 'No items reached this node.' }
          : {
            title: 'No input data yet',
            // Singular when only the node directly before still has to run.
            text: canExecuteNode
              ? `Execute the previous ${previousCount === 1 ? 'node' : 'nodes'} to see the items that arrive here.`
              : 'Connect this node to an earlier one first.',
            action: canExecuteNode && !running
              ? { label: previousCount === 1 ? 'Execute previous node' : 'Execute previous nodes', onClick: onExecutePrevious }
              : null,
          })}
    />
  );

  return (
    <div
      className="ca-ndv-scrim"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="ca-ndv" role="dialog" aria-modal="true" aria-label={`${node.name} settings`}>
        <div className="ca-ndv-top">
          <Button variant="text" size="xsmall" className="ca-ndv-back" onClick={onClose} title="Back to canvas (Esc)">
            <Icon name="arrow-left" />
            <span>Back to canvas</span>
          </Button>
        </div>

        <div className="ca-ndv-body">
          <SplitPanel
            className="ca-detail-outer"
            orientation="horizontal"
            initialSplit={27}
            minLeft={14}
            minRight={45}
            dividerLabel="Resize input panel"
            left={inputPane}
            right={(
              <SplitPanel
                className="ca-detail-inner"
                orientation="horizontal"
                initialSplit={56}
                minLeft={36}
                minRight={20}
                dividerLabel="Resize output panel"
                left={centerPane}
                right={outputPane}
              />
            )}
          />
        </div>
      </div>
    </div>
  );
}

function SettingsTab({ node, definition, mode, onToggleDisabled, onOpenDocs }) {
  return (
    <div className="ca-settings">
      <div className="ca-field">
        <Checkbox
          label="Disable this node"
          checked={Boolean(node.disabled)}
          onChange={(e) => onToggleDisabled(e.target.checked)}
          size="xsmall"
        />
        <p className="ca-field-hint body-xxsmall">
          A disabled node does nothing: the items it receives pass straight through
          to the next one.
        </p>
      </div>

      <dl className="ca-settings-facts">
        <div>
          <dt className="body-xxsmall">Node type</dt>
          <dd className="body-xsmall">{definition.label}</dd>
        </div>
        <div>
          <dt className="body-xxsmall">Runs</dt>
          <dd className="body-xsmall">{mode}</dd>
        </div>
      </dl>

      <Button variant="secondary" size="xsmall" onClick={onOpenDocs}>
        <Icon name="book" size={14} />
        <span>{`Read the ${definition.label} reference`}</span>
      </Button>
    </div>
  );
}

/**
 * The credential picker.
 *
 * It offers only credentials of the type this node asks for. That is the point
 * of `credentialType`: "which credential does this node need" becomes something
 * the candidate has to get right, rather than a list with one entry in it. A
 * node with no declared type — HTTP Request — offers all of them.
 *
 * When nothing matches, the empty state names the type and offers to create
 * one, because "— none —" on its own gives a candidate nowhere to go.
 */
function CredentialField({
  node, definition, credentials, credentialTypes, onCredentialChange, onCreateCredential,
}) {
  const wanted = definition.credentialType || null;
  const usable = wanted ? credentials.filter((c) => c.type === wanted) : credentials;
  const typeLabel = (credentialTypes.find((t) => t.name === wanted) || {}).label || wanted;

  /**
   * A credential of the wrong type stays visible while it is attached, rather
   * than silently vanishing from the dropdown and looking like nothing is set.
   */
  const attached = credentials.find((c) => c.id === node.credentialId);
  const mismatched = attached && wanted && attached.type !== wanted;

  return (
    <div className="ca-field">
      <div className="ca-field-label-row">
        <span className="ca-field-label body-xsmall">Credential</span>
        <Button variant="text-primary" size="xsmall" className="ca-field-action" onClick={() => onCreateCredential(wanted)}>
          {usable.length ? 'Manage' : `Create ${typeLabel ? `a ${typeLabel}` : 'a'} credential`}
        </Button>
      </div>
      <Select
        value={node.credentialId || ''}
        options={[
          { value: '', label: usable.length ? '— none —' : `— no ${typeLabel || ''} credential yet —` },
          ...usable.map((c) => ({ value: c.id, label: c.name })),
          ...(mismatched ? [{ value: attached.id, label: `${attached.name} (wrong type)` }] : []),
        ]}
        onChange={(value) => onCredentialChange(value || null)}
      />

      {mismatched ? (
        <p className="ca-field-hint ca-field-hint-error body-xxsmall">
          {`"${attached.name}" is a ${attached.type} credential; this node needs `}
          {typeLabel}.
        </p>
      ) : null}

      <p className="ca-field-hint body-xxsmall">
        {wanted
          ? `Uses a ${typeLabel} credential. Its value is sent to the service and never printed in the report.`
          : 'Any credential type. Its value is sent to the service and never printed in the report.'}
      </p>
    </div>
  );
}
