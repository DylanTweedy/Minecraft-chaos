// scripts/chaos/features/links/transfer/adapter.js
import { parseKey } from "./keys.js";

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
