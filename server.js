'use strict';

/**
 * Cosmo Automations server — one process, one port.
 *
 *   GET  /api/scenario     scenario for the client (assertions + secrets stripped)
 *   POST /api/graph        persist solution.json
 *   POST /api/execute      run the engine, write execution.json, return the trace
 *   ALL  /__mock/*         the mock API surface, same resolver the engine uses
 *   GET  /*                static assets from dist/ (production only)
 *
 * Binds 127.0.0.1 in development and all interfaces in a session — see HOST
 * below. The template binds all interfaces unconditionally.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { run, paletteFor, hashGraph } = require('./engine');
const { resolveRequest } = require('./engine/mock/resolver');
const { defaultScenario } = require('./engine/scenarios');
const { createLiveAgent } = require('./live/openai');

/*
 * Live AI answers, when the session has the platform's LLM Proxy: the proxy puts
 * a session-scoped key and its URL in OPENAI_API_KEY / OPENAI_BASE_URL. Null
 * without them, and then every agent call replays its recorded answer. Only the
 * interactive run below is given this — grading never is.
 */
const liveAgent = createLiveAgent({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
});
const {
  createActivityLog, diffGraphs, diffCredentials, CLIENT_EVENTS,
} = require('./engine/activity');

let WebSocket = null;
try { WebSocket = require('ws'); } catch { /* optional */ }

const DIST_DIR = path.join(__dirname, 'dist');
const isProduction = process.env.IS_PRODUCTION === 'true';
if (isProduction && !fs.existsSync(DIST_DIR)) {
  throw new Error(`Production mode enabled but dist directory does not exist: ${DIST_DIR}`);
}

/*
 * Production serves everything on 3000, which the Engine session contract
 * requires and which the base task never overrides. An explicit PORT is honoured
 * so a packaged release can be booted somewhere else and verified
 * (`npm run verify:release`) without colliding with whatever holds 3000.
 */
const PORT = Number(process.env.PORT || 3000);

/*
 * Where to listen. Loopback for local development, so nothing on the network can
 * reach a laptop's dev server. ALL interfaces in production, which means in a
 * session (setup.sh sets IS_PRODUCTION=true): the platform's preview reaches port
 * 3000 through the container's network interface, so a loopback-bound server
 * shows a blank preview. The session container, not this bind, is the isolation
 * boundary there. HOST overrides both.
 */
const HOST = process.env.HOST || (process.env.IS_PRODUCTION === 'true' ? '0.0.0.0' : '127.0.0.1');

/**
 * State lives in the session filesystem (cwd), per README "In a session".
 * Locally there is no session, so fall back to the bundled scenario.
 */
const STATE_DIR = process.env.STATE_DIR
  ? path.resolve(process.env.STATE_DIR)
  : process.cwd();
/**
 * The per-activity configuration.
 *
 * The platform's convention for a bespoke simulation is `config.json`; this
 * project calls it `scenario.json`, and every
 * scenario, doc and script says so. Both are accepted, `config.json` first,
 * because a base task written to the platform convention must work without
 * anybody knowing about our name — and renaming ours wholesale would churn four
 * scenarios, the validator, the docs and the release verifier for no gain until
 * the convention is confirmed. See docs/engine-config-request.md.
 */
const CONFIG_NAMES = ['config.json', 'scenario.json'];

