// scripts/chaos/features/links/shared/keys.js
// Pure helpers only. No imports, no side effects.

export function makeKey(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}

export function makeKeyFromBlock(block) {
  const dimId = block.dimension.id;
  const loc = block.location;
  return makeKey(dimId, loc.x, loc.y, loc.z);
}

export function pendingToKey(pending) {
  return makeKey(pending.dimId, pending.x, pending.y, pending.z);
}
