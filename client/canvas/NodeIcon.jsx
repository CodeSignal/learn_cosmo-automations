/**
 * Node glyphs.
 *
 * The design system's icon set is domain-specific (career tracks, lesson
 * types) and has nothing for "filter" or "webhook", so node types get their own
 * inline SVGs. They draw with `currentColor` so the surrounding token-driven
 * colour still controls them — no literal colours here either.
 */

const PATHS = {
  play: <path d="M4 2.5v11l9-5.5-9-5.5Z" />,
  webhook: (
    <>
      <circle cx="8" cy="4" r="2.2" />
      <path d="M8 6.2 5 11.2M8 6.2l3 5" />
      <circle cx="4" cy="12.5" r="2.2" />
      <circle cx="12" cy="12.5" r="2.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 4.6V8l2.6 1.6" />
    </>
  ),
  filter: <path d="M2 3h12l-4.6 5.4V13L6.6 11.4V8.4L2 3Z" />,
  branch: (
    <>
      <path d="M3 3v3.5c0 1.4 1.1 2.5 2.5 2.5H13" />
      <path d="M3 13V9.5" />
      <path d="M10.5 6 13 9l-2.5 3" />
    </>
  ),
  pencil: <path d="M11.2 2.4l2.4 2.4L5.4 13H3v-2.4l8.2-8.2Z" />,
  split: (
    <>
      <path d="M2 8h4" />
      <path d="M6 8 11 4M6 8l5 4" />
      <circle cx="12.6" cy="3.6" r="1.4" />
      <circle cx="12.6" cy="12.4" r="1.4" />
    </>
  ),
  merge: (
    <>
      <path d="M14 8h-4" />
      <path d="M10 8 5 4M10 8l-5 4" />
      <circle cx="3.4" cy="3.6" r="1.4" />
      <circle cx="3.4" cy="12.4" r="1.4" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6M8 2.2c1.7 1.6 2.6 3.6 2.6 5.8S9.7 12.2 8 13.8C6.3 12.2 5.4 10.2 5.4 8S6.3 3.8 8 2.2Z" />
    </>
  ),
  chat: <path d="M2.6 3h10.8v7.4H7.2L4 13.2V10.4H2.6V3Z" />,
  stop: <rect x="3" y="3" width="10" height="10" rx="1.6" />,
  code: (
    <>
      <path d="M6 5.5 3 8l3 2.5" />
      <path d="M10 5.5 13 8l-3 2.5" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="3.2" />,
  approval: (
    <>
      <path d="M3 8.4 6.2 11.6 13 4.8" />
      <path d="M2.4 13.6h11.2" />
    </>
  ),
  sparkle: (
    <>
      <path d="M8 1.8 9.5 6.1 13.8 7.6 9.5 9.1 8 13.4 6.5 9.1 2.2 7.6 6.5 6.1Z" />
      <path d="M12.8 11.4 13.4 13.1 15.1 13.7 13.4 14.3 12.8 16 12.2 14.3 10.5 13.7 12.2 13.1Z" />
    </>
  ),
  switch: (
    <>
      <path d="M2 8h3.5" />
      <path d="M5.5 8 10 4.2M5.5 8H10M5.5 8 10 11.8" />
      <circle cx="12" cy="4.2" r="1.3" />
      <circle cx="12" cy="8" r="1.3" />
      <circle cx="12" cy="11.8" r="1.3" />
    </>
  ),
  sort: (
    <>
      <path d="M2.5 4h9M2.5 8h6M2.5 12h3" />
      <path d="M12.5 9.5 14 11l1.5-1.5" />
    </>
  ),
  limit: (
    <>
      <path d="M2.5 4h11M2.5 8h11" />
      <path d="M3.5 11.5 12.5 11.5" strokeDasharray="1.6 1.8" />
    </>
  ),
  dedupe: (
    <>
      <rect x="2.2" y="2.2" width="7" height="7" rx="1.2" />
      <path d="M11 6.5h2.8v7.3H6.5" />
    </>
  ),
  loop: (
    <>
      <path d="M4 6.5A4 4 0 0 1 12 7.5" />
      <path d="M12 9.5A4 4 0 0 1 4 8.5" />
      <path d="M11.6 4.4 12.2 7.6 9.2 7" />
      <path d="M4.4 11.6 3.8 8.4 6.8 9" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.4" />
      <path d="M2.6 4.4 8 8.6l5.4-4.2" />
    </>
  ),
  grid: (
    <>
      <rect x="2.2" y="2.7" width="11.6" height="10.6" rx="1.3" />
      <path d="M2.2 6.2h11.6M2.2 9.8h11.6M6.5 2.7v10.6" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="4" rx="5.2" ry="2" />
      <path d="M2.8 4v8c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V4" />
      <path d="M2.8 8c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2" />
    </>
  ),
  table: (
    <>
      <rect x="2.2" y="2.7" width="11.6" height="10.6" rx="2.4" />
      <path d="M2.2 8h11.6M8 2.7v10.6" />
    </>
  ),
};

export function NodeIcon({ name = 'dot', title }) {
  const filled = name === 'play' || name === 'filter' || name === 'pencil'
    || name === 'chat' || name === 'dot' || name === 'sparkle';
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name] || PATHS.dot}
    </svg>
  );
}

/**
 * A node type's glyph in its group colour — the one way a node type is drawn
 * everywhere it appears (canvas tile, node panel, menus, detail view, help).
 *
 * `size`: `sm` (lists and menus), `md` (node panel rows), `lg` (canvas tile).
 * `tile`: draw the tinted square behind it; the canvas tile is its own square,
 * so it draws the glyph bare.
 */
export function NodeGlyph({ group, icon, size = 'md', tile = true }) {
  return (
    <span
      className={[
        'ca-glyph', `ca-glyph-${size}`, `ca-glyph-${group || 'data'}`, tile && 'ca-glyph-tile',
      ].filter(Boolean).join(' ')}
    >
      <NodeIcon name={icon} />
    </span>
  );
}
