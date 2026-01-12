// scripts/chaos/features/links/transfer/runtime/helpers/pos.js

/**
 * Normalize coordinates into a canonical prism/block position object.
 * Ensures x/y/z are integers and dimId is set if available.
 */
export function normalizePos(source) {
  if (!source) return null;
  const x = typeof source.x === "number" ? Math.floor(source.x) : null;
  const y = typeof source.y === "number" ? Math.floor(source.y) : null;
  const z = typeof source.z === "number" ? Math.floor(source.z) : null;
  const dimId =
    typeof source.dimId === "string"
      ? source.dimId
      : typeof source.dimension?.id === "string"
      ? source.dimension.id
      : typeof source.dim?.id === "string"
      ? source.dim.id
      : null;

  if (x === null || y === null || z === null || !dimId) return null;

  return { x, y, z, dimId };
}

/**
 * Attach a dimId to a position object if missing.
 */
export function withDim(pos, dimId) {
  if (!pos) return null;
  const normalized = normalizePos(pos);
  if (!normalized) return null;
  return dimId ? { ...normalized, dimId } : normalized;
}

