// scripts/chaos/features/links/transfer/runtime/hybrid/arrival.js

import { ItemStack, system } from "@minecraft/server";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function computeSettleChance(cfg = {}, mode = "drift", hops = 0, reroutes = 0) {
  const settings =
    mode === "attuned"
      ? {
          base: Number(cfg?.hybridAttunedSettleBase) || 0.01,
          hopGain: Number(cfg?.hybridAttunedHopGain) || 0.005,
          rerouteGain: Number(cfg?.hybridAttunedRerouteGain) || 0.02,
          max: Number(cfg?.hybridAttunedMaxChance) || 0.6,
        }
      : {
          base: Number(cfg?.hybridDriftSettleBase) || 0.05,
          hopGain: Number(cfg?.hybridDriftHopGain) || 0.02,
          rerouteGain: Number(cfg?.hybridDriftRerouteGain) || 0.05,
          max: Number(cfg?.hybridDriftMaxChance) || 0.95,
        };
  const chance =
    settings.base + hops * settings.hopGain + reroutes * settings.rerouteGain;
  return clamp(chance, 0, settings.max);
}

function computeCooldownTicks(cfg = {}, reroutes = 0) {
  const base = Math.max(1, Number(cfg?.hybridRerouteCooldownBaseTicks) || 10);
  const step = Math.max(0, Number(cfg?.hybridRerouteCooldownStepTicks) || 5);
  const maxTicks = Math.max(base, Number(cfg?.hybridRerouteCooldownMaxTicks) || 60);
  const ticks = Math.min(maxTicks, base + (reroutes | 0) * step);
  return Math.max(0, ticks | 0);
}

function attemptInsertIntoInventories(inventories, typeId, amount, filterSet) {
  if (!Array.isArray(inventories) || inventories.length === 0) {
    return { inserted: 0, remaining: amount };
  }
  if (!typeId || amount <= 0) {
    return { inserted: 0, remaining: amount };
  }
  if (filterSet && filterSet.size > 0 && !filterSet.has(typeId)) {
    return { inserted: 0, remaining: amount, rejected: true };
  }

  let remaining = amount;
  const prototype = new ItemStack(typeId, 1);
  const maxStack = prototype?.maxAmount || 64;

  function tryFillSlot(container, slot, maxAmount) {
    try {
      const existing = container.getItem(slot);
      if (!existing) {
        const insert = Math.min(maxAmount, remaining);
        container.setItem(slot, new ItemStack(typeId, insert));
        remaining -= insert;
        return;
      }
      if (existing.typeId !== typeId) return;
      const space = (existing.maxAmount || maxStack) - existing.amount;
      if (space <= 0) return;
      const insert = Math.min(space, remaining);
      if (insert <= 0) return;
      const clone = existing.clone();
      clone.amount = existing.amount + insert;
      container.setItem(slot, clone);
      remaining -= insert;
    } catch {}
  }

  for (const inv of inventories) {
    if (!inv?.container) continue;
    const size = inv.container.size || 0;
    for (let slot = 0; slot < size && remaining > 0; slot++) {
      tryFillSlot(inv.container, slot, maxStack);
    }
    if (remaining <= 0) break;
  }

  return { inserted: amount - remaining, remaining };
}

