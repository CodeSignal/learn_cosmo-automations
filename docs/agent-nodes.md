# AI Agent and Wait For Approval

Nodes that bring the agentic-workflow vocabulary into the
simulation — and the reasoning that makes them gradable, which is the part that is
not obvious.

## The objection, and the answer

> A model is non-deterministic. If the answer changes between runs, nothing it
> says can be asserted on, so an agent node cannot be part of a graded task.

True, and beside the point. The model's prose was never the interesting part.
Three things are, and all three are deterministic:

| | What it tests | How it is graded |
|---|---|---|
| **The prompt** | Did they give the model a role? Did they put the *item* in the prompt, or hardcode one example? | `expressionContains` on `systemPrompt` / `userPrompt` — static text in the graph, no model involved |
| **The output contract** | Did they ask for the fields the rest of the workflow needs? | `outputFields` becomes part of the item; get it wrong and the next node reads `[undefined]` |
| **The call pattern** | One call per item or one for all? Which model? | `aiCalled` — this is the bill |

A candidate who writes `Classify this ticket: Card declined at checkout` instead
of `Classify this ticket: {{ $json.subject }}` has written a workflow that asks
the same question six times. That is a real mistake, it is the most common one,
and catching it needs no model at all.

## The engine can only replay

`test/transport.test.js` walks `engine/` and fails the build if any file imports a
network module. That rule covers `engine/ai/` too, so a live model call cannot be
made from inside the engine however anyone configures it — `ai.mode: "live"` is
refused with an explanation rather than quietly behaving like replay.

The consequences are the whole security argument for putting agents in front of a
candidate:

- **A session cannot reach a model.** No API key in the container, no spend, no
  egress — and no path for a prompt-injection payload hidden in the fixture data
  to reach a real model.
- **Two runs agree**, so a grader can assert on what came out.
- **The task costs nothing**, however many candidates sit it.

## Fixtures match the input, never the prompt

The one decision that makes prompt-grading survivable.

```jsonc
"ai": {
  "mode": "replay",
  "models": ["gpt-5", "gpt-5-mini"],
  "fixtures": [
    { "id": "classify-T-01",
      "when":    { "input": { "ticket": "T-01" } },   // ← data the AUTHOR controls
      "respond": { "category": "billing", "severity": 4 } },

    { "id": "catch-all", "when": {}, "respond": { "category": "question", "severity": 1 } }
  ]
}
```

Key a fixture to the prompt text and a candidate who writes a **better** prompt
gets a fixture miss and fails for improving. So `when` accepts `input` (a partial
match on the incoming item) and `node` (the node's name, for tasks that ship a
fixed `initialWorkflow`) — and the validator refuses anything else by name,
including `prompt`, with that reasoning in the error.

First match wins, as with Switch rules and mock routes. **Always include a
catch-all**; without one, an input you did not anticipate denies the call and
reads to a candidate as a broken task. The validator warns if you forget.

## Wait For Approval, and why pausing is not a snapshot

The run stops, a person approves or rejects, the items leave on the matching port.

The obvious implementation suspends the engine mid-walk and serialises its state
so a later request can resume. That is what you must do when runs are expensive or
non-deterministic, and it costs you a state format, a recovery path and a restart
story.

This engine is deterministic — fixed clock, seeded randomness, mocked transport,
replayed model calls — so **a trace is a pure function of (scenario, graph,
decisions)**. Resuming is therefore just running again with one more answer known.
There is no snapshot to write, nothing to restore after a restart, and no way for
saved state to drift from the code that produced it. Re-executing the nodes before
the pause costs nothing, because none of them touch anything real.

Determinism bought resumability for free. It is the same property that makes
grading possible, used twice.

```jsonc
// Answers approvals for HEADLESS runs — the solvability check, run.js, the tests.
// An interactive run ignores this and asks the candidate, which is the point.
"approvals": { "Confirm Escalation": "approve" }
```

A paused run is **never** the graded run: `execution.json` is not written until
the workflow finishes, exactly as for a partial "Execute Node" run.

## Writing a task with an agent

1. Declare `ai.models` — the choice should matter. Offering only one model removes
   the cost decision.
2. Record `ai.fixtures`, one per input you expect, plus a catch-all.
3. Say in the task statement **which fields to ask for**. The candidate cannot
   guess your fixture's schema, and guessing is not the skill.
4. Assert on the prompt (`expressionContains`), the fields (`expressionContains`
   on `outputFields`) and the calls (`aiCalled`).
5. If the task has an approval, add `approvals` so `npm run validate` can prove it
   solvable.

`scenarios/ticket-triage-ai/` does all five.

## Subagents: an agent calling another as a tool

An **AI Agent Tool** is a second agent the first may call — agent-as-tool. It is wired from its top edge to the **Tools**
port on the bottom of an AI Agent. That wire means "may call", not "sends
items", so the tool never runs as a step of the workflow: it runs when, and as
often as, the parent's model calls it.

**How that replays.** In production the model decides to call a tool, the tool
answers, and the answer goes back into the conversation. Here the decision is
recorded in the parent's fixture, and the subagent answers from its own:

```jsonc
{ "id": "decide-R-01", "when": { "input": { "request": "R-01" } },
  "calls": [{ "tool": "lookup_order", "input": { "orderId": "O-1001" } }],
  "respond": { "decision": "refund" } },

{ "id": "lookup-O-1001", "when": { "tool": "lookup_order", "input": { "orderId": "O-1001" } },
  "respond": { "status": "delivered", "daysSinceDelivery": 3 } }
```

