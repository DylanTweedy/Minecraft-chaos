// scripts/chaos/features/links/transfer/runtime/prismKeys.js

import { isPrismBlock } from "../../transfer/config.js";

const CANONICAL_SEPARATOR = "|";
const DIMENSION_ALIASES = {
  overworld: "minecraft:overworld",
  nether: "minecraft:nether",
  the_end: "minecraft:the_end",
  end: "minecraft:the_end",
};

export function normalizeDimId(dimId) {
  if (!dimId || typeof dimId !== "string") return null;
  if (dimId.startsWith("minecraft:")) return dimId;
  const lookup = DIMENSION_ALIASES[dimId.toLowerCase()];
  if (lookup) return lookup;
  return `minecraft:${dimId}`;
}

function intOrNull(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num | 0;
}

export function makePrismKey(dimId, x, y, z) {
  const normalizedDim = normalizeDimId(dimId);
  if (!normalizedDim) return null;
  const xi = intOrNull(x);
  const yi = intOrNull(y);
  const zi = intOrNull(z);
  if (xi === null || yi === null || zi === null) return null;
  return `${normalizedDim}${CANONICAL_SEPARATOR}${xi}${CANONICAL_SEPARATOR}${yi}${CANONICAL_SEPARATOR}${zi}`;
}

export function key(dimId, x, y, z) {
  return makePrismKey(dimId, x, y, z);
}

export function prismKeyFromBlock(block) {
  if (!isPrismBlock(block)) return null;
  const dimId = block.dimension?.id;
  if (!dimId || !block.location) return null;
  const loc = block.location;
  return makePrismKey(dimId, loc.x, loc.y, loc.z);
}

export function parsePrismKey(value) {
  if (typeof value !== "string") return null;
  const canonicalMatch = value.match(
    /^([^|]+)\|(-?\d+)\|(-?\d+)\|(-?\d+)$/
  );
  if (canonicalMatch) {
    const dim = normalizeDimId(canonicalMatch[1]);
    if (!dim) return null;
    return {
      dimId: dim,
      x: Number(canonicalMatch[2]) | 0,
      y: Number(canonicalMatch[3]) | 0,
      z: Number(canonicalMatch[4]) | 0,
    };
  }
  const legacyMatch = value.match(
    /^([^|]+)\|(-?\d+),(-?\d+),(-?\d+)$/
  );
  if (legacyMatch) {
    const dim = normalizeDimId(legacyMatch[1]);
    if (!dim) return null;
    return {
      dimId: dim,
      x: Number(legacyMatch[2]) | 0,
      y: Number(legacyMatch[3]) | 0,
      z: Number(legacyMatch[4]) | 0,
    };
  }
  return null;
}

export function canonicalizePrismKey(value) {
  const parsed = parsePrismKey(value);
  if (!parsed) return null;
  return makePrismKey(parsed.dimId, parsed.x, parsed.y, parsed.z);
}
