// scripts/chaos/features/links/transfer/systems/levels.js
import { isPrismBlock, getPrismTierFromTypeId, getPrismTypeIdForTier } from "../config.js";

export function createLevelsManager(cfg, state, deps = {}) {
  // State maps and flags are maintained by controller, passed in
  const prismCounts = state.prismCounts;
  const transferCounts = state.transferCounts;
  const outputCounts = state.outputCounts;
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
    } catch {
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
    const base = Math.max(1, cfg.orbStepTicks | 0);
    const minTicks = Math.max(1, cfg.minOrbStepTicks | 0);
    const scale = Math.pow(2, Math.max(0, safeLevel - 1));
    return Math.max(minTicks, Math.floor(base / scale));
  }

  function notePrismPassage(prismKey, block) {
    // Ensure we have a valid key in the format "dimId|x,y,z"
    // If we have a block but the key might be wrong, regenerate it from the block
    let actualKey = prismKey;
    if (block && block.location) {
      const loc = block.location;
      const dim = block.dimension;
      if (dim && dim.id) {
        // Use dimension.id format to match linkVision
        actualKey = `${dim.id}|${loc.x},${loc.y},${loc.z}`;
      }
    }
    
    const prismStep = Number.isFinite(cfg.prismLevelStep) ? cfg.prismLevelStep : (cfg.levelStep * 2);
    const blockLevel = isPrismBlock(block) ? getPrismTierFromTypeId(block) : 1;
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
      const currentTier = getPrismTierFromTypeId(block);
      if (currentTier === safeLevel) return;
      
      // Get current block location and states
      const loc = block.location;
      const dim = block.dimension;
      if (!dim || !loc) return;
      
      // Replace block with new tier (no state preservation needed - prisms use same texture on all sides)
      try {
        dim.setBlock(loc, newTypeId);
      } catch {
        return; // Failed to replace block
      }
      
      // Spawn level up effect on the new block
      const updatedBlock = dim.getBlock(loc);
      if (updatedBlock) spawnLevelUpBurst(updatedBlock);
    } catch {
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
