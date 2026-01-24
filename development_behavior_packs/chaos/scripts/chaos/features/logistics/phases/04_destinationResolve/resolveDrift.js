// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveDrift.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { getContainerKey } from "../../keys.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";

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
  let sameContainerSkipped = 0;
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
    let selectedContainerKey = null;
    let hasNonSourceContainer = false;
    for (const inv of inventories) {
      if (!inv?.container) continue;
      const containerKey = getContainerKey(inv.entity || inv.block, inv.dim || dim);
      if (!containerKey) continue;
      if (containerKey !== intent.containerKey) {
        hasNonSourceContainer = true;
      }
      const capacity = cacheManager.getInsertCapacityCached(
        containerKey,
        inv.container,
        intent.itemTypeId,
        { typeId: intent.itemTypeId, amount: intent.count }
      );
      if (capacity > 0) {
        hasCapacity = true;
        selectedContainerKey = containerKey;
        break;
      }
    }
    if (!hasNonSourceContainer) {
      sameContainerSkipped++;
      continue;
    }
    if (!hasCapacity) {
      noCapacitySkipped++;
      continue;
    }
    candidates.push({ prismKey, destContainerKey: selectedContainerKey });
  }

  if (candidates.length === 0) {
    const remaining = totalOtherPrisms - filteredSkipped;
    if (remaining <= 0) {
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.RESOLVE_DRIFT_ALL_FILTERED,
        "Drift: none (all other prisms are filtered/attuned)"
      );
      bumpCounter(ctx, "resolve_none_drift_all_filtered");
      return null;
    }
    if (noInventorySkipped >= remaining) {
      emitPrismReason(
        ctx,
        intent.sourcePrismKey,
        ReasonCodes.RESOLVE_DRIFT_NO_INVENTORIES,
        "Drift: none (no destination inventories found)"
      );
      bumpCounter(ctx, "resolve_none_drift_no_inventories");
      return null;
    }
    const fullSuffix =
      noCapacitySkipped > 0
        ? ` (${noCapacitySkipped} sink${noCapacitySkipped === 1 ? "" : "s"} full)`
        : "";
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_DRIFT_ALL_FULL,
      `Drift: none (all destinations full for ${intent.itemTypeId})${fullSuffix}`,
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_drift_full");
    return null;
  }

  let pathAttempted = false;
  const pool = candidates.slice();
  for (let i = 0; i < candidates.length && pool.length > 0; i++) {
    const candidate = pickRandom(pool);
    if (!candidate) continue;
    const idx = pool.indexOf(candidate);
    if (idx >= 0) pool.splice(idx, 1);
    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate.prismKey, ctx.cfg.maxVisitedPerSearch || 120);
    pathAttempted = true;
    if (!path || path.length < 2) continue;
    return { destPrismKey: candidate.prismKey, path, destContainerKey: candidate.destContainerKey };
  }

  if (pathAttempted) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_DRIFT_NO_PATH,
      "Drift: none (no path to any drift sink)",
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_drift_no_path");
  }

  if (sameContainerSkipped > 0 && candidates.length === 0) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_SAME_CONTAINER,
      "Drift: none (destination shares source container)",
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_same_container");
  }

  return null;
}

