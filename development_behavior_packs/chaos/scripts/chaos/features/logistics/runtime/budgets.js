// scripts/chaos/features/logistics/runtime/budgets.js

export function createBudgets(cfg = {}) {
  const defaults = {
    exports: Math.max(1, Number(cfg.maxExportsPerTick) || 6),
    resolves: Math.max(1, Number(cfg.maxResolvesPerTick) || 6),
    arrivals: Math.max(1, Number(cfg.maxArrivalsPerTick) || 24),
    departures: Math.max(1, Number(cfg.maxDeparturesPerTick) || 24),
    ioExtracts: Math.max(1, Number(cfg.maxIoExtractsPerTick) || 8),
    ioInserts: Math.max(1, Number(cfg.maxIoInsertsPerTick) || 8),
    movements: Math.max(1, Number(cfg.maxMovementsPerTick) || 128),
    flux: Math.max(1, Number(cfg.maxFluxPerTick) || 24),
  };

  const state = { ...defaults };

  function reset() {
    Object.assign(state, defaults);
  }

  function take(key, amount = 1) {
    const k = String(key || "");
    if (!Object.prototype.hasOwnProperty.call(state, k)) return false;
    const remaining = state[k] | 0;
    if (remaining < amount) return false;
    state[k] = remaining - amount;
    return true;
  }

  return { state, reset, take };
}

