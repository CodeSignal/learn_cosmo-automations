import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './shell/Header.jsx';
import { LogsPanel } from './shell/LogsPanel.jsx';
import { Modal } from './ui/Modal.jsx';
import { Button, Kbd } from './ui/primitives.jsx';
import { Icon, Spinner } from './ui/Icon.jsx';
import { Canvas } from './canvas/Canvas.jsx';
import { NodePanel } from './canvas/NodePanel.jsx';
import { NodeDetail } from './detail/NodeDetail.jsx';
import { CredentialsModal } from './detail/Credentials.jsx';
import { Help } from './help/Help.jsx';
import { api, makeGraphSaver } from './lib/api.js';
import { connectProgress } from './lib/progress.js';
import {
  canRedo, canUndo, createHistory, push, redo, undo,
} from './lib/history.js';
import {
  addConnection, addCredential, addNode, credentialsOf, duplicateNodes, moveNodes,
  removeConnection, removeCredential, removeNodes, renameNode, setNodeParameter,
  setNodesDisabled, updateCredential, updateNode, wouldCycle,
} from './lib/graph.js';
import { effectiveOutputs } from '../shared/node-ports.mjs';
import { lastRunInput } from '../shared/last-run-input.mjs';

const EMPTY_GRAPH = { version: 1, nodes: [], connections: [], credentials: [] };

