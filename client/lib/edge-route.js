/**
 * How a connection is drawn, and where its "N items" label goes.
 *
 * Wires are drawn under nodes, so a wire that crosses a node looks like it runs
 * through it, and one that crosses a caption strikes through a name. Two rules
 * keep that from happening:
 *
 * 1. **Bend around nodes.** A wire is the usual bezier when that curve is
 *    clear of every tile, caption and port row. When it is not — a long wire
 *    past a node in the way, or a wire to a node below or behind its source —
 *    it is still a smooth curve, bent through the clearest lane: it leaves and
 *    enters its handles the same way, so it reads as the same kind of wire.
 * 2. **Place the label on a clear stretch.** The label slides along its route,
 *    outward from the middle, to the first spot clear of every tile and
 *    caption; if the whole route is crowded it tries just beside a handle;
 *    failing that it takes the least-covered spot.
 *
 * Pure geometry in flow coordinates, no DOM — which is what makes it testable
 * headlessly (test/edge-route.test.js).
 */

/** Matches React Flow's default bezier curvature, so we test the drawn curve. */
const CURVATURE = 0.25;

/** How far a detour's lane keeps from anything it passes. */
const MARGIN = 14;

/** At most this many detour shapes are tried per wire, shortest first. */
const MAX_SHAPES = 600;

/** Label positions along the route, as fractions of it: middle first, then out. */
const LABEL_SPOTS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.12, 0.88];

/** Breathing room kept between a label and anything it must not touch. */
const CLEARANCE = 4;

/** Caption metrics, matching `.ca-node-caption` in theme/canvas.css. */
const CAPTION = {
  gap: 8, maxWidth: 168, nameLine: 17, subLine: 16, nameChar: 7.4, subChar: 6.7, pad: 8,
};

/* ── obstacles ───────────────────────────────────────────────────────────── */

/**
 * The areas wires and labels must stay off: each node's tile, and the caption
 * under it sized to its actual text, so a short name does not block a lane
 * the width of the longest one.
 */
export function obstaclesFor(nodes) {
  const out = [];
  for (const node of nodes) {
    const width = node.measured?.width ?? node.width ?? 80;
    const height = node.measured?.height ?? node.height ?? 80;
    const { x, y } = node.position;
    out.push({ id: node.id, kind: 'tile', x, y, width, height });

    const name = node.data?.node?.name || '';
    const sub = node.data?.summary || '';
    const nameWidth = name.length * CAPTION.nameChar + CAPTION.pad;
    const nameLines = nameWidth > CAPTION.maxWidth ? 2 : 1;
    // An agent's Tools / Output Parser port row sits at the foot of its caption.
    const def = node.data?.definition;
    const toolsRow = def && (def.toolInput || def.parserInput) ? 26 : 0;
    const captionWidth = Math.min(
      CAPTION.maxWidth,
      Math.max(nameWidth, sub ? sub.length * CAPTION.subChar + CAPTION.pad : 0, 40),
    );
    out.push({
      id: node.id,
      kind: 'caption',
      x: x + width / 2 - captionWidth / 2,
      y: y + height + CAPTION.gap,
      width: captionWidth,
      height: nameLines * CAPTION.nameLine + (sub ? CAPTION.subLine : 0) + toolsRow,
    });

    // Right of the tile, one row per output (see `.ca-node-port`): a
    // multi-output node's port name, and on an unconnected output the stub —
    // line, item count, "+" button.
    const ports = node.data?.ports || [];
    const connected = node.data?.connectedOutputs;
    const counts = node.data?.outputCounts;
    ports.forEach((portName, index) => {
      const portY = ports.length > 1 ? y + ((index + 1) / (ports.length + 1)) * height : y + height / 2;
      const free = connected ? !connected.has(index) : false;
      let rowWidth = ports.length > 1 ? Math.min(96, portName.length * 6.6 + 8) : 0;
      if (free) {
        const count = counts ? counts[index] : null;
        rowWidth += 20 + 20;
        if (count !== null && count !== undefined) {
          rowWidth += `${count} ${count === 1 ? 'item' : 'items'}`.length * 6.4 + 8 + 10;
        }
      }
      if (rowWidth > 0) {
        out.push({
          id: node.id, kind: 'port', x: x + width + 8, y: portY - 10, width: rowWidth, height: 20,
        });
      }
    });
  }
  return out;
}

/* ── geometry ────────────────────────────────────────────────────────────── */

/** Does segment a→b pass through rectangle r (grown by pad)? Liang–Barsky. */
function segmentHits(a, b, r, pad = 0) {
  const minX = r.x - pad;
  const maxX = r.x + r.width + pad;
  const minY = r.y - pad;
  const maxY = r.y + r.height + pad;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a.x - minX) && clip(dx, maxX - a.x)
    && clip(-dy, a.y - minY) && clip(dy, maxY - a.y) && t0 < t1;
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1], points[i]);
  return total;
}

