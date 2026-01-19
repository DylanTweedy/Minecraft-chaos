// scripts/chaos/features/logistics/runtime/helpers/speed.js

export function createGetSpeed(deps) {
  const { cfg, getSpeedForInput, isPrismBlock, getPrismTier } = deps || {};

  return function getSpeed(block) {
    try {
      if (typeof getSpeedForInput === "function") {
        const s = getSpeedForInput(block);
        if (s && typeof s === "object") return s;
      }
    } catch (_) {}

    // Prisms now use tier block IDs, not state
    let level = 1;

    if (block) {
      if (isPrismBlock(block)) {
        level = getPrismTier(block);
      } else {
        const perm = block.permutation;
        level = (perm?.getState("chaos:level") | 0) || 1;
      }
    }

    const scale = Math.pow(2, Math.max(0, level - 1));
    const interval = Math.max(1, Math.floor(cfg.perInputIntervalTicks / scale));
    return { intervalTicks: interval, amount: 1 };
  };
}


