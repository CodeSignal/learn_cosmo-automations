'use strict';

/**
 * The Approval node — a human decision in the middle of a workflow.
 *
 * The run stops, a person approves or rejects, and the items leave on the
 * matching port. It is the pattern every real automation needs the moment it
 * does something irreversible: post to customers, issue a refund, delete a
 * record. "Which steps should a human see before they happen" is a judgement
 * worth testing, and it is not expressible with a Filter.
 *
 * HOW PAUSING WORKS HERE, AND WHY IT IS NOT A SNAPSHOT
 *
 * The obvious implementation suspends the engine mid-walk and serialises its
 * state so a later request can resume it. That is what you have to do when runs
 * are expensive or non-deterministic, and it means a state format, a recovery
 * path, and a restart story.
 *
 * This engine is deterministic — fixed clock, seeded randomness, mocked
 * transport, replayed model calls — so a trace is a pure function of
 * (scenario, graph, decisions). Resuming is therefore just running again with one
 * more decision known. There is no snapshot to write, nothing to restore after a
 * restart, and no way for saved state to drift from the code that produced it.
 * The cost is re-executing the nodes before the pause, which cost nothing to
 * begin with because none of them touch anything real.
 *
 * Determinism bought resumability for free. It is the same property that makes
 * grading possible, used twice.
 */

module.exports = (register) => {
  register({
    type: 'approval',
    label: 'Wait For Approval',
    group: 'flow',
    icon: 'approval',
    description: 'Pauses the workflow until a person approves or rejects.',
    latency: { base: 40 },
    mode: 'runOnceForAllItems',
    outputs: [{ name: 'approved' }, { name: 'rejected' }],
    /**
     * Handled by the scheduler, like Loop Over Items. Pausing is an instruction
     * to the thing that owns the walk, not something a node can compute.
     */
    pauses: true,
    defaults: {
      prompt: '',
    },
    params: [
      {
        name: 'prompt', label: 'Prompt', type: 'string', multiline: true,
        placeholder: 'Send these 3 refunds?',
        hint: 'What the person is being asked. Say what will happen if they approve.',
      },
    ],
    // Never called: `pauses: true` is handled in the scheduler.
    run: () => { throw new Error('Wait For Approval is executed by the scheduler.'); },
  });
};
