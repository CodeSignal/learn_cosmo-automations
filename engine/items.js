'use strict';

/**
 * The item model.
 *
 * Data flows between nodes as arrays of items. Most nodes run once per item;
 * a few (Aggregate, Sort, Limit) see the whole array at once. This module is
 * the single source of truth for the shape.
 *
 * type Item = {
 *   json: Record<string, unknown>,
 *   binary?: Record<string, { data: string, mimeType: string, fileName?: string }>,
 *   pairedItem?: number,   // index in the input array this item derives from
 *   meta?: Record<string, unknown>  // engine-owned passthrough (agent traces, token
 *                                   // counts). Reserved — never
 *                                   // written by candidate-facing node params.
 * }
 */

function makeItem(json, opts = {}) {
  const item = { json: json === undefined ? {} : json };
  if (opts.binary) item.binary = opts.binary;
  if (opts.pairedItem !== undefined) item.pairedItem = opts.pairedItem;
  if (opts.meta) item.meta = opts.meta;
  return item;
}

/** Deep clone so a node can never mutate its input in place. */
function cloneItem(item) {
  return {
    json: deepClone(item.json),
    ...(item.binary ? { binary: deepClone(item.binary) } : {}),
    ...(item.pairedItem !== undefined ? { pairedItem: item.pairedItem } : {}),
    ...(item.meta ? { meta: deepClone(item.meta) } : {}),
  };
}

function cloneItems(items) {
  return items.map(cloneItem);
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
  return out;
}

/**
 * Merge the item arrays arriving on a single input port. A node with two
 * upstream nodes wired into input 0 sees their items concatenated.
 */
function concatPort(arrays) {
  const out = [];
  for (const arr of arrays) if (arr) out.push(...arr);
  return out;
}

module.exports = { makeItem, cloneItem, cloneItems, deepClone, concatPort };
