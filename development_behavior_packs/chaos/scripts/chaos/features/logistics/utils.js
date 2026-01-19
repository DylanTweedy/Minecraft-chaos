// scripts/chaos/features/logistics/utils.js
import { parseKey } from "./keys.js";

export function mergeCfg(defaults, opts) {
  const cfg = {};
  for (const k in defaults) cfg[k] = defaults[k];
  if (opts) {
    // IMPORTANT: don't stomp defaults with `undefined`.
    // Some call sites pass a large opts object with optional fields.
    // Copying `undefined` through breaks runtime budgets (e.g. maxSearchesPerTick),
    // which can silently disable pathfinding and transfers.
    for (const k2 in opts) {
      const v = opts[k2];
      if (v !== undefined) cfg[k2] = v;
    }
  }
  return cfg;
}

export function runTransferPipeline(stepsOrPipeline, ctx) {
  if (!stepsOrPipeline) return;
  if (typeof stepsOrPipeline.runTick === "function") {
    return stepsOrPipeline.runTick(ctx);
  }
  if (Array.isArray(stepsOrPipeline)) {
    for (const step of stepsOrPipeline) {
      if (typeof step === "function") step(ctx);
    }
  }
}

export function resolveBlockInfoStatic(world, blockKey) {
  try {
    const pos = parseKey(blockKey);
    if (!pos) return null;
    const dim = world.getDimension(pos.dimId);
    if (!dim) return null;
    const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
    if (!block) return null;
    return { dim, block, pos };
  } catch (e) {
    return null;
  }
}


