// scripts/chaos/pairs.js
import { world } from "@minecraft/server";
import {
  DP_PAIRS_COUNT,
  DP_PAIRS_CHUNK_PREFIX,
  DP_PAIRS_MAX_CHUNKS,
  DP_PAIRS_CHUNK_SIZE,
} from "./constants.js";

// inputKey -> Set(outputKey)
const pairs = new Map();

// Persistence auto-disables if DP throws at runtime
let persistenceEnabled = true;

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function isPersistenceEnabled() {
  return persistenceEnabled;
}

export function getPairsMap() {
  return pairs;
}

/** Returns a COPY as an array (safe for iteration / debug) */
export function getOutputsArray(inputKey) {
  const set = pairs.get(inputKey);
  return set ? Array.from(set) : [];
}

export function addOutput(inputKey, outputKey) {
  let set = pairs.get(inputKey);
  if (!set) {
    set = new Set();
    pairs.set(inputKey, set);
  }
  const before = set.size;
  set.add(outputKey);
  return set.size > before; // true if newly added
}

export function removeOutput(inputKey, outputKey) {
  const set = pairs.get(inputKey);
  if (!set) return false;
  const removed = set.delete(outputKey);
  if (set.size === 0) pairs.delete(inputKey);
  return removed;
}

export function clearOutputs(inputKey) {
  return pairs.delete(inputKey);
}

/**
 * ✅ Toggle membership:
 * If outputKey exists for inputKey => remove
 * else => add
 * Returns: { added:boolean, removed:boolean }
 */
export function toggleOutput(inputKey, outputKey) {
  let set = pairs.get(inputKey);
  if (!set) {
    set = new Set();
    pairs.set(inputKey, set);
  }

  if (set.has(outputKey)) {
    set.delete(outputKey);
    if (set.size === 0) pairs.delete(inputKey);
    return { added: false, removed: true };
  }

  set.add(outputKey);
  return { added: true, removed: false };
}

/**
 * IMPORTANT:
 * Call this ONLY after startup, e.g. system.runTimeout(() => loadPairsFromWorldSafe(), 1)
 */
export function loadPairsFromWorldSafe() {
  pairs.clear();

  if (!persistenceEnabled) return;

  try {
    const count = world.getDynamicProperty(DP_PAIRS_COUNT);
    const chunkCount = typeof count === "number" && count > 0 ? count : 0;
    if (chunkCount <= 0) return;

    let raw = "";
    for (let i = 0; i < chunkCount; i++) {
      const part = world.getDynamicProperty(`${DP_PAIRS_CHUNK_PREFIX}${i}`);
      if (typeof part === "string" && part.length) raw += part;
    }
    if (!raw.length) return;

    const obj = safeJsonParse(raw, null);
    if (!obj || typeof obj !== "object") return;

    for (const [inputKey, outputs] of Object.entries(obj)) {
      if (!Array.isArray(outputs)) continue;

      const set = new Set();
      for (const outKey of outputs) {
        if (typeof outKey === "string" && outKey.length) set.add(outKey);
      }
      if (set.size) pairs.set(inputKey, set);
    }
  } catch {
    // DP read failed -> disable persistence, keep wand alive
    persistenceEnabled = false;
    pairs.clear();
  }
}

/**
 * Safe save:
 * - serializes Sets to arrays
 * - chunks JSON
 * - writes count last (so partial writes don't pretend they're valid)
 */
export function savePairsToWorldSafe() {
  if (!persistenceEnabled) return;

  try {
    // Map -> { [inputKey]: string[] }
    const obj = {};
    for (const [k, set] of pairs.entries()) {
      obj[k] = Array.from(set);
    }

    const raw = JSON.stringify(obj);

    const chunks = [];
    for (let i = 0; i < raw.length; i += DP_PAIRS_CHUNK_SIZE) {
      chunks.push(raw.slice(i, i + DP_PAIRS_CHUNK_SIZE));
    }

    if (chunks.length > DP_PAIRS_MAX_CHUNKS) {
      // Too big; refuse to corrupt saved data. Keep memory-only.
      return;
    }

    // Write chunks first
    for (let i = 0; i < chunks.length; i++) {
      world.setDynamicProperty(`${DP_PAIRS_CHUNK_PREFIX}${i}`, chunks[i]);
    }

    // Clear unused old chunks
    for (let i = chunks.length; i < DP_PAIRS_MAX_CHUNKS; i++) {
      world.setDynamicProperty(`${DP_PAIRS_CHUNK_PREFIX}${i}`, "");
    }

    // Write count last (commit marker)
    world.setDynamicProperty(DP_PAIRS_COUNT, chunks.length);
  } catch {
    // DP write failed -> disable persistence, keep wand alive
    persistenceEnabled = false;
  }
}

/** Optional: wipe DP clean (no backwards compatibility needed) */
export function wipePairsInWorldSafe() {
  try {
    world.setDynamicProperty(DP_PAIRS_COUNT, 0);
    for (let i = 0; i < DP_PAIRS_MAX_CHUNKS; i++) {
      world.setDynamicProperty(`${DP_PAIRS_CHUNK_PREFIX}${i}`, "");
    }
  } catch {
    // ignore
  }
}
