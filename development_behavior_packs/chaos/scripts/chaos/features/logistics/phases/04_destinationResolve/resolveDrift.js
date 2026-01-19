// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveDrift.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { getContainerKey } from "../../keys.js";
import { emitPrismReason } from "../../util/insightReasons.js";

export function resolveDrift(ctx, intent) {
  const linkGraph = ctx.services?.linkGraph;
  const cacheManager = ctx.services?.cacheManager;
  const resolveBlockInfo = ctx.services?.resolveBlockInfo;
  const getFilterSetForBlock = ctx.services?.getFilterSetForBlock;
  const prismKeys = Array.isArray(ctx.prismKeys) ? ctx.prismKeys : [];

  if (!linkGraph || !cacheManager || !resolveBlockInfo) return null;

  let totalOtherPrisms = 0;
  let filteredSkipped = 0;
  let noInventorySkipped = 0;
  let noCapacitySkipped = 0;
  const candidates = [];
  for (const prismKey of prismKeys) {
    if (!prismKey || prismKey === intent.sourcePrismKey) continue;
    const info = resolveBlockInfo(prismKey);
    const block = info?.block;
    const dim = info?.dim;
    if (!block || !dim) continue;
    totalOtherPrisms++;
    const filterSet = getFilterSetForBlock ? getFilterSetForBlock(ctx.world, block) : null;
    if (filterSet && filterSet.size > 0) {
      filteredSkipped++;
      continue;
    } // drift sinks must be unfiltered

    const inventories = cacheManager.getPrismInventoriesCached(prismKey, block, dim);
    if (!Array.isArray(inventories) || inventories.length === 0) {
      noInventorySkipped++;
      continue;
    }

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
    if (!hasCapacity) {
      noCapacitySkipped++;
      continue;
    }
    candidates.push(prismKey);
  }

  if (candidates.length === 0) {
    const remaining = totalOtherPrisms - filteredSkipped;
    if (remaining <= 0) {
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        "RESOLVE_DRIFT_ALL_FILTERED",
        "Drift: none (all other prisms are filtered/attuned)"
      );
      return null;
    }
    if (noInventorySkipped >= remaining) {
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        "RESOLVE_DRIFT_NO_INVENTORIES",
        "Drift: none (no destination inventories found)"
      );
      return null;
    }
    const fullSuffix =
      noCapacitySkipped > 0
        ? ` (${noCapacitySkipped} sink${noCapacitySkipped === 1 ? "" : "s"} full)`
        : "";
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      "RESOLVE_DRIFT_ALL_FULL",
      `Drift: none (all destinations full for ${intent.itemTypeId})${fullSuffix}`,
      { itemTypeId: intent.itemTypeId }
    );
    return null;
  }

  let pathAttempted = false;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = pickRandom(candidates);
    if (!candidate) continue;
    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate, ctx.cfg.maxVisitedPerSearch || 120);
    pathAttempted = true;
    if (!path || path.length < 2) continue;
    return { destPrismKey: candidate, path };
  }

  if (pathAttempted) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      "RESOLVE_DRIFT_NO_PATH",
      "Drift: none (no path to any drift sink)"
    );
  }

  return null;
}

