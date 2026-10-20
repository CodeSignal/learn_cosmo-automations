'use strict';

const { makeItem, deepClone } = require('../items');

/**
 * The Agent node.
 *
 * An LLM step: a system prompt, a user prompt, a model, and a declared set of
 * output fields. The answer comes from the fixture layer (`engine/ai/resolver.js`),
 * never from a live model — see that file for why.
 *
 * WHAT THIS GRADES, GIVEN THE ANSWER IS CANNED
 *
 * The obvious objection to a replayed agent is that if the answer is fixed, the
 * node tests nothing. It tests three things, and they are the three that matter
 * outside a toy:
 *
 *   1. THE PROMPT. It is static text the candidate wrote, sitting in the graph
 *      where an assertion can read it. Did they give the model a role? Did they
 *      interpolate the item rather than hardcode one ticket? Did they constrain
 *      the output, or hope for the best? `expressionContains` on `systemPrompt`
 *      or `userPrompt` grades all of that without a model being involved.
 *
 *   2. THE OUTPUT CONTRACT. `outputFields` is the schema the candidate asks the
 *      model for, and the rest of their workflow depends on those names. Get it
 *      wrong and the next node reads `[undefined]` — the same failure, and the
 *      same debugging, as any other wrong field path. This is where "structured
 *      output" stops being a slogan and becomes something a workflow needs.
 *
 *   3. THE CALL PATTERN. Once per item or once for all items is the item-model
 *      lesson again, except here it is the difference between one model call and
 *      forty. That is a real bill, and `aiCalled` asserts on it.
 *
 * None of those needs the model to actually think, which is exactly why this is
 * safe to put in front of a candidate and cheap to run at any scale.
 */

const ALL_ITEMS = 'runOnceForAllItems';
const PER_ITEM = 'runOncePerItem';