export function App() {
  const [scenario, setScenario] = useState(null);
  const [graph, setGraph] = useState(EMPTY_GRAPH);
  const [history, setHistory] = useState(createHistory);
  const [trace, setTrace] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [openNodeId, setOpenNodeId] = useState(null);
  const [running, setRunning] = useState(false);
  // nodeId -> 'running' while a run is in flight, so the canvas can show it.
  const [liveStatus, setLiveStatus] = useState({});
  const [saveState, setSaveState] = useState('idle');
  const [toast, setToast] = useState(null);
  const [logOpen, setLogOpen] = useState(false);
  const [helpTopic, setHelpTopic] = useState(null);
  // The node panel, and — when it was opened from a node's "+" stub — the
  // output the next node should be wired to.
  // Hidden at first: the canvas leads, and "+ Add node", "/" and every free
  // output's "+" open it.
  const [panelOpen, setPanelOpen] = useState(false);
  const [connectFrom, setConnectFrom] = useState(null);
  const [panelFocus, setPanelFocus] = useState(0);
  // Where the next node from the panel goes, when the panel was opened by
  // right-clicking the canvas: there, rather than after the rightmost node.
  const [addAt, setAddAt] = useState(null);
  // Bumped when the whole document is replaced, so the canvas re-frames it.
  const [fitToken, setFitToken] = useState(0);
  const [error, setError] = useState(null);

  const saver = useRef(makeGraphSaver()).current;
  // The saver and the keyboard handlers need the newest graph without
  // re-subscribing on every change.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;

  /**
   * Nothing may be written to disk before the initial load resolves. Without
   * this, any change React Flow reports while `graph` is still EMPTY_GRAPH would
   * persist an empty workflow over the candidate's saved one.
   */
  const loadedRef = useRef(false);

  useEffect(() => {
    saver.onState((state) => setSaveState(state));
  }, [saver]);

  // Live per-node progress. Cosmetic: if the socket never connects, runs still
  // work, they just complete without the play-by-play.
  useEffect(() => connectProgress((event) => {
    if (event.type === 'nodeStart') {
      setLiveStatus((current) => ({ ...current, [event.id]: 'running' }));
    } else if (event.type === 'nodeEnd') {
      setLiveStatus((current) => {
        const next = { ...current };
        delete next[event.id];
        return next;
      });
    } else if (event.type === 'runEnd') {
      setLiveStatus({});
    }
  }), []);

  useEffect(() => {
    let cancelled = false;
    api.loadScenario()
      .then((data) => {
        if (cancelled) return;
        setScenario(data.scenario);
        setGraph(normalise(data.graph));
        if (data.trace) setTrace(data.trace);
        loadedRef.current = true;
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, []);

  /**
   * The single write path for document changes: record the previous state for
   * undo, update React state, and schedule the debounced save.
   *
   * `graphRef` is assigned here as well as by the render-time assignment above,
   * so that two commits in one tick both see the newer graph.
   */
  const commit = useCallback((next) => {
    setHistory((current) => push(current, graphRef.current));
    graphRef.current = next;
    setGraph(next);
    if (loadedRef.current) saver.save(next);
  }, [saver]);

  const showToast = useCallback((message) => {
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? null : current)), 3200);
  }, []);

  const palette = scenario ? scenario.palette : [];
  const definitions = useMemo(
    () => Object.fromEntries(palette.map((p) => [p.type, p])),
    [palette],
  );
  const definitionsRef = useRef(definitions);
  definitionsRef.current = definitions;

  /* ── graph mutations ─────────────────────────────────────────────────── */

  const handleAddNode = useCallback((entry, position) => {
    const target = position || freeSpot(graphRef.current);
    const { graph: next, node } = addNode(graphRef.current, entry, target);
    commit(next);
    setSelectedIds([node.id]);
  }, [commit]);

  /**
   * Add from the node panel. In connect mode the new node is placed to the
   * right of the output it was asked for and wired to it, in ONE commit — so
   * one undo removes both, the way it was one gesture.
   */
  const handlePanelAdd = useCallback((entry) => {
    const current = graphRef.current;
    const source = connectFrom && current.nodes.find((n) => n.id === connectFrom.id);
    if (!source) {
      handleAddNode(entry, addAt || undefined);
      setAddAt(null);
      return;
    }
    const { graph: withNode, node } = addNode(
      current,
      entry,
      connectFrom.position || besideOutput(source, connectFrom),
    );
    const next = entry.inputs === 0
      ? withNode
      : addConnection(withNode, { from: source.id, fromOutput: connectFrom.port, to: node.id, toInput: 0 });
    commit(next);
    setSelectedIds([node.id]);
    setConnectFrom(null);
  }, [connectFrom, addAt, commit, handleAddNode]);

  /**
   * Open the panel ready to add the next step after a node's output: from its
   * "+" stub (placed beside the output), or from a wire dragged out of it and
   * dropped on empty canvas (placed at `position`, where it was dropped).
   */
  const handleAddAfter = useCallback((nodeId, port, position = null) => {
    const node = graphRef.current.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const definition = definitionsRef.current[node.type];
    // A tool's output only connects to an agent's Tools port, never to a new node.
    if (definition && definition.toolOutput) return;
    const outputs = definition ? effectiveOutputs(definition, node) : [];
    setConnectFrom({
      id: node.id,
      name: node.name,
      port,
      portCount: outputs.length,
      portName: outputs.length > 1 ? outputs[port]?.name : null,
      position,
    });
    setAddAt(null);
    setPanelOpen(true);
    setPanelFocus((n) => n + 1);
  }, []);

  /** Open the panel to add a node — at `position` if one is given. */
  const requestAdd = useCallback((position = null) => {
    setConnectFrom(null);
    setAddAt(position);
    setPanelOpen(true);
    setPanelFocus((n) => n + 1);
  }, []);

  /**
   * Called once when a drag finishes. React Flow renders the movement itself
   * from its own node state, so the document only needs the final positions —
   * which keeps a drag to one undo entry and one disk write.
   */
  const handleMoveNodes = useCallback((moves) => {
    const next = moveNodes(graphRef.current, moves);
    if (next === graphRef.current) return;
    const unchanged = moves.every(({ id, position }) => {
      const node = graphRef.current.nodes.find((n) => n.id === id);
      return node && node.position[0] === Math.round(position.x)
        && node.position[1] === Math.round(position.y);
    });
    if (unchanged) return;
    commit(next);
  }, [commit]);

  const handleConnect = useCallback((connection) => {
    const current = graphRef.current;
    if (wouldCycle(current, connection.from, connection.to)) {
      showToast('That connection would create a loop, which this simulation does not support.');
      return;
    }
    // A tool wire means "may call", not "sends items", so both ends must be
    // tool ports. Refused here with the reason, rather than drawn and then
    // failing the run.
    const typeOf = (id) => (current.nodes.find((n) => n.id === id) || {}).type;
    const fromDef = definitions[typeOf(connection.from)] || {};
    const toDef = definitions[typeOf(connection.to)] || {};
    const fromTool = Boolean(fromDef.toolOutput);
    const intoTools = Boolean(toDef.toolInput) && (connection.toInput || 0) === (toDef.inputs || 0);
    if (fromTool !== intoTools) {
      showToast(fromTool
        ? 'An AI Agent Tool connects to the Tools port on the bottom of an AI Agent.'
        : 'The Tools port only takes AI Agent Tools.');
      return;
    }
    commit(addConnection(current, connection));
  }, [commit, showToast, definitions]);

  const handleDeleteNodes = useCallback((ids) => {
    if (!ids.length) return;
    commit(removeNodes(graphRef.current, ids));
    setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
    setOpenNodeId((current) => (ids.includes(current) ? null : current));
  }, [commit]);

  const handleDuplicateNodes = useCallback((ids) => {
    const { graph: next, ids: created } = duplicateNodes(graphRef.current, ids);
    if (!created.length) return;
    commit(next);
    setSelectedIds(created);
  }, [commit]);

  const handleSetDisabled = useCallback((ids, disabled) => {
    commit(setNodesDisabled(graphRef.current, ids, disabled));
  }, [commit]);

  /* ── history ─────────────────────────────────────────────────────────── */

  const handleUndo = useCallback(() => {
    setHistory((current) => {
      const result = undo(current, graphRef.current);
      if (!result) return current;
      graphRef.current = result.graph;
      setGraph(result.graph);
      if (loadedRef.current) saver.save(result.graph);
      return result.history;
    });
  }, [saver]);

  const handleRedo = useCallback(() => {
    setHistory((current) => {
      const result = redo(current, graphRef.current);
      if (!result) return current;
      graphRef.current = result.graph;
      setGraph(result.graph);
      if (loadedRef.current) saver.save(result.graph);
      return result.history;
    });
  }, [saver]);

  /* ── execution ───────────────────────────────────────────────────────── */

  /**
   * Run the workflow, or — with `untilNode` — just that node and everything it
   * depends on. A partial run is deliberately not saved as the graded trace, so
   * the reminder matters: a candidate who only ever runs single nodes has not
   * produced a submittable run.
   */
  /**
   * Decisions made at approval nodes during THIS run.
   *
   * Every decision so far is re-sent with each execute, because resuming is
   * re-running with one more answer known — the engine is deterministic, so
   * there is no suspended state to hold on to. Starting a fresh run clears them.
   */
  const [decisions, setDecisions] = useState({});

  const handleExecute = useCallback(async (untilNode = null, withDecisions = null, options = {}) => {
    setRunning(true);
    setError(null);
    setLiveStatus({});

    // A new run from the top forgets previous answers; a resume carries them.
    const answers = withDecisions || {};
    if (!withDecisions) setDecisions({});

    try {
      await saver.flushNow();
      const { trace: result } = await api.execute(graphRef.current, {
        ...(untilNode ? { untilNode } : {}),
        ...(untilNode && options.inputOnly ? { inputOnly: true } : {}),
        ...(options.resumeFrom ? { resumeFrom: options.resumeFrom } : {}),
        ...(Object.keys(answers).length ? { decisions: answers } : {}),
      });
      setTrace(result);
      // Open the logs when there is something to act on or read; a clean run
      // leaves the canvas uncovered, its counts already on the connections.
      if (result.status !== 'completed' || result.partial) setLogOpen(true);
      if (result.status === 'error') {
        const first = (result.errors || [])[0];
        showToast(first ? `${first.node ? `${first.node}: ` : ''}${first.message}` : 'Execution failed.');
      } else if (result.status === 'paused') {
        // The prompt itself is shown in the run log, where the items are; a toast
        // on top of it would say the same thing twice.
      } else if (result.partial) {
        const ran = (result.nodes || []).filter((r) => r.status !== 'notRun' && !r.reused).length;
        showToast(result.inputOnly
          ? `Ran ${ran === 1 ? 'the node' : `the ${ran} nodes`} before this one. Execute the whole workflow before submitting.`
          : `Ran ${ran} node${ran === 1 ? '' : 's'}. Execute the whole workflow before submitting.`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
      setLiveStatus({});
    }
  }, [saver, showToast]);

  /** Answer the approval the run is waiting on, and carry on from there. */
  const handleDecide = useCallback((node, decision) => {
    const next = { ...decisions, [node]: decision };
    setDecisions(next);
    // Carry on from the approval: the nodes before it replay without being shown.
    handleExecute(null, next, { resumeFrom: node });
  }, [decisions, handleExecute]);

  /**
   * `credentialsOpen` is either false, or the credential TYPE to preselect —
   * so "Create one" inside a Slack node opens the panel already on Slack rather
   * than making someone find it in a list.
   */
  const [credentialsOpen, setCredentialsOpen] = useState(false);

  const handleAddCredential = useCallback((spec) => {
    const { graph: next, credential } = addCredential(graphRef.current, spec);
    commit(next);
    return credential.id;
  }, [commit]);

  const handleUpdateCredential = useCallback((id, patch) => {
    commit(updateCredential(graphRef.current, id, patch));
  }, [commit]);

  const handleRemoveCredential = useCallback((id) => {
    commit(removeCredential(graphRef.current, id));
  }, [commit]);

  /**
   * The two events the server cannot observe, reported from ONE place each.
   *
   * A node can be opened from the canvas, the run log, a context menu or a
   * keyboard shortcut, and the help panel from the header, a node's ? button or a
   * cross-reference inside the panel itself. Calling `api.activity` at each of
   * those would be seven call sites to keep in step, and the eighth would be
   * added without one. Watching the state instead means a new route in is
   * instrumented by construction.
   */
  useEffect(() => {
    if (!openNodeId) return;
    const node = graphRef.current.nodes.find((n) => n.id === openNodeId);
    if (node) api.activity('node.open', { node: node.name, nodeType: node.type });
  }, [openNodeId]);

  useEffect(() => {
    if (helpTopic) api.activity('help.open', { topic: helpTopic });
  }, [helpTopic]);

  const handleReset = useCallback(async () => {
    try {
      const { graph: fresh } = await api.reset();
      const next = normalise(fresh);
      setHistory((current) => push(current, graphRef.current));
      graphRef.current = next;
      setGraph(next);
      setTrace(null);
      setOpenNodeId(null);
      setSelectedIds([]);
      setLogOpen(false);
      setFitToken((n) => n + 1);
      showToast('Workflow reset. Undo is still available.');
    } catch (err) {
      setError(err.message);
    }
  }, [showToast]);

  /* ── keyboard ────────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKeyDown = (event) => {
      const mod = event.metaKey || event.ctrlKey;
      const target = event.target;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.isContentEditable;

      if (mod && event.key === 'Enter') {
        event.preventDefault();
        handleExecute();
        return;
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) handleRedo(); else handleUndo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        handleRedo();
        return;
      }
      if (event.key === 'Escape' && openNodeId) {
        setOpenNodeId(null);
        return;
      }
      if (event.key === 'Escape' && connectFrom && !typing) {
        setConnectFrom(null);
        return;
      }

      // Destructive and node-scoped shortcuts must never fire while the user is
      // typing in a parameter field, or with the detail view covering the canvas.
      if (typing || openNodeId) return;

      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        handleDuplicateNodes(selectedRef.current);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectedRef.current.length) return;
        event.preventDefault();
        handleDeleteNodes(selectedRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleExecute, handleUndo, handleRedo, handleDuplicateNodes, handleDeleteNodes, openNodeId,
    connectFrom]);

  /* ── render ──────────────────────────────────────────────────────────── */

  if (error && !scenario) {
    return (
      <div className="ca-loading body-medium">
        Could not load the simulation: {error}
      </div>
    );
  }
  if (!scenario) {
    return <div className="ca-loading body-medium">Loading Cosmo Automations…</div>;
  }

  const openNode = graph.nodes.find((n) => n.id === openNodeId) || null;
  const openDefinition = openNode ? definitions[openNode.type] : null;
  const openRecord = openNode && trace
    ? (trace.nodes || []).find((r) => r.id === openNode.id) || null
    : null;
  const openInputFallback = openNode && !(openRecord && openRecord.inputSample)
    ? lastRunInput(graph, trace, openNode.id)
    : null;

  const nodesById = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));

  return (
    <div className="ca-app">
      <Header
        title={scenario.title}
        saveState={saveState}
        canUndo={canUndo(history)}
        canRedo={canRedo(history)}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onHelp={() => setHelpTopic('overview')}
        onReset={handleReset}
        onCredentials={() => setCredentialsOpen(true)}
        credentialCount={credentialsOf(graph).length}
      />

      <div className="ca-workspace">
        <main className="ca-stage">
          <div className="ca-canvas-area">
            {/*
              The node panel floats over the canvas rather than squeezing it,
              so opening it never shifts the graph — a node dropped or
              right-clicked into place stays where you put it.
            */}
            <NodePanel
              palette={palette}
              open={panelOpen}
              onOpen={() => setPanelOpen(true)}
              onClose={() => { setPanelOpen(false); setConnectFrom(null); setAddAt(null); }}
              onAdd={handlePanelAdd}
              connectFrom={connectFrom
                ? { name: connectFrom.name, port: connectFrom.portName }
                : null}
              onCancelConnect={() => setConnectFrom(null)}
              focusToken={panelFocus}
            />

            <Canvas
              graph={graph}
              palette={palette}
              trace={trace}
              liveStatus={liveStatus}
              selectedIds={selectedIds}
              running={running}
              onAddNode={handleAddNode}
              onMoveNodes={handleMoveNodes}
              onConnect={handleConnect}
              onDisconnect={(connection) => commit(removeConnection(graphRef.current, connection))}
              onDeleteNodes={handleDeleteNodes}
              onDuplicateNodes={handleDuplicateNodes}
              onSetDisabled={handleSetDisabled}
              onSelectionChange={setSelectedIds}
              onOpenNode={(id) => { setSelectedIds([id]); setOpenNodeId(id); }}
              onExecuteNode={(id) => handleExecute(id)}
              onAddAfter={handleAddAfter}
              onRequestAdd={requestAdd}
              fitToken={fitToken}
              panelOpen={panelOpen}
            />

            {panelOpen ? null : (
              <div className="ca-canvas-tools">
                <Button
                  variant="secondary"
                  size="xsmall"
                  className="ca-canvas-tool"
                  onClick={() => requestAdd()}
                  title="Open the node panel (/)"
                >
                  <Icon name="plus" size={14} />
                  <span>Add node</span>
                  <Kbd>/</Kbd>
                </Button>
              </div>
            )}

            {/*
              The one Execute Workflow button: under the canvas it runs, right
              above the logs bar that reports how it went.
            */}
            <div className="ca-execute-bar">
              <Button
                variant="primary"
                size="small"
                className="ca-execute-button"
                onClick={() => handleExecute()}
                disabled={running}
                title="Run the whole workflow (⌘↵)"
              >
                {running ? <Spinner size={16} /> : <Icon name="play" size={16} />}
                <span>{running ? 'Executing…' : 'Execute Workflow'}</span>
              </Button>
            </div>

            {toast ? <div className="ca-toast body-xsmall" role="status">{toast}</div> : null}
          </div>

          <LogsPanel
            trace={trace}
            running={running}
            open={logOpen}
            onToggle={() => setLogOpen((o) => !o)}
            onOpenNode={(id) => { setSelectedIds([id]); setOpenNodeId(id); }}
            onDecide={handleDecide}
            definitions={definitions}
            nodesById={nodesById}
            liveAnswers={scenario ? scenario.liveAnswers : null}
          />
        </main>

        {openNode && openDefinition ? (
          <NodeDetail
            key={openNode.id}
            node={openNode}
            definition={openDefinition}
            record={openRecord}
            trace={trace}
            credentials={credentialsOf(graph)}
            credentialTypes={scenario.credentialTypes || []}
            onCreateCredential={(type) => setCredentialsOpen(type || true)}
            running={running}
            onClose={() => setOpenNodeId(null)}
            onRename={(name) => commit(renameNode(graphRef.current, openNode.id, name))}
            onParameterChange={(param, value) => commit(
              setNodeParameter(graphRef.current, openNode.id, param, value),
            )}
            onCredentialChange={(credentialId) => commit(
              updateNode(graphRef.current, openNode.id, { credentialId }),
            )}
            onToggleDisabled={(disabled) => handleSetDisabled([openNode.id], disabled)}
            onExecuteNode={() => handleExecute(openNode.id)}
            onExecutePrevious={() => handleExecute(openNode.id, null, { inputOnly: true })}
            inputFallback={openInputFallback}
            canExecuteNode={!openDefinition.toolOutput && (openDefinition.inputs === 0
              || graph.connections.some((c) => c.to === openNode.id))}
            onOpenDocs={() => setHelpTopic(`node:${openNode.type}`)}
          />
        ) : null}
      </div>

      <CredentialsModal
        open={Boolean(credentialsOpen)}
        initialType={typeof credentialsOpen === 'string' ? credentialsOpen : null}
        onClose={() => setCredentialsOpen(false)}
        credentialTypes={scenario.credentialTypes || []}
        credentials={credentialsOf(graph)}
        onAdd={handleAddCredential}
        onUpdate={handleUpdateCredential}
        onRemove={handleRemoveCredential}
      />

      <Modal
        open={Boolean(helpTopic)}
        onClose={() => setHelpTopic(null)}
        title="Help"
        size="xlarge"
        layout="panel"
      >
        <Help palette={palette} initialTopic={helpTopic} />
      </Modal>
    </div>
  );
}

