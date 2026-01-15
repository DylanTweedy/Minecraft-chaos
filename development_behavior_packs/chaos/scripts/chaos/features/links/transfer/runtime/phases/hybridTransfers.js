// scripts/chaos/features/links/transfer/runtime/phases/hybridTransfers.js

import { ok, phaseStep } from "../helpers/result.js";
import {
  createHybridJobId,
  createHybridJob,
  refreshHybridJobForNextHop,
} from "../hybrid/jobFactory.js";
import { pickDriftNeighbor } from "../hybrid/routing.js";

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
  } = deps || {};

  const driftMaxAmount = Math.max(1, Number(cfg?.driftMaxTransferAmount) || 4);
  let prismCursor = 0;

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
    scheduler?.useNewTransfer?.();
    markDirty();
  }

  function processCooldowns(nowTick) {
    if (!pendingCooldowns || pendingCooldowns.size === 0) return;
    for (const entry of Array.from(pendingCooldowns.values())) {
      entry.cooldownTicks = Math.max(0, (entry.cooldownTicks || 0) - 1);
      if (entry.cooldownTicks > 0) continue;
      if (scheduler && !scheduler.canSpawnNewTransfer(inflight.length)) break;
      spawnJobFromPending(entry, nowTick);
    }
  }

  function spawnFromPrism(prismKey, nowTick) {
    if (!prismKey || !linkGraph || !cacheManager || !getRandomItemFromInventories) return false;

    const prismInfo = resolveBlockInfo?.(prismKey);
    const prismBlock = prismInfo?.block;
    const prismDim = prismInfo?.dim;
    if (!prismBlock || !prismDim) return false;

    const inventories = cacheManager.getPrismInventoriesCached?.(prismKey, prismBlock, prismDim) || [];
    if (!inventories.length) return false;

    const filterContainer = getFilterForBlock ? getFilterForBlock(prismBlock) : null;
    const filterSet =
      filterContainer && getFilterSet
        ? filterContainer instanceof Set
          ? filterContainer
          : getFilterSet(filterContainer)
        : null;

    const itemSource = getRandomItemFromInventories(inventories, filterSet);
    if (!itemSource) return false;
    const stack = itemSource.stack;
    if (!stack || stack.amount <= 0) return false;

    const amount = Math.min(driftMaxAmount, stack.amount);
    const neighborKey = pickDriftNeighbor(linkGraph, prismKey, null);
    if (!neighborKey) return false;

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

    if (!job) return false;

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
      return false;
    }

    job.prevPrismKey = prismKey;
    job.currentPrismKey = prismKey;
    job.destPrismKey = neighborKey;
    childPushJob(job, nowTick);

    return true;
  }

  function spawnNewTransfers(nowTick) {
    if (!scheduler || !getPrismKeys) return;
    const prismKeys = getPrismKeys() || [];
    if (!prismKeys.length) return;

    const maxAttempts = prismKeys.length;
    let attempts = 0;

    while (scheduler.canSpawnNewTransfer(inflight.length) && attempts < maxAttempts) {
      const idx = prismCursor % prismKeys.length;
      const prismKey = prismKeys[idx];
      prismCursor = (prismCursor + 1) % prismKeys.length;
      attempts++;
      if (spawnFromPrism(prismKey, nowTick)) {
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
    return ok();
  }

  return {
    name: "hybridTransfers",
    run,
  };
}
