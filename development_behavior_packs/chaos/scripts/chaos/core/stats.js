// scripts/chaos/stats.js
// Bedrock-safe, read-only, no imports, no side effects.

export function getGlobalInputCount(pairsMap) {
  try {
    return pairsMap ? pairsMap.size : 0;
  } catch (e) {
    return 0;
  }
}

export function getGlobalLinkCount(pairsMap) {
  try {
    if (!pairsMap) return 0;
    let total = 0;
    for (const set of pairsMap.values()) {
      total += set.size;
    }
    return total;
  } catch (e) {
    return 0;
  }
}

export function getPerInputOutputCount(pairsMap, inputKey) {
  try {
    if (!pairsMap || !inputKey) return 0;
    const set = pairsMap.get(inputKey);
    return set ? set.size : 0;
  } catch (e) {
    return 0;
  }
}
