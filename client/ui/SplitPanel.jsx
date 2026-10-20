import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import SplitPanelJS from '../design-system/components/split-panel/split-panel.js';

/**
 * React wrapper for the imperative SplitPanel.
 *
 * The component wipes its container's innerHTML and builds its own
 * `.split-panel-left` / `.split-panel-right` nodes, so React children cannot be
 * rendered as markup inside it — they are portalled into the panels the
 * component creates. (The plan sketched `data-panel` slot attributes; the
 * source does not work that way.)
 *
 * `destroy()` on unmount is not optional: it holds a ResizeObserver.
 */
export function SplitPanel({
  orientation = 'horizontal',
  initialSplit = 50,
  minLeft = 10,
  minRight = 10,
  left,
  right,
  className,
  dividerLabel,
}) {
  const hostRef = useRef(null);
  const instanceRef = useRef(null);
  const [panels, setPanels] = useState(null);

  useEffect(() => {
    const instance = new SplitPanelJS(hostRef.current, {
      orientation, initialSplit, minLeft, minRight, dividerLabel,
    });
    instanceRef.current = instance;
    setPanels({ left: instance.getLeftPanel(), right: instance.getRightPanel() });

    return () => {
      instance.destroy();
      instanceRef.current = null;
      setPanels(null);
    };
    // Re-creating on config change is correct here: these are layout-defining.
  }, [orientation, initialSplit, minLeft, minRight, dividerLabel]);

  return (
    <div ref={hostRef} className={className}>
      {panels ? createPortal(left, panels.left) : null}
      {panels ? createPortal(right, panels.right) : null}
    </div>
  );
}
