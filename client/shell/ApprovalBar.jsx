import { Button } from '../ui/primitives.jsx';
import { Icon } from '../ui/Icon.jsx';

/**
 * The approval a paused run is waiting on.
 *
 * It floats at the top of the workspace, above the canvas, the logs and an open
 * node's settings alike: a run waiting on a person is the one thing that must
 * not be hidden behind whatever they were looking at. It is a bar rather than a
 * dialog, so it does not take over the screen or cover the items being decided
 * on — the logs still list them below.
 */
export function ApprovalBar({ awaiting, running, onDecide }) {
  if (!awaiting) return null;
  const count = (awaiting.items || []).length;
  return (
    <div className="ca-approval ca-approval-bar" role="alertdialog" aria-live="assertive" aria-label="Approval required">
      <span className="ca-approval-icon" aria-hidden="true"><Icon name="pause" size={14} /></span>
      <div className="ca-approval-text">
        <span className="ca-approval-prompt body-small">{awaiting.prompt}</span>
        <span className="ca-approval-meta body-xxsmall">
          {`"${awaiting.node}" is holding ${count} ${count === 1 ? 'item' : 'items'}`}
        </span>
      </div>
      <span className="ca-approval-actions">
        <Button variant="secondary" size="xsmall" disabled={running} onClick={() => onDecide(awaiting.node, 'reject')}>
          Reject
        </Button>
        <Button variant="primary" size="xsmall" disabled={running} onClick={() => onDecide(awaiting.node, 'approve')}>
          Approve
        </Button>
      </span>
    </div>
  );
}
