/**
 * CSS-class primitives.
 *
 * Trivial wrappers that emit design system class names, so class strings live
 * in one place instead of scattering through the codebase. Built first, before
 * any feature work.
 *
 * The first five map one-to-one onto design system components. The rest
 * (IconButton, Segmented, Tabs, Kbd) are app-level controls the design system
 * has no component for; they are styled from its tokens in `theme/base.css`.
 */

const cx = (...parts) => parts.filter(Boolean).join(' ');

export const Button = ({ variant = 'primary', size, className, children, ...rest }) => (
  <button
    type="button"
    className={cx('button', `button-${variant}`, size && `button-${size}`, className)}
    {...rest}
  >
    {children}
  </button>
);

export const Box = ({
  card, selected, emphasized, shadowed, nonInteractive, className, children, ...rest
}) => (
  <div
    className={cx(
      'box',
      card && 'card',
      selected && 'selected',
      emphasized && 'emphasized',
      shadowed && 'shadowed',
      nonInteractive && 'non-interactive',
      className,
    )}
    {...rest}
  >
    {children}
  </div>
);

/** variant: default | secondary | outline | success | error | warning | info */
export const Tag = ({ variant = 'default', className, children, ...rest }) => (
  <div className={cx('tag', variant !== 'default' && variant, className)} {...rest}>
    {children}
  </div>
);

export const Input = ({ className, mono, ...rest }) => (
  <input
    type="text"
    className={cx('input', mono && 'ca-mono', className)}
    {...rest}
  />
);

export const Checkbox = ({ label, checked, onChange, size, disabled }) => (
  <label className={cx('input-checkbox', size && `input-checkbox-${size}`)}>
    <input type="checkbox" checked={Boolean(checked)} onChange={onChange} disabled={disabled} />
    <span className="input-checkbox-box"><span className="input-checkbox-checkmark" /></span>
    {label ? <span className="input-checkbox-label">{label}</span> : null}
  </label>
);

/**
 * Square icon-only button. `label` is required: it is the accessible name and
 * the tooltip, because an icon alone names nothing.
 */
export const IconButton = ({
  label, tone, size = 'medium', className, children, ...rest
}) => (
  <button
    type="button"
    className={cx('ca-icon-button', `ca-icon-button-${size}`, tone && `ca-icon-button-${tone}`, className)}
    aria-label={label}
    title={rest.title || label}
    {...rest}
  >
    {children}
  </button>
);

/** A one-of-N choice that looks like one: Schema | Table | JSON. */
export const Segmented = ({ value, options, onChange, label }) => (
  <div className="ca-segmented" role="group" aria-label={label}>
    {options.map((option) => (
      <button
        type="button"
        key={option.value}
        className={value === option.value ? 'is-active' : ''}
        aria-pressed={value === option.value}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);

/** Underlined tabs for switching a panel's content. */
export const Tabs = ({ value, options, onChange, label }) => (
  <div className="ca-tabs" role="tablist" aria-label={label}>
    {options.map((option) => (
      <button
        type="button"
        role="tab"
        key={option.value}
        aria-selected={value === option.value}
        className={cx('ca-tab body-xsmall', value === option.value && 'is-active')}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
);

/** A keyboard key, for shortcut hints. */
export const Kbd = ({ children }) => <kbd className="ca-kbd">{children}</kbd>;

export { cx };
