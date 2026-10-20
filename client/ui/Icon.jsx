/**
 * UI chrome icons.
 *
 * Two sources, one rule: use the design system's icon when it has one, draw our
 * own only when it does not.
 *
 * - `DsIcon` renders a design system mask icon (`.icon .icon-<name>`). It covers
 *   search, trash and a few others, and it tracks the submodule rather than a
 *   copied asset.
 * - `Icon` draws the controls the design system's career/learning set has
 *   nothing for — undo, play, power, chevrons. Stroked with `currentColor`, so
 *   the surrounding token-driven colour still controls them.
 *
 * Separate from `canvas/NodeIcon.jsx`, which draws node *types*.
 */

const PATHS = {
  undo: <path d="M3.5 7.5h6.2a3.3 3.3 0 1 1 0 6.6H6M3.5 7.5l3-3M3.5 7.5l3 3" />,
  redo: <path d="M12.5 7.5H6.3a3.3 3.3 0 1 0 0 6.6H10M12.5 7.5l-3-3M12.5 7.5l-3 3" />,
  play: <path d="M4.5 3.2v9.6l8-4.8-8-4.8Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <path d="M5.5 3.5v9M10.5 3.5v9" />
    </>
  ),
  reset: (
    <>
      <path d="M2.6 8a5.4 5.4 0 1 0 1.9-4.1" />
      <path d="M2.3 2.4v3.2h3.2" />
    </>
  ),
  key: (
    <>
      <circle cx="5.6" cy="10.4" r="3.1" />
      <path d="M7.9 8.1 13.5 2.5" />
      <path d="M11.4 4.6l1.6 1.6M9.8 6.2l1.4 1.4" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.4 6.2a1.7 1.7 0 1 1 2.4 1.5c-.5.3-.8.6-.8 1.2" />
      <circle cx="8" cy="11.6" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.2 8.4 6.5 11.6 12.8 4.8" />,
  alert: (
    <>
      <path d="M8 4.2v4.6" />
      <circle cx="8" cy="11.4" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  power: (
    <>
      <path d="M8 2.5v5" />
      <path d="M4.6 4.8a4.8 4.8 0 1 0 6.8 0" />
    </>
  ),
  more: (
    <>
      <circle cx="3.6" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  'chevron-up': <path d="M4 10l4-4 4 4" />,
  'chevron-right': <path d="M6 4l4 4-4 4" />,
  'arrow-left': <path d="M13 8H3.5M7.5 4 3.5 8l4 4" />,
  'panel-left': (
    <>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.8" />
      <path d="M6.2 2.8v10.4" />
    </>
  ),
  book: (
    <>
      <path d="M8 4.2C6.6 3.2 4.6 3 2.6 3.3v9c2-.3 4 0 5.4 1 1.4-1 3.4-1.3 5.4-1v-9c-2-.3-4-.1-5.4.9Z" />
      <path d="M8 4.2v9.1" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3" />
    </>
  ),
  eye: (
    <>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M6.3 4C6.8 3.9 7.4 3.8 8 3.8c4 0 6.2 4.2 6.2 4.2a10 10 0 0 1-1.6 2.1M4.2 5.1A10 10 0 0 0 1.8 8S4 12.2 8 12.2c1.2 0 2.2-.4 3.1-.9" />
      <path d="M2.5 2.5l11 11" />
    </>
  ),
  logs: (
    <>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
    </>
  ),
  fx: (
    <>
      <path d="M6.6 2.8c-1.4 0-1.9.8-2.1 2.2L3.4 13.2" />
      <path d="M2.8 6.6h3.6" />
      <path d="M8.6 7.2l4.2 5M12.8 7.2l-4.2 5" />
    </>
  ),
  stack: (
    <>
      <path d="M8 2.4 13.6 5.2 8 8 2.4 5.2Z" />
      <path d="M2.4 8 8 10.8 13.6 8" />
      <path d="M2.4 10.8 8 13.6 13.6 10.8" />
    </>
  ),
  branch: (
    <>
      <circle cx="4" cy="3.6" r="1.4" />
      <circle cx="4" cy="12.4" r="1.4" />
      <circle cx="12" cy="6.4" r="1.4" />
      <path d="M4 5v6M4 9.4c0-2.2 1.6-3 6.6-3" />
    </>
  ),
  cursor: <path d="M3.5 2.5 12.5 7 8.4 8.4 7 12.5Z" />,
  'arrow-right': <path d="M3 8h9.5M8.5 4l4 4-4 4" />,
    drag: (
    <>
      <circle cx="6" cy="4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="6" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({ name, size = 16, title }) {
  return (
    <svg
      className="ca-icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}

/** A design system mask icon. `size`: small (16) | medium (24) | large | xlarge. */
export function DsIcon({ name, size = 'small', className }) {
  return (
    <span
      className={['icon', `icon-${name}`, size && `icon-${size}`, 'ca-ds-icon', className]
        .filter(Boolean).join(' ')}
      aria-hidden="true"
    />
  );
}

/** Indeterminate spinner for in-flight actions. */
export function Spinner({ size = 14 }) {
  return (
    <svg
      className="ca-spinner"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="6" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" />
    </svg>
  );
}
