// scripts/chaos/features/links/transfer/runtime/ctx.js

/**
 * Create a per-tick context that carries caches, budgets, timers, and shared state.
 */
export function createTickContext(opts = {}) {
  const nowTick = opts.nowTick || 0;
  const cfg = opts.cfg || {};

  const ctx = {
    nowTick,
    cfg,
    world: opts.world || null,
    system: opts.system || null,
    emitTrace: opts.emitTrace || (() => {}),
    noteWatchdog: opts.noteWatchdog || (() => {}),
    softBudgetMs: opts.softBudgetMs || 0,
    tickStart: Date.now(),
    metrics: {
      phases: {},
      counters: {},
      notes: [],
    },
    debugEnabled: !!opts.debugEnabled,
    debugState: opts.debugState || {},
    managers: opts.managers || {},
    services: opts.services || {},
    budgets: {
      transfers: Math.max(0, cfg.maxTransfersPerTick | 0),
      searches: Math.max(0, cfg.maxSearchesPerTick | 0),
    },
    queueState: null,
    cache: {
      resolveBlockInfo: new Map(),
      filterForBlock: new Map(),
      containerKey: new Map(),
    },
    timers: {
      start: Date.now(),
      phases: {},
    },
  };

  ctx.setQueueState = (state) => {
    ctx.queueState = state || null;
  };

  ctx.incrementCounter = (name, delta = 1) => {
    if (!ctx.metrics || !ctx.metrics.counters) return;
    const current = ctx.metrics.counters[name] || 0;
    ctx.metrics.counters[name] = current + (delta | 0);
  };

  return ctx;
}

