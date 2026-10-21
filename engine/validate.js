'use strict';

/**
 * Scenario validator.
 *
 * A task is data, not code: authors write `scenario.json` and never touch this
 * repository. That is the right split, but it means an authoring mistake has
 * nowhere to surface — without this, a scenario with a typo'd node type or an
 * unsatisfiable assertion looks fine until a candidate opens the task and cannot
 * solve it.
 *
 * So everything checkable is checked here, once, and reused by three callers:
 * `npm run validate` (authors), the test suite (every shipped scenario), and
 * `scripts/grading-experiment.sh` (before it bothers Cosmo).
 *
 * Errors are things that will break or mislead a candidate. Warnings are things
 * that are probably mistakes but might be deliberate.
 */

const { allNodes, getNode, paletteFor, run } = require('./index');
const { registry, isLibraryNode } = require('./nodes');
const { credentialTypes, BUILT_IN_TYPES, applyCredential } = require('./credentials');
const { ICON_NAMES, isKnownIcon } = require('../shared/node-icons.mjs');
const { topologicalOrder, loopStructure } = require('./scheduler');

/** Hostnames guaranteed never to resolve — RFC 2606 / 6761. */
const RESERVED_TLDS = ['.test', '.invalid', '.example', '.localhost'];

const ASSERTION_FIELDS = {
  nodeExists: ['nodeType'],
  connected: [],
  paramEquals: ['param'],
  expressionContains: ['substring'],
  itemCount: ['count'],
  sinkPayloadMatches: ['match'],
  noNodeErrors: [],
  httpCalled: ['path'],
  aiCalled: [],
};

/**
 * @param {object} scenario
 * @param {object} [options]  { referenceSolution } — when given, the scenario is
 *                            also checked for being *solvable*, which is the
 *                            single most valuable check available.
 * @returns {Promise<{ok, errors: string[], warnings: string[], notes: string[] }>}
 */