/** The point a fraction `f` of the way along a polyline. */
function pointAlong(points, f) {
  const target = polylineLength(points) * f;
  let walked = 0;
  for (let i = 1; i < points.length; i += 1) {
    const step = dist(points[i - 1], points[i]);
    if (walked + step >= target && step > 0) {
      const k = (target - walked) / step;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * k,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * k,
      };
    }
    walked += step;
  }
  return points[points.length - 1];
}

/* ── the bezier ──────────────────────────────────────────────────────────── */

function controlOffset(distance) {
  return distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);
}

function control(position, x1, y1, x2) {
  if (position === 'left') return [x1 - controlOffset(x1 - x2), y1];
  return [x1 + controlOffset(x2 - x1), y1];
}

/** Point at `t` on the bezier React Flow draws between two handles. */
export function pointOnEdge(edge, t) {
  const {
    sourceX, sourceY, targetX, targetY,
    sourcePosition = 'right', targetPosition = 'left',
  } = edge;
  const [c1x, c1y] = control(sourcePosition, sourceX, sourceY, targetX);
  const [c2x, c2y] = control(targetPosition, targetX, targetY, sourceX);
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * sourceX + b * c1x + c * c2x + d * targetX,
    y: a * sourceY + b * c1y + c * c2y + d * targetY,
  };
}

/** The bezier as a polyline, for collision tests and label placement. */
function bezierPolyline(edge, samples = 32) {
  return Array.from({ length: samples + 1 }, (_, i) => pointOnEdge(edge, i / samples));
}

/* ── collisions ──────────────────────────────────────────────────────────── */

/**
 * How many obstacles a polyline passes through. A wire starts on its source
 * tile's edge and ends on its target's, so the first and last segments are
 * allowed to touch those two tiles — and only those.
 */
function hitsOf(points, obstacles, edge, pad) {
  let hits = 0;
  for (const o of obstacles) {
    for (let i = 1; i < points.length; i += 1) {
      // A node's own port labels sit beside its own wires by design.
      const own = (o.kind === 'port' && o.id === edge.source)
        || (o.kind === 'tile'
          && ((i === 1 && o.id === edge.source) || (i === points.length - 1 && o.id === edge.target)));
      if (!own && segmentHits(points[i - 1], points[i], o, pad)) { hits += 1; break; }
    }
  }
  return hits;
}

/** A bezier is fine unless its body — away from the two handles — hits something. */
function bezierHits(edge, obstacles) {
  const points = bezierPolyline(edge);
  const body = points.slice(2, points.length - 2);
  return hitsOf(body, obstacles, { source: edge.source, target: null }, 2);
}

/* ── routing ─────────────────────────────────────────────────────────────── */

/**
 * Control points for a smooth curve through `points`: it leaves the first
 * point heading right and enters the last heading right, exactly like the
 * ordinary bezier, and passes each waypoint travelling horizontally — so a
 * detour reads as the same kind of wire, just bent around something.
 */
function smoothSegments(points) {
  const n = points.length;
  const tangent = (i) => {
    if (i === 0 || i === n - 1) {
      const other = points[i === 0 ? 1 : n - 2];
      return { x: Math.max(60, 1.5 * Math.abs(other.x - points[i].x), 0.5 * dist(points[i], other)), y: 0 };
    }
    const dx = (points[i + 1].x - points[i - 1].x) / 2;
    return { x: Math.sign(dx || 1) * Math.max(60, Math.abs(dx)), y: 0 };
  };
  const segments = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const ta = tangent(i);
    const tb = tangent(i + 1);
    segments.push({
      a,
      c1: { x: a.x + ta.x / 3, y: a.y + ta.y / 3 },
      c2: { x: b.x - tb.x / 3, y: b.y - tb.y / 3 },
      b,
    });
  }
  return segments;
}

