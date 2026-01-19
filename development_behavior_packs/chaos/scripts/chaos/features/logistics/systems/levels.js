// scripts/chaos/features/logistics/systems/levels.js
import { isPrismBlock, getPrismTier, getPrismTypeIdForTier } from "../config.js";
import { key as makePrismKey } from "../keys.js";

export function createLevelsManager(cfg, state, deps = {}) {
  // State maps and flags are maintained by controller, passed in
  if (!cfg || !state) return null; // Return null if required params are missing
  const prismCounts = state.prismCounts || new Map();
  const transferCounts = state.transferCounts || new Map();
  const outputCounts = state.outputCounts || new Map();
  const spawnLevelUpBurst = deps.spawnLevelUpBurst || (() => {}); // Optional FX function
  
  // Helper to set dirty flag (handles both direct assignment and getter/setter objects)
  function setPrismLevelsDirty(value) {
    try {
      const dirtyFlag = state.prismLevelsDirty;
      if (dirtyFlag && typeof dirtyFlag.set === 'function') {
        dirtyFlag.set(value);
      } else if (dirtyFlag && typeof dirtyFlag === 'object' && 'value' in dirtyFlag) {
        dirtyFlag.value = value;
      } else if (dirtyFlag !== undefined) {
        state.prismLevelsDirty = value;
      }
    } catch (e) {
      // Ignore errors setting dirty flag
    }
  }

  function getLevelForCount(count, step, maxLevel) {
    const base = Math.max(1, step | 0);
    const cap = Math.max(1, maxLevel | 0);
    let needed = base;
    let total = 0;
    const c = Math.max(0, count | 0);
    for (let lvl = 1; lvl <= cap; lvl++) {
      total += needed;
      if (c < total) return lvl;
      needed *= 2;
    }
    return cap;
  }

  function getMinCountForLevel(level, step) {
    const base = Math.max(1, step | 0);
    const lvl = Math.max(1, level | 0);
    let needed = base;
    let total = 0;
    for (let i = 1; i < lvl; i++) {
      total += needed;
      needed *= 2;
    }
    return total;
  }

  function getNextInputLevel(inputKey) {
    // Use unified prism counts system
    if (!inputKey) return 1; // Guard against null/undefined keys
    const stored = prismCounts.has(inputKey) ? prismCounts.get(inputKey) : 0;
    const prismStep = Number.isFinite(cfg.prismLevelStep) ? cfg.prismLevelStep : (cfg.levelStep * 2);
    return getLevelForCount(stored + 1, prismStep, cfg.maxLevel);
  }

  function getTransferAmount(level, stack) {
    const maxItems = Math.max(1, cfg.maxItemsPerOrb | 0);
    const lvl = Math.max(1, level | 0);
    const maxStack = Math.max(1, stack?.maxAmount || 64);
    const cap = Math.min(maxItems, maxStack);
    if (lvl <= 1) return 1;
    const steps = Math.max(0, (cfg.maxLevel | 0) - lvl);
    const desired = Math.floor(cap / Math.pow(2, steps));
    return Math.max(1, Math.min(cap, desired));
  }

  function getOrbStepTicks(level) {
    const safeLevel = Math.max(1, level | 0);
    // Direct tier-based speed: Tier 1 = 16 ticks, Tier 5 = 1 tick
    // Formula: 16 / (2^(tier-1)) = 2^(5-tier)
    // This gives: T1=16, T2=8, T3=4, T4=2, T5=1
    const stepTicks = Math.pow(2, 5 - safeLevel);
    return Math.max(1, Math.floor(stepTicks)); // Ensure at least 1 tick
  }

  function notePrismPassage(prismKey, block) {
    // Ensure we have a valid canonical prism key
    // If we have a block but the key might be wrong, regenerate it from the block
    let actualKey = prismKey;
    if (block && block.location) {
      const loc = block.location;
      const dimId = block.dimension?.id;
      const canonical = makePrismKey(dimId, loc.x, loc.y, loc.z);
      if (canonical) {
        actualKey = canonical;
      }
    }
    
    // Guard against invalid keys
    if (!actualKey || (typeof actualKey !== 'string' && typeof actualKey !== 'number')) {
      return;
    }
    
    const prismStep = Number.isFinite(cfg.prismLevelStep) ? cfg.prismLevelStep : (cfg.levelStep * 2);
    const blockLevel = isPrismBlock(block) ? getPrismTier(block) : 1;
    const minCount = getMinCountForLevel(blockLevel, prismStep);
    const stored = prismCounts.has(actualKey) ? prismCounts.get(actualKey) : 0;
    const storedLevel = getLevelForCount(stored, prismStep, cfg.maxLevel);
    const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const next = current + 1;
    prismCounts.set(actualKey, next);
    setPrismLevelsDirty(true);
    const level = getLevelForCount(next, prismStep, cfg.maxLevel);
    updatePrismBlockLevel(block, level);
  }

  function updatePrismBlockLevel(block, level) {
    try {
      if (!block || !isPrismBlock(block)) return;
      const safeLevel = Math.max(1, Math.min(5, Math.floor(level || 1)));
      const newTypeId = getPrismTypeIdForTier(safeLevel);
      
      // Check if already at correct tier
      const currentTier = getPrismTier(block);
      if (currentTier === safeLevel) return;
      
      // Get current block location and states
      const loc = block.location;
      const dim = block.dimension;
      if (!dim || !loc) return;
      
      // Replace block with new tier (no state preservation needed - prisms use same texture on all sides)
      try {
        dim.setBlock(loc, newTypeId);
      } catch (e) {
        return; // Failed to replace block
      }
      
      // Spawn level up effect on the new block
      const updatedBlock = dim.getBlock(loc);
      if (updatedBlock && typeof spawnLevelUpBurst === "function") {
        spawnLevelUpBurst(updatedBlock);
      }
    } catch (e) {
      // Ignore errors
    }
  }

  return {
    getLevelForCount,
    getMinCountForLevel,
    getNextInputLevel,
    getTransferAmount,
    getOrbStepTicks,
    notePrismPassage,
    updatePrismBlockLevel,
  };
}


