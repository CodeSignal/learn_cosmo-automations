# Changing things

The repo looks big because the *engine* lives here. **Most of what a course needs
changed is not in this repo at all.** Find your change below and start there.

| I want to… | Touch | Repo change? |
|---|---|---|
| Write a new task / course exercise | a `scenario.json`, authored in the Engine task | **No** |
| Add a credential type for a service | that task's `scenario.json`, under `credentialTypes` | **No** |
| Reword or narrow an existing task | that task's `scenario.json` | **No** |
| Add a scenario to develop or regression-test against | `scenarios/<name>/` | yes, data only |
| Add a **service/integration** node for one task | that task's `scenario.json`, under `nodes` | **No** |
| Replace a shipped integration for one task | that task's `scenario.json`, same `type` | **No** |
| Add a shipped integration for everyone | `engine/nodes/library/<name>.json` | yes, data only |
| Add a **flow or data** node (branching, item algebra) | `engine/nodes/`, `shared/node-docs.mjs`, a test | yes, code |
| Add an assertion type | `grading/assertions.js`, `engine/validate.js`, a test | yes, code |
| Change what STDOUT says | `grading/format.js` | yes, code — **read the warning** |
| Change the canvas or panels | `client/` | yes, code |
| Change a platform contract | don't — see [`AGENTS.md`](../AGENTS.md) | — |

---

## 1. A new task — the common case

A task is **data**. `scenario.json` is authored in the Engine task; `setup.sh`
downloads this simulation's release and drops that file in beside it. Nobody
writing a course clones this repo.

Copy [`scenario.example.jsonc`](../scenario.example.jsonc) — it documents every
key inline — and then, **always**:

```bash
npm run validate path/to/scenario.json
```

That is the only place an authoring mistake can surface before a candidate hits
it. It catches typo'd node types, assertions the palette makes impossible, hosts
that aren't reserved TLDs, duplicate ids, cycles in the starting workflow, and
node defaults that would hand over the answer.

**Put a `reference_solution.json` next to it.** The validator then executes your
intended answer and grades it, so the task is *proved solvable*. This is worth
more than every other check combined — it catches an assertion that expects the
wrong number, or an endpoint no credential can reach:

```
✗ the reference solution does not satisfy this scenario's own assertions,
  so the task is not solvable as authored:
      keeps-three-orders: expected in exactly 4, got Aggregate Totals=3
```

### The one design decision that matters

Assertions can check **how** a workflow is built (`nodeExists`, `connected`,
`expressionContains`, `itemCount` on an intermediate node) or **what it achieves**
(`sinkPayloadMatches`, `httpCalled`). Pick deliberately:

- **Mechanism assertions → narrow the palette.** If the lesson *is* Split Out →
  Filter → Aggregate, don't also offer the Code node. A candidate who solves it
  with Code will be right and get rejected.
- **Offering Code → assert on outcomes only.** Check the payload and the calls
  made, not which nodes exist.

The validator rejects the combination, because it produced exactly that false
negative during development.

---

## 2. A scenario in this repo

`scenarios/` holds **development fixtures**, not the tasks candidates get. They
exist so we can regression-test and demo. Adding one:

```bash
mkdir -p scenarios/my-task
cp scenario.example.jsonc scenarios/my-task/scenario.json   # strip the comments
# author reference_solution.json, and variants/ if you want grading coverage
npm run validate
```

Everything discovers scenarios through `engine/scenarios.js`, so there is nothing
else to edit. Pick which one the dev tooling uses with `COSMO_SCENARIO=my-task`.

Adding `variants/correct-*.json` and `variants/wrong-*.json` gets you a grading
experiment for free — `npm run experiment` runs them all and checks each is
classified as its filename claims.

---

## 3. A new node type

**First question: is it a service, or is it semantics?**

If the node calls something — an API, a database, a SaaS product — write it in the
task's `scenario.json` and change no code. That is [section 3a](#3a-a-service-node-in-scenariojson).

If the node *branches, splits, joins, sorts or counts*, it is semantics and it
belongs in code. Section 3b.

The line is deliberate: **JSON adds services, code adds semantics.** Services are
what varies task by task, and there is no end to them. Semantics are what every
task shares, they are what the grader's mechanism assertions name, and a JSON
dialect expressive enough to write them would be a programming language with none
of a language's tools.

### 3a. A service node, in `scenario.json`

```jsonc
"nodes": [{
  "type": "zendesk",
  "label": "Zendesk",
  "group": "integration",
  "icon": "chat",
  "description": "Lists helpdesk tickets, or adds a comment to one.",
  "credential": true,

  "operations": {
    "listTickets": {
      "mode": "runOnceForAllItems",
      "request": { "method": "GET", "url": "https://zendesk.test/api/v2/tickets",
                   "query": { "status": "{status}" } },
      "itemsFrom": "tickets"        // one item per array element
    },
    "addComment": {
      "mode": "runOncePerItem",
      "request": { "method": "POST",
                   "url": "https://zendesk.test/api/v2/tickets/{ticketId}/comments",
                   "body": { "body": "{comment}", "public": false } },
      "sink": true                  // record what was sent, for sinkPayloadMatches
    }
  },

  "params": [
    { "name": "status",   "label": "Status",    "type": "options",
      "options": ["open", "pending", "solved"], "showFor": { "operation": "listTickets" } },
    { "name": "ticketId", "label": "Ticket ID", "type": "string",
      "showFor": { "operation": "addComment" } },
    { "name": "comment",  "label": "Comment",   "type": "string", "multiline": true,
      "showFor": { "operation": "addComment" } }
  ],

  "docs": { "summary": "…", "when": "…", "gotchas": ["…"] }
}]
```

