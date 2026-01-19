// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveDrift.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { getContainerKey } from "../../keys.js";

export function resolveDrift(ctx, intent) {
  const linkGraph = ctx.services?.linkGraph;
  const cacheManager = ctx.services?.cacheManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;
  const getFilterSetForBlock = ctx.services?.getFilterSetForBlock;
  const prismKeys = Array.isArray(ctx.prismKeys) ? ctx.prismKeys : [];

  if (!linkGraph || !cacheManager || !resolveBlockInfo) return null;

  const candidates = [];
  for (const prismKey of prismKeys) {
    if (!prismKey || prismKey === intent.sourcePrismKey) continue;
    const info = resolveBlockInfo(prismKey);
    const block = info?.block;
    const dim = info?.dim;
    if (!block || !dim) continue;
    const filterSet = getFilterSetForBlock ? getFilterSetForBlock(ctx.world, block) : null;
    if (filterSet && filterSet.size > 0) continue; // drift sinks must be unfiltered

    const inventories = cacheManager.getPrismInventoriesCached(prismKey, block, dim);
    if (!Array.isArray(inventories) || inventories.length === 0) continue;

    let hasCapacity = false;
    for (const inv of inventories) {
      if (!inv?.container) continue;
      const containerKey = getContainerKey(inv.entity || inv.block, inv.dim || dim);
      if (!containerKey) continue;
      const capacity = cacheManager.getInsertCapacityCached(
        containerKey,
        inv.container,
        intent.itemTypeId,
        { typeId: intent.itemTypeId, amount: intent.count }
      );
      if (capacity > 0) {
        hasCapacity = true;
        break;
      }
    }
    if (hasCapacity) candidates.push(prismKey);
  }

  if (candidates.length === 0) return null;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = pickRandom(candidates);
    if (!candidate) continue;
    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate, ctx.cfg.maxVisitedPerSearch || 120);
    if (!path || path.length < 2) continue;
    return { destPrismKey: candidate, path };
  }

  return null;
}

