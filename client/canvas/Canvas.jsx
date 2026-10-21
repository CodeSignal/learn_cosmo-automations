import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls,
  ReactFlowProvider, useReactFlow, applyNodeChanges, applyEdgeChanges,
} from '@xyflow/react';
import { NodeCard } from './NodeCard.jsx';
import { CanvasEdge } from './CanvasEdge.jsx';
import { ContextMenu } from './ContextMenu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { summariseNode } from '../../shared/summarise.mjs';
import { effectiveOutputs } from '../../shared/node-ports.mjs';

const NODE_TYPES = { automation: NodeCard };
const EDGE_TYPES = { automation: CanvasEdge };

/** Half the tile, so a dropped or menu-added node lands centred on the cursor. */
const DROP_OFFSET = { x: 40, y: 40 };

/**
 * The canvas.
 *
 * ┌─ How state is split, and why ──────────────────────────────────────────┐
 * │ The GRAPH is the document: node ids, types, parameters, positions and   │
 * │ connections. It is what gets persisted and graded.                      │
 * │                                                                        │
 * │ REACT FLOW owns transient interaction state, and it keeps it ON THE     │
 * │ NODE OBJECTS — `measured` dimensions, `dragging`, `selected`. That is   │
 * │ why the node array must be React Flow's own state, mutated through      │
 * │ `applyNodeChanges`, rather than a fresh array derived from the graph on  │
 * │ every render: deriving it discards `measured`, so nodes never finish    │
 * │ initialising and dragging fails outright with React Flow error #015.    │
 * │                                                                        │
 * │ So: changes flow into `rfNodes` via applyNodeChanges (smooth drag, real │
 * │ measurement), and only *document-level* outcomes — a finished drag, a   │
 * │ deletion, a new connection — are pushed back into the graph.            │
 * └────────────────────────────────────────────────────────────────────────┘
 */