/**
 * A graph from the server, with the pieces the canvas assumes guaranteed present.
 *
 * The THIRD place that listed the graph's parts by hand, and the third to drop
 * credentials when they were added — after the save endpoint and the execute
 * endpoint. Loading was the worst of the three: the credential saved fine, and
 * vanished on reload.
 *
 * If a fourth part of the graph ever appears, it needs adding here too. That is
 * the cost of an explicit list, and it is still the right trade: the alternative
 * is spreading whatever the server sent into the canvas's state.
 */
function normalise(graph) {
  return {
    version: 1,
    nodes: (graph && graph.nodes) || [],
    connections: (graph && graph.connections) || [],
    credentials: (graph && graph.credentials) || [],
  };
}

/**
 * Where a node added after `source`'s output `port` goes: one step to the
 * right, fanned vertically when the source has several outputs, so If's true
 * and false branches do not land on top of each other.
 */
function besideOutput(source, { port, portCount }) {
  const spread = portCount > 1 ? (port - (portCount - 1) / 2) * 160 : 0;
  return { x: source.position[0] + 220, y: source.position[1] + spread };
}

/** Place a keyboard-added node to the right of the rightmost existing one. */
function freeSpot(graph) {
  if (!graph.nodes.length) return { x: 120, y: 240 };
  const rightmost = graph.nodes.reduce(
    (best, n) => (n.position[0] > best.position[0] ? n : best),
    graph.nodes[0],
  );
  return { x: rightmost.position[0] + 220, y: rightmost.position[1] };
}
