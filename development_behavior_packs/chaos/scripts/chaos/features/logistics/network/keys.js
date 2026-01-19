// scripts/chaos/features/logistics/shared/keys.js
// Pure helpers that delegate to the canonical prism key helpers.
import { makePrismKey } from "./graph/prismKeys.js";

export function makeKey(dimId, x, y, z) {
  return makePrismKey(dimId, x, y, z);
}

export function makeKeyFromBlock(block) {
  const dimId = block.dimension.id;
  const loc = block.location;
  return makeKey(dimId, loc.x, loc.y, loc.z);
}

export function pendingToKey(pending) {
  return makeKey(pending.dimId, pending.x, pending.y, pending.z);
}

