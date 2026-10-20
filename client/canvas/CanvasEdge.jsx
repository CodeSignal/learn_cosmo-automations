import { useMemo } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, getBezierPath, useNodes,
} from '@xyflow/react';
import { DsIcon } from '../ui/Icon.jsx';
import {
  labelSize, obstaclesFor, placeLabel, routeEdge,
} from '../lib/edge-route.js';

/**
 * A connection: a wire with its item count riding on it after a run, and a
 * delete button when it is selected.
 *
 * The count is per connection, which is what makes a two-input node legible —
 * Merge's two inputs each arrive on their own labelled wire, so `4` and `8`
 * are visible before anyone sees the `12` going in.
 *
 * The wire is the usual bezier when that curve is clear, and a smooth detour
 * around the nodes when it is not; the label sits on a clear stretch of
 * whichever it is (`lib/edge-route.js`).
 *
 * Under every wire runs a halo in the canvas colour, a little wider than the
 * wire. Where two wires cross, the one on top cuts a small gap in the one
 * below — the way a transit map shows which line is which — so a crossing
 * reads as two wires rather than a junction.
 */
export function CanvasEdge({
  id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  markerEnd, selected, data,
}) {
  const count = data ? data.count : null;
  const hasCount = count !== null && count !== undefined;
  const text = hasCount ? `${count} ${count === 1 ? 'item' : 'items'}` : '';

  // Routes depend only on where things are and how big their text is, so
  // selecting or hovering a node must not re-route every wire.
  const nodes = useNodes();
  const geometry = geometryKey(nodes);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const obstacles = useMemo(() => obstaclesFor(nodes), [geometry]);

  const { path, label } = useMemo(() => {
    const edge = {
      source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    };
    // A tool wire runs from a tool's top edge up to an agent's Tools port. It
    // carries no items, so it has no label to place and keeps React Flow's
    // own top-to-bottom curve.
    if (data?.tool) {
      const [toolPath, midX, midY] = getBezierPath({
        sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
      });
      return { path: toolPath, label: { x: midX, y: midY } };
    }
    const route = routeEdge(edge, obstacles);
    const d = route.kind === 'detour'
      ? route.path
      : getBezierPath({
        sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
      })[0];
    // A selected edge also shows its delete button beside the count.
    const size = selected
      ? { width: labelSize(text).width + 30, height: 24 }
      : labelSize(text);
    return { path: d, label: placeLabel(route.points, size, obstacles) };
  }, [source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    text, selected, obstacles, data?.tool]);

  return (
    <>
      <path d={path} className="ca-edge-halo" />
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={18} />
      {hasCount || selected ? (
        <EdgeLabelRenderer>
          <div
            className={`ca-edge-label nodrag nopan${data?.emphasis ? ` is-${data.emphasis}` : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
          >
            {hasCount ? (
              <span className={`ca-edge-count body-xxsmall${count === 0 ? ' is-empty' : ''}`}>
                {text}
              </span>
            ) : null}
            {selected && data?.onDelete ? (
              <button
                type="button"
                className="ca-edge-delete"
                onClick={data.onDelete}
                aria-label="Delete connection"
                title="Delete connection"
              >
                <DsIcon name="trash" />
              </button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

/** Everything about the nodes that routing reads, as one comparable string. */
function geometryKey(nodes) {
  return nodes.map((n) => {
    const d = n.data || {};
    return [
      n.id, n.position.x, n.position.y, n.measured?.width, n.measured?.height,
      d.node?.name, d.summary, (d.ports || []).join('|'),
      d.connectedOutputs ? [...d.connectedOutputs].join('|') : '',
      (d.outputCounts || []).join('|'),
    ].join(',');
  }).join(';');
}
