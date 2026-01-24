// scripts/chaos/features/logistics/phases/04_destinationResolve/resolveAttuned.js
import { findPathBetweenKeys, pickRandom } from "../../util/routing.js";
import { getContainerKey } from "../../keys.js";
import { emitPrismReason } from "../../util/insightReasons.js";
import { emitTrace } from "../../../../core/insight/trace.js";
import { bumpCounter } from "../../util/insightCounters.js";
import { ReasonCodes } from "../../util/insightReasonCodes.js";

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
      ReasonCodes.RESOLVE_NO_ATTUNED,
      `Resolve: none (no attuned prisms for ${intent.itemTypeId})`,
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_no_attuned");
    return null;
  }

  const maxAttempts = Math.min(candidates.length, Math.max(1, Number(ctx.cfg.maxResolveCandidates) || 6));
  const pool = candidates.slice();
  let hasCapacityCandidate = false;
  let hasPathAttempt = false;
  let sameContainerSkipped = 0;
  let examined = 0;

  for (let i = 0; i < maxAttempts && pool.length > 0; i++) {
    const candidate = pickRandom(pool);
    if (!candidate || candidate === intent.sourcePrismKey) continue;
    const idx = pool.indexOf(candidate);
    if (idx >= 0) pool.splice(idx, 1);
    examined++;

    const info = resolveBlockInfo(candidate);
    const block = info?.block;
    const dim = info?.dim;
    if (!block || !dim) continue;

    const inventories = cacheManager.getPrismInventoriesCached(candidate, block, dim);
    if (!Array.isArray(inventories) || inventories.length === 0) continue;

    let hasCapacity = false;
    let selectedContainerKey = null;
    let rejectInfo = null;
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
      if (!rejectInfo) {
        rejectInfo = { candidate, containerKey, capacity: capacity | 0, itemTypeId: intent.itemTypeId };
      }
      if (capacity > 0) {
        hasCapacity = true;
        selectedContainerKey = containerKey;
        break;
      }
      if (ctx.cfg?.debugOrbLifecycleTrace && typeof emitTrace === "function" && capacity <= 0) {
        let emptySlots = 0;
        try {
          const size = inv.container.size || 0;
          for (let i = 0; i < size; i++) {
            if (!inv.container.getItem(i)) emptySlots++;
          }
        } catch {}
        if (emptySlots > 0) {
          emitTrace(null, "transfer", {
            text: `[Transfer] Resolve reject: full candidate=${candidate} container=${containerKey} cap=${capacity} item=${intent.itemTypeId}`,
            category: "transfer",
            dedupeKey: `transfer_resolve_full_${intent.sourcePrismKey}_${candidate}_${containerKey}_${intent.itemTypeId}`,
          });
        }
      }
    }
    if (!hasNonSourceContainer) {
      sameContainerSkipped++;
      continue;
    }
    if (!hasCapacity) {
      if (ctx.cfg?.debugOrbLifecycleTrace && rejectInfo && typeof emitTrace === "function") {
        emitTrace(null, "transfer", {
          text: `[Transfer] Resolve reject: full candidate=${rejectInfo.candidate} container=${rejectInfo.containerKey} cap=${rejectInfo.capacity} item=${rejectInfo.itemTypeId}`,
          category: "transfer",
          dedupeKey: `transfer_resolve_full_${intent.sourcePrismKey}_${rejectInfo.candidate}_${rejectInfo.containerKey}_${rejectInfo.itemTypeId}`,
        });
      }
      continue;
    }
    hasCapacityCandidate = true;

    const path = findPathBetweenKeys(linkGraph, intent.sourcePrismKey, candidate, ctx.cfg.maxVisitedPerSearch || 120);
    hasPathAttempt = true;
    if (!path || path.length < 2) continue;

    return { destPrismKey: candidate, path, destContainerKey: selectedContainerKey };
  }

  if (sameContainerSkipped > 0 && sameContainerSkipped === examined) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_SAME_CONTAINER,
      "Resolve: none (destination shares source container)",
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_same_container");
    return null;
  }

  if (!hasCapacityCandidate) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_ATTUNED_FULL,
      `Resolve: none (all attuned destinations full for ${intent.itemTypeId})`,
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_attuned_full");
    return null;
  }

  if (hasPathAttempt) {
    emitPrismReason(
      ctx,
      intent.sourcePrismKey,
      ReasonCodes.RESOLVE_ATTUNED_NO_PATH,
      "Resolve: none (no path to attuned destination)",
      { itemTypeId: intent.itemTypeId }
    );
    bumpCounter(ctx, "resolve_none_attuned_no_path");
  }

  return null;
}

