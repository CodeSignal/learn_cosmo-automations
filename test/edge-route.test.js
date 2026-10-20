'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  pointOnEdge, obstaclesFor, labelSize, placeLabel, routeEdge,
} = require('../client/lib/edge-route.js');

const tile = (id, x, y, name = 'Node') => ({
  id, position: { x, y }, measured: { width: 80, height: 80 }, data: { node: { name }, summary: '' },
});

/** Handles sit mid-height on a tile's right (out) and left (in) edges. */
const edgeBetween = (a, b) => ({
  source: a.id,
  target: b.id,
  sourceX: a.position.x + 80,
  sourceY: a.position.y + 40,
  targetX: b.position.x,
  targetY: b.position.y + 40,
  sourcePosition: 'right',
  targetPosition: 'left',
});

const hits = (point, size, box) => (
  point.x + size.width / 2 > box.x && point.x - size.width / 2 < box.x + box.width
  && point.y + size.height / 2 > box.y && point.y - size.height / 2 < box.y + box.height
);

/** Does any segment of a polyline enter a box (other than its own end tiles)? */
function crosses(points, box) {
  for (let i = 1; i < points.length; i += 1) {
    for (let k = 0; k <= 20; k += 1) {
      const x = points[i - 1].x + (points[i].x - points[i - 1].x) * (k / 20);
      const y = points[i - 1].y + (points[i].y - points[i - 1].y) * (k / 20);
      if (x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height) return true;
    }
  }
  return false;
}

test('the curve starts at the source handle and ends at the target handle', () => {
  const edge = edgeBetween(tile('a', 0, 0), tile('b', 300, 100));
  assert.deepStrictEqual(pointOnEdge(edge, 0), { x: edge.sourceX, y: edge.sourceY });
  const end = pointOnEdge(edge, 1);
  assert.ok(Math.abs(end.x - edge.targetX) < 1e-9 && Math.abs(end.y - edge.targetY) < 1e-9);
});

test('an ordinary wire stays a bezier with its label in the middle', () => {
  const a = tile('a', 0, 0);
  const b = tile('b', 300, 0);
  const obstacles = obstaclesFor([a, b]);
  const route = routeEdge(edgeBetween(a, b), obstacles);
  assert.strictEqual(route.kind, 'bezier');
  assert.strictEqual(placeLabel(route.points, labelSize('3 items'), obstacles).f, 0.5);
});

test('a wire with a node in its way is routed around it', () => {
  // Source far left, target far right, a third node sitting right on the curve.
  const a = tile('a', 0, 0);
  const b = tile('b', 600, 200);
  const blocker = tile('blocker', 300, 80);
  const nodes = [a, b, blocker];
  const obstacles = obstaclesFor(nodes);
  const route = routeEdge(edgeBetween(a, b), obstacles);
  assert.strictEqual(route.kind, 'detour');
  for (const o of obstacles.filter((x) => x.id === 'blocker')) {
    assert.ok(!crosses(route.points, o), `route crosses the blocker's ${o.kind}`);
  }
});

test('a wire to the node directly below loops around the caption, not through it', () => {
  const top = tile('top', 0, 0, 'All Handled');
  const below = tile('below', 0, 150, 'Summarise Run');
  const obstacles = obstaclesFor([top, below]);
  const route = routeEdge(edgeBetween(top, below), obstacles);
  assert.strictEqual(route.kind, 'detour');
  const caption = obstacles.find((o) => o.id === 'top' && o.kind === 'caption');
  assert.ok(!crosses(route.points, caption));

  const size = labelSize('9 items');
  const placed = placeLabel(route.points, size, obstacles);
  assert.ok(!obstacles.some((o) => hits(placed, size, o)), 'the label spot is clear');
});

test('a detour is one smooth curve, starting and ending on the handles', () => {
  const a = tile('a', 0, 0);
  const b = tile('b', 600, 200);
  const blocker = tile('blocker', 300, 80);
  const edge = edgeBetween(a, b);
  const route = routeEdge(edge, obstaclesFor([a, b, blocker]));
  assert.match(route.path, new RegExp(`^M${edge.sourceX},${edge.sourceY} C`));
  assert.ok(!/ L/.test(route.path), 'only curves, no straight segments or corners');
  assert.ok(route.path.endsWith(` ${edge.targetX},${edge.targetY}`));
});

test('with nowhere clear, the least-covered label spot wins rather than nothing', () => {
  const a = tile('a', 0, 0);
  const b = tile('b', 300, 0);
  const route = routeEdge(edgeBetween(a, b), obstaclesFor([a, b]));
  const wall = { x: -1000, y: -1000, width: 3000, height: 3000 };
  const placed = placeLabel(route.points, labelSize('1 item'), [wall]);
  assert.ok(Number.isFinite(placed.x) && Number.isFinite(placed.y));
});
