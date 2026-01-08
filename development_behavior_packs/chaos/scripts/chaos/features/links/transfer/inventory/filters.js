// scripts/chaos/features/links/transfer/inventory/filters.js
export function getFilterContainer(block) {
  try {
    if (!block) return null;
    const inv = block.getComponent("minecraft:inventory");
    if (!inv) return null;
    return inv.container || null;
  } catch (_) {
    return null;
  }
}

export function isFilterEmpty(filter) {
  try {
    if (!filter) return true;
    if (filter instanceof Set) return filter.size === 0;
    const size = filter.size;
    for (let i = 0; i < size; i++) {
      const it = filter.getItem(i);
      if (it && it.amount > 0) return false;
    }
    return true;
  } catch (_) {
    return true;
  }
}

export function getFilterSet(filter) {
  try {
    if (!filter) return null;
    if (filter instanceof Set) return filter;
    const size = filter.size;
    const set = new Set();
    for (let i = 0; i < size; i++) {
      const it = filter.getItem(i);
      if (!it || it.amount <= 0) continue;
      set.add(it.typeId);
    }
    return set;
  } catch (_) {
    return null;
  }
}

export function filterAllows(filter, typeId) {
  if (!filter || !typeId) return true;
  if (isFilterEmpty(filter)) return true;
  const set = getFilterSet(filter);
  if (!set || set.size === 0) return true;
  return set.has(typeId);
}

export function filterOutputsByWhitelist(options, typeId, resolveBlockInfo, getFilterForBlock, ids) {
  try {
    if (!options || options.length === 0) return [];
    if (typeof resolveBlockInfo !== "function") return options;
    const prioritized = [];
    const allowAll = [];
    for (const opt of options) {
      if (!opt || !opt.outputKey) continue;
      const outInfo = resolveBlockInfo(opt.outputKey);
      if (!outInfo || !outInfo.block) continue;
      if (outInfo.block.typeId === ids.CRYSTALLIZER_ID) {
        allowAll.push(opt);
        continue;
      }
      // Target prisms (unified system)
      if (!ids.isPrismBlock(outInfo.block)) continue;
      const filter = (typeof getFilterForBlock === "function")
        ? getFilterForBlock(outInfo.block)
        : getFilterContainer(outInfo.block);
      if (!filterAllows(filter, typeId)) continue;
      if (filter && !isFilterEmpty(filter)) prioritized.push(opt);
      else allowAll.push(opt);
    }
    return (prioritized.length > 0) ? prioritized : allowAll;
  } catch (_) {
    return [];
  }
}
