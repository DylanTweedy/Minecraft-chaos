// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveAttuned.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { getContainerKey } from "../../keys.js";
import { emitPrismReason } from "../../util/insightReasons.js";

export function resolveAttuned(ctx, intent) {
  const filterIndex = ctx.indexes?.filterIndex;
  const linkGraph = ctx.services?.linkGraph;
  const cacheManager = ctx.services?.cacheManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;

  if (!filterIndex || !linkGraph || !cacheManager || !resolveBlockInfo) return null;

  const candidates = filterIndex.getCandidates(intent.itemTypeId) || [];
  if (candidates.length === 0) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      "RESOLVE_NO_ATTUNED",
      `Resolve: none (no attuned prisms for ${intent.itemTypeId})`,
      { itemTypeId: intent.itemTypeId }
    );
    return null;
  }

  const maxAttempts = Math.min(candidates.length, Math.max(1, Number(ctx.cfg.maxResolveCandidates) || 6));
  const shuffled = candidates.slice();
  let hasCapacityCandidate = false;
  let hasPathAttempt = false;

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
    hasCapacityCandidate = true;

    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate, ctx.cfg.maxVisitedPerSearch || 120);
    hasPathAttempt = true;
    if (!path || path.length < 2) continue;

    return { destPrismKey: candidate, path };
  }

  if (!hasCapacityCandidate) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      "RESOLVE_ALL_FULL",
      `Resolve: none (all attuned destinations full for ${intent.itemTypeId})`,
      { itemTypeId: intent.itemTypeId }
    );
    return null;
  }

  if (hasPathAttempt) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      "RESOLVE_NO_PATH",
      "Resolve: none (no path to attuned destination)"
    );
  }

  return null;
}