`scenarios/helpdesk-escalation/` is that example, working, with a reference
solution that `npm run validate` runs and grades.

**Start from a real one.** Every shipped integration is already JSON, in
`engine/nodes/library/`: `slack.json` (simplest — one operation, a write),
`gmail.json` (two operations, two modes), `google-sheets.json` (an envelope on the
way in and out), `postgres.json` (required parameters), `airtable.json` (a nested
response flattened). Copy the nearest one and edit it.

**You may replace a library node.** Declare `slack` in your scenario's `nodes` and
yours wins for that task; the validator notes it so nobody does it by accident. You
may *not* replace a coded node — flow and data nodes have to mean the same thing in
every task.

**What you get, free:** a palette entry, the parameter form, the operation picker
(generated from `operations` — do not declare it yourself), the right execution
mode per operation, the credential dropdown, expression support in every field,
the wiki page, the canvas summary, and identical treatment in the graded report.

**The template language is one feature wide.** `{paramName}` in a URL, query,
header or body is replaced with that parameter's value. `{param}` on its own keeps
the value's type; inside a longer string it interpolates. That is all it does —
and it is deliberately *not* the `{{ }}` expression language, because expressions
belong to the candidate: they type `={{ $json.id }}` into Ticket ID and the engine
resolves it before your node ever runs.

**Rules the validator enforces**, because there is no reviewer between an author
and a candidate:

- every host you call must be declared in `mockApi.hosts` — the transport is
  default-deny, so an undeclared host is a node that can only ever fail
- a `{placeholder}` may not appear in the **host**. Path, query, headers and body
  only: a candidate must never be able to choose which server gets called
- every `{placeholder}` must name a real parameter
- you cannot redefine a built-in — built-ins always win, and a scenario that could
  redefine `slack` would make every assertion naming a node type untrustworthy
- `mode` must be `runOncePerItem` or `runOnceForAllItems`

**What a service node cannot do:** route items to more than one output, run
candidate code, or transform items without calling something. Those are section 3b.

### 3b. A flow or data node, in code

Four files, and a test enforces the third:

1. **`engine/nodes/<group>.js`** — `register({ type, label, group, icon, inputs,
   outputs, mode, latency, defaults, params, run })`. `run(ctx, input)` receives
   parameters with expressions **already resolved**, and returns `Item[][]`
   (outer array = output port).
2. **`client/canvas/NodeIcon.jsx`** — a glyph, drawn with `currentColor`.
3. **`shared/node-docs.mjs`** — the wiki entry. *A test fails if you skip this*,
   deliberately: an undocumented node is a node candidates cannot learn.
4. **`shared/summarise.mjs`** — the one-line summary, if the node has interesting
   parameters. One implementation serves both the canvas and the STDOUT report, so
   they cannot disagree.

Then add it to a scenario's `palette.include` and run `npm test`.

Node defaults must be **empty of anything task-specific**. A default URL or
channel hands over the answer; a test derives the forbidden strings from every
shipped scenario and fails the build.

---

## 4. Changing the grading report

⚠️ **`grading/format.js` is the highest-risk file in the repo.** Its output is
what Cosmo reads, and the ten variants in `scenarios/*/variants/` are the
regression fixture for it. After any change:

```bash
npm test && npm run experiment    # must stay 10/10
```

Ask the question that has already caught two bugs: **could a correct solution be
misread as broken?** A false negative — a right answer marked wrong — is the
failure that destroys trust in a grader, because the candidate escalates and is
entitled to. It is why branch nodes spell out their ports and why fan-in/fan-out
annotate where items came from and went.

If you change the `## ASSERTIONS` or `## TRACE SIGNATURE` shape, update the
task's acceptance criteria in the same change — the grader reads those sections
positionally.

---

## 5. Known gaps in the authoring surface

Honest about what a course author *cannot* currently change without code.

### Presentation and wording

There is no way for an author to set the title or labels, hide whole affordances,
or override UI strings per language. A beginner course cannot hide the run log or
simplify a label without a code change.

The shape to copy, when this is needed:

```jsonc
"ui": {
  "title": "Order Routing",
  "hideRunLog": true,
  "strings": { "Execute Workflow": "Run it" }
}
```

Plus `i18n/en.json` with a `strings` override layer on top. Not built — flagged so
the next person doesn't rediscover the gap.

### Feedback to the candidate on submit

When `run_solution.sh` runs, the simulation could push a WebSocket event so the
candidate sees which parts were right or wrong, rather than only the grader
seeing it. The plumbing exists — `POST /message` broadcasts to
connected clients, and the canvas already consumes a WebSocket for run progress —
but **`run_solution.sh` does not use it.** A few lines, and a real UX improvement.

### Dependencies

Simulations usually keep dependencies minimal because of `npm install` wait time
in a session. We use React and `@xyflow/react` anyway, and that cost does not
apply here: nothing is installed
at runtime — `setup.sh` is `wget` + `tar`, with `node_modules` already inside the
release. The real cost is a **17 MB tarball** (75 MB unpacked). That is a
deliberate, documented divergence rather than an oversight; revisit it if session
start time ever measures badly.

---

## Before you commit, whatever you changed

```bash
npm test            # everything, headless
npm run validate    # every scenario still authored correctly and solvable
npm run experiment  # every grading variant still classified correctly
npm run rehearse    # the eu-orders demo workflow still behaves
```

Touched the release surface? `npm run release:local` builds a tarball and boots it
end to end.

Security and integrity properties are pinned by `test/security-regressions.test.js`;
a change that reopens one fails there.
