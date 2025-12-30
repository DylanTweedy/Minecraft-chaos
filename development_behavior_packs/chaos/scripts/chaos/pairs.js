import { world } from "@minecraft/server";
import { DP_PAIRS } from "./constants.js";
import { log } from "./log.js";

const pairs = new Map(); // key: inputKey -> { input:{...}, output:{...} }

export function makeKey(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}

export function getPairsMap() {
  return pairs;
}

export function hasPairForInput(inputKey) {
  return pairs.has(inputKey);
}

export function setPair(input, output) {
  const inputKey = makeKey(input.dimId, input.x, input.y, input.z);
  pairs.set(inputKey, { input, output });
}

export function removePairByInputKey(inputKey) {
  pairs.delete(inputKey);
}

export function loadPairsFromWorld() {
  pairs.clear();

  const raw = world.getDynamicProperty(DP_PAIRS);
  if (!raw || typeof raw !== "string") {
    log("No saved pairs found (fresh world or not saved yet).");
    return;
  }

  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;

    for (const [k, v] of Object.entries(obj)) {
      if (!v?.input || !v?.output) continue;
      pairs.set(k, v);
    }

    log(`Loaded ${pairs.size} pair(s) from dynamic properties.`);
  } catch (e) {
    log(`Failed to parse saved pairs JSON. Starting empty. Error: ${e}`);
  }
}

export function savePairsToWorld() {
  // Convert Map -> plain object for JSON
  const obj = {};
  for (const [k, v] of pairs.entries()) obj[k] = v;

  const raw = JSON.stringify(obj);
  world.setDynamicProperty(DP_PAIRS, raw);
  log(`Saved ${pairs.size} pair(s). JSON bytes=${raw.length}`);
}
