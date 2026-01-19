// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveAttuned.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { getContainerKey } from "../../keys.js";

export function resolveAttuned(ctx, intent) {
  const filterIndex = ctx.indexes?.filterIndex;
  const linkGraph = ctx.services?.linkGraph;
  const cacheManager = ctx.services?.cacheManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;

  if (!filterIndex || !linkGraph || !cacheManager || !resolveBlockInfo) return null;

  const candidates = filterIndex.getCandidates(intent.itemTypeId) || [];
  if (candidates.length === 0) return null;

  const maxAttempts = Math.min(candidates.length, Math.max(1, Number(ctx.cfg.maxResolveCandidates) || 6));
  const shuffled = candidates.slice();

  for (let i = 0; i < maxAttempts; i++) {
    const candidate = pickRandom(shuffled);
    if (!candidate || candidate === intent.sourcePrismKey) continue;

    const info = resolveBlockInfo(candidate);
    const block = info?.block;
    const dim = info?.dim;
    if (!block || !dim) continue;

    const inventories = cacheManager.getPrismInventoriesCached(candidate, block, dim);
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
    if (!hasCapacity) continue;

    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate, ctx.cfg.maxVisitedPerSearch || 120);
    if (!path || path.length < 2) continue;

    return { destPrismKey: candidate, path };
  }

  return null;
}

