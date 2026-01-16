// scripts/chaos/features/links/transfer/runtime/phases/hybridTransfers.js

import { ok, phaseStep } from "../helpers/result.js";
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

    getRandomItemFromInventories,
    decrementInputSlotSafe,
    tryInsertAmount,
    dropItemAt,

    pendingCooldowns,
    scheduler,

    emitTrace,

    setInflightDirty,
    setInflightStepDirty,

    getNowTick,
  } = deps || {};

  // Tier pacing tables (tier 1..5 -> index 0..4)
  const driftAmountByTier = Array.isArray(cfg?.hybridDriftAmountByTier)
    ? cfg.hybridDriftAmountByTier
    : [1, 2, 4, 16, 64];

  const driftIntervalByTier = Array.isArray(cfg?.hybridDriftIntervalByTier)
    ? cfg.hybridDriftIntervalByTier
    : [20, 15, 10, 7, 5];

  let prismCursor = 0;

  // Per-prism throttle
  const prismNextAllowedTick = new Map();
  const prismThrottleLogTick = new Map();

  // Insight counters for this tick
  const hybridInsightStats = {
    spawned: 0,
    cooldown: 0,
    caps: 0,
    noPath: 0,
  };

  function clampTierIndex(tier) {
    const t = Number(tier);
    const idx = (Number.isFinite(t) ? (t | 0) : 1) - 1;
    return Math.max(0, Math.min(4, idx));
  }

  function getDriftAmountForTier(tier) {
    const idx = clampTierIndex(tier);
    return Math.max(1, Number(driftAmountByTier[idx]) || 1);
  }

  function getDriftIntervalForTier(tier) {
    const idx = clampTierIndex(tier);
    return Math.max(1, Number(driftIntervalByTier[idx]) || 5);
  }

  function recordHybridStat(key) {
    if (hybridInsightStats && Object.prototype.hasOwnProperty.call(hybridInsightStats, key)) {
      hybridInsightStats[key]++;
    }
  }

  function resetHybridInsightStats() {
    hybridInsightStats.spawned = 0;
    hybridInsightStats.cooldown = 0;
    hybridInsightStats.caps = 0;
    hybridInsightStats.noPath = 0;
  }

  function markDirty() {
    if (typeof setInflightDirty === "function") setInflightDirty(true);
    if (typeof setInflightStepDirty === "function") setInflightStepDirty(true);
  }

  function logPrismThrottle(prismKey, nextTick, interval, nowTick) {
    if (typeof emitTrace !== "function" || !prismKey) return;

    const window = Math.max(1, Math.floor(interval || 1));
    const lastLogged = prismThrottleLogTick.get(prismKey) || -Infinity;
    if (nowTick < lastLogged + window) return;

    prismThrottleLogTick.set(prismKey, nowTick);
    emitTrace(null, "hybrid", {
      text: `[HybridDrift] ${prismKey} throttled until tick ${nextTick}`,
      category: "hybrid",
      dedupeKey: `hybrid_throttle_${prismKey}`,
    });
  }

  function restoreItemOrDrop(container, typeId, amount, location, dim) {
    if (!container || amount <= 0) return false;

    try {
      if (typeof tryInsertAmount === "function") {
        const restored = tryInsertAmount(container, typeId, amount);
        if (restored) return true;
      }
    } catch {
      // ignore
    }

    if (typeof dropItemAt === "function" && location && dim) {
      dropItemAt(dim, location, typeId, amount);
      return true;
    }

    return false;
  }

  function pushInflightJob(job, nowTick) {
    job.createdTick = nowTick;
    job.cooldownTicks = 0;

    if (Array.isArray(inflight)) inflight.push(job);

    recordHybridStat("spawned");
    scheduler?.useNewTransfer?.();
    markDirty();
  }

  function spawnJobFromPending(entry, nowTick) {
    const job = entry?.job;
    if (!job) return false;

    if (job.amount <= 0) {
      pendingCooldowns?.delete?.(job.id);
      return false;
    }

    if (scheduler && !scheduler.canSpawnNewTransfer(inflight?.length || 0)) {
      recordHybridStat("caps");
      return false;
    }

    const targetKey = pickDriftNeighbor(linkGraph, job.currentPrismKey, job.prevPrismKey);
    if (!targetKey) {
      const info = resolveBlockInfo?.(job.currentPrismKey);
      dropItemAt?.(info?.dim || null, info?.block?.location || null, job.itemTypeId, job.amount);
      pendingCooldowns?.delete?.(job.id);
      return false;
    }

    const stepTicks = Math.max(1, Number(cfg?.orbStepTicks) || 16);
    if (!refreshHybridJobForNextHop(job, targetKey, stepTicks)) {
      pendingCooldowns?.delete?.(job.id);
      return false;
    }

    job.prevPrismKey = job.currentPrismKey;
    job.currentPrismKey = targetKey;
    job.destPrismKey = targetKey;
    job.stepTicks = stepTicks;
    job.ticksUntilStep = 0;
    job.stepIndex = 0;

    pushInflightJob(job, nowTick);
    pendingCooldowns?.delete?.(job.id);
    return true;
  }

  function processCooldowns(nowTick) {
    if (!pendingCooldowns || pendingCooldowns.size === 0) return;

    for (const entry of Array.from(pendingCooldowns.values())) {
      entry.cooldownTicks = Math.max(0, (entry.cooldownTicks || 0) - 1);
      if (entry.cooldownTicks > 0) continue;

      // Respect global caps: if we hit it, stop for this tick.
      if (scheduler && !scheduler.canSpawnNewTransfer(inflight?.length || 0)) {
        recordHybridStat("caps");
        break;
      }

      spawnJobFromPending(entry, nowTick);
    }
  }

  function spawnFromPrism(prismKey, nowTick) {
    if (!prismKey || !linkGraph || !cacheManager || !getRandomItemFromInventories) return "invalid";

    const prismInfo = resolveBlockInfo?.(prismKey);
    const prismBlock = prismInfo?.block;
    const prismDim = prismInfo?.dim;
    if (!prismBlock || !prismDim) return "invalid";

    if (scheduler && !scheduler.canSpawnNewTransfer(inflight?.length || 0)) {
      recordHybridStat("caps");
      return "caps";
    }

    const tier = typeof getPrismTier === "function" ? getPrismTier(prismBlock) : 1;
    const interval = getDriftIntervalForTier(tier);

    const nextAllowed = prismNextAllowedTick.get(prismKey) || 0;
    if (nowTick < nextAllowed) {
      recordHybridStat("cooldown");
      logPrismThrottle(prismKey, nextAllowed, interval, nowTick);
      return "cooldown";
    }

    const inventories =
      cacheManager.getPrismInventoriesCached?.(prismKey, prismBlock, prismDim) || [];
    if (!inventories.length) return "invalid";

    // If the prism has a filter, only drift filtered items.
    const filterContainer = typeof getFilterForBlock === "function" ? getFilterForBlock(prismBlock) : null;
    const filterSet =
      filterContainer && typeof getFilterSet === "function"
        ? filterContainer instanceof Set
          ? filterContainer
          : getFilterSet(filterContainer)
        : null;

    const itemSource = getRandomItemFromInventories(inventories, filterSet);
    if (!itemSource?.stack) return "invalid";

    const stack = itemSource.stack;
    if (stack.amount <= 0) return "invalid";

    const amount = Math.min(getDriftAmountForTier(tier), stack.amount);

    const neighborKey = pickDriftNeighbor(linkGraph, prismKey, null);
    if (!neighborKey) {
      recordHybridStat("noPath");
      return "noPath";
    }

    const stepTicks = Math.max(1, Number(cfg?.orbStepTicks) || 16);

    const job = createHybridJob({
      id: createHybridJobId(),
      itemTypeId: stack.typeId,
      amount,
      dimId: prismDim.id,
      sourcePrismKey: prismKey,
      destPrismKey: neighborKey,
      stepTicks,
      startTick: nowTick,
    });

    if (!job) return "invalid";

    const decremented = typeof decrementInputSlotSafe === "function"
      ? decrementInputSlotSafe(itemSource.container, itemSource.slot, stack, amount)
      : false;

    if (!decremented) {
      restoreItemOrDrop(itemSource.container, stack.typeId, amount, prismBlock.location, prismDim);
      emitTrace?.(prismKey, "transfer", {
        text: `[HybridDrift] Failed to decrement for job=${job.id}`,
        category: "hybrid",
        dedupeKey: `hybrid_decrement_${job.id}`,
      });
      return "invalid";
    }

    job.prevPrismKey = prismKey;
    job.currentPrismKey = prismKey;
    job.destPrismKey = neighborKey;

    pushInflightJob(job, nowTick);
    prismNextAllowedTick.set(prismKey, nowTick + interval);

    return "ok";
  }

  function spawnNewTransfers(nowTick) {
    if (!scheduler || typeof getPrismKeys !== "function") return;

    const prismKeys = getPrismKeys() || [];
    if (!prismKeys.length) return;

    // Round-robin attempt; respect global caps.
    const maxAttempts = prismKeys.length;
    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      const idx = prismCursor % prismKeys.length;
      const prismKey = prismKeys[idx];
      prismCursor = (prismCursor + 1) % prismKeys.length;

      const result = spawnFromPrism(prismKey, nowTick);
      if (result === "caps") break;
    }
  }

  function run(ctx) {
    phaseStep(ctx, "hybridTransfers");

    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;

    resetHybridInsightStats();
    scheduler?.beginTick?.();

    inflightProcessorManager?.tickInFlight?.(inflight, nowTick);
    inflightProcessorManager?.tickFluxFxInFlight?.(fluxFxInflight, null);

    markDirty();

    processCooldowns(nowTick);
    spawnNewTransfers(nowTick);

    // Insight line
    try {
      noteHybridActivity?.({
        inflight: Array.isArray(inflight) ? inflight.length : 0,
        spawned: hybridInsightStats.spawned,
        cooldown: hybridInsightStats.cooldown,
        caps: hybridInsightStats.caps,
        noPath: hybridInsightStats.noPath,
      });
    } catch {
      // ignore
    }

    return ok();
  }

  return {
    name: "hybridTransfers",
    run,
  };
}
