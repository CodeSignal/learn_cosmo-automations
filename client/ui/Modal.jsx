import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import ModalJS from '../design-system/components/modal/modal.js';

/**
 * React wrapper for the design system's imperative Modal.
 *
 * Children are rendered by React into a detached element which is handed to
 * the Modal as a DOM node, so the content is always populated before it opens.
 *
 * `layout`:
 *  - `panel` — full-height, edge-to-edge content (Help's two columns). The
 *    dialog gets a stable height so it does not resize as you browse.
 *  - `form`  — padded, top-aligned content (Credentials).
 *
 * Three corrections apply to both, scoped by `.ca-modal` in `theme/shell.css`:
 * `.modal-header` is published at a fixed 48px with 24px of vertical padding,
 * so its content box collapses; the close button is absolutely positioned and
 * never lines up with the title; and `.modal-content` centres its child, which
 * is right for a short message and wrong for anything with structure.
 *
 * `createHelpModal` adds a footer Close button on top of the corner ×; we pass
 * `footerButtons: null` everywhere, so there is one way to close.
 */
export function Modal({
  open, onClose, title, size = 'large', layout = 'form', children,
}) {
  const holderRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  if (!holderRef.current && typeof document !== 'undefined') {
    holderRef.current = document.createElement('div');
    holderRef.current.className = 'ca-modal-holder';
  }

  useEffect(() => {
    if (!open) return undefined;

    const modal = new ModalJS({
      size,
      title: title || null,
      content: holderRef.current,
      footerButtons: null,
      closeButtonLabel: 'Close',
      onClose: () => onCloseRef.current?.(),
    });

    modal.dialog?.classList.add('ca-modal', `ca-modal-${layout}`);
    modal.open();

    return () => modal.destroy?.();
  }, [open, title, size, layout]);

  return holderRef.current ? createPortal(children, holderRef.current) : null;
}