function CanvasInner({
  graph, palette, trace, liveStatus, selectedIds, running,
  onAddNode, onMoveNodes, onConnect, onDisconnect,
  onSelectionChange, onOpenNode, onDeleteNodes, onDuplicateNodes, onSetDisabled,
  onExecuteNode, onAddAfter, onRequestAdd, fitToken, panelOpen,
}) {
  const wrapperRef = useRef(null);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [menu, setMenu] = useState(null);

  const [rfNodes, setRfNodes] = useState([]);

  /**
   * The node panel floats over the canvas's left edge. While it is open, the
   * zoom controls move out from under it and "fit view" frames the graph in
   * the visible area to its right — the panel itself never moves the graph.
   */
  const [panelInset, setPanelInset] = useState(0);
  useLayoutEffect(() => {
    const panel = panelOpen
      ? wrapperRef.current?.parentElement?.querySelector('.ca-nodes-panel')
      : null;
    setPanelInset(panel ? panel.offsetWidth : 0);
  }, [panelOpen]);
  const fitOptions = useMemo(() => (panelInset
    ? { ...FIT_VIEW, padding: { top: 0.16, bottom: 0.16, right: 0.16, left: `${panelInset + 48}px` } }
    : FIT_VIEW), [panelInset]);

  /**
   * What the pointer is over, so its connections can be picked out of a busy
   * graph: hovering a node or a wire brings its wires forward and fades the
   * rest. Selection highlights a node's wires too, without fading anything.
   */
  const [hovered, setHovered] = useState(null);
  const [rfEdges, setRfEdges] = useState([]);

  const definitions = useMemo(
    () => Object.fromEntries(palette.map((p) => [p.type, p])),
    [palette],
  );

  const recordsByNodeId = useMemo(() => {
    if (!trace) return {};
    return Object.fromEntries((trace.nodes || []).map((r) => [r.id, r]));
  }, [trace]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  /** Which output ports of each node already have a connection. */
  const connectedOutputs = useMemo(() => {
    const byNode = {};
    for (const c of graph.connections) {
      (byNode[c.from] = byNode[c.from] || new Set()).add(c.fromOutput || 0);
    }
    return byNode;
  }, [graph.connections]);

  /** What the document says the nodes should look like right now. */
  const desiredNodes = useMemo(() => graph.nodes.map((node) => {
    const definition = definitions[node.type] || {
      label: node.type, group: 'data', icon: 'dot', inputs: 1, outputs: [{ name: 'main' }],
    };
    const record = recordsByNodeId[node.id] || null;
    return {
      id: node.id,
      type: 'automation',
      position: { x: node.position[0], y: node.position[1] },
      selected: selected.has(node.id),
      data: {
        node,
        definition,
        record,
        live: (liveStatus || {})[node.id] || null,
        running,
        summary: summariseNode(node.type, node.parameters, definition),
        // Port names, so connections can keep their labels off them.
        ports: definition.toolOutput || definition.parserOutput ? [] : effectiveOutputs(definition, node).map((o) => o.name),
        connectedOutputs: connectedOutputs[node.id] || EMPTY_SET,
        outputCounts: record && record.outputsByPort
          ? record.outputsByPort.map((p) => p.count)
          : null,
        onOpen: () => onOpenNode(node.id),
        onExecute: () => onExecuteNode(node.id),
        onToggleDisabled: () => onSetDisabled([node.id], !node.disabled),
        onDelete: () => onDeleteNodes([node.id]),
        onAddAfter: (port) => onAddAfter(node.id, port),
      },
    };
  }), [graph.nodes, definitions, recordsByNodeId, liveStatus, selected, running, connectedOutputs,
    onOpenNode, onExecuteNode, onSetDisabled, onDeleteNodes, onAddAfter]);

  /** A subagent wire: drawn dashed, never labelled with an item count. */
  const isToolWire = useCallback((c) => {
    const from = graph.nodes.find((n) => n.id === c.from);
    const def = from && definitions[from.type];
    return Boolean(def && (def.toolOutput || def.parserOutput));
  }, [graph.nodes, definitions]);

  const desiredEdges = useMemo(() => graph.connections.map((c) => {
    const record = recordsByNodeId[c.from];
    const port = c.fromOutput || 0;
    const byPort = record && record.outputsByPort ? record.outputsByPort[port] : null;
    const count = byPort ? byPort.count : null;
    const id = `${c.from}:${port}->${c.to}:${c.toInput || 0}`;
    const tool = isToolWire(c);

    let emphasis = null;
    if (hovered) {
      const related = hovered.kind === 'edge'
        ? hovered.id === id
        : (c.from === hovered.id || c.to === hovered.id);
      emphasis = related ? 'related' : 'dimmed';
    } else if (selected.has(c.from) || selected.has(c.to)) {
      emphasis = 'related';
    }

    return {
      id,
      type: 'automation',
      source: c.from,
      sourceHandle: `out-${port}`,
      target: c.to,
      targetHandle: `in-${c.toInput || 0}`,
      className: [
        tool ? 'ca-edge-tool' : null,
        count === null || tool ? null : (count > 0 ? 'ca-edge-active' : 'ca-edge-empty'),
        emphasis && `is-${emphasis}`,
      ].filter(Boolean).join(' ') || undefined,
      data: {
        connection: c,
        // A tool wire means "may call", not "sends items": it has no count.
        count: tool ? null : count,
        tool,
        emphasis,
        onDelete: () => onDisconnect(c),
      },
    };
  }), [graph.connections, recordsByNodeId, onDisconnect, hovered, selected, isToolWire]);

  /**
   * Reconcile the document into React Flow's state, carrying each surviving
   * node's React Flow-owned fields across. A node being dragged keeps its live
   * position so the document cannot yank it back mid-gesture.
   */
  useEffect(() => {
    setRfNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return desiredNodes.map((desired) => {
        const previous = byId.get(desired.id);
        if (!previous) return desired;
        return {
          ...previous,
          data: desired.data,
          selected: desired.selected,
          position: previous.dragging ? previous.position : desired.position,
        };
      });
    });
  }, [desiredNodes]);

  useEffect(() => {
    setRfEdges((current) => {
      const byId = new Map(current.map((e) => [e.id, e]));
      return desiredEdges.map((desired) => {
        const previous = byId.get(desired.id);
        return previous ? { ...previous, ...desired } : desired;
      });
    });
  }, [desiredEdges]);

  /**
   * Re-frame the workflow when the document is replaced wholesale (a reset),
   * after React Flow has measured the new nodes.
   */
  useEffect(() => {
    if (!fitToken) return undefined;
    const timer = setTimeout(() => fitView({ ...fitOptions, duration: 200 }), 60);
    return () => clearTimeout(timer);
    // Only a document swap re-frames; opening the panel must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken, fitView]);

  /**
   * Every change goes into React Flow's state — including `dimensions`, which is
   * how nodes become measured and therefore draggable. Only removals and
   * selection are also reported upward; positions wait for drag stop.
   */
  const handleNodesChange = useCallback((changes) => {
    setRfNodes((current) => applyNodeChanges(changes, current));

    const removals = [];
    const selectionOn = [];
    const selectionOff = [];
    for (const change of changes) {
      if (change.type === 'remove') removals.push(change.id);
      if (change.type === 'select') (change.selected ? selectionOn : selectionOff).push(change.id);
    }

    if (removals.length) onDeleteNodes(removals);
    if (selectionOn.length || selectionOff.length) {
      onSelectionChange((currentSelection) => {
        const next = new Set(currentSelection);
        for (const id of selectionOn) next.add(id);
        for (const id of selectionOff) next.delete(id);
        return [...next];
      });
    }
  }, [onDeleteNodes, onSelectionChange]);

  const handleEdgesChange = useCallback((changes) => {
    setRfEdges((current) => applyEdgeChanges(changes, current));
    for (const change of changes) {
      if (change.type !== 'remove') continue;
      const edge = rfEdges.find((e) => e.id === change.id);
      if (edge?.data?.connection) onDisconnect(edge.data.connection);
    }
  }, [rfEdges, onDisconnect]);

  /** One undo entry and one disk write per drag, taken at the end. */
  const handleDragStop = useCallback((_event, _node, draggedNodes) => {
    const moves = (draggedNodes || []).map((n) => ({ id: n.id, position: n.position }));
    if (moves.length) onMoveNodes(moves);
  }, [onMoveNodes]);

  /**
   * A connection dragged out of an output and dropped on empty canvas asks
   * for a new node there: the node panel opens, and whatever is picked lands
   * where the wire was dropped, already connected. A drag that barely moved is
   * a click on the "+", which the button itself handles.
   */
  const connectStart = useRef(null);
  const handleConnectStart = useCallback((event) => {
    const point = 'touches' in event ? event.touches[0] : event;
    connectStart.current = point ? { x: point.clientX, y: point.clientY } : null;
  }, []);

  const handleConnectEnd = useCallback((event, state) => {
    const start = connectStart.current;
    connectStart.current = null;
    if (!state || state.isValid || !state.fromNode || !state.fromHandle) return;
    if (state.fromHandle.type !== 'source') return;
    if (!event.target?.classList?.contains('react-flow__pane')) return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (start && Math.hypot(point.clientX - start.x, point.clientY - start.y) < 8) return;
    const at = screenToFlowPosition({ x: point.clientX, y: point.clientY });
    onAddAfter(state.fromNode.id, portIndex(state.fromHandle.id), {
      x: at.x - DROP_OFFSET.x, y: at.y - DROP_OFFSET.y,
    });
  }, [screenToFlowPosition, onAddAfter]);

  const handleConnect = useCallback((params) => {
    onConnect({
      from: params.source,
      fromOutput: portIndex(params.sourceHandle),
      to: params.target,
      toInput: portIndex(params.targetHandle),
    });
  }, [onConnect]);

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/cosmo-node');
    if (!type) return;
    const entry = definitions[type];
    if (!entry) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    // Drop point is the cursor; offset so the card lands centred on it.
    onAddNode(entry, { x: position.x - DROP_OFFSET.x, y: position.y - DROP_OFFSET.y });
  }, [definitions, screenToFlowPosition, onAddNode]);

  /**
   * Enter opens the focused node's settings. React Flow makes nodes focusable
   * but does not bind Enter, and the detail view must be reachable without a
   * mouse.
   */
  const handleKeyDown = useCallback((event) => {
    // A selected connection is deleted from the keyboard here; nodes are the
    // app's job, so that deletion can be undone and never fires mid-typing.
    if ((event.key === 'Delete' || event.key === 'Backspace')
      && event.target.closest?.('.react-flow')) {
      const edge = rfEdges.find((e) => e.selected);
      if (edge?.data?.connection) {
        event.preventDefault();
        onDisconnect(edge.data.connection);
      }
      return;
    }
    if (event.key !== 'Enter') return;
    const host = event.target.closest?.('.react-flow__node');
    if (!host || !host.dataset.id) return;
    event.preventDefault();
    onOpenNode(host.dataset.id);
  }, [onOpenNode, rfEdges, onDisconnect]);

  /* ── context menus ─────────────────────────────────────────────────── */

  const openPaneMenu = useCallback((event) => {
    event.preventDefault();
    const flowPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        // Opens the node panel; the node picked lands where you right-clicked.
        {
          label: 'Add node…',
          hint: '/',
          onSelect: () => onRequestAdd({ x: flowPosition.x - DROP_OFFSET.x, y: flowPosition.y - DROP_OFFSET.y }),
        },
        {
          label: 'Fit view', separatorBefore: true,
          onSelect: () => fitView(fitOptions),
        },
        {
          label: 'Select all nodes',
          disabled: !graph.nodes.length,
          onSelect: () => onSelectionChange(graph.nodes.map((n) => n.id)),
        },
      ],
    });
  }, [screenToFlowPosition, onRequestAdd, fitView, fitOptions, graph.nodes, onSelectionChange]);

  const openNodeMenu = useCallback((event, rfNode) => {
    event.preventDefault();
    // Right-clicking outside the current selection acts on that node alone,
    // which is what every graph editor does.
    const ids = selected.has(rfNode.id) && selected.size > 1 ? [...selected] : [rfNode.id];
    const node = graph.nodes.find((n) => n.id === rfNode.id);
    if (!node) return;
    if (ids.length === 1) onSelectionChange(ids);

    const many = ids.length > 1;
    const allDisabled = ids.every((id) => graph.nodes.find((n) => n.id === id)?.disabled);

    setMenu({
      x: event.clientX,
      y: event.clientY,
      title: many ? `${ids.length} nodes selected` : node.name,
      items: [
        ...(many ? [] : [
          { label: 'Open settings', hint: '⏎', onSelect: () => onOpenNode(node.id) },
          { label: 'Execute Node', disabled: running, onSelect: () => onExecuteNode(node.id) },
        ]),
        { label: many ? 'Duplicate nodes' : 'Duplicate', hint: '⌘D', onSelect: () => onDuplicateNodes(ids) },
        {
          label: allDisabled ? 'Enable' : 'Disable',
          onSelect: () => onSetDisabled(ids, !allDisabled),
        },
        {
          label: many ? `Delete ${ids.length} nodes` : 'Delete',
          hint: '⌫',
          danger: true,
          separatorBefore: true,
          onSelect: () => onDeleteNodes(ids),
        },
      ],
    });
  }, [selected, graph.nodes, running, onSelectionChange, onOpenNode, onExecuteNode,
    onDuplicateNodes, onSetDisabled, onDeleteNodes]);

  const openEdgeMenu = useCallback((event, edge) => {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      title: 'Connection',
      items: [{
        label: 'Delete connection',
        danger: true,
        onSelect: () => onDisconnect(edge.data.connection),
      }],
    });
  }, [onDisconnect]);

  return (
    <div className="ca-canvas" ref={wrapperRef} onKeyDown={handleKeyDown}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeDragStop={handleDragStop}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        // A click on a handle is the "+" button's job, not a click-to-connect.
        connectOnClick={false}
        onNodeDoubleClick={(_, node) => onOpenNode(node.id)}
        onNodeContextMenu={openNodeMenu}
        onNodeMouseEnter={(_, node) => setHovered({ kind: 'node', id: node.id })}
        onNodeMouseLeave={() => setHovered(null)}
        onEdgeMouseEnter={(_, edge) => setHovered({ kind: 'edge', id: edge.id })}
        onEdgeMouseLeave={() => setHovered(null)}
        onNodeDragStart={() => setHovered(null)}
        onEdgeContextMenu={openEdgeMenu}
        onPaneContextMenu={openPaneMenu}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        minZoom={0.3}
        maxZoom={1.6}
        snapToGrid
        snapGrid={[20, 20]}
        // Deletion is handled by the app so it can be undone and so it can never
        // be triggered from an unexpected focus context.
        deleteKeyCode={null}
        multiSelectionKeyCode={['Meta', 'Shift', 'Control']}
        // React Flow zooms on double-click by default, which swallows the
        // open-settings gesture candidates expect from every tool in this space.
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        nodesFocusable
        edgesFocusable
        fitView
        fitViewOptions={FIT_VIEW}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
        <Controls
          showInteractive={false}
          position="bottom-left"
          fitViewOptions={fitOptions}
          style={{ transform: `translateX(${panelInset}px)` }}
        />
      </ReactFlow>

      {graph.nodes.length === 0 ? (
        <div className="ca-canvas-empty">
          <button type="button" className="ca-canvas-empty-add" onClick={() => onRequestAdd()}>
            <span className="ca-canvas-empty-plus" aria-hidden="true"><Icon name="plus" size={28} /></span>
            <span className="body-small">Add first step</span>
          </button>
          <p className="ca-canvas-empty-hint body-xxsmall">
            Every workflow starts with a trigger. Pick one from the node panel, or
            drag it onto the canvas.
          </p>
        </div>
      ) : null}

      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

const EMPTY_SET = new Set();
// Room beyond the tiles for what React Flow does not measure: captions below,
// port rows and "+" stubs to the right.
const FIT_VIEW = { padding: 0.16, maxZoom: 1 };

/** `out-2`, `in-1` and the "+" handle `out-2-plus` all name their port number. */
function portIndex(handleId) {
  const match = /^(?:in|out)-(\d+)/.exec(handleId || '');
  return match ? Number(match[1]) : 0;
}

export function Canvas(props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