async function validateScenario(scenario, options = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!scenario || typeof scenario !== 'object') {
    return { ok: false, errors: ['scenario.json is not an object'], warnings, notes };
  }

  /* ── identity ─────────────────────────────────────────────────────── */

  if (!scenario.title) warn('no `title` — the header will be blank');
  if (scenario.version !== 1) {
    warn(`\`version\` is ${JSON.stringify(scenario.version)}; the engine expects 1`);
  }

  /* ── scenario-defined nodes ───────────────────────────────────────── */

  /**
   * A node written in JSON gets checked harder than a built-in, because a
   * built-in has tests and a reviewer and this has neither. Everything below is a
   * mistake someone will actually make: a URL pointing at a host the scenario
   * never declared, an operation with no request, a `{param}` naming a field that
   * does not exist, a type that shadows a built-in.
   */
  const declaredHosts = new Set(Object.keys((scenario.mockApi || {}).hosts || {}));
  const specTypes = new Set();

  if (scenario.nodes !== undefined && !Array.isArray(scenario.nodes)) {
    err('`nodes` must be an array of node definitions');
  }

  for (const [index, spec] of (Array.isArray(scenario.nodes) ? scenario.nodes : []).entries()) {
    const where = spec && spec.type ? `nodes."${spec.type}"` : `nodes[${index}]`;

    if (!spec || typeof spec !== 'object') { err(`${where} is not an object`); continue; }
    if (typeof spec.type !== 'string' || !spec.type) {
      err(`${where} has no \`type\` — it is the id used in solution.json and it is required`);
      continue;
    }
    /**
     * Replacing a LIBRARY node is the point of the library — swapping Slack for
     * your own Slack is a supported thing to do, and it is noted rather than
     * warned about. Replacing a CODED node is refused: `filter` has to mean the
     * same thing in every task, or an assertion naming a node type means nothing.
     */
    if (registry.has(spec.type)) {
      if (!isLibraryNode(spec.type)) {
        err(`${where} redefines "${spec.type}", which is built into the engine. Flow and data nodes cannot be replaced — an assertion naming a node type has to mean the same thing in every task. Pick another type name.`);
        continue;
      }
      notes.push(`${where} replaces the library node "${spec.type}" for this task`);
    }
    if (specTypes.has(spec.type)) err(`${where} is defined twice`);
    specTypes.add(spec.type);

    if (!spec.label) warn(`${where} has no \`label\`; the palette will show the raw type`);
    if (!spec.description) warn(`${where} has no \`description\`; the palette tooltip will be empty`);
    if (spec.icon && !isKnownIcon(spec.icon)) {
      warn(`${where} asks for icon "${spec.icon}", which does not exist — it will draw a plain dot. Known: ${ICON_NAMES.join(', ')}`);
    }
    if (!spec.docs || !spec.docs.summary) {
      warn(`${where} has no \`docs.summary\`; its wiki page will be blank, and the help panel is how candidates learn a node they have never seen`);
    }

    const paramNames = new Set((spec.params || []).map((param) => param && param.name).filter(Boolean));
    for (const param of spec.params || []) {
      if (!param || !param.name) { err(`${where} has a parameter with no \`name\``); continue; }
      if (param.name === 'operation' && Object.keys(spec.operations || {}).length > 1) {
        err(`${where} declares a parameter called "operation", which is generated from \`operations\` — rename it`);
      }
      if (!param.label) warn(`${where}.${param.name} has no \`label\``);
      if (param.type === 'options' && !Array.isArray(param.options)) {
        err(`${where}.${param.name} is type "options" but declares no \`options\` array`);
      }
    }

    const operations = spec.operations && typeof spec.operations === 'object' ? spec.operations : null;
    if (!operations || !Object.keys(operations).length) {
      err(`${where} declares no \`operations\`, so it would do nothing when run`);
      continue;
    }

    for (const [opName, op] of Object.entries(operations)) {
      const at = `${where}.operations.${opName}`;
      if (!op || typeof op !== 'object') { err(`${at} is not an object`); continue; }
      if (!op.request || !op.request.url) { err(`${at} has no \`request.url\``); continue; }

      if (op.mode && op.mode !== 'runOncePerItem' && op.mode !== 'runOnceForAllItems') {
        err(`${at}.mode is "${op.mode}"; it must be runOncePerItem or runOnceForAllItems`);
      }
      if (!op.mode) {
        notes.push(`${at} declares no \`mode\`; defaulting to runOnceForAllItems (one call for the whole list)`);
      }

      // Every `{placeholder}` anywhere in the request must name a real parameter.
      const templated = JSON.stringify([op.request.url, op.request.query, op.request.headers, op.request.body]);
      for (const [, name] of templated.matchAll(/\{([A-Za-z_$][\w$]*)\}/g)) {
        if (!paramNames.has(name) && name !== 'operation') {
          err(`${at} uses {${name}}, but "${name}" is not a parameter of ${spec.type}`);
        }
      }

      // The mock transport is default-deny, so an undeclared host is a node that
      // can only ever fail — and it fails at candidate time, not authoring time.
      const host = /^[a-zA-Z][\w+.-]*:\/\/([^/?#]+)/.exec(String(op.request.url));
      if (!host) {
        err(`${at}.request.url is not an absolute URL: ${JSON.stringify(op.request.url)}`);
      } else {
        const hostname = host[1].replace(/^[^@]*@/, '').toLowerCase();
        if (/\{/.test(hostname)) {
          err(`${at}.request.url puts a {placeholder} in the HOST. Only the path, query, headers and body may be templated — a candidate must never be able to choose which server is called.`);
        } else if (!declaredHosts.has(hostname)) {
          err(`${at} calls "${hostname}", which \`mockApi.hosts\` does not declare. The transport is default-deny, so every call would be refused.`);
        }
      }
    }
  }

  /* ── palette ──────────────────────────────────────────────────────── */

  const known = new Set(allNodes(scenario).map((n) => n.type));
  const include = scenario.palette && scenario.palette.include;

  if (include && !Array.isArray(include)) {
    err('`palette.include` must be an array of node types');
  } else if (include) {
    for (const type of include) {
      if (!known.has(type)) {
        err(`palette.include lists unknown node type "${type}". Known: ${[...known].sort().join(', ')}`);
      }
    }
    if (!include.some((t) => (getNode(t, scenario) || {}).inputs === 0)) {
      err('the palette offers no trigger, so a candidate cannot start a workflow');
    }
  } else {
    notes.push('no `palette.include` — every node type is offered');
  }

  const offered = new Set(safePalette(scenario).map((n) => n.type));

  for (const [type, overrides] of Object.entries((scenario.palette || {}).defaults || {})) {
    const def = getNode(type, scenario);
    if (!def) { err(`palette.defaults has an entry for unknown node type "${type}"`); continue; }
    if (!offered.has(type)) warn(`palette.defaults sets "${type}", which the palette does not offer`);
    for (const key of Object.keys(overrides)) {
      if (!(def.params || []).some((p) => p.name === key) && !(key in (def.defaults || {}))) {
        warn(`palette.defaults.${type}.${key} is not a parameter of ${type}`);
      }
    }
  }

  /* ── credentials ──────────────────────────────────────────────────── */

  /**
   * Credential TYPES are what a scenario declares now. The candidate creates the
   * instances and types the secret in, so there is nothing here to check for a
   * value — only that the shape a candidate is asked to fill in can actually
   * produce the header the mock host demands.
   */
  const types = credentialTypes(scenario);
  const declaredTypes = new Set((scenario.credentialTypes || []).map((t) => t && t.name));

  for (const [index, type] of (scenario.credentialTypes || []).entries()) {
    const where = type && type.name ? `credentialTypes."${type.name}"` : `credentialTypes[${index}]`;
    if (!type || typeof type !== 'object') { err(`${where} is not an object`); continue; }
    if (!type.name) { err(`${where} has no \`name\` — nodes reference a credential type by name`); continue; }
    if (!type.label) warn(`${where} has no \`label\`; the picker will show the raw name`);

    const fieldNames = new Set((type.fields || []).map((f) => f && f.name).filter(Boolean));
    if (!fieldNames.size) err(`${where} declares no \`fields\`, so there is nothing for a candidate to fill in`);
    for (const field of type.fields || []) {
      if (!field || !field.name) err(`${where} has a field with no \`name\``);
      else if (!field.label) warn(`${where}.${field.name} has no \`label\``);
    }

    if (!Array.isArray(type.auth) || !type.auth.length) {
      err(`${where} declares no \`auth\` rules, so filling it in would send no header`);
    }
    for (const rule of type.auth || []) {
      if (!rule || rule.in !== 'header') { err(`${where} has an auth rule that is not \`in: "header"\``); continue; }
      for (const [, ref] of String(`${rule.name} ${rule.value}`).matchAll(/\{([A-Za-z_$][\w$]*)\}/g)) {
        if (!fieldNames.has(ref)) err(`${where} auth references {${ref}}, which is not one of its fields`);
      }
    }
  }

  /**
   * A node whose credential type nobody declared can never be authenticated — the
   * candidate opens the picker and finds nothing to create.
   *
   * An ERROR when the palette names the node explicitly: offering something
   * unusable is a mistake. A WARNING when the palette is open, because "every node
   * is offered" is a convenience default and most of the catalogue will be
   * irrelevant to the task anyway.
   */
  const explicit = Array.isArray(include);
  for (const node of safePalette(scenario)) {
    const wanted = node.credentialType;
    if (!wanted) continue;
    if (declaredTypes.has(wanted) || BUILT_IN_TYPES[wanted]) continue;

    const message = `${explicit ? 'the palette offers' : 'the palette (open by default) includes'} `
      + `"${node.type}", which needs a "${wanted}" credential, but \`credentialTypes\` `
      + 'does not declare one. The candidate would have nothing to create.';
    if (explicit) err(message); else warn(message);
  }

  // A scenario MAY still ship ready-made credentials for a task that is not about
  // credentials; those still have to be well formed.
  const credentialIds = new Set();
  for (const cred of scenario.credentials || []) {
    if (!cred.id) { err('a credential has no `id`'); continue; }
    if (credentialIds.has(cred.id)) err(`two credentials share the id "${cred.id}"`);
    credentialIds.add(cred.id);
    if (!cred.name) warn(`credential "${cred.id}" has no \`name\`; the picker will show nothing`);
    if (!types.has(cred.type)) {
      err(`credential "${cred.id}" has type "${cred.type}", which \`credentialTypes\` does not declare`);
    }
  }

  /* ── mock API ─────────────────────────────────────────────────────── */

  const hosts = (scenario.mockApi || {}).hosts || {};
  if (!Object.keys(hosts).length && offered.has('httpRequest')) {
    warn('the palette offers HTTP Request but `mockApi.hosts` is empty — every request will be refused');
  }

  for (const [host, config] of Object.entries(hosts)) {
    if (!RESERVED_TLDS.some((tld) => host.endsWith(tld))) {
      err(`host "${host}" does not use a reserved TLD (${RESERVED_TLDS.join(', ')}). `
        + 'Reserved TLDs are guaranteed not to resolve, which is what makes the sandbox safe.');
    }
    if (!Array.isArray(config.routes) || !config.routes.length) {
      err(`host "${host}" declares no routes`);
      continue;
    }
    for (const [i, route] of config.routes.entries()) {
      const at = `${host} route ${i + 1}`;
      if (!route.path || !String(route.path).startsWith('/')) err(`${at}: \`path\` must start with "/"`);
      if (route.method && !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(route.method)) {
        err(`${at}: unsupported method "${route.method}"`);
      }
      if (route.when && !['authenticated', 'unauthenticated'].includes(route.when)) {
        err(`${at}: \`when\` must be "authenticated" or "unauthenticated"`);
      }
      if (route.status !== undefined && typeof route.status !== 'number') {
        err(`${at}: \`status\` must be a number`);
      }
      if (route.when && !config.requireAuth) {
        warn(`${at}: uses \`when\` but the host has no \`requireAuth\`, so auth state never varies`);
      }
    }
    if (config.requireAuth) {
      const header = config.requireAuth.header;
      if (!header) err(`host "${host}": requireAuth needs a \`header\``);

      /**
       * Can any credential the candidate is able to CREATE set this header?
       *
       * The old check looked for a ready-made credential carrying the right
       * value; there are none any more. What matters now is whether some declared
       * type writes this header name at all — because if none does, the host is
       * unreachable however carefully the candidate fills the form in, and they
       * will spend the task hunting a 401 they cannot fix.
       *
       * The value is not checked and cannot be: the candidate supplies it, and
       * getting it wrong is the lesson.
       */
      const canSetHeader = (rules) => (rules || []).some((rule) => rule && rule.in === 'header'
        // A `{placeholder}` in the header NAME could match anything, so a type
        // whose header name is candidate-controlled is treated as able to reach it.
        && (/\{/.test(String(rule.name))
          || String(rule.name).toLowerCase() === String(header).toLowerCase()));

      const reachable = [...types.values()].some((t) => canSetHeader(t.auth));
      if (!reachable && header) {
        warn(`host "${host}" requires header "${header}", and no declared credential type `
          + 'sets it — the endpoint is unreachable however the candidate fills the form in');
      }
    }
  }

  /* ── initial workflow ─────────────────────────────────────────────── */

  const initial = scenario.initialWorkflow;
  if (initial) {
    const ids = new Set();
    const names = new Set();
    for (const node of initial.nodes || []) {
      if (!node.id) err('a node in initialWorkflow has no `id`');
      if (ids.has(node.id)) err(`initialWorkflow has two nodes with id "${node.id}"`);
      ids.add(node.id);
      if (names.has(node.name)) {
        err(`initialWorkflow has two nodes named "${node.name}" — names must be unique, `
          + 'because expressions address nodes by name');
      }
      names.add(node.name);
      if (!getNode(node.type, scenario)) err(`initialWorkflow node "${node.name}" has unknown type "${node.type}"`);
      else if (include && !offered.has(node.type)) {
        warn(`initialWorkflow uses "${node.type}", which the palette does not offer — `
          + 'the candidate could not re-create it if they delete it');
      }
      if (node.credentialId && !credentialIds.has(node.credentialId)) {
        err(`initialWorkflow node "${node.name}" references undeclared credential "${node.credentialId}"`);
      }
      if (!Array.isArray(node.position) || node.position.length !== 2) {
        warn(`initialWorkflow node "${node.name}" has no valid \`position\`; it will land at 0,0`);
      }
    }
    for (const c of initial.connections || []) {
      if (!ids.has(c.from)) err(`initialWorkflow connection references unknown node "${c.from}"`);
      if (!ids.has(c.to)) err(`initialWorkflow connection references unknown node "${c.to}"`);
    }
    /**
     * A Loop Over Items back-edge is a legal cycle, so the check has to strip the
     * back-edges the same way the scheduler does before deciding. Otherwise a
     * perfectly valid starting workflow with a loop in it would fail validation.
     */
    if ((initial.nodes || []).length) {
      const { backEdges, nested } = loopStructure(initial.nodes, initial.connections || []);
      if (nested) {
        err(`initialWorkflow has a Loop Over Items node ("${nested}") inside another loop's body; nested loops are not supported`);
      }
      const acyclic = (initial.connections || []).filter((c) => !backEdges.has(c));
      if (!topologicalOrder(initial.nodes, acyclic)) {
        err('initialWorkflow contains a cycle that is not a Loop Over Items back-edge, which the engine cannot execute');
      }
    }
  } else {
    notes.push('no `initialWorkflow` — the candidate starts from an empty canvas');
  }

  /* ── trigger payloads ─────────────────────────────────────────────── */

  for (const type of Object.keys(scenario.triggerPayload || {})) {
    if (!getNode(type, scenario)) warn(`triggerPayload has an entry for unknown node type "${type}"`);
    else if (getNode(type, scenario).inputs !== 0) warn(`triggerPayload."${type}" is not a trigger node`);
  }
  for (const type of offered) {
    const def = getNode(type, scenario);
    // A subagent has no inputs either, but it is called, not triggered.
    if (def && def.inputs === 0 && !def.toolOutput && !def.parserOutput && !(scenario.triggerPayload || {})[type] && type !== 'scheduleTrigger') {
      warn(`the palette offers "${type}" but no triggerPayload is declared for it — `
        + 'it will emit an empty item');
    }
  }

  /* ── limits ───────────────────────────────────────────────────────── */

  for (const [key, value] of Object.entries(scenario.limits || {})) {
    if (typeof value !== 'number' || value <= 0) err(`limits.${key} must be a positive number`);
  }

  /* ── assertions ───────────────────────────────────────────────────── */

  if (scenario.grading !== undefined) {
    if (!scenario.grading || typeof scenario.grading !== 'object' || Array.isArray(scenario.grading)) {
      err('`grading` must be an object, e.g. { "private": true }');
    } else if (scenario.grading.private !== undefined && typeof scenario.grading.private !== 'boolean') {
      err('`grading.private` must be true or false');
    }
  }

  const assertions = scenario.assertions;
  if (!assertions) {
    warn('no `assertions` — nothing defines correct, so every solution grades as FAIL');
  } else if (!Array.isArray(assertions) || !assertions.length) {
    err('`assertions` must be a non-empty array');
  } else {
    const seen = new Set();
    let outcomeChecks = 0;
    const mechanismIds = [];

    for (const a of assertions) {
      if (!a.id) { err('an assertion has no `id`'); continue; }
      if (seen.has(a.id)) err(`two assertions share the id "${a.id}"`);
      seen.add(a.id);

      if (!ASSERTION_FIELDS[a.type]) {
        err(`assertion "${a.id}" has unknown type "${a.type}". `
          + `Known: ${Object.keys(ASSERTION_FIELDS).join(', ')}`);
        continue;
      }
      for (const field of ASSERTION_FIELDS[a.type]) {
        if (a[field] === undefined) err(`assertion "${a.id}" (${a.type}) needs \`${field}\``);
      }
      if (!a.message) {
        warn(`assertion "${a.id}" has no \`message\`; a rejection will be harder to explain`);
      }
      if (a.private !== undefined && typeof a.private !== 'boolean') {
        err(`assertion "${a.id}": \`private\` must be true or false`);
      }

      // An assertion targeting a node the candidate cannot add is unsatisfiable.
      const spec = a.nodeType || a.fromType || a.toType;
      if (spec) {
        const alternatives = String(spec).split('|').map((t) => t.trim());
        for (const t of alternatives) {
          if (!known.has(t)) err(`assertion "${a.id}" targets unknown node type "${t}"`);
        }
        if (!alternatives.some((t) => offered.has(t))) {
          err(`assertion "${a.id}" requires ${spec}, which the palette does not offer — `
            + 'the task is impossible as authored');
        }
        if (['aggregate', 'splitOut', 'filter', 'if', 'set', 'code'].some((t) => alternatives.includes(t))) {
          mechanismIds.push(a.id);
        }
      }
      if (['sinkPayloadMatches', 'httpCalled'].includes(a.type)) outcomeChecks += 1;
    }

    // The trap that produced a false negative: mechanism assertions plus a
    // general-purpose escape hatch invites a solution the grader then rejects.
    if (mechanismIds.length && offered.has('code')) {
      err('this scenario asserts on specific node types '
        + `(${mechanismIds.join(', ')}) but also offers the Code node, which can satisfy `
        + 'the task without them. Either drop `code` from the palette, or restate those '
        + 'assertions as outcomes (sinkPayloadMatches / httpCalled).');
    }
    if (!outcomeChecks) {
      warn('no assertion checks an outcome (sinkPayloadMatches / httpCalled) — '
        + 'a solution could satisfy every structural check and still do the wrong thing');
    }
  }

  /* ── the AI block: models and replay fixtures ──────────────────────── */

  /**
   * The checks below are the ones an author trips over,
   * and the first is the one that matters most: a task offering an Agent with no
   * fixtures produces a node that can only ever fail, and it fails at candidate
   * time rather than authoring time.
   */
  const offersAgent = safePalette(scenario).some((n) => n.type === 'agent');

  // A subagent with no agent to attach to can never run.
  if (safePalette(scenario).some((n) => n.type === 'agentTool') && !offersAgent) {
    err('the palette offers the AI Agent Tool but not the AI Agent, so a subagent has '
      + 'nothing to attach to');
  }

  if (scenario.ai !== undefined) {
    if (typeof scenario.ai !== 'object' || scenario.ai === null || Array.isArray(scenario.ai)) {
      err('`ai` must be an object — see docs/agent-nodes.md');
    } else {
      const ai = scenario.ai;

      if (ai.mode && !['replay', 'live', 'record'].includes(ai.mode)) {
        err(`ai.mode must be "replay", "live" or "record"; got ${JSON.stringify(ai.mode)}`);
      }
      if (ai.mode && ai.mode !== 'replay') {
        err(`ai.mode is "${ai.mode}", but the engine can only replay — it cannot import a `
          + 'network module, by a test that fails the build. Record fixtures with the '
          + 'authoring tool and ship the task as "replay".');
      }
      if (ai.models !== undefined && (!Array.isArray(ai.models) || !ai.models.length)) {
        err('`ai.models` must be a non-empty array of model names the task offers');
      }
      if (ai.fixtures !== undefined && !Array.isArray(ai.fixtures)) {
        err('`ai.fixtures` must be an array');
      }

      const seen = new Set();
      const calledTools = new Set();
      const answeredTools = new Set();
      for (const [index, fixture] of (Array.isArray(ai.fixtures) ? ai.fixtures : []).entries()) {
        const where = fixture && fixture.id ? `ai.fixtures."${fixture.id}"` : `ai.fixtures[${index}]`;
        if (!fixture || typeof fixture !== 'object') { err(`${where} is not an object`); continue; }
        if (!fixture.id) warn(`${where} has no \`id\`; the trace cannot say which fixture answered`);
        else if (seen.has(fixture.id)) err(`${where} is defined twice`);
        if (fixture.id) seen.add(fixture.id);

        if (fixture.respond === undefined) {
          err(`${where} has no \`respond\`, so the agent would receive nothing`);
        } else if (fixture.respond === null || !['string', 'object'].includes(typeof fixture.respond)) {
          err(`${where}.respond must be text (no output parser), an object of fields (Structured Output Parser) or a list (Item List Output Parser)`);
        }
        if (fixture.fixed !== undefined && (fixture.fixed === null || !['string', 'object'].includes(typeof fixture.fixed))) {
          err(`${where}.fixed must be the answer an Auto-fixing Output Parser's model returns: an object of fields or a list`);
        }

        const when = fixture.when;
        if (when !== undefined && (when === null || typeof when !== 'object' || Array.isArray(when))) {
          err(`${where}.when must be an object`);
        } else if (when) {
          for (const key of Object.keys(when)) {
            if (!['node', 'input', 'tool'].includes(key)) {
              err(`${where}.when."${key}" is not a thing a fixture can match on. Use \`input\` `
                + '(a partial match on the incoming item), \`node\` (the node name) or \`tool\` '
                + '(a subagent\'s tool name). Never the prompt: a candidate who improves their '
                + 'prompt would stop matching.');
            }
          }
          if (when.tool !== undefined && (typeof when.tool !== 'string' || !when.tool)) {
            err(`${where}.when.tool must be a tool name`);
          }
        }

        /*
         * `calls` replays the tool calls the model made before answering. Each
         * names a subagent by tool name and gives it the input the model chose.
         */
        if (fixture.calls !== undefined) {
          if (!Array.isArray(fixture.calls)) {
            err(`${where}.calls must be an array of { "tool": ..., "input": { ... } }`);
          } else {
            for (const [i, call] of fixture.calls.entries()) {
              if (!call || typeof call.tool !== 'string' || !call.tool) {
                err(`${where}.calls[${i}] needs a \`tool\` name`);
              } else {
                calledTools.add(call.tool);
              }
              if (call && call.input !== undefined
                && (call.input === null || typeof call.input !== 'object' || Array.isArray(call.input))) {
                err(`${where}.calls[${i}].input must be an object`);
              }
            }
          }
        }
        if (fixture.when && typeof fixture.when.tool === 'string') answeredTools.add(fixture.when.tool);
      }

      // A call to a tool no fixture answers is refused at run time, every time.
      for (const tool of calledTools) {
        if (!answeredTools.has(tool)) {
          err(`a fixture calls the tool "${tool}", but no fixture has \`when.tool: "${tool}"\` `
            + 'to answer it, so the subagent would always be refused. Top-level fixtures never '
            + 'answer a subagent.');
        }
      }

      /**
       * A catch-all last is almost always what an author wants: without one, an
       * input they did not anticipate denies the call and the candidate sees a
       * fixture error for a workflow that is arguably correct.
       */
      // Subagent fixtures have their own catch-alls; only top-level ones count here.
      const list = (Array.isArray(ai.fixtures) ? ai.fixtures : [])
        .filter((f) => !(f && f.when && f.when.tool !== undefined));
      if (list.length && list.every((f) => f && f.when && Object.keys(f.when).length)) {
        warn('no catch-all AI fixture (one with an empty `when`) — any input the fixtures do '
          + 'not anticipate will deny the call, which reads to a candidate as a broken task');
      }

      /*
       * Live answers (Learn): agent calls get real answers through the session's
       * LLM Proxy while the learner builds; grading still replays the fixtures.
       * So the fixtures stay required, and a catch-all becomes required too — a
       * live run reaches inputs the author never recorded, and grading must still
       * answer them.
       */
      const live = ai.live;
      if (live !== undefined) {
        if (!live || typeof live !== 'object' || Array.isArray(live)) {
          err('`ai.live` must be an object, e.g. { "enabled": true, "provider": "openai", "models": { … } }');
        } else if (live.enabled === true) {
          if (live.provider !== undefined && live.provider !== 'openai') {
            err('`ai.live.provider` must be "openai" — the LLM Proxy provider this simulation speaks');
          }
          const models = live.models;
          if (!models || typeof models !== 'object' || Array.isArray(models)) {
            err('`ai.live.models` must map each dropdown label to a model id the proxy serves, '
              + 'e.g. { "gpt-5-mini": "gpt-5-mini" }');
          } else {
            for (const label of (Array.isArray(ai.models) ? ai.models : [])) {
              const name = typeof label === 'string' ? label : label && label.id;
              if (typeof models[name] !== 'string' || !models[name]) {
                err(`\`ai.live.models\` has no model id for "${name}", so that choice could never answer live`);
              }
            }
          }
          for (const key of ['maxCallsPerRun', 'timeoutMs']) {
            if (live[key] !== undefined && !(Number.isInteger(live[key]) && live[key] > 0)) {
              err(`\`ai.live.${key}\` must be a positive whole number`);
            }
          }
          if (!list.length || list.every((f) => f && f.when && Object.keys(f.when).length)) {
            err('`ai.live` needs a catch-all fixture (an empty `when`): a live run can reach inputs '
              + 'nobody recorded, and grading replays the fixtures');
          }
          if (scenario.grading && scenario.grading.private === true) {
            err('`ai.live` cannot be combined with `grading.private` — private grading is for Hire, '
              + 'and Hire answers only from recordings');
          }
        } else if (live.enabled !== false) {
          err('`ai.live.enabled` must be true or false');
        }
      }
    }
  }

  /**
   * Same severity split as the credential-type check: an ERROR when the palette
   * names the Agent explicitly, because offering an unusable node is a mistake; a
   * WARNING when the palette is open, because "every node is offered" is a
   * convenience default and most of the catalogue is irrelevant to the task.
   */
  if (offersAgent) {
    const explicitAgent = Array.isArray(include);
    const say = explicitAgent ? err : warn;
    const how = explicitAgent ? 'the palette offers' : 'the palette (open by default) includes';

    if (!(((scenario.ai || {}).fixtures) || []).length) {
      say(`${how} the AI Agent, but \`ai.fixtures\` declares nothing for it to answer `
        + 'with. Every agent call would be refused.');
    }
    if (!(((scenario.ai || {}).models) || []).length) {
      say(`${how} the AI Agent, but \`ai.models\` declares no models, so the model `
        + 'dropdown would be empty.');
    }
  }

  /* ── approvals ────────────────────────────────────────────────────── */

  /**
   * `scenario.approvals` answers approval nodes for HEADLESS runs — the
   * solvability check here, `run.js`, the tests. An interactive run ignores it
   * and asks the candidate, which is the point of the node.
   *
   * Without it, a task containing an approval cannot be proved solvable: the
   * reference run would stop at the pause and every assertion after it would
   * fail, which reads as a broken task rather than a missing default.
   */
  if (scenario.approvals !== undefined) {
    if (typeof scenario.approvals !== 'object' || scenario.approvals === null
      || Array.isArray(scenario.approvals)) {
      err('`approvals` must be an object mapping an approval node name to "approve" or "reject"');
    } else {
      for (const [node, decision] of Object.entries(scenario.approvals)) {
        if (decision !== 'approve' && decision !== 'reject') {
          err(`approvals."${node}" is ${JSON.stringify(decision)}; it must be "approve" or "reject"`);
        }
      }
    }
  }

  if (safePalette(scenario).some((n) => n.type === 'approval')
    && !Object.keys(scenario.approvals || {}).length) {
    warn('the palette offers Wait For Approval but `approvals` declares no decision for a '
      + 'headless run, so the solvability check will stop at the pause. Name the approval '
      + 'node your reference solution uses and say what the approver does.');
  }

  /* ── answer leakage via node defaults ─────────────────────────────── */

  const secrets = answerStrings(scenario);
  for (const node of allNodes(scenario)) {
    for (const { at, value } of flattenStrings(node.defaults || {})) {
      for (const secret of secrets) {
        if (value.includes(secret)) {
          err(`node default ${node.type}.${at} contains "${secret}", which this scenario `
            + 'treats as the answer — dragging the node out would hand it over');
        }
      }
    }
  }
  for (const [type, overrides] of Object.entries((scenario.palette || {}).defaults || {})) {
    for (const { at, value } of flattenStrings(overrides)) {
      for (const secret of secrets) {
        if (value.includes(secret)) {
          warn(`palette.defaults.${type}.${at} pre-fills "${secret}", which an assertion checks. `
            + 'Deliberate pre-filling is fine — just confirm you meant to give this away.');
        }
      }
    }
  }

  /* ── expression hygiene ───────────────────────────────────────────── */

  for (const { at, value } of flattenStrings(initial || {})) {
    if (value.startsWith('=') && !value.includes('{{')) {
      warn(`initialWorkflow ${at} starts with "=" but has no {{ }} span, so it is literal text`);
    }
    const opens = (value.match(/\{\{/g) || []).length;
    const closes = (value.match(/\}\}/g) || []).length;
    if (opens !== closes) err(`initialWorkflow ${at} has unbalanced {{ }} braces`);
  }

  /* ── solvability: the check worth more than all the others ────────── */

  if (options.referenceSolution) {
    if (errors.length) {
      notes.push('skipped the solvability check because the scenario has errors');
    } else {
      const outcome = await checkSolvable(scenario, options.referenceSolution);
      errors.push(...outcome.errors);
      notes.push(...outcome.notes);
    }
  } else {
    warn('no reference_solution.json alongside this scenario, so it cannot be proved solvable. '
      + 'Authoring one is the single best check available.');
  }

  return { ok: errors.length === 0, errors, warnings, notes };
}

/**
 * Run the author's own reference solution and require it to pass. If the intended
 * answer does not grade as correct, nothing else about the scenario matters.
 */
async function checkSolvable(scenario, solution) {
  const { evaluateAssertions } = require('../grading/assertions');
  const errors = [];
  const notes = [];

  let trace;
  try {
    trace = await run(scenario, solution);
  } catch (e) {
    return { errors: [`the reference solution could not be executed: ${e.message}`], notes };
  }

  if (trace.status === 'error') {
    errors.push('the reference solution fails at runtime: '
      + (trace.errors || []).map((x) => `${x.node ? `${x.node}: ` : ''}${x.message}`).join('; '));
  }

  const failed = evaluateAssertions(scenario, solution, trace).filter((a) => !a.pass);
  if (failed.length) {
    errors.push('the reference solution does not satisfy this scenario\'s own assertions, '
      + 'so the task is not solvable as authored:\n'
      + failed.map((a) => `      ${a.id}: ${a.detail}`).join('\n'));
  } else if (trace.status !== 'error') {
    notes.push(`the reference solution passes all ${scenario.assertions.length} assertions`);
  }
  return { errors, notes };
}

/* ── helpers ────────────────────────────────────────────────────────── */

function safePalette(scenario) {
  try { return paletteFor(scenario); } catch { return []; }
}

/**
 * Tokens of the expression language itself, which are never an answer.
 *
 * An `expressionContains` substring is usually a giveaway — `$json.region` tells
 * you which field to read. But it can also be a SYNTAX requirement: "the prompt
 * must interpolate the item" is expressed as `substring: "$json."`, and that
 * reveals nothing a candidate could not read in the help panel. Treating it as an
 * answer makes every placeholder that shows how to write an expression — the ones
 * that exist precisely to teach the syntax — look like a leak.
 */
const LANGUAGE_TOKENS = new Set(['$json', '$json.', '{{', '}}', '{{ }}', '$node', '$vars', '$env', '$now', '$today']);

/** Strings a candidate is supposed to work out for themselves. */
function answerStrings(scenario) {
  const out = new Set();
  for (const a of scenario.assertions || []) {
    for (const { value } of flattenStrings(a.match === undefined ? {} : { match: a.match })) out.add(value);
    if (a.substring) out.add(a.substring);
    if (typeof a.value === 'string') out.add(a.value);
  }
  for (const host of Object.keys((scenario.mockApi || {}).hosts || {})) out.add(host);
  return [...out].filter((s) => typeof s === 'string' && s.length >= 4 && !LANGUAGE_TOKENS.has(s));
}

function flattenStrings(value, at = '') {
  const out = [];
  const walk = (v, path) => {
    if (typeof v === 'string') { out.push({ at: path, value: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
    }
  };
  walk(value, at);
  return out;
}

module.exports = {
  validateScenario, RESERVED_TLDS, ASSERTION_FIELDS, answerStrings, LANGUAGE_TOKENS,
};
