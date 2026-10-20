import { Button, IconButton } from '../ui/primitives.jsx';
import { Icon, Spinner } from '../ui/Icon.jsx';
import { NodeGlyph } from '../canvas/NodeIcon.jsx';

/**
 * The logs panel, docked under the canvas.
 *
 * Collapsed, it is a single bar that always answers "what happened last time I
 * ran this?" — the run's outcome, in words as well as colour, because this is
 * an assessment surface. Expanded, it lists every node that ran with its item
 * counts and anything worth knowing: the HTTP calls it made, the model calls,
 * errors and broken expressions. Clicking a row opens that node.
 *
 * Feedback here reads as system output ("Expression returned undefined").
 */
export function LogsPanel({
  trace, running, open, onToggle, onOpenNode, onDecide, definitions, nodesById, liveAnswers,
}) {
  const run = runState(trace, running);
  const records = trace ? trace.nodes || [] : [];
  const paused = trace && trace.status === 'paused' && trace.awaiting;

  return (
    <section className={`ca-logs${open ? ' is-open' : ''}`} aria-label="Logs">
      <div className="ca-logs-bar">
        <button
          type="button"
          className="ca-logs-toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="ca-logs-body"
        >
          <Icon name="logs" />
          <span className="ca-logs-title body-small">Logs</span>
        </button>

        {/* One live region, so a screen reader hears each change once. */}
        <span className={`ca-run-state ca-run-state-${run.tone} body-xsmall`} role="status" aria-live="polite">
          {run.tone === 'busy' ? <Spinner size={12} /> : <span className="ca-run-dot" aria-hidden="true" />}
          <span>{run.label}</span>
        </span>

        {trace && !running ? (
          <span className="ca-logs-meta body-xxsmall">
            {`${records.length} ${records.length === 1 ? 'node' : 'nodes'} · ${formatMs(trace.durationMs)}`}
            {liveSummary(trace)}
          </span>
        ) : null}

        {!trace && liveAnswers && liveAnswers.enabled && liveAnswers.available ? (
          <span className="ca-logs-meta body-xxsmall">AI answers come from a live model</span>
        ) : null}

        <IconButton
          label={open ? 'Collapse logs' : 'Expand logs'}
          onClick={onToggle}
          size="small"
          className="ca-logs-chevron"
        >
          <Icon name={open ? 'chevron-down' : 'chevron-up'} />
        </IconButton>
      </div>

      {open ? (
        <div className="ca-logs-body" id="ca-logs-body">
          {/*
            The approval prompt, where the items are. It sits at the top of the
            logs rather than in a modal: the decision is about the items listed
            right below it, and a dialog would cover them.
          */}
          {paused ? (
            <div className="ca-approval" role="group" aria-label="Approval required">
              <span className="ca-approval-icon" aria-hidden="true"><Icon name="pause" size={14} /></span>
              <div className="ca-approval-text">
                <span className="ca-approval-prompt body-small">{trace.awaiting.prompt}</span>
                <span className="ca-approval-meta body-xxsmall">
                  {`"${trace.awaiting.node}" is holding ${trace.awaiting.items.length} `}
                  {trace.awaiting.items.length === 1 ? 'item' : 'items'}
                </span>
              </div>
              <span className="ca-approval-actions">
                <Button
                  variant="secondary"
                  size="xsmall"
                  disabled={running}
                  onClick={() => onDecide(trace.awaiting.node, 'reject')}
                >
                  Reject
                </Button>
                <Button
                  variant="primary"
                  size="xsmall"
                  disabled={running}
                  onClick={() => onDecide(trace.awaiting.node, 'approve')}
                >
                  Approve
                </Button>
              </span>
            </div>
          ) : null}

          {!trace ? (
            <div className="ca-logs-empty body-small">
              <p>Nothing has run yet.</p>
              <p className="body-xsmall">
                Execute the workflow and every node&apos;s result appears here, with the
                items it received and produced.
              </p>
            </div>
          ) : (
            <ol className="ca-logs-list">
              {records.map((record) => (
                <LogRow
                  key={record.id}
                  record={record}
                  trace={trace}
                  definition={definitions[(nodesById[record.id] || {}).type]}
                  onOpen={() => onOpenNode(record.id)}
                />
              ))}

              {Object.keys(trace.sinks || {}).map((name) => (
                <li className="ca-log-row ca-log-row-sink" key={`sink-${name}`}>
                  <span className="ca-log-status" aria-hidden="true"><Icon name="check" size={13} /></span>
                  <span className="ca-log-name body-xsmall">{`${name} sent`}</span>
                  <span className="ca-log-details">
                    <span className="ca-log-detail ca-mono body-xxsmall">
                      {JSON.stringify(trace.sinks[name])}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}

function LogRow({ record, trace, definition, onOpen }) {
  const calls = (trace.httpCalls || []).filter((c) => c.node === record.name);
  const agentCalls = (trace.aiCalls || []).filter((c) => c.node === record.name);
  const problems = (record.diagnostics || []).filter((d) => d.error);
  const passes = record.batches || record.runs;

  return (
    <li className={`ca-log-row is-${record.status}`}>
      <span className="ca-log-status" title={record.status}>
        <StatusGlyph status={record.status} />
      </span>

      <button type="button" className="ca-log-name ca-log-line-name body-xsmall" onClick={onOpen}>
        {definition ? <NodeGlyph group={definition.group} icon={definition.icon} size="sm" /> : null}
        <span className="ca-log-name-text">{record.name}</span>
      </button>

      {/*
        A two-input node's `in` is the total across both, so `12 → 7` on a
        correct join reads as items vanishing. Spell the inputs out here for the
        same reason the graded report does — the candidate is debugging from
        this line.
      */}
      <span className="ca-log-items ca-mono body-xxsmall">
        {record.itemsIn}
        {record.inputsByPort && record.inputsByPort.length > 1
          ? ` (${record.inputsByPort.map((p) => p.count).join('+')})`
          : ''}
        {' → '}
        {record.itemsOut}
        {/* A loop's passes: the count is the only sign the loop ran. */}
        {passes > 1 ? ` · ${passes} passes` : ''}
      </span>

      <span className="ca-log-time ca-mono body-xxsmall">
        {typeof record.ms === 'number' ? formatMs(record.ms) : ''}
      </span>

      <span className="ca-log-details">
        {statusNote(record) ? (
          <span className="ca-log-detail ca-log-detail-muted body-xxsmall">{statusNote(record)}</span>
        ) : null}

        {calls.map((call, index) => (
          // eslint-disable-next-line react/no-array-index-key
          <span key={index} className="ca-log-detail ca-mono body-xxsmall">
            {`${call.method} ${call.path} → ${call.status}`}
          </span>
        ))}

        {/*
          Model calls, counted. An agent's in/out counts look like any other
          node's; the number of calls and the model are what it cost.
        */}
        {agentCalls.length ? (
          <span className="ca-log-detail ca-mono body-xxsmall">
            {`${agentCalls.length}× ${[...new Set(agentCalls.map((c) => c.model || '(no model)'))].join('/')}`}
            {agentCalls.some((c) => c.denied) ? ' · refused' : ''}
            {answerSource(agentCalls)}
          </span>
        ) : null}

        {record.error ? (
          <span className="ca-log-detail ca-log-detail-error body-xxsmall">{record.error}</span>
        ) : null}

        {problems.map((problem) => (
          <span key={problem.path} className="ca-log-detail ca-log-detail-error ca-mono body-xxsmall">
            {`${problem.path}: ${problem.error}`}
          </span>
        ))}
      </span>
    </li>
  );
}

function StatusGlyph({ status }) {
  if (status === 'success') return <Icon name="check" size={13} />;
  if (status === 'error') return <Icon name="alert" size={14} />;
  if (status === 'paused') return <Icon name="pause" size={12} />;
  if (status === 'disabled') return <Icon name="power" size={12} />;
  return <span className="ca-log-status-dot" />;
}

function statusNote(record) {
  if (record.status === 'paused') return 'Waiting for approval';
  if (record.status === 'noItems') return 'No items reached this node';
  if (record.status === 'disabled') return 'Disabled — items passed straight through';
  if (record.status === 'skipped' && !record.error) return 'Skipped';
  return null;
}

/**
 * The run indicator. Each state has its own word as well as its own colour, so
 * the meaning survives without colour vision.
 */
function runState(trace, running) {
  if (running) return { tone: 'busy', label: 'Running…' };
  if (!trace) return { tone: 'idle', label: 'Not run yet' };
  if (trace.status === 'error') return { tone: 'error', label: 'Last run failed' };
  // A paused run has not passed — it stopped at an approval and the rest never
  // happened. Saying "passed" here is the kind of small lie that makes someone
  // submit an unfinished workflow.
  if (trace.status === 'paused') return { tone: 'warn', label: 'Waiting for your approval' };
  if (trace.partial) return { tone: 'warn', label: 'Partial run — execute the whole workflow to submit' };
  return { tone: 'ok', label: 'Last run passed' };
}

/**
 * Where an agent's answers came from, when the run could answer live: a real
 * model, or the recorded answers — and if recorded, why. Said in words, because
 * "the model gave a different answer than last time" is exactly what a learner
 * would otherwise be left guessing about.
 */
const FALLBACK_WORDS = {
  'no-model': 'no live model for this choice',
  'rate-limit': 'rate limit',
  budget: 'live budget used up',
  timeout: 'live model too slow',
  'bad-answer': 'unusable live answer',
  error: 'live model unavailable',
  'call-limit': 'live-call limit reached',
  'time-limit': 'live time limit reached',
  'agent-recorded': 'its agent answered from recordings',
};

function answerSource(calls) {
  if (!calls.some((c) => c.source)) return '';
  const live = calls.filter((c) => c.source === 'live');
  const recorded = calls.filter((c) => c.source === 'recorded');
  const reasons = [...new Set(recorded.map((c) => FALLBACK_WORDS[c.fallback] || 'live model unavailable'))];
  const tokens = live.reduce((a, c) => a + (c.tokens || 0), 0);
  const parts = [];
  if (live.length) parts.push(recorded.length ? `${live.length} live` : 'live');
  if (recorded.length) parts.push(`${live.length ? `${recorded.length} ` : ''}recorded (${reasons.join(', ')})`);
  if (tokens) parts.push(`${formatTokens(tokens)} tokens`);
  return ` · ${parts.join(' · ')}`;
}

function liveSummary(trace) {
  const live = trace.live;
  if (!live || !live.calls) return '';
  if (!live.answered) return ' · recorded answers';
  return ` · ${live.answered} live${live.fallbacks ? `, ${live.fallbacks} recorded` : ''}`
    + (live.tokens ? ` · ${formatTokens(live.tokens)} tokens` : '');
}

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatMs(ms) {
  if (typeof ms !== 'number') return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