export function createHybridArrivalHandler(deps = {}) {
  const {
    cfg = {},
    cacheManager,
    resolveBlockInfo,
    dropItemAt,
    getFilterForBlock,
    getFilterSet,
    pendingCooldowns,
    noteOutputTransfer,
    emitTrace,
  } = deps;

  // Hybrid drift can get chat-spammy when many jobs reroute.
  // Aggregate reroutes per-destination prism and emit a short summary per window.
  const rerouteCountsByPrism = new Map(); // prismKey -> count
  const rerouteLastLogTickByPrism = new Map();
  const rerouteWindowTicks = Math.max(20, Number(cfg?.hybridRerouteLogWindowTicks) || 40);

  function dropRemaining(job, location, dim) {
    if (!dropItemAt || !location || job.amount <= 0) return;
    const dimObj = dim || (location?.dim ? location.dim : null);
    dropItemAt(dimObj, location, job.itemTypeId, job.amount);
    job.amount = 0;
  }

  return function handleHybridArrival(job) {
    if (
      !cfg?.useHybridDriftAttune ||
      !job ||
      job.mode !== "hybrid_drift" ||
      job.amount <= 0 ||
      !pendingCooldowns
    ) {
      return false;
    }

    const destKey = job.destPrismKey || job.currentPrismKey;
    const destInfo = resolveBlockInfo ? resolveBlockInfo(destKey) : null;
    const destBlock = destInfo?.block;
    const destDim = destInfo?.dim;
    const hasPrism =
      destBlock && typeof getFilterForBlock === "function" && typeof getFilterSet === "function";

    const inventories =
      cacheManager && destBlock && destDim
        ? cacheManager.getPrismInventoriesCached(destKey, destBlock, destDim)
        : [];

    const filterContainer = hasPrism ? getFilterForBlock(destBlock) : null;
    const filterSet = filterContainer
      ? filterContainer instanceof Set
        ? filterContainer
        : getFilterSet(filterContainer)
      : null;

    const dropThreshold = Math.max(1, Number(cfg?.hybridRerouteDropThreshold) || 12);
    const hopThreshold = Math.max(1, Number(cfg?.hybridHopDropThreshold) || 40);
    const forced =
      (job.reroutes || 0) >= dropThreshold || (job.hops || 0) >= hopThreshold;

    const chance = forced ? 1 : computeSettleChance(cfg, "drift", job.hops, job.reroutes);
    const shouldAttempt = forced || Math.random() < chance;
    const insertCandidate = shouldAttempt
      ? attemptInsertIntoInventories(inventories, job.itemTypeId, job.amount, filterSet)
      : { inserted: 0, remaining: job.amount };

    const inserted = Math.max(0, insertCandidate.inserted || 0);
    if (inserted > 0) {
      job.amount = Math.max(0, job.amount - inserted);
      if (typeof noteOutputTransfer === "function" && destBlock) {
        noteOutputTransfer(destKey, destBlock);
      }
      if (job.amount <= 0) {
        return true;
      }
    }

    if (forced && job.amount > 0) {
      dropRemaining(job, destBlock?.location || destInfo?.pos || null, destDim);
      return true;
    }

    job.hops = (job.hops || 0) + 1;
    job.reroutes = (job.reroutes || 0) + 1;
    job.prevPrismKey = job.currentPrismKey;
    job.currentPrismKey = destKey;
    job.destPrismKey = null;

    const cooldownTicks = computeCooldownTicks(cfg, job.reroutes);
    pendingCooldowns.set(job.id, { job, cooldownTicks });

    // Aggregate reroutes instead of logging every single job.
    if (typeof emitTrace === "function") {
      const nowTick = Number.isFinite(system?.currentTick) ? system.currentTick : 0;
      const count = (rerouteCountsByPrism.get(destKey) || 0) + 1;
      rerouteCountsByPrism.set(destKey, count);

      const lastLog = rerouteLastLogTickByPrism.get(destKey) || -Infinity;
      if ((nowTick - lastLog) >= rerouteWindowTicks) {
        rerouteLastLogTickByPrism.set(destKey, nowTick);
        const total = rerouteCountsByPrism.get(destKey) || count;
        rerouteCountsByPrism.set(destKey, 0);

        // Keep it short; details belong in deeper debugging, not chat spam.
        emitTrace(destKey, "transfer", {
          text: `[HybridDrift] ${total} reroute(s) (last cooldown=${cooldownTicks})`,
          category: "hybrid",
          dedupeKey: `hybrid_reroute_${destKey}_${nowTick}`,
        });
      }
    }

    return true;
  };
}
