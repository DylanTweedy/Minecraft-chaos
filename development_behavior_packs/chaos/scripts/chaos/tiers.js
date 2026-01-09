// scripts/chaos/tiers.js
import { getPrismTierFromTypeId, isPrismBlock } from "./features/links/transfer/config.js";

function getTierFromBlock(block) {
  try {
    if (!block) return 1;
    // Extract tier from block typeId
    if (isPrismBlock(block)) {
      // getPrismTierFromTypeId accepts either a block object or a typeId string
      return getPrismTierFromTypeId(block);
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

export function getPrismTier(block) {
  return getTierFromBlock(block);
}
