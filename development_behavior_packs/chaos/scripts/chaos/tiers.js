// scripts/chaos/tiers.js
import { getPrismTier, isPrismBlock } from "./features/logistics/config.js";

function getTierFromBlock(block) {
  try {
    if (!block) return 1;
    // Extract tier from block typeId
    if (isPrismBlock(block)) {
      // getPrismTier accepts either a block object or a typeId string
      return getPrismTier(block);
    }
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

// Re-export getPrismTier from config.js for convenience
export { getPrismTier } from "./features/logistics/config.js";


