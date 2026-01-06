// scripts/chaos/tiers.js

function getTierFromBlock(block) {
  try {
    const level = block?.permutation?.getState("chaos:level");
    if (Number.isFinite(level)) return Math.max(1, Math.min(5, level | 0));
  } catch {
    // ignore
  }
  return 1;
}

export function getTier(block) {
  return getTierFromBlock(block);
}

export function getOutputTier(block) {
  return getTierFromBlock(block);
}

export function getPrismTier(block) {
  return getTierFromBlock(block);
}