The call's `input` becomes the subagent's `$json`, so its prompt is built from
what the parent passed, and graded like any other prompt. A fixture without
`when.tool` answers top-level agents only, so a catch-all written for the main
agent can never answer a subagent with the wrong fields; give each tool its own.

**What it adds to grading** is delegation, and every part of it is a parameter
or a call the trace records:

| | Graded with |
|---|---|
| The subagent exists, with the name the task gives | `paramEquals` on `toolName` |
| It is attached to the agent | `connected` from `agentTool` to `agent` |
| Its prompt uses what the parent passes it | `expressionContains` on its `userPrompt` |
| The narrow job runs on the cheap model, the judgement on the capable one | `aiCalled` with `tool: "lookup_order"`, and with `tool: false` for the top-level agents |

Don't grade the tool's `description` by substring. It is what a real model reads
to choose a tool, so it is worth asking for, but wording is free text and a
substring check rejects good descriptions.

**Failure modes, each with its own message:** a tool wired into an ordinary input
or an ordinary node into a Tools port (refused before the run); the model asking
for a tool the agent does not have, which lists the tools it does have and says
if one is disabled; a subagent with no output fields or no fixture, which fails
its parent and names the subagent. Subagents may have subagents; a circle is
refused, naming it, and nesting stops at four levels.

`scenarios/refund-desk-agents/` is the worked example, with two correct and five
plausibly wrong variants under `variants/` that `npm run experiment` classifies.

## Live answers (Learn)

A Learn task can let agents answer from a real model while the learner builds.
Grading is unchanged: the graded report always replays the recorded fixtures, so a
live answer is never what a verdict is based on.

**Turn it on** in the scenario, mapping each model the dropdown offers to a model
id the proxy serves:

```jsonc
"ai": {
  "models": ["gpt-5", "gpt-5-mini"],
  "live": {
    "enabled": true,
    "provider": "openai",
    "models": { "gpt-5": "gpt-5", "gpt-5-mini": "gpt-5-mini" },
    "maxCallsPerRun": 30,   // optional, default 30
    "timeoutMs": 20000      // optional, per call
  },
  "fixtures": [ … ]          // still required, catch-all included — they are what is graded
}
```

…and enable the **LLM Proxy** for the task with the OpenAI provider: in question
editing, Advanced features → LLM Proxy, or on the bespoke preset as
`viewOverrides.llmProxyOptions: { "enabled": true, "providers": ["OpenAI"],
"rateLimitOverMinute": 30, "maxBudget": 2 }`. The proxy gives each session a
short-lived key in `OPENAI_API_KEY` and `OPENAI_BASE_URL`; the server reads them
and the browser never sees them. A per-item agent over six items with one subagent
is about a dozen calls per run, so the platform default of 5 requests a minute is
too low.

**When live is unavailable** — no proxy, a rate limit, a spent budget, a timeout,
an unusable answer, no model id for the chosen label, or the run's call limit —
that call answers from its recorded fixture, and the Logs panel says which answers
were recorded and why. A task never breaks because the proxy did. Identical calls
within a session are answered once.

**Tell the learner** in the task statement that answers are live while they build
and checked against recorded answers, so they should ask for exactly the fields the
task names.

Live answers are never used with `grading.private` (the validator rejects the
combination), and the grader, `run.js`, the validator and the tests always replay.
The model's answer can only become item fields: every service in the workflow is
still a mock. For local work, `node scripts/fake-llm-proxy.js` stands in for the
proxy — set `OPENAI_BASE_URL=http://127.0.0.1:4010/ OPENAI_API_KEY=fake`.

## Recording fixtures from a real model

Fixtures can be written by hand, and for a handful of inputs that is quickest.
For more, record them:

```bash
npm run record -- scenarios/my-task/scenario.json scenarios/my-task/reference_solution.json
npm run record -- scenarios/my-task/scenario.json scenarios/my-task/reference_solution.json \
  --provider anthropic --write
npm run record -- scenarios/my-task/scenario.json scenarios/my-task/reference_solution.json \
  --provider openai --model gpt-5-mini --write   # OPENAI_API_KEY, optional OPENAI_BASE_URL
```

The first is a **dry run**, and the default: it prints every question it would
ask — system prompt, user prompt, fields, tools — and sends nothing. Read it
before the second, which needs `ANTHROPIC_API_KEY` and sends exactly that to the
API. `--model` picks the model (default `claude-sonnet-5-5`); it is the model
that answers, not the task's `ai.models` label.

`scripts/record-fixtures.js` runs the workflow headlessly; every agent call no
fixture answers is a miss, and the trace records what was asked. Each miss goes
to the model; the answer becomes a fixture keyed on the **input item**, never
the prompt, marked `"recorded": { provider, model }`. It repeats until nothing
misses — a per-item agent stops at its first unanswered item, so that can take a
pass per item. Catch-alls are set aside while recording, or they would answer
everything, and go back **after** the new fixtures, since the first match wins.
Specific fixtures you already have are kept and never re-asked.

Subagents are offered to the model as real tools. When it calls one, the
subagent is asked in turn — its prompt built from the arguments the model chose
— and the answer goes back into the conversation, so the parent decides with
real tool results. Both are recorded: the parent with its `calls`, the subagent
under `when.tool`.

It lives in `scripts/`, not `engine/`, for the reason at the top of this page,
and it is an author's tool: nothing in a scenario can switch it on. Run
`npm run validate` afterwards — a recorded answer is a real model's opinion, and
the assertions may need to agree with it.