function findConfig() {
  if (process.env.SCENARIO_PATH) return path.resolve(process.env.SCENARIO_PATH);
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(STATE_DIR, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return bundledScenarioPath();
}

const SCENARIO_PATH = findConfig();
const SOLUTION_PATH = path.join(STATE_DIR, 'solution.json');
const EXECUTION_PATH = path.join(STATE_DIR, 'execution.json');
const ACTIVITY_PATH = path.join(STATE_DIR, 'activity.log');

/**
 * A session always has scenario.json in the working directory. Locally it does
 * not, so fall back to a bundled development scenario — whichever
 * `engine/scenarios.js` picks, rather than a hardcoded name.
 */
function bundledScenarioPath() {
  const fallback = defaultScenario();
  if (!fallback) throw new Error('No scenario.json in the working directory and none bundled.');
  return fallback.scenarioPath;
}

/**
 * Append-only, in the session filesystem, alongside solution.json.
 *
 * Written by the SERVER rather than reported by the client wherever it can be:
 * a graph delta computed from what was actually saved describes what happened,
 * where a client-reported event describes what the UI believed. Only the two
 * things the server cannot see — the help panel opening, a node being opened —
 * come from the browser.
 */
const activity = createActivityLog(ACTIVITY_PATH);

function loadScenario() {
  return JSON.parse(fs.readFileSync(SCENARIO_PATH, 'utf8'));
}

/**
 * What the browser gets. An ALLOWLIST, deliberately.
 *
 * This was a denylist — spread the scenario, delete `assertions` and
 * `instructions` — and that is precisely how it went wrong: `mockApi` was added
 * to the scenario format later, nobody thought to add it to the strip list, and
 * the browser was being handed every fixture body AND `requireAuth.equals`, the
 * exact API key the candidate is supposed to find and type in. One devtools tab
 * and the task was answered.
 *
 * A denylist has to be updated every time the format grows, by someone who
 * remembers it exists. An allowlist fails the other way: a new field is invisible
 * to the client until somebody deliberately adds it, and a missing field shows up
 * as a broken feature in development rather than a leak in production.
 *
 * Stripping assertions here is defence in depth: a Hire task ships them in a
 * hidden file that exists only at Submit, so they are not on the session
 * filesystem while the candidate works at all (README "Grading").
 */
const CLIENT_SCENARIO_FIELDS = [
  'version',
  'bespokeIdentifier',
  'title',
  // Field SCHEMAS for the credentials a candidate creates — labels, placeholders
  // and which header the value becomes. No values: there are none to leak, since
  // the candidate supplies them.
  'credentialTypes',
];

function scenarioForClient(scenario) {
  const out = {};
  for (const field of CLIENT_SCENARIO_FIELDS) {
    if (scenario[field] !== undefined) out[field] = scenario[field];
  }

  // A scenario may still ship ready-made credentials for a task that is not about
  // credentials. Ids and names only — never the fields.
  out.credentials = (scenario.credentials || []).map((c) => ({
    id: c.id, name: c.name, type: c.type,
  }));
  out.palette = paletteFor(scenario);

  // Whether agent answers can be live in this session — never the key or the URL.
  const liveConfig = scenario.ai && scenario.ai.live;
  out.liveAnswers = {
    enabled: Boolean(liveConfig && liveConfig.enabled === true)
      && !(scenario.grading && scenario.grading.private === true),
    available: Boolean(liveAgent),
  };
  return out;
}

/**
 * The candidate's workflow, out of a request body.
 *
 * Built in one place because it was built in two, and the two disagreed: both
 * listed `nodes` and `connections` explicitly, so when credentials moved into the
 * graph they were silently dropped on every save. The candidate typed a token,
 * the canvas showed it, and a reload lost it.
 *
 * Still an explicit list rather than a spread — the body also carries `runId` and
 * `untilNode`, which are request options and have no business on disk.
 */
/**
 * Log what changed, by comparing against what is currently on disk.
 *
 * Saves are debounced, so one line here can cover a few keystrokes — which is the
 * right granularity: "they reconfigured the Filter" is the behaviour, not the
 * individual characters.
 */
function recordEdit(next) {
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(SOLUTION_PATH, 'utf8'));
  } catch {
    previous = null;
  }

  const delta = diffGraphs(previous, next);
  if (delta) activity.record('workflow.edit', delta);

  const creds = diffCredentials(previous, next);
  for (const created of creds.created) activity.record('credential.create', created);
  for (const deleted of creds.deleted) activity.record('credential.delete', deleted);
}

function graphFromBody(body) {
  return {
    version: 1,
    nodes: (body.nodes || []).map(cleanNodeName),
    connections: body.connections || [],
    credentials: body.credentials || [],
  };
}

/**
 * A node name is one line of plain text. The canvas cannot produce anything
 * else, but this endpoint takes whatever is POSTed, and a name carrying line
 * breaks was a way to forge lines in the graded report. The report escapes them
 * regardless (grading/format.js `oneLine`); this keeps them out of solution.json
 * in the first place.
 */
function cleanNodeName(node) {
  if (!node || typeof node.name !== 'string') return node;
  const name = node.name.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').trim();
  return name === node.name ? node : { ...node, name };
}

function loadGraph(scenario) {
  try {
    return JSON.parse(fs.readFileSync(SOLUTION_PATH, 'utf8'));
  } catch {
    return scenario.initialWorkflow || { version: 1, nodes: [], connections: [] };
  }
}

/** The previous trace, but only when it matches the current graph. */
function loadTraceFor(graph) {
  try {
    const trace = JSON.parse(fs.readFileSync(EXECUTION_PATH, 'utf8'));
    return trace.graphHash === hashGraph(graph) ? trace : null;
  } catch {
    return null;
  }
}

