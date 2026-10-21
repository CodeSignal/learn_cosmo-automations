# `activity.log`

The platform's standardised view of what happened inside a bespoke UI.

A simulation is opaque from the outside. The platform can see that a session
happened and read the final `solution.json`, but not how the learner got there —
whether they built the workflow confidently or thrashed, whether they opened the
docs, whether they ran a node twenty times before it worked. This file is that
record.

**Append-only JSONL**, one event per line, written to the session filesystem next
to `solution.json` and `execution.json`.

```
/usercode/FILESYSTEM/
  config.json      the task           (scenario.json also accepted — see below)
  solution.json    the learner's work
  execution.json   the last full run
  activity.log     ← this
```

---

## Every line carries

| Field | |
|---|---|
| `seq` | Monotonic within the session, starting at 1. Ordering survives equal timestamps. |
| `ts` | ISO 8601 wall clock. |
| `type` | One of the event types below, and **only** one of them. |

Everything else is per-event payload, listed below.

---

## The vocabulary

It is fixed in [`engine/activity.js`](../engine/activity.js) and a test asserts
that this document lists every entry. Adding an event is a deliberate act — a log
whose types drift between releases cannot be consumed by anything downstream.

| Type | When | Payload |
|---|---|---|
| `session.start` | The simulation booted | `scenario`, `title`, `nodeCount` |
| `workflow.edit` | The workflow changed | `added[]`, `removed[]` (node types), `renamed[]`, `reconfigured[]` (node names), `connected`, `disconnected` (counts) |
| `credential.create` | A credential was created | `id`, `credentialType` |
| `credential.delete` | A credential was deleted | `id` |
| `workflow.run` | A full run finished | `status`, `nodes`, `errors`, `durationMs`, `itemsOut`; with live answers also `liveCalls` and `tokens` |
| `node.run` | One node was run with Execute Node, or only the nodes before it with Execute previous nodes | `node`, `nodeType`, `status`; `previousOnly: true` for Execute previous nodes, where `status` is `notRun` |
| `workflow.reset` | The canvas was reset | — |
| `approval.pause` | A run stopped at an approval | `node` |
| `approval.decide` | The learner approved or rejected | `node`, `decision` |
| `help.open` | The help panel was opened | `topic` |
| `node.open` | A node's settings were opened | `node`, `nodeType` |

One more type appears only in an abnormal session:

| `log.truncated` | More than 5000 events | `reason` |

---

## Three decisions worth knowing

### It contains no secrets

`credential.create` records the id and the type. **Never the field values.** The
learner types a real credential value now, and a log that echoed it back would be
the easiest place in the whole system to find one. Pinned by
`test/activity.test.js`, which writes a full session and greps the file.

### It is derived server-side, not reported by the client

`workflow.edit` is computed by diffing the graph that was actually saved against
the one before it. A client-reported event describes what the UI *believed*; a
diff describes what *happened*, and cannot be spoofed by anything running in the
browser.

Only two events come from the client, because the server genuinely cannot see
them: `help.open` and `node.open`. `POST /api/activity` accepts those two and
refuses everything else.

### Moving a node emits nothing

Dragging a node around is tidying, not learning behaviour, and at one event per
drag it would drown everything else. `workflow.edit` fires on structure and
configuration — added, removed, renamed, reconfigured, wired, unwired — and
position is explicitly excluded.

Saves are debounced, so one `workflow.edit` line can cover several keystrokes.
That is the right granularity: "they reconfigured the Filter" is the behaviour,
not the individual characters.

---

## Reading one

```bash
jq -c . activity.log                        # pretty, one per line
jq -r 'select(.type=="workflow.run") | "\(.ts) \(.status) \(.errors) errors"' activity.log
jq -r '.type' activity.log | sort | uniq -c  # shape of the session at a glance
```

A typical successful session:

```json
{"seq":1,"ts":"…","type":"session.start","scenario":"cosmo-automations","title":"Route high-value EU orders…","nodeCount":1}
{"seq":2,"ts":"…","type":"node.open","node":"When clicking Execute","nodeType":"manualTrigger"}
{"seq":3,"ts":"…","type":"workflow.edit","added":["httpRequest"],"removed":[],"renamed":[],"reconfigured":[],"connected":1,"disconnected":0}
{"seq":4,"ts":"…","type":"node.run","node":"Fetch Orders","nodeType":"httpRequest","status":"error"}
{"seq":5,"ts":"…","type":"help.open","topic":"node:httpRequest"}
{"seq":6,"ts":"…","type":"credential.create","id":"cred_1","credentialType":"acmeCrmApi"}
{"seq":7,"ts":"…","type":"node.run","node":"Fetch Orders","nodeType":"httpRequest","status":"success"}
…
{"seq":24,"ts":"…","type":"workflow.run","status":"completed","nodes":6,"errors":0,"durationMs":1180,"itemsOut":29}
```

Read as a story: they opened the trigger, added an HTTP Request, ran it, got an
error, went to the docs, created a credential, and it worked.

An approval shows up as a pause and the answer that followed, which is worth
having: *how long* someone deliberated before approving, and whether they ever
rejected, is behaviour a transcript of the final workflow cannot show. That is the thing
the platform cannot otherwise see.

---

## `config.json` vs `scenario.json`

The platform convention for the per-activity configuration is **`config.json`**.
This project calls it **`scenario.json`**, and
every scenario directory, doc, script and test says so.

**Both are accepted**, `config.json` first, so a base task written to the platform
convention works without knowing our name.
