import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Canvas context menu.
 *
 * Items are `{ label, hint, onSelect, danger, disabled, separatorBefore }`.
 * Adding a node is not a submenu: "Add node…" opens the node panel, the one
 * place nodes are browsed and searched. Closes on Escape, on
 * outside click, and on selecting anything; arrow keys move, Enter activates.
 */
export function ContextMenu({ menu, onClose }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });

  // Flip the menu back inside the viewport rather than letting it clip.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let { x, y } = menu;
    if (rect.width && x + rect.width > window.innerWidth - 8) {
      x = Math.max(8, window.innerWidth - rect.width - 8);
    }
    if (rect.height && y + rect.height > window.innerHeight - 8) {
      y = Math.max(8, window.innerHeight - rect.height - 8);
    }
    setPosition({ x, y });
  }, [menu]);

  useEffect(() => {
    const onPointerDown = (event) => {
      if (!ref.current?.contains(event.target)) onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    // Capture phase: the canvas also listens for pointerdown.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  useEffect(() => {
    // Focus the first item so the menu is immediately keyboard-operable.
    ref.current?.querySelector('button:not(:disabled)')?.focus();
  }, []);

  const moveFocus = (event, delta) => {
    const items = [...ref.current.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    items[(index + delta + items.length) % items.length].focus();
  };

  return (
    <div
      className="ca-menu"
      ref={ref}
      style={{ left: position.x, top: position.y }}
      role="menu"
      aria-label={menu.title || 'Canvas actions'}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') moveFocus(event, 1);
        if (event.key === 'ArrowUp') moveFocus(event, -1);
      }}
    >
      {menu.title ? <div className="ca-menu-title body-xxsmall">{menu.title}</div> : null}

      {menu.items.map((item, index) => {
        return (
          <button
            type="button"
            role="menuitem"
            key={item.label}
            disabled={item.disabled}
            className={[
              'ca-menu-item', 'body-xsmall',
              item.danger && 'ca-menu-item-danger',
              item.separatorBefore && 'ca-menu-sep',
            ].filter(Boolean).join(' ')}
            onClick={() => { item.onSelect(); onClose(); }}
          >
            <span className="ca-menu-item-label">{item.label}</span>
            {item.hint ? <span className="ca-menu-hint body-xxsmall">{item.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
