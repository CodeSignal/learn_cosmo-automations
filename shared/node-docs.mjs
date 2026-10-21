/**
 * The node wiki.
 *
 * One module rather than prose scattered through the node implementations: this
 * is content that will grow (examples, gotchas, cross-references) and wants to
 * be read and reviewed as a whole. `engine/index.js` merges it into the palette
 * payload, so the client gets it for free and there is exactly one copy.
 *
 * Each entry:
 *   summary   one or two sentences: what the node does
 *   mode      plain-English restatement of the execution mode, in item terms
 *   when      when to reach for it — and when not to
 *   params    [{ name, text }] per-parameter guidance, beyond the field label
 *   examples  [{ label, code }] short, concrete, copy-pasteable
 *   gotchas   [string] the mistakes people actually make
 *   seeAlso   [nodeType] related nodes
 */

export const NODE_DOCS = {
  /* ── triggers ──────────────────────────────────────────────────────── */

  manualTrigger: {
    summary: 'Starts the workflow when you press Execute Workflow. It emits a '
      + 'single empty item, which is enough to get the first real node running.',
    mode: 'Runs once. Emits 1 item.',
    when: 'Use it whenever the workflow is something you trigger yourself rather '
      + 'than something an external event starts. It is the usual starting point '
      + 'when the first real step is fetching data.',
    gotchas: [
      'The item it emits has no fields, so `{{ $json.anything }}` on the node '
      + 'straight after it resolves to [undefined]. Fetch or set data first.',
    ],
    seeAlso: ['webhook', 'scheduleTrigger'],
  },

  webhook: {
    summary: 'Starts the workflow when an HTTP request arrives. The request is '
      + 'delivered to your workflow as one item.',
    mode: 'Runs once. Emits 1 item.',
    when: 'Use it when something outside the workflow should start it — another '
      + 'system posting an event, a form submission, an alert.',
    params: [
      { name: 'path', text: 'The URL segment this hook listens on. Naming only; nothing in the simulation depends on it.' },
      { name: 'method', text: 'Which HTTP verb the hook accepts.' },
    ],
    examples: [
      {
        label: 'The incoming request is wrapped, not flattened',
        code: '{\n  "body":    { "region": "EU", "total": 1420 },\n  "headers": { "content-type": "application/json" },\n  "query":   {}\n}',
      },
      { label: 'So a body field is reached through body', code: '={{ $json.body.region }}' },
    ],
    gotchas: [
      'The payload is under `body`, not at the top level. `{{ $json.region }}` is '
      + 'a very common mistake — it should be `{{ $json.body.region }}`.',
    ],
    seeAlso: ['manualTrigger'],
  },

  scheduleTrigger: {
    summary: 'Starts the workflow on a timer. Inside the simulation it fires '
      + 'exactly once so runs stay reproducible.',
    mode: 'Runs once. Emits 1 item containing the run timestamp.',
    when: 'Use it for work that should happen on a cadence — a nightly report, a '
      + 'periodic sync.',
    seeAlso: ['manualTrigger'],
  },

  /* ── flow ──────────────────────────────────────────────────────────── */

  filter: {
    summary: 'Checks every item against your conditions and passes through only '
      + 'the ones that match. Items that fail are discarded.',
    mode: 'Runs once per item. Emits 0 or 1 item for each item in.',
    when: 'Use it when you want to narrow a list and do not care about the items '
      + 'you dropped. If you need to do something different with the rejects, use '
      + 'If instead — it keeps both groups.',
    params: [
      { name: 'combinator', text: '`and` requires every condition; `or` requires at least one.' },
      { name: 'conditions', text: 'The left side is normally an expression reading a field; the right side is usually a fixed value.' },
    ],
    examples: [
      { label: 'Keep one region', code: 'left:  ={{ $json.region }}\nop:    equals\nright: EU' },
      { label: 'Keep above a threshold (strictly greater)', code: 'left:  ={{ $json.total }}\nop:    gt\nright: 1000' },
    ],
    gotchas: [
      '`gt` is strictly greater than; `gte` includes the boundary value. Choosing '
      + 'the wrong one is the single most common off-by-one in an automation.',
      'A condition on a field that does not exist never matches, so the node '
      + 'quietly emits 0 items. If a Filter outputs nothing, check the resolved '
      + 'value under the field first — [undefined] means the path is wrong.',
      'Numbers typed into the right-hand side stay numbers. Comparing a number to '
      + 'the text "1000" still works, but reading the wrong field does not.',
    ],
    seeAlso: ['if'],
  },

  if: {
    summary: 'Routes each item down one of two branches depending on whether your '
      + 'conditions match: the true output or the false output.',
    mode: 'Runs once per item. Each item leaves on exactly one of the two outputs.',
    when: 'Use it when both groups matter — flag the matches and archive the rest. '
      + 'If you only want the matches, Filter says that more plainly.',
    gotchas: [
      'Items sent to an output with nothing connected to it are dropped. Wiring '
      + 'only the true branch makes If behave exactly like Filter.',
      'The two outputs are separate. A node wired to both receives items from both.',
    ],
    seeAlso: ['filter'],
  },

  switch: {
    summary: 'Routes each item to one of several named outputs, chosen by the '
      + 'first rule it matches. If with more than two branches.',
    mode: 'Runs once per item. Each item leaves on one output — or on several, if '
      + 'you turn on Send To All Matching Outputs.',
    when: 'Use it when items need to go three or more different ways: one region '
      + 'per branch, one priority per branch. Two branches is what If is for, and '
      + 'If reads more plainly for two.',
    params: [
      { name: 'rules', text: 'Each rule is one condition plus the name of the output it routes to. The name you type appears as the port label on the node, which is how the canvas ends up readable.' },
      { name: 'fallback', text: '`none`: an item matching nothing is dropped. `extra`: it leaves on an additional output named fallback, so you can see what fell through.' },
      { name: 'allMatches', text: 'Off: the first matching rule wins, so rule order matters. On: the item is copied to every rule it matches, so one item in can be several items out.' },
    ],
    examples: [
      {
        label: 'Three regions, each to its own branch',
        code: 'rule 1  output: EU     ={{ $json.region }} equals EU\n'
          + 'rule 2  output: US     ={{ $json.region }} equals US\n'
          + 'rule 3  output: APAC   ={{ $json.region }} equals APAC\n'
          + 'fallback: extra        → anything else, so nothing vanishes silently',
      },
      {
        label: 'Rule order decides the winner',
        code: '// with allMatches off, an item with total = 5000 matches BOTH:\n'
          + 'rule 1  output: large   ={{ $json.total }} gt 1000\n'
          + 'rule 2  output: huge    ={{ $json.total }} gt 4000\n'
          + '// …and leaves on "large", because rule 1 is checked first.',
      },
    ],
    gotchas: [
      'With Send To All Matching Outputs off, only the FIRST matching rule fires. '
      + 'Put your narrowest rule first, or it will never be reached.',
      'An item matching no rule at all is dropped unless the fallback output is '
      + 'switched on. A Switch that outputs fewer items than it received is usually '
      + 'this.',
      'Items sent to an output with nothing wired to it are dropped, exactly as '
      + 'with If. Check every port has a wire before blaming the rules.',
      'Two rules may share an output name. They are still two separate ports — the '
      + 'name is a label, not a destination.',
    ],
    seeAlso: ['if', 'filter', 'merge'],
  },

  merge: {
    summary: 'Brings two branches back into one. It can append them, pair them up '
      + 'position by position, join them on a shared field, or simply wait for both.',
    mode: 'Runs once for all items, and it has TWO inputs. It waits for both '
      + 'branches before it runs.',
    when: 'Use it after an If or a Switch when the branches need to end up in one '
      + 'place, or to bring together data from two different services — orders '
      + 'from one, customer records from the other.',
    params: [
      { name: 'mode', text: '`append` puts input 2 after input 1. `combineByPosition` pairs 1st with 1st. `combineByFields` is a join on a shared field. `chooseBranch` waits for both and continues with one.' },
      { name: 'matchField', text: 'For `combineByFields`: the field name present on both sides. A plain field name, not an expression.' },
      { name: 'joinMode', text: '`keepMatches` returns only items that found a partner. `enrichInput1` returns every input 1 item, with input 2\'s fields added where there was a match.' },
      { name: 'includeUnpaired', text: 'For `combineByPosition`, when the two inputs have different lengths: pass the leftovers through instead of discarding them.' },
    ],
    examples: [
      {
        label: 'Join orders to customers on customerId',
        code: '// input 1: 3 orders          input 2: 5 customers\n'
          + 'mode:        combineByFields\n'
          + 'matchField:  customerId\n'
          + 'joinMode:    keepMatches\n'
          + '// → 3 items, each carrying both the order and the customer fields',
      },
      {
        label: 'Two If branches back into one list',
        code: 'mode: append   // input 1 = the true branch, input 2 = the false branch',
      },
    ],
    gotchas: [
      'The two inputs are numbered and the numbers matter. `enrichInput1` keeps '
      + 'input 1\'s items; wiring the branches the other way round changes the '
      + 'answer.',
      'In `combineByPosition` the pairing is by position only — nothing checks that '
      + 'the two items are actually related. If either branch reordered or dropped '
      + 'items, you are pairing up unrelated records.',
      'In `combineByFields` a field name that exists on neither side is an error, '
      + 'not an empty result — a silent 0 items out would be much harder to debug.',
      'When both inputs carry the same field name, input 2 wins. Rename first with '
      + 'Edit Fields if you need to keep both.',
      'Appending two branches is not the same as wiring both into one node\'s input. '
      + 'Wiring both directly also concatenates them — Merge earns its place when '
      + 'you want to pair or join, or to make the wait explicit.',
    ],
    seeAlso: ['if', 'switch', 'aggregate'],
  },

  loopOverItems: {
    summary: 'Sends the items through a group of nodes a batch at a time, then '
      + 'carries on once every batch has been through.',
    mode: 'Runs once for all items — it needs the whole list to divide it into '
      + 'batches. The nodes wired to its loop output run once per batch.',
    when: 'Most of the time you do NOT need this: almost every node here already '
      + 'runs once per item, so a plain chain already loops. Reach for it when a '
      + 'group of nodes has to run together per batch, or when you want to work '
      + 'through a long list in deliberate chunks rather than all at once.',
    params: [
      { name: 'batchSize', text: 'How many items go round on each pass. 1 is one item at a time; 10 sends ten and runs the body a tenth as often.' },
    ],
    examples: [
      {
        label: 'The two outputs',
        code: 'loop  → the nodes that run once per batch\n'
          + 'done  → the nodes that run after every batch has been through',
      },
      {
        label: 'Closing the loop, or not',
        code: '// Wire the END of the body back into the loop node\'s input, and\n'
          + '// "done" carries everything that came back.\n'
          + '//\n'
          + '// Wire nothing back, and the body is a pure side effect — one message\n'
          + '// per batch, say — while "done" passes the original items through.',
      },
    ],
    gotchas: [
      'Reaching for this first is the most common mistake. An HTTP Request already '
      + 'runs once per item; wrapping it in a loop adds a node and changes nothing.',
      'Whether you wire the end of the body back into the loop decides what leaves '
      + 'on `done`: what came back, or the original items. Both are useful, and '
      + 'they are not the same answer.',
      'The nodes inside the body show summed counts across every pass, plus how '
      + 'many passes there were — not the figures from one pass.',
      'A loop inside another loop is refused, not silently mishandled. Use a larger '
      + 'batch size, or split the work into two workflows.',
      'The loop stops on the first failing pass rather than repeating the same error '
      + 'for every remaining batch.',
    ],
    seeAlso: ['splitOut', 'aggregate', 'limit'],
  },

  agent: {
    summary: 'Asks an AI model to do something with an item. Its answer goes on the '
      + 'item as `output` — text by default, or named fields when a Structured Output '
      + 'Parser is attached.',
    mode: 'You choose. Once per item means one model call per item — ten items, ten '
      + 'calls. Once for all items means a single call.',
    when: 'Use it for the judgement a rule cannot express: classifying free text, '
      + 'summarising, extracting fields from a sentence. Do NOT use it for anything '
      + 'a Filter or an If can decide — a model is slower, costs money, and is less '
      + 'predictable than a comparison.',
    params: [
      { name: 'mode', text: 'Once per item or once for all items. This is the cost decision as much as the item-model one.' },
      { name: 'model', text: 'Which model. A triage or classification step rarely needs the expensive one.' },
      { name: 'systemPrompt', text: 'Who the model is and how to behave. Fixed instructions that do not change per item.' },
      { name: 'userPrompt', text: 'The request for THIS item. Use an expression so the item goes in — a prompt with a hardcoded value asks the same question every time.' },
    ],
    examples: [
      {
        label: 'Text by default',
        code: '// in\n{ "ticket": "T-03", "subject": "500 error on /api/orders" }\n\n'
          + '// out\n{ "ticket": "T-03", "subject": "500 error on /api/orders",\n'
          + '  "output": "Technical problem, and urgent: the orders API is failing." }',
      },
      {
        label: 'Fields, with a Structured Output Parser attached',
        code: 'parser fields: category, severity\n\n'
          + '// out\n{ "ticket": "T-03", "subject": "500 error on /api/orders",\n'
          + '  "output": { "category": "technical", "severity": 5 } }\n\n'
          + '// a later Filter reads {{ $json.output.severity }}',
      },
    ],
    gotchas: [
      'Text is for people to read. A later node cannot branch on it reliably — when '
      + 'something downstream has to filter or route on the answer, attach a '
      + 'Structured Output Parser to the Output Parser port and name the fields.',
      'Ask for the fields the parser declares. The parser tells the workflow what to '
      + 'expect; the PROMPT is what actually asks for them. If they disagree, the '
      + 'fields come back empty.',
      'A prompt without an expression asks about the same thing for every item. If '
      + 'every item comes back with the same answer, check whether the item is '
      + 'actually in the prompt.',
      'Once per item is one call per item. Forty tickets is forty calls — aggregate '
      + 'first if a single call over the whole list would answer the question.',
      'When the task offers live answers, a real model answers while you build, and '
      + 'the Logs panel says which answers were live. Otherwise the answers are '
      + 'recorded ones. Grading always replays the recorded answers, so the verdict '
      + 'never depends on what a model happened to say: what is judged is your '
      + 'prompt, the fields you asked for, and how many calls you made.',
    ],
    seeAlso: ['outputParser', 'filter', 'switch', 'aggregate', 'agentTool'],
  },

  agentTool: {
    summary: 'A subagent: a second AI agent that another agent can call as a tool '
      + 'when it needs a narrow job done, such as looking something up or drafting a reply.',
    mode: 'It does not run as a step of the workflow and carries no items. It runs '
      + 'when the agent it is attached to decides to call it — once, several times, '
      + 'or not at all.',
    when: 'Use it to split a job the main agent should not do itself: a lookup, a '
      + 'specialised check, a draft. Attach it to the Tools port on the bottom of an '
      + 'AI Agent. If every item needs the work regardless, an ordinary step in the '
      + 'workflow is simpler and cheaper than a tool.',
    params: [
      { name: 'toolName', text: 'The name the parent agent calls it by. The task says which tools the agent needs — use exactly that name.' },
      { name: 'description', text: 'What the tool does and when to use it. The parent model reads this to decide whether to call it, so say what it is for, not how it works.' },
      { name: 'model', text: 'Which model the subagent uses. A narrow job rarely needs the expensive one.' },
      { name: 'systemPrompt', text: 'Who the subagent is and how to behave.' },
      { name: 'userPrompt', text: 'The request, built from what the parent passed in. Those arguments are this tool\'s `$json` — `{{ $json.customerId }}`.' },
    ],
    examples: [
      {
        label: 'A lookup the triage agent can call',
        code: 'tool name:   lookup_customer\n'
          + 'description: Looks up a customer\'s plan and account status by id.\n'
          + 'user:        =Look up customer {{ $json.customerId }}',
      },
    ],
    gotchas: [
      'Wire it from its top edge to the Tools port on the BOTTOM of the agent. Its '
      + 'output is not data, so it cannot connect to an ordinary input.',
      'If the run says the model asked for a tool this agent does not have, the Tool '
      + 'Name does not match what the task asked for — or the tool is disabled.',
      'A subagent that never runs means the parent never needed it for these items. '
      + 'Its line shows `notRun`, and that is worth reading as information.',
      'Subagents may have subagents, but never in a circle: an agent that can reach '
      + 'itself through its tools is refused.',
      'It answers the parent in text. Attach a Structured Output Parser to its Output '
      + 'Parser port when the parent needs named fields back.',
    ],
    seeAlso: ['agent', 'outputParser'],
  },

  outputParser: {
    summary: 'Makes an AI agent answer in named fields instead of text, so the rest '
      + 'of the workflow can read and branch on the answer.',
    mode: 'It does not run as a step and carries no items. The agent it is attached to '
      + 'uses it every time that agent answers.',
    when: 'Attach it when the next node needs to act on the answer — filter on a '
      + 'severity, route on a category, check a decision. If a person only reads the '
      + 'answer, text is fine and you do not need it.',
    params: [
      { name: 'mode', text: 'How the fields are defined: `fields` (a list of names), `example` (a sample answer — its keys are the fields and its values set the types) or `schema` (a JSON Schema, for types and nesting).' },
      { name: 'fields', text: 'The fields the model must return. The agent puts them on the item as `$json.output.<field>`. Ask for them in the prompt too.' },
      { name: 'jsonExample', text: 'A sample answer, as JSON. `{ "label": "billing", "score": 4 }` asks for a text `label` and a whole-number `score`.' },
      { name: 'jsonSchema', text: 'A JSON Schema object. Its `properties` are the fields; use it when you need types or nested objects the example cannot express.' },
    ],
    examples: [
      {
        label: 'Triage fields',
        code: 'fields: category, severity\n\n'
          + '// the agent\'s item\n{ ..., "output": { "category": "billing", "severity": 4 } }\n\n'
          + '// a Filter after it\n{{ $json.output.severity }}  ≥  4',
      },
    ],
    gotchas: [
      'Wire it from its top edge to the Output Parser port on the bottom of the agent, '
      + 'next to Tools. One parser per agent.',
      'Without a parser the agent answers in text, and `$json.output.severity` is '
      + 'undefined — `$json.output` is a sentence.',
      'Name the same fields in the prompt. The parser says what shape to return; the '
      + 'prompt says what the fields mean.',
    ],
    seeAlso: ['agent', 'agentTool', 'listOutputParser', 'autoFixingOutputParser'],
  },

  listOutputParser: {
    summary: 'Makes an AI agent answer with a list, and turns each entry into its own '
      + 'item — one model call, many items out.',
    mode: 'It does not run as a step. The agent it is attached to splits each answer '
      + 'into items: once per item, every input item can become several.',
    when: 'Use it when one question has several answers that each need handling on their '
      + 'own: every action item in an email, every product a review mentions.',
    params: [
      { name: 'maxItems', text: 'Keep at most this many entries per answer. 0 keeps them all.' },
      { name: 'separator', text: 'What separates entries when the answer is text. `\\n`, a new line, is the default; list markers like `- ` and `1. ` are removed.' },
    ],
    examples: [
      {
        label: 'Action items from one email',
        code: '// 1 item in\n{ "email": "E-7", "body": "…" }\n\n'
          + '// 3 items out\n{ "email": "E-7", "body": "…", "output": "Send the contract" }\n'
          + '{ "email": "E-7", "body": "…", "output": "Book the room" }\n'
          + '{ "email": "E-7", "body": "…", "output": "Call Dana back" }',
      },
    ],
    gotchas: [
      'Each entry is text in `$json.output`, alongside the item it came from. For fields '
      + 'per entry, split the list first and then use a Structured Output Parser.',
      'More items out than in is the point here, not a bug. The counts on the canvas show it.',
    ],
    seeAlso: ['agent', 'outputParser', 'splitOut'],
  },

  autoFixingOutputParser: {
    summary: 'Wraps another output parser, and has a model fix any answer that does not '
      + 'fit it before the workflow sees it.',
    mode: 'It does not run as a step. It only calls its model when an answer does not '
      + 'fit — a well-shaped answer passes straight through.',
    when: 'Use it when the agent\'s model is cheap or chatty and sometimes misses the '
      + 'format. Attach the parser it should enforce to its own Output Parser port, and '
      + 'attach it to the agent.',
    params: [
      { name: 'model', text: 'The model asked to fix an answer. It sees the bad answer and the required format, nothing else, so a small model is usually enough.' },
    ],
    examples: [
      {
        label: 'Wiring',
        code: 'Structured Output Parser → Auto-fixing Output Parser → AI Agent\n'
          + '            (its Output Parser port)        (the agent\'s Output Parser port)',
      },
    ],
    gotchas: [
      'A fix is a model call of its own, and it shows in the calls. If it fixes every '
      + 'answer, the agent\'s prompt is the problem — tighten it rather than paying twice.',
      'It needs a parser attached to it. On its own it has no format to fix answers towards.',
      'One is enough: it cannot wrap another Auto-fixing Output Parser.',
    ],
    seeAlso: ['outputParser', 'listOutputParser', 'agent'],
  },

  approval: {
    summary: 'Stops the workflow and waits for a person to approve or reject '
      + 'before the items go any further.',
    mode: 'Runs once for all items. Everything waiting goes down one branch or '
      + 'the other, together.',
    when: 'Use it in front of anything you would not want to happen by accident — '
      + 'messaging customers, issuing refunds, deleting records. The question it '
      + 'answers is "should a human see this first?", and no condition can decide '
      + 'that for you.',
    params: [
      { name: 'prompt', text: 'What the person is being asked. Say what will happen if they approve — "Send these 3 refunds?" beats "Continue?".' },
    ],
    examples: [
      {
        label: 'Both paths matter',
        code: 'approved → Send Refunds\n'
          + 'rejected → Log For Review\n\n'
          + '// Leave "rejected" unconnected and a rejection silently discards\n'
          + '// the items, which is rarely what anybody wants.',
      },
    ],
    gotchas: [
      'Items sent to an output with nothing wired to it are dropped, exactly as '
      + 'with If. A rejection usually still needs to go somewhere.',
      'The run stops here until you answer. A paused run is not a finished run — '
      + 'it is never saved as the graded one, so answer the approval and let the '
      + 'workflow complete before you submit.',
      'It waits for ALL the items at once, not one at a time. If you need a '
      + 'decision per item, put the approval after a Loop Over Items.',
    ],
    seeAlso: ['if', 'switch', 'loopOverItems'],
  },

  noOp: {
    summary: 'Passes items straight through, unchanged.',
    mode: 'Runs once for all items. Emits exactly what it received.',
    when: 'Use it to tidy a layout, or as a single join point for several branches.',
  },

  stopAndError: {
    summary: 'Fails the workflow on purpose, with a message you choose.',
    mode: 'Runs once for all items. Emits nothing.',
    when: 'Use it to make an impossible state loud instead of letting bad data '
      + 'flow onward — for example on the false branch of a validation check.',
  },

  /* ── data ──────────────────────────────────────────────────────────── */

  set: {
    summary: 'Adds, overwrites or reshapes fields on every item.',
    mode: 'Runs once per item. Emits 1 item for each item in.',
    when: 'Use it to build the exact shape a later node needs, to rename fields, '
      + 'or to compute a value once so several later nodes can reuse it.',
    params: [
      { name: 'keepOnlySet', text: 'On: the item is replaced by just the fields you set. Off: your fields are merged into what arrived.' },
      { name: 'fields', text: 'Each field has a name and a value. The name may be a dotted path to write something nested.' },
    ],
    examples: [
      { label: 'Combine two fields into one', code: 'name:  label\nvalue: ={{ $json.region }} order {{ $json.id }}' },
      { label: 'Write a nested field', code: 'name:  meta.processed\nvalue: true' },
    ],
    gotchas: [
      'With `keepOnlySet` on, every field you did not list is gone — including ones '
      + 'a later node still needs.',
    ],
    seeAlso: ['aggregate'],
  },

  splitOut: {
    summary: 'Takes one item that contains a list, and turns that list into many '
      + 'items — one per entry.',
    mode: 'Runs once per item. One item in becomes as many items out as the list is long.',
    when: 'Use it whenever an API hands you a whole collection inside a single '
      + 'response and you want to work on the entries one at a time. Nearly every '
      + '"fetch a list, then act on each one" workflow needs it as its second step.',
    params: [
      { name: 'field', text: 'The name of the field holding the list. A plain field name or a dotted path — not an expression, so no `{{ }}`.' },
      { name: 'include', text: '`noOtherFields`: each new item is just the list entry. `allOtherFields`: the surrounding fields are copied onto every new item too.' },
    ],
    examples: [
      {
        label: 'One response containing three orders',
        code: '// 1 item in\n{ "since": "2026-07-30",\n  "orders": [ {"id":"A"}, {"id":"B"}, {"id":"C"} ] }\n\n// field = orders  →  3 items out\n{ "id": "A" }\n{ "id": "B" }\n{ "id": "C" }',
      },
      { label: 'A nested list', code: 'field: body.orders' },
    ],
    gotchas: [
      'The field must actually be a list. Pointing it at an object or a number is '
      + 'an error, not a silent no-op.',
      'This is a field name, not an expression. Write `orders`, not `{{ $json.orders }}`.',
      'With `noOtherFields`, context from the wrapper — a timestamp, a page number '
      + '— is discarded. Use `allOtherFields` if later nodes still need it.',
    ],
    seeAlso: ['aggregate'],
  },

  aggregate: {
    summary: 'Combines many items into one. It is the counterpart to Split Out.',
    mode: 'Runs once for all items. Any number of items in, exactly 1 item out.',
    when: 'Use it when the outcome should be a single thing rather than one per '
      + 'record — one summary message instead of forty, one total, one list to '
      + 'send in a single API call.',
    params: [
      { name: 'mode', text: '`summarize` computes counts and totals. `individualFields` turns each chosen field into a list. `allItemData` puts every whole item into one field.' },
      { name: 'outputs', text: 'For `summarize`: each row is one output field — an operation (count, sum, avg, min, max, concat), the field to read, and the name to write.' },
    ],
    examples: [
      {
        label: 'Count and total three items',
        code: '// 3 items in\n{ "total": 1420 }\n{ "total": 2100 }\n{ "total": 1180 }\n\n// summarize: count → count, sum(total) → total\n// 1 item out\n{ "count": 3, "total": 4700 }',
      },
      {
        label: 'Collect one field into a list',
        code: '// individualFields, fields = id\n{ "id": ["A", "B", "C"] }',
      },
    ],
    gotchas: [
      'The output is a brand-new item. The individual records\' fields are gone '
      + 'unless an output row captured them, so `{{ $json.id }}` afterwards is '
      + '[undefined].',
      '`count` needs no source field; every other operation does.',
      'Putting it in the wrong place is a classic error: aggregate *after* '
      + 'filtering, or you will summarise records you meant to exclude.',
    ],
    seeAlso: ['splitOut', 'set'],
  },

  sort: {
    summary: 'Reorders the items. By one or more fields, or shuffled.',
    mode: 'Runs once for all items — it has to see the whole list to order it. '
      + 'Same items out as in, in a different order.',
    when: 'Use it when order is part of the answer: the largest orders first, the '
      + 'oldest tickets first. Also use it before Limit, which is what turns '
      + '"keep 10" into "keep the top 10".',
    params: [
      { name: 'type', text: '`fields` orders by field values. `random` shuffles.' },
      { name: 'fields', text: 'Sorted by the first field; each later field breaks ties in the ones before it. Ascending is smallest-first.' },
    ],
    examples: [
      {
        label: 'Largest first',
        code: 'field: total   order: descending',
      },
      {
        label: 'Group by region, then largest within each region',
        code: 'field: region  order: ascending\nfield: total   order: descending',
      },
    ],
    gotchas: [
      'Sort alone changes nothing about which items you have. It is Limit '
      + 'afterwards that makes it a "top N" — Sort then Limit, in that order.',
      'Numbers stored as text sort as text: "100" comes before "9". If a field is '
      + 'numeric, make sure it arrived as a number.',
      'Items that compare equal keep their original order, so the result is stable '
      + 'and two runs agree.',
      '`random` is seeded, so the same items always shuffle the same way. That is '
      + 'deliberate: a genuinely random order would make grading unrepeatable.',
    ],
    seeAlso: ['limit', 'aggregate'],
  },

  limit: {
    summary: 'Keeps at most a set number of items and discards the rest.',
    mode: 'Runs once for all items. Any number in, at most Max Items out.',
    when: 'Use it to cap work — a preview of the first few, or the top N after a '
      + 'Sort. Also useful as a safety valve before something expensive, so a '
      + 'surprise 500-item fan-out does not turn into 500 API calls.',
    params: [
      { name: 'maxItems', text: 'The ceiling. Fewer items than this pass through untouched.' },
      { name: 'keep', text: '`firstItems` keeps the front of the list, `lastItems` the end.' },
    ],
    examples: [
      { label: 'Top 5 by value', code: '// Sort: total descending\n// Limit: maxItems 5, keep firstItems' },
    ],
    gotchas: [
      '"First" means first in the current order, which is whatever the previous node '
      + 'left. Without a Sort in front of it, Limit keeps an arbitrary handful — not '
      + 'the biggest, the newest or the most important.',
      'The discarded items are gone. If you need to know how many there were, '
      + 'Aggregate a count before limiting.',
    ],
    seeAlso: ['sort', 'aggregate'],
  },

  removeDuplicates: {
    summary: 'Drops items that repeat one already seen. The first occurrence of '
      + 'each is kept.',
    mode: 'Runs once for all items — it needs the whole list to know what repeats.',
    when: 'Use it after combining lists from two places, or after a fan-out that '
      + 'can produce the same record twice. A duplicate that reaches a Slack node '
      + 'or an API call is a duplicate message or a double write.',
    params: [
      { name: 'compare', text: '`allFields`: two items are duplicates only if every field matches. `selectedFields`: only the fields you list are compared. `allFieldsExcept`: everything except the fields you list.' },
      { name: 'fields', text: 'The field names to compare on, or to ignore, depending on the mode above.' },
    ],
    examples: [
      {
        label: 'One row per customer',
        code: 'compare: selectedFields\nfields:  customerId',
      },
      {
        label: 'Ignore a timestamp that differs on every copy',
        code: 'compare: allFieldsExcept\nfields:  fetchedAt',
      },
    ],
    gotchas: [
      'With `allFields`, one differing field — a timestamp, an internal id — makes '
      + 'two otherwise identical records count as different. That is usually why '
      + 'nothing gets removed.',
      'The FIRST occurrence is kept. If you want the newest of each, Sort so the '
      + 'one you want comes first.',
      'It only compares within this run. It does not remember items from a previous '
      + 'execution.',
    ],
    seeAlso: ['sort', 'aggregate', 'merge'],
  },

  code: {
    summary: 'Runs your own JavaScript over the items. The escape hatch for '
      + 'anything the other nodes cannot express.',
    mode: 'You choose. In runOnceForAllItems it runs once and sees the whole list; '
      + 'in runOncePerItem it runs once for each item.',
    when: 'Use it when no other node fits — a calculation across items, a reshape '
      + 'too fiddly for Edit Fields, a bespoke grouping. Reach for it *last*: a '
      + 'workflow built from named nodes says what it does at a glance, and one '
      + 'built from Code nodes does not.',
    params: [
      { name: 'mode', text: 'Whether your code runs once with the whole list, or once per item. This is the same distinction every other node has — see the Items page.' },
      { name: 'jsCode', text: 'Plain JavaScript, run as a function body, so `return` works. No network, no filesystem, no imports — it is a sealed sandbox.' },
    ],
    examples: [
      {
        label: 'All items: total them into one item',
        code: `let total = 0;
for (const i of items) total += i.json.total;
return [{ json: { count: items.length, total } }];`,
      },
      {
        label: 'Per item: add a derived field',
        code: `return { json: { ...item.json, withVat: item.json.total * 1.2 } };`,
      },
      {
        label: 'What you get to work with',
        code: `items          // every item, in all-items mode
item           // the current item, in per-item mode
$input.all()   // the same list, another spelling
$json          // shorthand for the current item's data
$now, $today   // the run clock`,
      },
    ],
    gotchas: [
      'Return items, or one item — not a bare number or string. Both `{ json: {…} }` '
      + 'and a plain `{…}` are accepted; a scalar is not, because `$json.field` '
      + 'downstream needs an object.',
      'In runOncePerItem mode return ONE item, not a list. Returning several is an '
      + 'error rather than a silent fan-out.',
      'The sandbox has no network and no imports. If you need to call a service, '
      + 'that is what HTTP Request is for.',
      'An infinite loop is stopped, not tolerated — you get a timeout error.',
      '`Date` and `Math.random` are pinned to the run, so two runs of the same '
      + 'workflow agree. That is deliberate: grading has to be reproducible.',
    ],
    seeAlso: ['set', 'aggregate', 'splitOut'],
  },

  /* ── transport & integrations ──────────────────────────────────────── */

  httpRequest: {
    summary: 'Calls an HTTP API. Methods, headers, query strings, status codes and '
      + 'JSON parsing all behave exactly as they would against a real service.',
    mode: 'Runs once per item — an item in means a request out.',
    when: 'Use it for any service without a dedicated node. It is the most '
      + 'flexible node here and usually the first real step of a workflow.',
    params: [
      { name: 'method', text: 'The HTTP verb. Reading data is normally GET; creating or changing it is POST/PUT/PATCH.' },
      { name: 'url', text: 'The full URL. It may contain expressions, so one request per item can hit a different address.' },
      { name: 'sendQuery', text: 'Turn on to add `?key=value` pairs. Values may be expressions.' },
      { name: 'sendBody', text: 'Turn on to send a JSON body. Values may be expressions.' },
      { name: 'neverError', text: 'On: a 4xx/5xx becomes a normal item you can inspect and branch on. Off: it fails the node.' },
    ],
    examples: [
      { label: 'Per-item URL', code: '=https://api.example.test/v1/orders/{{ $json.id }}' },
      { label: 'A query parameter', code: 'name:  since\nvalue: 2026-07-30' },
    ],
    gotchas: [
      'A service that needs authentication returns 401 until you attach the right '
      + 'credential. Read the status code — it tells you what is wrong.',
      'This node runs once per item, so ten items in means ten requests. If you '
      + 'meant to make one call, aggregate first.',
      'Only the hosts this task provides will answer. Anything else is refused '
      + 'without leaving the sandbox.',
    ],
    seeAlso: ['slack'],
  },





};

export function docsFor(type) {
  return NODE_DOCS[type] || null;
}
