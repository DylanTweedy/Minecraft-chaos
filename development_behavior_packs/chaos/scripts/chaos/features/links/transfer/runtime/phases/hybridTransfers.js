// scripts/chaos/features/links/transfer/runtime/phases/hybridTransfers.js

import { ok, phaseStep } from "../../util/result.js";
import {
  createHybridJobId,
  createHybridJob,
  refreshHybridJobForNextHop,
} from "../hybrid/jobFactory.js";
import { pickDriftNeighbor } from "../hybrid/routing.js";
import { noteHybridActivity } from "../../../../../core/insight/transferStats.js";

export function createHybridTransfersPhase(deps) {
  const {
    cfg = {},
    inflightProcessorManager,
    inflight,
    fluxFxInflight,
    cacheManager,
    linkGraph,
    getPrismKeys,
    resolveBlockInfo,
    getPrismTier,
    getFilterForBlock,
    getFilterSet,
    getAllAdjacentInventories,
    getRandomItemFromInventories,
    decrementInputSlotSafe,
    tryInsertAmount,
    dropItemAt,
    pendingCooldowns,
    scheduler,
    setInflightDirty,
    setInflightStepDirty,
    getNowTick,
    emitTrace,
  } = deps || {};

  const driftAmountByTier = Array.isArray(cfg?.hybridDriftAmountByTier)
    ? cfg.hybridDriftAmountByTier
    : [1, 2, 4, 16, 64];
  const driftIntervalByTier = Array.isArray(cfg?.hybridDriftIntervalByTier)
    ? cfg.hybridDriftIntervalByTier
    : [20, 15, 10, 7, 5];
  let prismCursor = 0;

  const prismNextAllowedTick = new Map();
  const hybridInsightStats = {
    spawned: 0,
    cooldown: 0,
    caps: 0,
    noPath: 0,
    invalid: 0,
  };

  function getDriftAmountForTier(tier) {
    const index = Math.max(0, Math.min(driftAmountByTier.length - 1, (tier | 0) - 1));
    return Math.max(1, Number(driftAmountByTier[index]) || 1);
  }

  function getDriftIntervalForTier(tier) {
    const index = Math.max(0, Math.min(driftIntervalByTier.length - 1, (tier | 0) - 1));
    return Math.max(1, Number(driftIntervalByTier[index]) || 5);
  }

  function recordHybridStat(stat) {
    if (hybridInsightStats && Number.isFinite(hybridInsightStats[stat])) {
      hybridInsightStats[stat]++;
    }
  }

  function resetHybridInsightStats() {
    hybridInsightStats.spawned = 0;
    hybridInsightStats.cooldown = 0;
    hybridInsightStats.caps = 0;
    hybridInsightStats.noPath = 0;
    hybridInsightStats.invalid = 0;
  }

  function markDirty() {
    if (typeof setInflightDirty === "function") setInflightDirty(true);
    if (typeof setInflightStepDirty === "function") setInflightStepDirty(true);
  }

  function restoreItemPrism(container, typeId, amount, location, dim) {
    if (!container || amount <= 0) return false;
    if (typeof tryInsertAmount === "function") {
      const restored = tryInsertAmount(container, typeId, amount);
      if (restored) return true;
    }
    if (dropItemAt && location && dim) {
      dropItemAt(dim, location, typeId, amount);
      return true;
    }
    return false;
  }

  function spawnJobFromPending(entry, nowTick) {
    const job = entry?.job;
    if (!job || !scheduler?.canSpawnNewTransfer?.(inflight.length)) return false;
    if (job.amount <= 0) {
      pendingCooldowns.delete(job.id);
      return false;
    }
    const targetKey = pickDriftNeighbor(linkGraph, job.currentPrismKey, job.prevPrismKey);
    if (!targetKey) {
      dropItemAt?.(
        resolveBlockInfo?.(job.currentPrismKey)?.dim || null,
        resolveBlockInfo?.(job.currentPrismKey)?.block?.location || null,
        job.itemTypeId,
        job.amount
      );
      pendingCooldowns.delete(job.id);
      return false;
    }
    if (!refreshHybridJobForNextHop(job, targetKey, Math.max(1, Number(cfg?.orbStepTicks) || 16))) {
      pendingCooldowns.delete(job.id);
      return false;
    }
    job.prevPrismKey = job.currentPrismKey;
    job.currentPrismKey = targetKey;
    job.destPrismKey = targetKey;
    job.stepTicks = Math.max(1, Number(cfg?.orbStepTicks) || 16);
    job.ticksUntilStep = 0;
    job.stepIndex = 0;
    childPushJob(job, nowTick);
    pendingCooldowns.delete(job.id);
    return true;
  }

  function childPushJob(job, nowTick) {
    job.createdTick = nowTick;
    job.cooldownTicks = 0;
    if (Array.isArray(inflight)) {
      inflight.push(job);
    }
    recordHybridStat("spawned");
    scheduler?.useNewTransfer?.();
    markDirty();
  }

  function processCooldowns(nowTick) {
    if (!pendingCooldowns || pendingCooldowns.size === 0) return;
    for (const entry of Array.from(pendingCooldowns.values())) {
      entry.cooldownTicks = Math.max(0, (entry.cooldownTicks || 0) - 1);
      if (entry.cooldownTicks > 0) continue;
      if (scheduler && !scheduler.canSpawnNewTransfer(inflight.length)) {
        recordHybridStat("caps");
        break;
      }
      spawnJobFromPending(entry, nowTick);
    }
  }

  function spawnFromPrism(prismKey, nowTick) {
    if (!prismKey || !linkGraph || !cacheManager || !getRandomItemFromInventories) {
      recordHybridStat("invalid");
      return "invalid";
    }

    const prismInfo = resolveBlockInfo?.(prismKey);
    const prismBlock = prismInfo?.block;
    const prismDim = prismInfo?.dim;
    if (!prismBlock || !prismDim) {
      recordHybridStat("invalid");
      return "invalid";
    }

    if (scheduler && !scheduler.canSpawnNewTransfer(inflight.length)) {
      recordHybridStat("caps");
      return "caps";
    }

    const tier = typeof getPrismTier === "function" ? getPrismTier(prismBlock) : 1;
    const interval = getDriftIntervalForTier(tier);
    const nextAllowed = prismNextAllowedTick.get(prismKey) || 0;
    if (nowTick < nextAllowed) {
      recordHybridStat("cooldown");
      return "cooldown";
    }

    const inventories = cacheManager.getPrismInventoriesCached?.(prismKey, prismBlock, prismDim) || [];
    if (!inventories.length) {
      recordHybridStat("invalid");
      return "invalid";
    }

    const filterContainer = getFilterForBlock ? getFilterForBlock(prismBlock) : null;
    const filterSet =
      filterContainer && getFilterSet
        ? filterContainer instanceof Set
          ? filterContainer
          : getFilterSet(filterContainer)
        : null;

    const itemSource = getRandomItemFromInventories(inventories, filterSet);
    if (!itemSource) {
      recordHybridStat("invalid");
      return "invalid";
    }
    const stack = itemSource.stack;
    if (!stack || stack.amount <= 0) {
      recordHybridStat("invalid");
      return "invalid";
    }

    const amount = Math.min(getDriftAmountForTier(tier), stack.amount);
    const neighborKey = pickDriftNeighbor(linkGraph, prismKey, null);
    if (!neighborKey) {
      recordHybridStat("noPath");
      return "noPath";
    }

    const job = createHybridJob({
      id: createHybridJobId(),
      itemTypeId: stack.typeId,
      amount,
      dimId: prismDim.id,
      sourcePrismKey: prismKey,
      destPrismKey: neighborKey,
      stepTicks: Math.max(1, Number(cfg?.orbStepTicks) || 16),
      startTick: nowTick,
    });

    if (!job) {
      return "invalid";
    }

    const decremented = decrementInputSlotSafe
      ? decrementInputSlotSafe(itemSource.container, itemSource.slot, stack, amount)
      : false;

    if (!decremented) {
      restoreItemPrism(
        itemSource.container,
        stack.typeId,
        amount,
        prismBlock.location,
        prismDim
      );
      if (emitTrace) {
        emitTrace(prismKey, "transfer", {
          text: `[HybridDrift] Failed to decrement for job=${job.id}`,
          category: "hybrid",
          dedupeKey: `hybrid_decrement_${job.id}`,
        });
      }
      return "invalid";
    }

    job.prevPrismKey = prismKey;
    job.currentPrismKey = prismKey;
    job.destPrismKey = neighborKey;
    childPushJob(job, nowTick);
    prismNextAllowedTick.set(prismKey, nowTick + interval);

    return "ok";
  }

  function emitHybridSummary(nowTick) {
    if (!emitTrace) return;
    // One line per ~2s (40 ticks) to avoid chat spam.
    if ((nowTick % 40) !== 0) return;
    const total =
      hybridInsightStats.spawned +
      hybridInsightStats.cooldown +
      hybridInsightStats.caps +
      hybridInsightStats.noPath +
      hybridInsightStats.invalid;
    if (total <= 0) return;

    const parts = [];
    if (hybridInsightStats.spawned) parts.push(`spawn ${hybridInsightStats.spawned}`);
    if (hybridInsightStats.cooldown) parts.push(`cool ${hybridInsightStats.cooldown}`);
    if (hybridInsightStats.caps) parts.push(`cap ${hybridInsightStats.caps}`);
    if (hybridInsightStats.noPath) parts.push(`noPath ${hybridInsightStats.noPath}`);
    if (hybridInsightStats.invalid) parts.push(`invalid ${hybridInsightStats.invalid}`);

    emitTrace(null, "hybrid", {
      text: `[HybridDrift] ${parts.join(" | ")}`,
      category: "hybrid",
      // Dedupe per window so it updates instead of stacking.
      dedupeKey: `hybrid_summary_${Math.floor(nowTick / 40)}`,
    });

    resetHybridInsightStats();
  }

  function spawnNewTransfers(nowTick) {
    if (!scheduler || !getPrismKeys) return;
    const prismKeys = getPrismKeys() || [];
    if (!prismKeys.length) return;

    const maxAttempts = prismKeys.length;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const idx = prismCursor % prismKeys.length;
      const prismKey = prismKeys[idx];
      prismCursor = (prismCursor + 1) % prismKeys.length;
      attempts++;
      const result = spawnFromPrism(prismKey, nowTick);
      if (result === "ok") {
        continue;
      }
      if (result === "caps") {
        break;
      }
    }
  }

  function run(ctx) {
    phaseStep(ctx, "hybridTransfers");
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    scheduler?.beginTick?.();
    inflightProcessorManager?.tickInFlight?.(inflight, nowTick);
    inflightProcessorManager?.tickFluxFxInFlight?.(fluxFxInflight, null);
    markDirty();
    processCooldowns(nowTick);
    spawnNewTransfers(nowTick);
    noteHybridActivity({
      inflight: Array.isArray(inflight) ? inflight.length : 0,
      spawned: hybridInsightStats.spawned,
      cooldown: hybridInsightStats.cooldown,
      caps: hybridInsightStats.caps,
      noPath: hybridInsightStats.noPath,
    });
    emitHybridSummary(nowTick);
    return ok();
  }

  return {
    name: "hybridTransfers",
    run,
  };
}
