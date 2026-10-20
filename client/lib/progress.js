/**
 * Live execution progress.
 *
 * The engine runs server-side, so without this the canvas would jump straight
 * from "nothing" to "everything" when the response lands. The server streams a
 * nodeStart/nodeEnd pair per node over the WebSocket the template already
 * provides, and the canvas lights each node up as it runs.
 *
 * This is presentation only. The authoritative result is still the trace
 * returned by `POST /api/execute`; if the socket never connects, execution works
 * exactly as before, just without the play-by-play.
 */
export function connectProgress(onEvent) {
  if (typeof WebSocket === 'undefined') return () => {};

  let socket = null;
  let closed = false;
  let retry = null;
  let attempts = 0;

  const open = () => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    } catch {
      schedule();
      return;
    }

    socket.addEventListener('open', () => { attempts = 0; });

    socket.addEventListener('message', (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload && payload.type) onEvent(payload);
    });

    // A dropped socket costs progress reporting, not correctness, so reconnect
    // with a backoff and give up quietly rather than hammering.
    socket.addEventListener('close', schedule);
    socket.addEventListener('error', () => socket && socket.close());
  };

  function schedule() {
    if (closed || attempts >= 5) return;
    attempts += 1;
    retry = setTimeout(open, Math.min(500 * attempts, 4000));
  }

  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  };
}
