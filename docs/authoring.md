# Authoring a task

Everything a task needs lives in one `scenario.json` (delivered to a session as
`config.json`). The bundled scenarios are worked examples, each a model for a
different kind of lesson:

| | Teaches | Reach for it as a model when |
|---|---|---|
| [`scenarios/eu-orders`](../scenarios/eu-orders/scenario.json) | fetch → Split Out → Filter → Aggregate → notify | the lesson is the item model: one response becomes many items and then one again |
| [`scenarios/support-triage`](../scenarios/support-triage/scenario.json) | two sources → Remove Duplicates → Merge (join) → Switch → Sort → Limit → write | the lesson is combining and narrowing: data that lives in two places, routed and ranked |
| [`scenarios/payment-recovery`](../scenarios/payment-recovery/scenario.json) | all of the above, four branches, a batched loop, six services | you want the widest example — it is also the showcase demo (`npm run rehearse:showcase`) |
| [`scenarios/helpdesk-escalation`](../scenarios/helpdesk-escalation/scenario.json) | a **node defined in the scenario itself** — Zendesk, no code change | the task needs a service the palette does not have |
| [`scenarios/ticket-triage-ai`](../scenarios/ticket-triage-ai/scenario.json) | an **AI Agent** and a **human approval** — prompt, structured output, call cost | the lesson is using a model well, not just using one |
| [`scenarios/refund-desk-agents`](../scenarios/refund-desk-agents/scenario.json) | an agent with a **subagent tool** — delegation, and which model each job gets | the lesson is splitting agent work, not just prompting one agent |

`npm run validate` checks both, and *runs their reference solutions* — a scenario
whose own answer does not pass every assertion fails the build.

**The task statement is not in here.** It is written in Learn, outside the
simulation, and the sim never displays it — so the help panel is pure product
documentation and can never be mistaken for a hint. `scenario.json` keeps an
`instructions` array purely so whoever maintains the fixtures and assertions can
see what the task asks; the server strips it before the client ever sees it.

> **Validate before shipping any task.** `npm run validate path/to/scenario.json`
> catches typo'd node types, assertions the palette makes impossible, hosts that
> are not reserved TLDs, duplicate ids, cycles, and defaults that give away the
> answer. Put a `reference_solution.json` beside the scenario and it also **proves
> the task solvable** by executing your intended answer and grading it — worth more
> than every other check combined.

## 1. Which nodes the candidate gets

```jsonc
"palette": {
  "include": ["manualTrigger", "httpRequest", "splitOut", "filter", "aggregate", "slack"],
  "exclude": [],
  // Optional: pre-fill fields on every node of a type the candidate drags out.
  "defaults": {
    "httpRequest": { "url": "https://api.acme-crm.test/v1/" }
  }
}
```

`include` is the allowlist — omit it to offer every node. Narrowing the palette
is itself a design tool: leaving Aggregate out of a task that needs one summary
message tests whether the candidate notices, and leaving it *in* on a task
solvable with a plain IF tests whether they reach for it unnecessarily.

**Node defaults ship empty on purpose.** A default URL or channel would hand over
the answer, and `test/defaults.test.js` fails the build if any default or
placeholder ever contains a string a scenario treats as the answer. When you
*want* something pre-filled, say so explicitly with `palette.defaults`, or with a
starting graph:

```jsonc
"initialWorkflow": {
  "nodes": [
    { "id": "n1", "name": "When clicking Execute", "type": "manualTrigger",
      "position": [80, 240], "parameters": {} }
  ],
  "connections": []
}
```

`initialWorkflow` is also how you build the higher-signal task type: ship a
workflow that is wired but wrong and ask the candidate to fix it. The sim loads
`solution.json` if the candidate has one, and falls back to `initialWorkflow`.

### Bringing your own node

A task that needs a service the palette does not have — Zendesk, HubSpot, an
internal API — declares it in the same `scenario.json`, with no code change:

```jsonc
"nodes": [{
  "type": "zendesk", "label": "Zendesk", "icon": "chat",
  "description": "Lists helpdesk tickets, or adds a comment to one.",
  "operations": {
    "listTickets": { "mode": "runOnceForAllItems",
                     "request": { "method": "GET", "url": "https://zendesk.test/api/v2/tickets" },
                     "itemsFrom": "tickets" },
    "addComment":  { "mode": "runOncePerItem",
                     "request": { "method": "POST",
                                  "url": "https://zendesk.test/api/v2/tickets/{ticketId}/comments",
                                  "body": { "body": "{comment}" } },
                     "sink": true }
  },
  "params": [ /* the fields the candidate fills in */ ],
  "docs":   { "summary": "…" }
}]
```

