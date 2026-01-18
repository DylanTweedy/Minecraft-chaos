// scripts/chaos/features/links/transfer/runtime/phases/beginTick.js

import { ok } from "../../util/result.js";

export function createBeginTickPhase(deps) {
  const servicesFallback = (deps && deps.services) || {};
  const cfgFallback = (deps && deps.cfg) || servicesFallback.cfg || {};

  function pickService(ctx, key) {
    return (ctx && ctx.services && ctx.services[key]) || servicesFallback[key] || null;
  }

  function clearMaybe(map) {
    try {
      if (map && typeof map.clear === "function") map.clear();
    } catch (e) {
      // ignore
    }
  }

  return {
    name: "beginTick",
    run(ctx) {
      // --- Establish per-tick authority (budgets/caps reset) ---
      const schedulerSvc =
        pickService(ctx, "hybridScheduler") ||
        pickService(ctx, "scheduler");

      if (schedulerSvc && typeof schedulerSvc.beginTick === "function") {
        schedulerSvc.beginTick();
      }

      // --- Reset caches (safe, optional) ---
      const cacheManager = pickService(ctx, "cacheManager");
      if (cacheManager && typeof cacheManager.updateTick === "function") {
        cacheManager.updateTick(ctx.nowTick);
      }
      if (cacheManager && typeof cacheManager.resetTickCaches === "function") {
        cacheManager.resetTickCaches();
      }

      // Some builds keep ad-hoc maps on ctx.cache
      const cache = ctx && ctx.cache;
      if (cache) {
        clearMaybe(cache.resolveBlockInfo);
        clearMaybe(cache.filterForBlock);
        clearMaybe(cache.containerKey);
      }

      // --- Queue snapshot (optional) ---
      const queuesManager = pickService(ctx, "queuesManager");
      if (queuesManager && typeof queuesManager.getState === "function" && typeof ctx.setQueueState === "function") {
        ctx.setQueueState(queuesManager.getState());
      }

      // --- Per-tick budgets (keep compatible with existing callers) ---
      const cfg = (ctx && ctx.cfg) || cfgFallback;

      const maxTransfers = Math.max(0, (cfg && cfg.maxTransfersPerTick) | 0);
      const maxSearches = Math.max(0, (cfg && cfg.maxSearchesPerTick) | 0);

      ctx.budgets = {
        transfers: maxTransfers,
        searches: maxSearches,
        inputTransfers: maxTransfers,
        inputSearches: maxSearches,
      };

      // --- Perf scratch (optional) ---
      ctx.tickStart = Date.now();
      ctx.perf = { cacheMs: 0, queueMs: 0 };

      return ok();
    },
  };
}
