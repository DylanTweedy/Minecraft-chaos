// scripts/chaos/features/links/transfer/keys.js
export function key(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}

export function getContainerKey(block) {
  try {
    if (!block) return null;
    const loc = block.location;
    return key(block.dimension.id, loc.x, loc.y, loc.z);
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
