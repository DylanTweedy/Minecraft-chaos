// scripts/chaos/features/links/transfer/keys.js
import {
  makePrismKey,
  parsePrismKey,
  canonicalizePrismKey,
  normalizeDimId,
  prismKeyFromBlock,
} from "./runtime/prismKeys.js";

export { makePrismKey, parsePrismKey, canonicalizePrismKey, normalizeDimId };
export { prismKeyFromBlock };

export function key(dimId, x, y, z) {
  return makePrismKey(dimId, x, y, z);
}

export function getContainerKey(blockOrEntity) {
  try {
    if (!blockOrEntity) return null;
    // Handle blocks
    if (blockOrEntity.location && typeof blockOrEntity.location.x === "number") {
      const loc = blockOrEntity.location;
      const dimId = blockOrEntity.dimension?.id || blockOrEntity.location?.dimension?.id;
      if (!dimId) return null;
      return key(dimId, Math.floor(loc.x), Math.floor(loc.y), Math.floor(loc.z));
    }
    // Handle entities (use entity ID as part of key)
    if (blockOrEntity.id && typeof blockOrEntity.id === "string") {
      const loc = blockOrEntity.location;
      const dimId = blockOrEntity.dimension?.id;
      if (!dimId || !loc) return null;
      // Round to block position and add entity ID hash for uniqueness
      const blockX = Math.floor(loc.x);
      const blockY = Math.floor(loc.y);
      const blockZ = Math.floor(loc.z);
      const entityHash = blockOrEntity.id.slice(-8) || "entity";
      return key(dimId, blockX, blockY, blockZ) + `|${entityHash}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function getContainerKeyFromInfo(info) {
  try {
    if (!info) return null;
    // Use entity if available, otherwise use block
    const ref = info.entity || info.block;
    return ref ? getContainerKey(ref) : null;
  } catch {
    return null;
  }
}

export function parseKey(k) {
  return parsePrismKey(k);
}