module.exports = (register) => {
  register({
    type: 'agent',
    label: 'AI Agent',
    group: 'ai',
    icon: 'sparkle',
    description: 'Asks a model to do something and return structured fields.',
    // Subagents attach here. The port after the data input, drawn on the
    // bottom edge, and it carries "may call", never items.
    toolInput: true,
    // Per item by default: an agent usually reasons about ONE record, and that is
    // also the expensive choice, which is the point worth noticing.
    mode: 'dynamic',
    dynamicModeParam: 'mode',
    defaultMode: PER_ITEM,
    latency: { base: 700, perItem: 450 },
    defaults: {
      mode: PER_ITEM,
      model: '',
      systemPrompt: '',
      userPrompt: '',
      outputFields: [],
    },
    params: [
      {
        name: 'mode', label: 'Run', type: 'options', options: [PER_ITEM, ALL_ITEMS],
        hint: 'Once per item means one model call per item. Ten items is ten calls, '
          + 'and ten times the cost — aggregate first if one call would do.',
      },
      {
        name: 'model', label: 'Model', type: 'options', options: [],
        hint: 'Which model to use. The task decides which are available.',
      },
      {
        name: 'systemPrompt', label: 'System Prompt', type: 'string', multiline: true,
        placeholder: 'You are a support triage assistant. Be concise and literal.',
        hint: 'Who the model is and how it should behave. Fixed instructions, not the task.',
      },
      {
        name: 'userPrompt', label: 'User Prompt', type: 'string', multiline: true,
        placeholder: '=Classify this ticket:\n{{ $json.subject }}',
        hint: 'The request for THIS item. Use an expression to put the item in it.',
      },
      {
        name: 'outputFields', label: 'Expected Output Fields', type: 'fieldNames',
        hint: 'The fields you are asking the model to return. They are added to the '
          + 'item, so later nodes read them as $json.<field>.',
      },
    ],

    run: async (ctx, input) => {
      const p = ctx.params;
      const perItem = (p.mode || PER_ITEM) === PER_ITEM;
      const items = input[0] || [];
      const item = items[0] || null;

      const fields = (p.outputFields || []).filter(Boolean);
      if (!fields.length) {
        throw new Error(
          'This agent declares no expected output fields, so nothing downstream can '
          + 'read its answer. Add the field names you are asking the model to return.',
        );
      }
      if (!String(p.userPrompt || '').trim()) {
        throw new Error('The user prompt is empty — there is nothing to ask the model.');
      }

      const res = await ctx.agent({
        input: item ? item.json : {},
        model: p.model,
        outputFields: fields,
        perItem,
        // Not used to match — never the prompt — only recorded on a fixture
        // miss, so the authoring tool can ask a real model the same question.
        systemPrompt: String(p.systemPrompt || ''),
        userPrompt: String(p.userPrompt || ''),
      });

      if (!res.ok) throw new Error(res.explanation);

      /**
       * The fixture answers with whatever the author recorded; the candidate
       * declared what they asked for. A field they expected and did not get is the
       * interesting failure — it is what happens in production when a model
       * ignores your schema — so it is named rather than left as `undefined`.
       */
      const missing = fields.filter((f) => res.output[f] === undefined);
      if (missing.length === fields.length) {
        throw new Error(
          `The model returned none of the fields you asked for (${fields.join(', ')}). `
          + `It returned: ${Object.keys(res.output).join(', ') || '(nothing)'}. `
          + 'Check the field names against what the task asks you to extract.',
        );
      }

      const answer = {};
      for (const field of fields) answer[field] = res.output[field];
      ctx.note({ model: p.model || '(unset)', fields, missing: missing.length ? missing : undefined });

      // All-items mode still produces one item: one call, one answer. Carrying the
      // whole input list forward would imply the model saw each item separately.
      if (!perItem) return [[makeItem(answer)]];

      return [[makeItem(
        { ...deepClone(item ? item.json : {}), ...answer },
        { pairedItem: item ? item.pairedItem : undefined },
      )]];
    },
  });

  /**
   * The AI Agent Tool — a subagent.
   *
   * An agent the parent agent may call, the way agent-as-tool works elsewhere. It is wired from its top edge to the
   * parent's Tools port; it carries no items and never runs as a step of the
   * workflow. It runs when the parent's model calls it — replayed from the
   * parent's fixture — and answers from its own fixture. The scheduler does all
   * of that; see `runToolCalls` in engine/scheduler.js.
   *
   * What it adds to grading over a lone agent is delegation: which work the
   * candidate split off, how they described the tool so a model would pick it,
   * what the subagent's prompt asks for, and whether the narrow job got the
   * cheap model. All four are parameters here, so all four are assertable.
   */
  register({
    type: 'agentTool',
    label: 'AI Agent Tool',
    group: 'ai',
    icon: 'sparkle',
    description: 'A subagent another agent can call as a tool.',
    inputs: 0,
    outputs: [{ name: 'tool' }],
    toolOutput: true,
    // Subagents can have subagents of their own; the scheduler refuses a circle.
    toolInput: true,
    mode: 'runOnceForAllItems',
    defaults: {
      toolName: '',
      description: '',
      model: '',
      systemPrompt: '',
      userPrompt: '',
      outputFields: [],
    },
    params: [
      {
        name: 'toolName', label: 'Tool Name', type: 'string',
        placeholder: 'lookup_customer',
        hint: 'The name the parent agent calls this tool by. The task says which tools '
          + 'the agent needs; use the name it gives.',
      },
      {
        name: 'description', label: 'Description', type: 'string', multiline: true,
        placeholder: 'Looks up a customer\'s plan and account status by customer id.',
        hint: 'What the tool does and when to use it. This is what the parent model '
          + 'reads to decide whether to call it.',
      },
      {
        name: 'model', label: 'Model', type: 'options', options: [],
        hint: 'A narrow job rarely needs the biggest model.',
      },
      {
        name: 'systemPrompt', label: 'System Prompt', type: 'string', multiline: true,
        placeholder: 'You look up customer records. Answer only from the record.',
      },
      {
        name: 'userPrompt', label: 'User Prompt', type: 'string', multiline: true,
        placeholder: '=Look up customer {{ $json.customerId }}',
        hint: 'The request, built from what the parent passed in. The parent\'s '
          + 'arguments are this tool\'s $json.',
      },
      {
        name: 'outputFields', label: 'Expected Output Fields', type: 'fieldNames',
        hint: 'The fields this subagent returns to the parent.',
      },
    ],

    run: async () => {
      throw new Error('An AI Agent Tool runs only when an agent calls it.');
    },
  });
};
