// scripts/chaos/features/links/transfer/runtime/phases/beginTick.js

import { ok } from "../../util/result.js";

export function createBeginTickPhase(deps) {
  const services = deps?.services || {};
  const cfg = deps?.cfg || services.cfg || {};

  function getService(ctx, name, fallback) {
    return (ctx?.services && ctx.services[name]) || fallback;
  }

  function resetCacheMaps(ctx) {
    const cache = ctx.cache;
    if (!cache) return;
    cache.resolveBlockInfo?.clear?.();
    cache.filterForBlock?.clear?.();
    cache.containerKey?.clear?.();
  }

  return {
    name: "beginTick",
    run(ctx) {
      const cacheManager = getService(ctx, "cacheManager", services.cacheManager);
      const queuesManager = getService(ctx, "queuesManager", services.queuesManager);

      ctx.tickStart = Date.now();

      if (cacheManager && typeof cacheManager.updateTick === "function") {
        cacheManager.updateTick(ctx.nowTick);
      }
      if (cacheManager && typeof cacheManager.resetTickCaches === "function") {
        cacheManager.resetTickCaches();
      }

      resetCacheMaps(ctx);

      if (queuesManager && typeof queuesManager.getState === "function") {
        ctx.setQueueState(queuesManager.getState());
      }

      ctx.budgets = {
        transfers: Math.max(0, cfg?.maxTransfersPerTick | 0),
        searches: Math.max(0, cfg?.maxSearchesPerTick | 0),
        inputTransfers: Math.max(0, cfg?.maxTransfersPerTick | 0),
        inputSearches: Math.max(0, cfg?.maxSearchesPerTick | 0),
      };

      ctx.perf = {
        cacheMs: 0,
        queueMs: 0,
      };

      return ok();
    },
  };
}

