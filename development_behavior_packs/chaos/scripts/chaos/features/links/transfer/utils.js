// scripts/chaos/features/links/transfer/utils.js
import { parseKey } from "./keys.js";

export function mergeCfg(defaults, opts) {
  const cfg = {};
  for (const k in defaults) cfg[k] = defaults[k];
  if (opts) {
    for (const k2 in opts) cfg[k2] = opts[k2];
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
  } catch {
    return null;
  }
}