function cubicAt({
  a, c1, c2, b,
}, t) {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** The smooth curve as an SVG path. */
export function smoothPath(segments) {
  const first = segments[0].a;
  return segments.reduce(
    (d, s) => `${d} C${s.c1.x},${s.c1.y} ${s.c2.x},${s.c2.y} ${s.b.x},${s.b.y}`,
    `M${first.x},${first.y}`,
  );
}

function sampleSegments(segments, perSegment = 16) {
  const out = [segments[0].a];
  for (const segment of segments) {
    for (let k = 1; k <= perSegment; k += 1) out.push(cubicAt(segment, k / perSegment));
  }
  return out;
}

/**
 * The best smooth detour: the fewest things crossed, then the shortest. A
 * forward wire bends through a clear lane above or below whatever is in the
 * way; a wire to a node behind or below its source swings out to the right,
 * runs back along a clear lane, and comes into its target from the left.
 */
function bestDetour(edge, obstacles) {
  const S = { x: edge.sourceX, y: edge.sourceY };
  const T = { x: edge.targetX, y: edge.targetY };
  const forward = T.x - S.x > 80;

  // Lanes run horizontally just above and below everything near the wire;
  // turns happen in the vertical gaps beside things. Only obstacles in the
  // wire's own neighbourhood are considered, which keeps the search small.
  const top = Math.min(S.y, T.y) - 240;
  const bottom = Math.max(S.y, T.y) + 240;
  const left = Math.min(S.x, T.x) - 160;
  const right = Math.max(S.x, T.x) + 160;
  const near = obstacles.filter((o) => !(o.x > right || o.x + o.width < left
    || o.y > bottom || o.y + o.height < top));

  const lanes = [S.y, T.y, (S.y + T.y) / 2];
  const turns = [];
  for (const o of near) {
    lanes.push(o.y - MARGIN, o.y + o.height + MARGIN);
    turns.push(o.x - MARGIN, o.x + o.width + MARGIN);
  }

  const shapes = [];
  if (forward) {
    const third = (T.x - S.x) / 3;
    const firstTurns = [S.x + third, ...turns.filter((x) => x > S.x + 24 && x < T.x - 24)];
    const lastTurns = [T.x - third, ...turns.filter((x) => x > S.x + 24 && x < T.x - 24)];
    for (const lane of lanes) {
      shapes.push([S, { x: (S.x + T.x) / 2, y: lane }, T]);
      for (const x1 of firstTurns) {
        for (const x2 of lastTurns) {
          if (x2 - x1 >= 40) shapes.push([S, { x: x1, y: lane }, { x: x2, y: lane }, T]);
        }
      }
    }
  } else {
    const reach = 60;
    for (const lane of lanes) {
      shapes.push([S, { x: S.x + reach, y: lane }, { x: T.x - reach, y: lane }, T]);
    }
  }

  // Shortest first, so the first clear shape is also the most direct one; the
  // cap keeps a pathological graph from stalling a drag.
  const ordered = shapes
    .map((points) => ({ points, estimate: polylineLength(points) }))
    .sort((a, b) => a.estimate - b.estimate)
    .slice(0, MAX_SHAPES);

  let best = null;
  for (const { points } of ordered) {
    const segments = smoothSegments(points);
    const samples = sampleSegments(segments, 12);
    const body = samples.slice(2, samples.length - 2);
    const hits = hitsOf(body, near, { source: edge.source, target: null }, MARGIN / 2);
    const cost = hits * 1e6 + polylineLength(samples);
    if (!best || cost < best.cost) best = { segments, samples, hits, cost };
    if (hits === 0) break;
  }
  return best;
}

/**
 * How to draw `edge` among `obstacles`. `edge` carries the handle coordinates
 * and positions plus `source` / `target` node ids. Returns `{ kind, path?,
 * points }`: `bezier` when the ordinary curve is clear (React Flow draws it),
 * otherwise `detour` with its own smooth SVG `path` — or `bezier` again if no
 * detour does better. `points` samples the drawn curve, for the label.
 */
export function routeEdge(edge, obstacles) {
  const bezier = bezierHits(edge, obstacles);
  if (bezier === 0) return { kind: 'bezier', points: bezierPolyline(edge), hits: 0 };
  const detour = bestDetour(edge, obstacles);
  if (detour && detour.hits < bezier) {
    return {
      kind: 'detour', path: smoothPath(detour.segments), points: detour.samples, hits: detour.hits,
    };
  }
  return { kind: 'bezier', points: bezierPolyline(edge), hits: bezier };
}

/* ── labels ──────────────────────────────────────────────────────────────── */

/** Roughly how big "12 items" renders: 11px text in a pill. */
export function labelSize(text) {
  return { width: Math.ceil(text.length * 6.4) + 14, height: 18 };
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The centre point for a label of `size` along a route (its polyline points),
 * avoiding `obstacles`. Returns `{ x, y, f }` — `f` the fraction along the
 * route, or `null` when the label had to go beside a handle.
 */
export function placeLabel(points, size, obstacles) {
  const first = points[0];
  const last = points[points.length - 1];
  const gap = 10;
  const spots = [
    ...LABEL_SPOTS.map((f) => ({ ...pointAlong(points, f), f })),
    // Beside the handles: right of the output, left of the input, above the wire.
    { x: first.x + gap + size.width / 2, y: first.y - size.height / 2 - 4, f: null },
    { x: last.x - gap - size.width / 2, y: last.y - size.height / 2 - 4, f: null },
    { x: first.x + gap + size.width / 2, y: first.y + size.height / 2 + 4, f: null },
  ];

  let best = null;
  for (const spot of spots) {
    const box = {
      x: spot.x - size.width / 2 - CLEARANCE,
      y: spot.y - size.height / 2 - CLEARANCE,
      width: size.width + 2 * CLEARANCE,
      height: size.height + 2 * CLEARANCE,
    };
    const cost = obstacles.reduce((sum, o) => sum + overlap(box, o), 0);
    if (cost === 0) return { x: spot.x, y: spot.y, f: spot.f };
    if (!best || cost < best.cost) best = { x: spot.x, y: spot.y, f: spot.f, cost };
  }
  return { x: best.x, y: best.y, f: best.f };
}
