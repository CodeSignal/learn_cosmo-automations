import { Button, IconButton } from '../ui/primitives.jsx';
import { Icon, Spinner } from '../ui/Icon.jsx';

/**
 * Application header: where you are on the left, document tools on the right.
 *
 *   mark  Cosmo Automations / <task title>  · Saved          undo redo │ Credentials  Help  Reset
 *
 * Execute Workflow is NOT here. It floats at the bottom of the canvas, next to
 * the thing it runs, and the run's outcome is reported in the logs bar right
 * under it — action and result in one place, instead of a button in one corner
 * and its result in another. It also keeps the header's top-right corner free,
 * which is where the platform overlays its own reset control.
 *
 * Two rules carried over from the previous header:
 *
 * 1. **Status is quiet.** The design system uppercases `.label-*` and `.tag`, so
 *    state renders in sentence case with a small glyph, never a shouting tag.
 * 2. **Nothing shifts.** The save slot reserves its width whether or not it has
 *    anything to say, so undo/redo never slide sideways mid-interaction.
 */
export function Header({
  title, saveState, canUndo, canRedo,
  onUndo, onRedo, onHelp, onReset, onCredentials, credentialCount,
}) {
  return (
    <header className="ca-header">
      <div className="ca-header-start">
        {/*
          The product mark, from the design system (a currentColor mask, so it
          themes for free and tracks the submodule rather than a copied asset).
        */}
        <span className="ca-brand-mark" aria-hidden="true">
          <span className="icon icon-app-icon" />
        </span>

        <nav className="ca-breadcrumb" aria-label="Workflow">
          <span className="ca-breadcrumb-product body-small">Cosmo Automations</span>
          {title ? (
            <>
              <span className="ca-breadcrumb-sep body-small" aria-hidden="true">/</span>
              <span className="ca-breadcrumb-title body-small" title={title}>{title}</span>
            </>
          ) : null}
        </nav>

        <SaveState state={saveState} />
      </div>

      <div className="ca-header-end">
        <div className="ca-header-group" role="group" aria-label="History">
          <IconButton label="Undo (⌘Z)" onClick={onUndo} disabled={!canUndo}>
            <Icon name="undo" />
          </IconButton>
          <IconButton label="Redo (⇧⌘Z)" onClick={onRedo} disabled={!canRedo}>
            <Icon name="redo" />
          </IconButton>
        </div>

        <span className="ca-divider-v" aria-hidden="true" />

        {/*
          Credentials sit in the header rather than only inside a node, because a
          candidate has to be able to find them BEFORE they know which node needs
          one — and because "you have none yet" is worth seeing at a glance.
        */}
        <Button
          variant="text"
          size="xsmall"
          className="ca-header-button"
          onClick={onCredentials}
          title="Create and manage the credentials your nodes use"
        >
          <Icon name="key" />
          <span className="ca-button-label">Credentials</span>
          <span className="ca-count-badge body-xxsmall">{credentialCount}</span>
        </Button>

        <Button
          variant="text"
          size="xsmall"
          className="ca-header-button"
          onClick={onHelp}
          title="How Cosmo Automations works"
        >
          <Icon name="help" />
          <span className="ca-button-label">Help</span>
        </Button>

        <Button
          variant="text"
          size="xsmall"
          className="ca-header-button"
          onClick={onReset}
          title="Discard this workflow and start again (undoable)"
        >
          <Icon name="reset" />
          <span className="ca-button-label">Reset</span>
        </Button>
      </div>
    </header>
  );
}

function SaveState({ state }) {
  let content = null;
  if (state === 'saving') content = <><Spinner size={12} /><span>Saving…</span></>;
  if (state === 'saved') content = <><Icon name="check" size={14} /><span>Saved</span></>;
  if (state === 'error') content = <><Icon name="alert" size={14} /><span>Not saved</span></>;
  return (
    <span className={`ca-save ca-save-${state} body-xxsmall`} role="status" aria-live="polite">
      {content}
    </span>
  );
}