It gets the palette entry, the parameter form, a generated operation picker, the
right execution mode per operation, credentials, expressions, a wiki page, a
canvas summary and identical treatment in the graded report.
`scenarios/helpdesk-escalation/` is a working example.

**The line is: JSON adds services, code adds semantics.** Anything that *calls*
something is configuration. Anything that branches, splits, joins, sorts or counts
is the item model — it is what every task shares and what the grader's mechanism
assertions name, so it stays in `engine/nodes/` with tests and a reviewer.

Every shipped integration is on the JSON side of that line already:

```
engine/nodes/library/   slack · gmail · google-sheets · postgres · airtable
```

They are not a lesser kind of node — they are registered alongside the coded ones
and behave identically. Writing them in JSON does two things. It proves the format
is expressive enough for real integrations rather than a toy, which is the only way
to know it is worth offering to authors. And it makes each one a **complete,
copyable example**: writing a Zendesk node starts from `slack.json`, not from a
specification.

Because they are examples, **a scenario may replace one** — declare `slack` in your
own `nodes` and yours wins for that task. A *coded* node it may not: `filter` has to
mean the same thing in every task, or an assertion naming a node type means nothing.

The validator is strict here, because nobody reviews a scenario before a candidate
opens it: undeclared hosts, `{placeholders}` that name nothing, a placeholder in
the *host* part of a URL, and redefining a built-in are all errors. See
[`docs/extending.md`](extending.md).

Adding a **flow or data** node is still a code change: register it in
`engine/nodes/` (type, ports, execution mode, parameter descriptors, `run`) and
document it in `shared/node-docs.mjs` — a test enforces that every node has
documentation, so the wiki cannot silently rot.

## 2. Expressions

Authors do not define expressions; the engine provides one evaluator and every
string parameter accepts it. What an author decides is **what the candidate must
write**, which is expressed through the fixtures and the assertions.

The convention, in scenario files and in the product, is that a string beginning
`=` is an expression and `{{ }}` spans inside it are evaluated per item:

```jsonc
{ "left": "={{ $json.region }}", "op": "equals", "right": "EU" }
```

Available inside a span: `$json`, `$node["Name"]`, `$("Name")`, `$itemIndex`,
`$items()`, `$now`, `$today`, `$vars`, `$env`, plus plain JavaScript on the
values. A parameter that is *only* a span keeps the value's real type, so
`={{ $json.total }}` stays the number `1420` and `gt` compares numerically.

To require a particular expression, assert on it rather than on prose:

```jsonc
{ "id": "filters-on-region", "type": "expressionContains",
  "nodeType": "filter|if", "param": "conditions", "substring": "$json.region" }
```

Shape the *data* so the interesting expression is the only one that works — for
example nest the payload under `body` so `{{ $json.region }}` resolves to
`[undefined]` and only `{{ $json.body.region }}` succeeds. That teaches the
lesson without ever stating it.

`$vars` and `$env` are stubbed from top-level `vars` / `env` blocks in the
scenario if a task needs configuration values.

## 3. Credentials the candidate creates

The scenario declares credential **types**. The candidate creates the instances
and types the secret in.

```jsonc
"credentialTypes": [
  {
    "name": "slackApi",                 // nodes reference a type by this name
    "label": "Slack API",
    "auth": [
      { "in": "header", "name": "Authorization", "value": "Bearer {token}" }
    ],
    "fields": [
      { "name": "token", "label": "Bot User OAuth Token", "type": "password",
        "placeholder": "xoxb-…" }
    ],
    "docs": "Slack → Your apps → OAuth & Permissions."
  }
]
```

**Why they create it rather than pick it.** Picking the only entry in a dropdown
tests nothing. Creating a credential tests three things the job actually requires:
which type a given node needs (the picker offers only matching ones), that the
secret goes in a specific named field, and what a 401 means when it is wrong.

**Put the value in the task statement**, which is written in Learn, outside the
simulation. The expected value stays in `mockApi.hosts[…].requireAuth`,
server-side — the browser is never sent it — so a wrong value is a real 401 rather
than a validation message.

