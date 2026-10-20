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
    return () => { instance.destroy?.(); instanceRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, placeholder, width]);

  // Keep the widget in sync when the value changes from outside.
  useEffect(() => {
    const instance = instanceRef.current;
    if (instance && instance.getValue?.() !== value) instance.setValue?.(value);
  }, [value]);

  return <div ref={hostRef} />;
}
