// scripts/chaos/features/logistics/systems/foundryFilters.js
import { world } from "@minecraft/server";
import { canonicalizePrismKey, key as makePrismKey } from "../network/graph/prismKeys.js";

const DP_FOUNDRY_FILTERS = "chaos:foundry_filters_v0_json";

let _filtersCache = null; // key -> array
let _setsCache = new Map();

function safeJsonParse(s, fallback) {
  try {
    if (typeof s !== "string" || !s) return fallback;
    const parsed = JSON.parse(s);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function normalizeFilters(obj) {
  if (!obj || typeof obj !== "object") return {};
  const normalized = {};
  for (const [key, value] of Object.entries(obj)) {
    const canonical = canonicalizePrismKey(key);
    if (!canonical) continue;
    normalized[canonical] = Array.isArray(value) ? value.slice() : [];
  }
  return normalized;
}

function ensureLoaded() {
  if (_filtersCache) return;
  const raw = world.getDynamicProperty(DP_FOUNDRY_FILTERS);
  const parsed = safeJsonParse(raw, {});
  _filtersCache = normalizeFilters(parsed);
  _setsCache.clear();
}

function persist() {
  const raw = safeJsonStringify(_filtersCache || {});
  if (typeof raw !== "string") return;
  world.setDynamicProperty(DP_FOUNDRY_FILTERS, raw);
}

function keyFromBlock(block) {
  try {
    if (!block) return null;
    const loc = block.location;
    const dimId = block.dimension?.id;
    if (!dimId) return null;
    return makePrismKey(dimId, loc.x, loc.y, loc.z);
  } catch {
    return null;
  }
}

function normalizeArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => typeof v === "string" && v.length > 0);
}

function getSetForKey(key) {
  ensureLoaded();
  if (!key) return null;
  let set = _setsCache.get(key);
  if (set) return set;
  const arr = normalizeArray(_filtersCache[key]);
  set = new Set(arr);
  _setsCache.set(key, set);
  return set;
}

export function getFoundryFilterList(block) {
  const key = keyFromBlock(block);
  if (!key) return [];
  const set = getSetForKey(key);
  return Array.from(set);
}

export function toggleFoundryFilterForBlock(block, typeId) {
  try {
    if (!typeId) return null;
    const key = keyFromBlock(block);
    if (!key) return null;

    ensureLoaded();
    const set = getSetForKey(key);

    let added = false;
    let removed = false;
    if (set.has(typeId)) {
      set.delete(typeId);
      removed = true;
    } else {
      set.add(typeId);
      added = true;
    }

    if (set.size === 0) {
      delete _filtersCache[key];
      _setsCache.delete(key);
    } else {
      _filtersCache[key] = Array.from(set);
    }
    persist();
    return { added, removed, size: set.size };
  } catch {
    return null;
  }
}

export function clearFoundryFiltersForBlock(block) {
  try {
    const key = keyFromBlock(block);
    if (!key) return false;
    ensureLoaded();
    if (!_filtersCache[key]) return false;
    delete _filtersCache[key];
    _setsCache.delete(key);
    persist();
    return true;
  } catch {
    return false;
  }
}
