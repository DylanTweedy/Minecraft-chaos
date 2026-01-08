// scripts/chaos/features/links/transfer/keys.js
export function key(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
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
  try {
    if (typeof k !== "string") return null;
    const p = k.indexOf("|");
    if (p <= 0) return null;
    const dimId = k.slice(0, p);
    const rest = k.slice(p + 1);
    const parts = rest.split(",");
    if (parts.length !== 3) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { dimId, x: x | 0, y: y | 0, z: z | 0 };
  } catch {
    return null;
  }
}
