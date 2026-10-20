'use strict';

const { makeItem } = require('../items');

/**
 * Triggers have no inputs. They read their starting items from
 * `scenario.triggerPayload[<type>]`, which is what makes a run reproducible.
 */
module.exports = (register) => {
  register({
    type: 'manualTrigger',
    label: 'Manual Trigger',
    group: 'trigger',
    icon: 'play',
    inputs: 0,
    mode: 'runOnceForAllItems',
    description: 'Starts the workflow with a single empty item.',
    latency: { base: 60 },
    params: [],
    run: (ctx) => {
      const payload = ctx.triggerPayload.manualTrigger;
      if (Array.isArray(payload)) return [payload.map((json) => makeItem(json))];
      return [[makeItem(payload || {})]];
    },
  });

  register({
    type: 'webhook',
    label: 'Webhook',
    group: 'trigger',
    icon: 'webhook',
    inputs: 0,
    mode: 'runOnceForAllItems',
    description: 'Starts the workflow from an inbound HTTP request.',
    latency: { base: 90 },
    defaults: { path: '', method: 'POST' },
    params: [
      { name: 'path', label: 'Path', type: 'string', placeholder: 'incoming-hook' },
      {
        name: 'method', label: 'HTTP Method', type: 'options',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      },
    ],
    run: (ctx) => {
      const payload = ctx.triggerPayload.webhook || {};
      // Real webhook nodes emit one item whose json wraps body/headers/query.
      return [[makeItem({
        body: payload.body === undefined ? {} : payload.body,
        headers: payload.headers || {},
        query: payload.query || {},
      })]];
    },
  });

  register({
    type: 'scheduleTrigger',
    label: 'Schedule Trigger',
    group: 'trigger',
    icon: 'clock',
    inputs: 0,
    mode: 'runOnceForAllItems',
    description: 'Starts the workflow on a schedule. In the simulation it fires once.',
    defaults: { interval: 'hours', value: 1 },
    params: [
      { name: 'interval', label: 'Interval', type: 'options', options: ['minutes', 'hours', 'days'] },
      { name: 'value', label: 'Every', type: 'number' },
    ],
    run: (ctx) => [[makeItem({ timestamp: ctx.now.toISOString() })]],
  });
};