/* ── helpers ───────────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error(`Invalid JSON: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathName, res) {
  const filePath = path.join(DIST_DIR, pathName.replace(/^\/+/, ''));
  const relative = path.relative(path.resolve(DIST_DIR), path.resolve(filePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback so a deep link still boots the app.
      if (!path.extname(filePath)) return serveStatic('/index.html', res);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'text/plain',
    });
    res.end(data);
  });
}

/* ── routes ────────────────────────────────────────────────────────── */

async function handleApi(req, res, parsed) {
  const { pathname } = parsed;

  if (req.method === 'GET' && pathname === '/api/scenario') {
    const scenario = loadScenario();
    const graph = loadGraph(scenario);
    return sendJson(res, 200, {
      scenario: scenarioForClient(scenario),
      graph,
      // Replay the last run only if it belongs to the graph being loaded, so a
      // reload restores item counts without ever showing a stale trace.
      trace: loadTraceFor(graph),
    });
  }

  if (req.method === 'POST' && pathname === '/api/graph') {
    const body = await readBody(req);
    const next = graphFromBody(body);
    recordEdit(next);
    fs.writeFileSync(SOLUTION_PATH, JSON.stringify(next, null, 2));
    return sendJson(res, 200, { saved: true });
  }

  if (req.method === 'POST' && pathname === '/api/activity') {
    const body = await readBody(req);
    // Only the handful of events the server genuinely cannot observe. Anything
    // else is either already logged from an authoritative source, or noise a
    // client should not be able to inject into the platform's record.
    if (!CLIENT_EVENTS.has(body.type)) {
      return sendJson(res, 400, { error: `"${body.type}" is not a client-reportable event` });
    }
    activity.record(body.type, body.payload || {});
    return sendJson(res, 200, { recorded: true });
  }

  if (req.method === 'POST' && pathname === '/api/execute') {
    const body = await readBody(req);
    const scenario = loadScenario();

    /**
     * A request with no `nodes` array is malformed, not an empty workflow — and
     * the difference matters because the next line overwrites the candidate's
     * saved graph. `nodes: []` IS legitimate (delete everything, press run), so
     * the guard is on the field being absent or the wrong type, not on it being
     * empty.
     */
    if (!Array.isArray(body.nodes) || !Array.isArray(body.connections)) {
      return sendJson(res, 400, {
        error: 'A run needs a graph: send { nodes: [...], connections: [...] }. '
          + 'Nothing was saved.',
      });
    }

    const graph = graphFromBody(body);
    recordEdit(graph);
    // Persist first: the trace must always correspond to a graph on disk.
    fs.writeFileSync(SOLUTION_PATH, JSON.stringify(graph, null, 2));

    const runId = String(body.runId || Date.now());
    const untilNode = body.untilNode || null;

    const trace = await run(scenario, graph, {
      untilNode,
      /**
       * Interactive: an approval with no decision yet PAUSES rather than falling
       * back to `scenario.approvals`. That fallback exists so headless runs (the
       * validator's solvability check, run.js, the tests) can get past an
       * approval; a candidate is supposed to be asked.
       */
      interactive: true,
      decisions: body.decisions && typeof body.decisions === 'object' ? body.decisions : {},
      liveAgent,
      // Interactive runs wait like a real integration would. The headless
      // runner and the tests leave this off, so grading stays instant.
      simulateLatency: true,
      onProgress: (event) => broadcast({ ...event, runId }),
    });

    /**
     * Only a full run may become the graded trace. An Execute Node run stops
     * partway by design, so saving it would leave `execution.json` describing a
     * workflow that was never finished — and the assertions would judge it.
     */
    /**
     * A paused run is as incomplete as a partial one — it stopped at an approval
     * and the rest never happened — so it must not become the graded trace
     * either. Saving it would leave execution.json describing a workflow that was
     * never finished, and the assertions would judge it.
     */
    if (!trace.partial && trace.status !== 'paused') {
      fs.writeFileSync(EXECUTION_PATH, JSON.stringify(trace, null, 2));
    }

    /**
     * A partial run is a different behaviour from a full one — trying one node in
     * isolation is debugging, running the lot is checking the answer — so they are
     * different event types rather than one with a flag.
     */
    if (trace.status === 'paused' && trace.awaiting) {
      activity.record('approval.pause', { node: trace.awaiting.node });
    }
    for (const [node, decision] of Object.entries(body.decisions || {})) {
      if (decision === 'approve' || decision === 'reject') {
        activity.record('approval.decide', { node, decision });
      }
    }

    if (trace.partial) {
      const target = graph.nodes.find((n) => n.id === untilNode);
      const record = (trace.nodes || []).find((n) => n.id === untilNode);
      activity.record('node.run', {
        node: target ? target.name : untilNode,
        nodeType: target ? target.type : null,
        status: record ? record.status : 'notRun',
      });
    } else {
      activity.record('workflow.run', {
        status: trace.status,
        nodes: (trace.nodes || []).length,
        errors: (trace.errors || []).length,
        durationMs: trace.durationMs,
        itemsOut: (trace.nodes || []).reduce((a, n) => a + (n.itemsOut || 0), 0),
        ...(trace.live ? { liveCalls: trace.live.answered, tokens: trace.live.tokens } : {}),
      });
    }

    broadcast({ type: 'runEnd', runId, status: trace.status, partial: Boolean(trace.partial) });
    return sendJson(res, 200, { trace });
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    const scenario = loadScenario();
    const graph = scenario.initialWorkflow || { version: 1, nodes: [], connections: [] };
    fs.writeFileSync(SOLUTION_PATH, JSON.stringify(graph, null, 2));
    for (const f of [EXECUTION_PATH]) if (fs.existsSync(f)) fs.unlinkSync(f);
    activity.record('workflow.reset', {});
    return sendJson(res, 200, { graph });
  }

  return sendJson(res, 404, { error: `No API route for ${req.method} ${pathname}` });
}

