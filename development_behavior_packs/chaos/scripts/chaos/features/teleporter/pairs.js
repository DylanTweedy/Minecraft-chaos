// scripts/chaos/features/teleporter/pairs.js
import { world } from "@minecraft/server";
import {
  DP_TP_PAIRS_COUNT,
  DP_TP_PAIRS_CHUNK_PREFIX,
  DP_TP_PAIRS_MAX_CHUNKS,
  DP_TP_PAIRS_CHUNK_SIZE,
} from "../../core/constants.js";
import { canonicalizePrismKey } from "../logistics/keys.js";

const pairs = new Map(); // key -> key
let persistenceEnabled = true;
let dirty = false;

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

export function markTeleporterDirty() {
  dirty = true;
}

export function getLinkedKey(key) {
  return pairs.get(key) || null;
}

export function unlinkKey(key) {
  if (!key) return false;
  const other = pairs.get(key);
  if (!other) return false;
  pairs.delete(key);
  if (pairs.get(other) === key) pairs.delete(other);
  markTeleporterDirty();
  return true;
}

export function linkKeys(a, b) {
  const k1 = canonicalizePrismKey(a);
  const k2 = canonicalizePrismKey(b);
  if (!k1 || !k2 || k1 === k2) return false;
  unlinkKey(k1);
  unlinkKey(k2);
  pairs.set(k1, k2);
  pairs.set(k2, k1);
  markTeleporterDirty();
  return true;
}

export function hasLink(key) {
  return pairs.has(key);
}

export function clearAllLinks() {
  pairs.clear();
  markTeleporterDirty();
}

export function loadTeleporterPairsFromWorldSafe() {
  pairs.clear();
  if (!persistenceEnabled) return;

  try {
    const count = world.getDynamicProperty(DP_TP_PAIRS_COUNT);
    const chunkCount = typeof count === "number" && count > 0 ? count : 0;
    if (chunkCount <= 0) return;

    let raw = "";
    for (let i = 0; i < chunkCount; i++) {
      const part = world.getDynamicProperty(`${DP_TP_PAIRS_CHUNK_PREFIX}${i}`);
      if (typeof part === "string" && part.length) raw += part;
    }
    if (!raw.length) return;

    const obj = safeJsonParse(raw, null);
    if (!obj || typeof obj !== "object") return;

    for (const [key, other] of Object.entries(obj)) {
      const k1 = canonicalizePrismKey(key);
      const k2 = canonicalizePrismKey(other);
      if (!k1 || !k2 || k1 === k2) continue;
      pairs.set(k1, k2);
    }
  } catch {
    persistenceEnabled = false;
    pairs.clear();
  }
}

export function saveTeleporterPairsToWorldSafe() {
  if (!persistenceEnabled) return;

  try {
    const obj = {};
    for (const [k, v] of pairs.entries()) {
      obj[k] = v;
    }

    const raw = safeJsonStringify(obj);
    if (typeof raw !== "string") return;

    const chunks = [];
    for (let i = 0; i < raw.length; i += DP_TP_PAIRS_CHUNK_SIZE) {
      chunks.push(raw.slice(i, i + DP_TP_PAIRS_CHUNK_SIZE));
    }

    if (chunks.length > DP_TP_PAIRS_MAX_CHUNKS) return;

    for (let i = 0; i < chunks.length; i++) {
      world.setDynamicProperty(`${DP_TP_PAIRS_CHUNK_PREFIX}${i}`, chunks[i]);
    }
    for (let i = chunks.length; i < DP_TP_PAIRS_MAX_CHUNKS; i++) {
      world.setDynamicProperty(`${DP_TP_PAIRS_CHUNK_PREFIX}${i}`, "");
    }
    world.setDynamicProperty(DP_TP_PAIRS_COUNT, chunks.length);
    dirty = false;
  } catch {
    persistenceEnabled = false;
  }
}

export function saveTeleporterPairsIfDirty() {
  if (!dirty) return;
  saveTeleporterPairsToWorldSafe();
}

function registerWorldDP(e) {
  const maxLength = DP_TP_PAIRS_MAX_CHUNKS * DP_TP_PAIRS_CHUNK_SIZE + 1000;
  try {
    e.propertyRegistry.registerWorldDynamicProperties({
      [DP_TP_PAIRS_COUNT]: { type: "number" },
      [DP_TP_PAIRS_CHUNK_PREFIX + "0"]: { type: "string", maxLength },
    });
    return true;
  } catch {
    try {
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineNumber(DP_TP_PAIRS_COUNT)
      );
      e.propertyRegistry.registerWorldDynamicProperties(
        e.propertyRegistry.defineString(DP_TP_PAIRS_CHUNK_PREFIX + "0", maxLength)
      );
      return true;
    } catch {
      return false;
    }
  }
}

try {
  const hook = world?.afterEvents?.worldInitialize;
  if (hook?.subscribe) {
    hook.subscribe((e) => {
      try {
        registerWorldDP(e);
      } catch {
        // ignore
      }
    });
  }
} catch {
  // ignore
}
