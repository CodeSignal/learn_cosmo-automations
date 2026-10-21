import { useEffect, useRef } from 'react';
import DropdownJS from '../design-system/components/dropdown/dropdown.js';

/**
 * React wrapper for the imperative Dropdown.
 *
 * `onSelect` is read through a ref so a changing callback identity does not
 * force the dropdown to be torn down and rebuilt on every parent render —
 * which would close it mid-interaction.
 */
export function Select({ value, options, placeholder, onChange, width }) {
  const hostRef = useRef(null);
  const instanceRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const signature = JSON.stringify(items);

  useEffect(() => {
    const instance = new DropdownJS(hostRef.current, {
      items,
      placeholder: placeholder || 'Select',
      selectedValue: value,
      width: width || '100%',
      onSelect: (item) => onChangeRef.current?.(item && item.value !== undefined ? item.value : item),
    });
    instanceRef.current = instance;
    const release = floatMenu(hostRef.current);
    return () => { release(); instance.destroy?.(); instanceRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, placeholder, width]);

  // Keep the widget in sync when the value changes from outside.
  useEffect(() => {
    const instance = instanceRef.current;
    if (instance && instance.getValue?.() !== value) instance.setValue?.(value);
  }, [value]);

  return <div ref={hostRef} />;
}

/**
 * Lift the open menu out of whatever contains the dropdown.
 *
 * The design system's menu is positioned inside its container, so a dropdown in
 * a modal or a scrolling panel was cut off at that box's edge. While it is open
 * the menu moves to <body> (or a modal's overlay), sits under (or, without room below, above) its
 * toggle at the toggle's width, and follows it on scroll and resize; on close it
 * goes back. The dropdown tells a click on its menu from an outside click by
 * asking the menu itself, so moving it changes nothing about how it behaves.
 */
function floatMenu(host) {
  // The design system may turn the host itself into the container.
  const container = host && (host.classList.contains('dropdown-container')
    ? host : host.querySelector('.dropdown-container'));
  const toggle = container && container.querySelector('.dropdown-toggle');
  const menu = container && container.querySelector('.dropdown-menu');
  if (!container || !toggle || !menu) return () => {};

  const place = () => {
    const box = toggle.getBoundingClientRect();
    menu.style.width = `${box.width}px`;
    menu.style.left = `${box.left}px`;
    const height = menu.offsetHeight;
    const below = window.innerHeight - box.bottom;
    const above = below < height + 8 && box.top > below;
    menu.style.top = `${above ? box.top - height - 4 : box.bottom + 4}px`;
  };

  /*
   * Moving a node blurs whatever inside it has focus, and the dropdown closes on
   * focus leaving its menu — so the move would close the menu it just opened.
   * Swallow the focus-out the move causes, then give focus back.
   */
  const moveTo = (parent) => {
    const focused = menu.contains(document.activeElement) ? document.activeElement : null;
    const swallow = (event) => event.stopPropagation();
    menu.addEventListener('focusout', swallow, true);
    parent.appendChild(menu);
    menu.removeEventListener('focusout', swallow, true);
    if (focused) focused.focus({ preventScroll: true });
  };

  // Inside a modal the menu goes into the modal's overlay: the modal makes every
  // other child of <body> inert, so a menu there could be seen but not clicked.
  // The overlay covers the viewport and has no transform, so `fixed` still
  // means the viewport, and it is the dialog inside it that clips.
  const open = () => {
    moveTo(container.closest('.modal-overlay') || document.body);
    Object.assign(menu.style, { position: 'fixed', display: 'block', zIndex: '20000', bottom: 'auto' });
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
  };

  const close = () => {
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    for (const key of ['position', 'display', 'zIndex', 'bottom', 'top', 'left', 'width']) menu.style[key] = '';
    if (menu.parentNode !== container) moveTo(container);
  };

  let isOpen = false;
  const observer = new MutationObserver(() => {
    const next = container.classList.contains('open');
    if (next === isOpen) return;
    isOpen = next;
    if (next) open(); else close();
  });
  observer.observe(container, { attributes: true, attributeFilter: ['class'] });

  return () => {
    observer.disconnect();
    if (isOpen) close();
    if (menu.parentNode && menu.parentNode !== container) menu.remove();
  };
}