/**
 * The mock API, mounted so the loopback rewrite is real and inspectable:
 *   curl -H 'X-Api-Key: …' http://127.0.0.1:3000/__mock/api.acme-crm.test/v1/orders
 */
async function handleMock(req, res, parsed) {
  const rest = parsed.pathname.slice('/__mock/'.length);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? '/' : rest.slice(slash);
  const query = parsed.search || '';

  let body = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { body = await readBody(req); } catch { body = {}; }
  }

  const result = resolveRequest(loadScenario(), {
    method: req.method,
    url: `https://${host}${tail}${query}`,
    headers: req.headers,
    body,
  });

  sendJson(res, result.status, result.body === undefined ? null : result.body);
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathName = parsed.pathname === '/' ? '/index.html' : parsed.pathname;

  const route = async () => {
    if (parsed.pathname.startsWith('/__mock/')) return handleMock(req, res, parsed);
    if (parsed.pathname.startsWith('/api/')) return handleApi(req, res, parsed);
    if (req.method === 'POST' && parsed.pathname === '/message') return handleMessage(req, res);
    if (isProduction) return serveStatic(pathName, res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found (development mode — static files come from the Vite dev server)');
    return undefined;
  };

  route().catch((err) => {
    if (res.headersSent) return;
    sendJson(res, 500, { error: err.message });
  });
});

/* ── WebSocket alerting, kept from the template ─────────────────────── */

const wsClients = new Set();

/**
 * Push a message to every connected client. Used to stream per-node execution
 * progress, so the canvas lights up as the run advances instead of jumping from
 * "nothing" to "everything" when the response lands.
 */
function broadcast(payload) {
  if (!WebSocket) return;
  const message = JSON.stringify(payload);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

async function handleMessage(req, res) {
  const body = await readBody(req);
  if (!body.message) return sendJson(res, 400, { error: 'Message is required' });
  if (!WebSocket) return sendJson(res, 503, { error: 'WebSocket functionality not available' });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'message', message: body.message }));
    }
  }
  return sendJson(res, 200, { success: true, clientCount: wsClients.size });
}

if (WebSocket) {
  const wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Cosmo Automations server: http://${HOST}:${PORT}`);
  console.log(`  scenario  ${SCENARIO_PATH}`);
  console.log(`  solution  ${SOLUTION_PATH}`);
  console.log(`  execution ${EXECUTION_PATH}`);
  console.log(`  activity  ${ACTIVITY_PATH}`);
  console.log(isProduction ? `  serving   ${DIST_DIR}` : '  dev mode — assets from Vite');

  // The first line of the log, so a session that produced nothing else is still
  // distinguishable from one that never started.
  try {
    const scenario = loadScenario();
    activity.record('session.start', {
      scenario: scenario.bespokeIdentifier || null,
      title: scenario.title || null,
      nodeCount: ((scenario.initialWorkflow || {}).nodes || []).length,
    });
  } catch {
    // A scenario that will not parse is reported by the request handlers, loudly.
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : `Server error: ${err.message}`);
  process.exit(1);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