The candidate's credentials live in their `solution.json` next to their nodes, so
they are saved, undone and hashed by the same machinery as everything else. Their
values are redacted from STDOUT by exact match, not by pattern.

`auth` is a list of header rules, each a `{placeholder}` template over the type's
own fields — enough for an API-key header, a bearer token, or a service wanting
two headers at once, without anyone editing the engine. A rule whose fields are
not all filled in contributes nothing, so a blank credential sends no header
instead of `Authorization: Bearer `.

A task that is *not* about credentials can still ship ready-made ones under
`credentials`, rather than making every candidate retype a token to reach the part
being taught. Most tasks should not.

## 4. APIs the workflow can call

Declare hosts and routes. Nothing else answers, and no request leaves the
sandbox:

```jsonc
"mockApi": {
  "hosts": {
    "api.acme-crm.test": {
      "requireAuth": { "header": "X-Api-Key", "equals": "sk_test_FAKE_2f9a1c" },
      "routes": [
        { "method": "GET", "path": "/v1/orders", "when": "unauthenticated",
          "status": 401, "body": { "error": "missing or invalid api key" } },
        { "method": "GET", "path": "/v1/orders", "when": "authenticated",
          "status": 200, "body": { "orders": [ /* fixture */ ] } },
        { "method": "POST", "path": "/v1/orders/:id/flag",
          "status": 202, "body": { "ok": true } }
      ]
    }
  }
}
```

- **Hostnames must use a reserved TLD** (`.test`, `.invalid`). They are
  guaranteed non-resolvable, so even a bug in the rewriter cannot reach a real
  host.
- **`path` supports `:params`**; `query` constrains query strings, where `"*"`
  means "present with any value".
- **`when: "authenticated" | "unauthenticated"`** is how you author a real 401
  path. A route that declares its auth state wins over a generic one, so listing
  the 401 first is not required but reads better.
- **`status` is honest.** A 4xx fails the node unless the candidate turns on
  *Never Error On Failed Status* — which is itself a gradeable decision.
- Credentials are declared separately and are fake, but the mock API *validates*
  them, so candidates still have to wire auth correctly:

```jsonc
"credentials": [
  { "id": "cred_crm", "name": "Acme CRM (staging)", "type": "httpHeaderAuth",
    "fields": { "name": "X-Api-Key", "value": "sk_test_FAKE_2f9a1c" } }
]
```

Supported types are `httpHeaderAuth` and `bearerAuth`. Values never reach the
browser, and the parse script redacts anything secret-shaped from STDOUT.

Because the fixtures are yours, you can author situations a live API cannot give
you reliably: a 401 on a missing key, a malformed record at a known index, a
boundary value that separates `gt` from `gte`.

## 5. Mechanism or outcome — pick one, deliberately

An assertion can check **how** a workflow is built (`nodeExists`, `connected`,
`expressionContains`, `itemCount` on an intermediate node) or **what it achieves**
(`sinkPayloadMatches`, `httpCalled`, `itemCount` on the sink). Both are valid, and
mixing them carelessly creates a false negative.

For example, adding the Code node to `eu-orders`' palette let a candidate
solve the task with one Code node producing the exactly-correct Slack payload —
and it was **rejected**, because three assertions require a Filter to exist and an
Aggregate to run. A right answer marked wrong is the failure that destroys trust
in a grader, so this matters more than it looks.

The rule:

- **Mechanism assertions? Narrow the palette.** If the lesson *is* Split Out →
  Filter → Aggregate, do not also offer a general-purpose escape hatch. `eu-orders`
  omits `code` for exactly this reason and says so in `palette.excludeNote`.
- **Offering Code? Assert on outcomes.** Check the sink payload and the calls made,
  not which nodes exist.

Two tests enforce the checkable half: every node type an assertion requires must
be in the palette (otherwise the task is impossible), and a scenario with
mechanism-based assertions must not also offer `code`.

## 6. What counts as correct

See [Grading](../README.md#grading). The one rule worth repeating: a scenario is well
designed when the assertion set separates a correct solution from a
*plausibly wrong* one. **Write the wrong variants first**, put them in
`variants/` as `wrong-*.json`, and run:

```bash
npm run experiment
```

Iterate headlessly — no browser needed:

```bash
node run.js scenarios/eu-orders/scenario.json my-attempt.json execution.json
node parse_automation_solution.js scenarios/eu-orders/scenario.json my-attempt.json
```
