// scripts/chaos/features/logistics/systems/filterIndex.js

// Index of prism filters: itemTypeId -> Set(prismKey)
// Rebuilt on a timer or when marked dirty.

export function createFilterIndexManager(deps = {}) {
  const {
    world,
    resolvePrismKeysFromWorld,
    resolveBlockInfo,
    getFilterSetForBlock,
    isPrismBlock,
  } = deps;

  const index = new Map();
  let lastRebuildTick = -999999;
  let dirty = true;

  function clear() {
    index.clear();
  }

  function markDirty() {
    dirty = true;
  }

  function add(prismKey, filterSet) {
    if (!prismKey || !(filterSet instanceof Set) || filterSet.size === 0) return;
    for (const typeId of filterSet) {
      if (typeof typeId !== "string" || typeId.length === 0) continue;
      let set = index.get(typeId);
      if (!set) {
        set = new Set();
        index.set(typeId, set);
      }
      set.add(prismKey);
    }
  }

  function rebuild(nowTick = 0, opts = {}) {
    const interval = Math.max(1, Number(opts.intervalTicks) || 80);
    if (!dirty && (nowTick - lastRebuildTick) < interval) return false;

    clear();

    const prismKeys = (typeof resolvePrismKeysFromWorld === "function")
      ? resolvePrismKeysFromWorld()
      : null;

    if (!Array.isArray(prismKeys) || prismKeys.length === 0) {
      lastRebuildTick = nowTick;
      dirty = false;
      return true;
    }

    for (const prismKey of prismKeys) {
      const info = (typeof resolveBlockInfo === "function") ? resolveBlockInfo(prismKey) : null;
      const block = info?.block;
      if (!block) continue;
      if (typeof isPrismBlock === "function" && !isPrismBlock(block)) continue;
      const set = (typeof getFilterSetForBlock === "function") ? getFilterSetForBlock(world, block) : null;
      if (set instanceof Set && set.size > 0) {
        add(prismKey, set);
      }
    }

    lastRebuildTick = nowTick;
    dirty = false;
    return true;
  }

  function hasAnyFor(typeId) {
    const set = index.get(typeId);
    return !!(set && set.size > 0);
  }

  function getCandidates(typeId) {
    const set = index.get(typeId);
    if (!set || set.size === 0) return null;
    return Array.from(set);
  }

  return {
    rebuild,
    markDirty,
    hasAnyFor,
    getCandidates,
    _index: index,
  };
}


