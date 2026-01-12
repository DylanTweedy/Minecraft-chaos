// scripts/chaos/features/links/shared/filters.js
// Node filter storage using world dynamic properties.

const DP_NODE_FILTERS = "chaos:node_filters_v0_json";

let _filtersCache = null; // key -> array of typeIds
let _setsCache = new Map(); // key -> Set(typeId)

function safeJsonParse(s) {
  try {
    if (typeof s !== "string" || !s) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function ensureLoaded(world) {
  if (_filtersCache) return;
  try {
    const raw = world.getDynamicProperty(DP_NODE_FILTERS);
    const parsed = safeJsonParse(raw);
    _filtersCache = (parsed && typeof parsed === "object") ? parsed : {};
    _setsCache.clear();
  } catch {
    _filtersCache = {};
    _setsCache.clear();
  }
}

function persist(world) {
  try {
    const raw = safeJsonStringify(_filtersCache || {});
    if (typeof raw !== "string") return;
    world.setDynamicProperty(DP_NODE_FILTERS, raw);
  } catch {
    // ignore
  }
}

function keyFromBlock(block) {
  try {
    if (!block) return null;
    const loc = block.location;
    const dimId = block.dimension?.id;
    if (!dimId) return null;
    return `${dimId}|${loc.x},${loc.y},${loc.z}`;
  } catch {
    return null;
  }
}

function normalizeArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => typeof v === "string" && v.length > 0);
}

function getSetForKey(world, key) {
  ensureLoaded(world);
  if (!key) return null;
  let set = _setsCache.get(key);
  if (set) return set.size > 0 ? set : null;
  const arr = normalizeArray(_filtersCache[key]);
  if (arr.length === 0) return null;
  set = new Set(arr);
  _setsCache.set(key, set);
  return set.size > 0 ? set : null;
}

export function getFilterSetForBlock(world, block) {
  const key = keyFromBlock(block);
  return getSetForKey(world, key);
}

export function toggleFilterForBlock(world, block, typeId) {
  try {
    if (!typeId) return null;
    const key = keyFromBlock(block);
    if (!key) return null;

    ensureLoaded(world);

    let set = _setsCache.get(key);
    if (!set) {
      const arr = normalizeArray(_filtersCache[key]);
      set = new Set(arr);
    }

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
      _setsCache.set(key, set);
    }

    persist(world);
    return { added, removed, size: set.size };
  } catch {
    return null;
  }
}

export function clearFilterForBlock(world, block) {
  try {
    const key = keyFromBlock(block);
    if (!key) return false;
    ensureLoaded(world);
    if (!_filtersCache[key]) return false;
    delete _filtersCache[key];
    _setsCache.delete(key);
    persist(world);
    return true;
  } catch {
    return false;
  }
}

