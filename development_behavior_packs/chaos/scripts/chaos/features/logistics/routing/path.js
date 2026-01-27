// scripts/chaos/features/logistics/pathfinding/path.js
import {
  isBeamId,
  CRYSTALLIZER_ID,
  TRANSPOSER_ID,
  COLLECTOR_ID,
  PATH_WEIGHT_MAX_LEN,
  PATH_WEIGHT_LEN_EXP,
  PATH_WEIGHT_RANDOM_MIN,
  PATH_WEIGHT_RANDOM_MAX,
  isPrismBlock,
} from "../config.js";
import { key } from "../keys.js";

export function validatePathStart(dim, path) {
  try {
    if (!dim || !Array.isArray(path) || path.length === 0) return false;
    const first = path[0];
    const last = path[path.length - 1];
    const firstBlock = dim.getBlock({ x: first.x, y: first.y, z: first.z });
    const lastBlock = dim.getBlock({ x: last.x, y: last.y, z: last.z });
    return !!(isPathBlock(firstBlock) && isNodeBlock(lastBlock));
  } catch (e) {
    return false;
  }
}

export function isPathBlock(block) {
  if (!block) return false;
  const id = block.typeId;
  return isBeamId(id) || isPrismBlock(block) || id === CRYSTALLIZER_ID || id === TRANSPOSER_ID || id === COLLECTOR_ID;
}

export function isRelayBlock(block) {
  if (!block) return false;
  const id = block.typeId;
  return isPrismBlock(block) || id === CRYSTALLIZER_ID || id === TRANSPOSER_ID || id === COLLECTOR_ID;
}

export function isNodeBlock(block) {
  if (!block) return false;
  const id = block.typeId;
  return isPrismBlock(block) || id === CRYSTALLIZER_ID || id === TRANSPOSER_ID || id === COLLECTOR_ID;
}

export function findFirstPrismKeyInPath(dim, dimId, path) {
  try {
    if (!dim || !Array.isArray(path) || path.length === 0) return null;
    for (const p of path) {
      const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
      if (b && isPrismBlock(b)) return key(dimId, p.x, p.y, p.z);
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function buildNodePathSegments(dim, path, startPos) {
  try {
    if (!dim || !Array.isArray(path) || path.length === 0) return null;
    const nodeIndices = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
      if (isNodeBlock(b) || isRelayBlock(b)) nodeIndices.push(i);
    }
    if (nodeIndices.length === 0) return null;
    if (!startPos) return null;
    
    // Check if path already starts with startPos (or very close to it)
    const pathStartMatches = nodeIndices.length > 0 && nodeIndices[0] === 0;
    let pathStartPos = pathStartMatches ? path[0] : null;
    const startPosMatches = pathStartPos && 
      Math.abs(pathStartPos.x - startPos.x) < 0.1 &&
      Math.abs(pathStartPos.y - startPos.y) < 0.1 &&
      Math.abs(pathStartPos.z - startPos.z) < 0.1;
    
    const points = [{ x: startPos.x, y: startPos.y, z: startPos.z }];
    const keys = [key(dim.id, startPos.x, startPos.y, startPos.z)];
    const lengths = [];
    let prev = -1;
    // Skip first node if it matches startPos (avoid duplicate)
    const startIdx = startPosMatches ? 1 : 0;
    for (let i = startIdx; i < nodeIndices.length; i++) {
      const idx = nodeIndices[i];
      if (idx <= prev) continue;
      const p = path[idx];
      points.push({ x: p.x, y: p.y, z: p.z });
      keys.push(key(dim.id, p.x, p.y, p.z));
      lengths.push(Math.max(1, idx - prev));
      prev = idx;
    }
    return points.length > 1 ? { points, lengths, keys } : null;
  } catch (e) {
    return null;
  }
}

export function buildFluxFxSegments(dim, path) {
  try {
    if (!dim || !Array.isArray(path) || path.length < 2) return null;
    const nodeIndices = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const b = dim.getBlock({ x: p.x, y: p.y, z: p.z });
      if (isNodeBlock(b) || isRelayBlock(b)) nodeIndices.push(i);
    }
    if (nodeIndices.length === 0) return null;
    if (nodeIndices[0] !== 0) nodeIndices.unshift(0);
    const lastIdx = path.length - 1;
    if (nodeIndices[nodeIndices.length - 1] !== lastIdx) nodeIndices.push(lastIdx);

    const points = [];
    const lengths = [];
    for (let i = 0; i < nodeIndices.length; i++) {
      const idx = nodeIndices[i];
      points.push(path[idx]);
      if (i < nodeIndices.length - 1) {
        const nextIdx = nodeIndices[i + 1];
        lengths.push(Math.max(1, nextIdx - idx));
      }
    }
    return { points, lengths };
  } catch (e) {
    return null;
  }
}

export function findDropLocation(dim, loc) {
  const candidates = [
    { x: loc.x, y: loc.y + 1, z: loc.z },
    { x: loc.x + 1, y: loc.y, z: loc.z },
    { x: loc.x - 1, y: loc.y, z: loc.z },
    { x: loc.x, y: loc.y, z: loc.z + 1 },
    { x: loc.x, y: loc.y, z: loc.z - 1 },
  ];
  for (const c of candidates) {
    const b = dim.getBlock(c);
    if (b && b.typeId === "minecraft:air") {
      return { x: c.x + 0.5, y: c.y + 0.1, z: c.z + 0.5 };
    }
  }
  return { x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5 };
}

export function pickWeightedRandom(outputs) {
  if (!outputs || outputs.length === 0) return null;
  if (outputs.length === 1) return outputs[0];

  let total = 0;
  const weights = outputs.map((o) => {
    const len = Array.isArray(o.path) ? o.path.length : 1;
    const clamped = Math.min(Math.max(1, len), PATH_WEIGHT_MAX_LEN);
    const base = 1 / Math.pow(clamped, PATH_WEIGHT_LEN_EXP);
    const jitter = PATH_WEIGHT_RANDOM_MIN + (Math.random() * (PATH_WEIGHT_RANDOM_MAX - PATH_WEIGHT_RANDOM_MIN));
    const w = base * jitter;
    total += w;
    return w;
  });

  let r = Math.random() * total;
  for (let i = 0; i < outputs.length; i++) {
    r -= weights[i];
    if (r <= 0) return outputs[i];
  }
  return outputs[outputs.length - 1];
}

export function pickWeightedRandomWithBias(outputs, getBias) {
  if (!outputs || outputs.length === 0) return null;
  if (outputs.length === 1) return outputs[0];
  const biasFn = (typeof getBias === "function") ? getBias : (() => 1.0);

  let total = 0;
  const weights = outputs.map((o) => {
    const len = Array.isArray(o.path) ? o.path.length : 1;
    const clamped = Math.min(Math.max(1, len), PATH_WEIGHT_MAX_LEN);
    const base = 1 / Math.pow(clamped, PATH_WEIGHT_LEN_EXP);
    const jitter = PATH_WEIGHT_RANDOM_MIN + (Math.random() * (PATH_WEIGHT_RANDOM_MAX - PATH_WEIGHT_RANDOM_MIN));
    const bias = Math.max(0.1, Number(biasFn(o)) || 1.0);
    const w = base * jitter * bias;
    total += w;
    return w;
  });

  let r = Math.random() * total;
  for (let i = 0; i < outputs.length; i++) {
    r -= weights[i];
    if (r <= 0) return outputs[i];
  }
  return outputs[outputs.length - 1];
}


