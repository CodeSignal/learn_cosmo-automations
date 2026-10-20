import { GROUP_ORDER } from '../canvas/NodePanel.jsx';

/** Group names as the help panel says them: "Flow nodes", not "Flow". */
export const GROUP_LABELS = {
  trigger: 'Trigger nodes',
  flow: 'Flow nodes',
  data: 'Data nodes',
  ai: 'AI nodes',
  transport: 'Transport nodes',
  integration: 'Integration nodes',
};

/** A group label in the singular, for a node page's eyebrow. */
export const GROUP_SINGULAR = {
  trigger: 'Trigger node',
  flow: 'Flow node',
  data: 'Data node',
  ai: 'AI node',
  transport: 'Transport node',
  integration: 'Integration node',
};

/** Nodes in palette order, grouped — the same order as the node panel. */
export function nodeGroups(nodes) {
  return GROUP_ORDER
    .map((group) => ({ group, items: nodes.filter((n) => n.group === group) }))
    .filter((g) => g.items.length);
}
