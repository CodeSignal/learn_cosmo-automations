/**
 * The glyph names a node may ask for.
 *
 * The drawings live in `client/canvas/NodeIcon.jsx` — they are JSX and cannot be
 * imported by the engine — so the *names* live here, where the scenario validator
 * can check that a JSON-defined node asked for one that exists.
 *
 * An unknown name is a warning rather than an error: the client falls back to a
 * dot, so a typo costs an author a plain-looking node, not a broken task.
 *
 * `test/declarative-nodes.test.js` asserts every built-in node's icon appears
 * here, which is what stops this list drifting from the drawings.
 */

export const ICON_NAMES = [
  'play', 'webhook', 'clock',
  'filter', 'branch', 'switch', 'merge', 'loop', 'stop', 'dot', 'approval',
  'pencil', 'split', 'sort', 'limit', 'dedupe', 'code',
  'globe', 'chat', 'mail', 'grid', 'database', 'table', 'sparkle',
];

export function isKnownIcon(name) {
  return ICON_NAMES.includes(name);
}
