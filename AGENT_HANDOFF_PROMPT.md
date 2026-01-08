# Agent Handoff: Minecraft Bedrock Chaos Prism Transfer System - Performance Optimization

## Current Status: ⚠️ PERFORMANCE ISSUES - High Tick Times

**The Problem**: The transfer system is experiencing significant lag spikes with tick times of **1900-2000ms** (nearly 2 seconds per tick). The system is functional but needs optimization.

**Current Performance Metrics** (from debug output):
- `[Transfer] Prisms: 32 | Transfers: 22 | In-flight: 23 | Queued: 2 items | Paths: 571 searches | Orbs: 26 | Time: 1941ms`
- `Time: 1962ms` - This is the total time for the transfer system tick, which is extremely high

**System Status**:
- ✅ Prisms are being detected (32 prisms found)
- ✅ Transfers are working (22 transfers completed, 23 in-flight)
- ✅ Visual system is active (26 orbs visible)
- ✅ Debug messages have been cleaned up (only aggregated stats remain)
- ⚠️ **Performance is the critical issue** - 2 second ticks cause severe lag spikes

## Optimization Recommendations

### Priority 1: DP Save Batching and Throttling

**Current State**: Multiple DP saves happen independently:
- `persistInflightIfNeeded()` - saves inflight transfers
- `persistLevelsIfNeeded()` - saves input levels (every 200 ticks)
- `persistOutputLevelsIfNeeded()` - saves output levels (every 200 ticks)
- `persistPrismLevelsIfNeeded()` - saves prism levels (every 200 ticks)
- `saveBeamsMap()` - saves beam map (from beam system)

**Problem**: Each save operation is expensive. Multiple saves per tick can cause lag spikes.

**Recommendation**:
1. **Batch all DP saves** into a single operation per tick (or every N ticks)
2. **Increase save intervals** - 200 ticks may be too frequent for level saves
3. **Use a save queue** - accumulate changes and save them all at once
4. **Throttle saves** - Only save if changes have accumulated (dirty flags are already in place)

**Files to Modify**:
- `development_behavior_packs/chaos/scripts/chaos/features/links/transfer/controller.js`
  - Lines ~362-445: All `persist*IfNeeded()` functions
  - Lines ~680-691: Where saves are called in `onTick()`

**Implementation Suggestion**:
```javascript
function persistAllIfNeeded() {
  const saveInterval = 200; // Only save every 200 ticks
  if ((nowTick - lastSaveTick) < saveInterval) return;
  
  // Batch all saves into one operation
  const allData = {
    inflight: inflightDirty ? inflight : null,
    inputLevels: levelsDirty ? Object.fromEntries(transferCounts) : null,
    outputLevels: outputLevelsDirty ? Object.fromEntries(outputCounts) : null,
    prismLevels: prismLevelsDirty ? Object.fromEntries(prismCounts) : null,
  };
  
  // Save all at once (or in sequence but throttled)
  if (allData.inflight) persistInflightStateToWorld(world, allData.inflight);
  if (allData.inputLevels) saveInputLevels(world, allData.inputLevels);
  // ... etc
  
  // Reset all dirty flags
  inflightDirty = false;
  levelsDirty = false;
  // ... etc
  lastSaveTick = nowTick;
}
```

### Priority 2: Cache Improvements

**Current State**: Caches are cleared every tick, which is good, but:
- Block lookups may be happening redundantly
- Container info lookups may be repeated
- Pathfinding results may not be cached effectively

**Recommendation**:
1. **Extend cache lifetime** - Don't clear caches every tick, use TTL-based expiration
2. **Cache pathfinding results** - Paths between prisms don't change often
3. **Cache inventory lookups** - Adjacent inventories don't change unless blocks are placed/removed
4. **Invalidate caches on block changes** - Use event system to clear relevant caches

**Files to Modify**:
- `development_behavior_packs/chaos/scripts/chaos/features/links/transfer/controller.js`
  - Lines ~188-200: `resetTickCaches()` function
  - Lines ~220-280: `resolveBlockInfoCached()` and related cache functions
  - `development_behavior_packs/chaos/scripts/chaos/features/links/transfer/pathfinder.js` - Add path caching

**Implementation Suggestion**:
```javascript
// Instead of clearing every tick, use TTL
const blockCacheTTL = 5; // Cache for 5 ticks
const cacheTimestamps = new Map();

function resolveBlockInfoCached(blockKey) {
  const cached = blockCache.get(blockKey);
  const timestamp = cacheTimestamps.get(blockKey);
  
  if (cached && timestamp && (nowTick - timestamp) < blockCacheTTL) {
    return cached;
  }
  
  // ... lookup and cache with timestamp
  cacheTimestamps.set(blockKey, nowTick);
}
```

### Priority 3: Reduce Redundant Operations

**Current State**: 
- `getPrismKeys()` is called every tick and does full map scan
- Pathfinding searches are happening frequently (571 searches shown in stats)
- Block lookups are happening for every prism every tick

**Recommendation**:
1. **Cache prism keys** - Only recalculate when network stamp changes (already partially implemented)
2. **Limit pathfinding searches** - Reduce `maxSearchesPerTick` or improve search efficiency
3. **Skip prisms that can't transfer** - Don't scan prisms that are on cooldown or have no items
4. **Batch block lookups** - Do multiple lookups in one operation if possible

**Files to Modify**:
- `development_behavior_packs/chaos/scripts/chaos/features/links/transfer/controller.js`
  - Lines ~695-847: `getPrismKeys()` - improve caching
  - Lines ~573-703: `onTick()` - optimize scanning loop
  - `development_behavior_packs/chaos/scripts/chaos/bootstrap/transferLoop.js` - Adjust `maxSearchesPerTick` config

### Priority 4: Code Organization (Lower Priority)

**Current State**: `controller.js` is a very large file (~2600 lines) with many responsibilities.

**Recommendation**:
1. **Split into modules**:
   - `transferCore.js` - Core transfer logic
   - `transferInventory.js` - Inventory operations
   - `transferPathfinding.js` - Pathfinding integration
   - `transferPersistence.js` - Save/load operations
   - `transferDebug.js` - Debug stats and messages
2. **Extract constants** - Move all magic numbers to config
3. **Improve function organization** - Group related functions together

**Files to Create**:
- `development_behavior_packs/chaos/scripts/chaos/features/links/transfer/transferCore.js`
- `development_behavior_packs/chaos/scripts/chaos/features/links/transfer/transferInventory.js`
- `development_behavior_packs/chaos/scripts/chaos/features/links/transfer/transferPersistence.js`

## Key Files

### Primary File (Main Optimization Target)
- **`development_behavior_packs/chaos/scripts/chaos/features/links/transfer/controller.js`** (~2600 lines)
  - Lines 362-445: DP save functions (Priority 1)
  - Lines 188-200: Cache clearing (Priority 2)
  - Lines 220-280: Block/container caching (Priority 2)
  - Lines 573-703: Main tick loop (Priority 3)
  - Lines 695-847: `getPrismKeys()` (Priority 3)

### Configuration
- **`development_behavior_packs/chaos/scripts/chaos/bootstrap/transferLoop.js`**
  - Line 59: `maxTransfersPerTick: 4`
  - Line 64: `maxInputsScannedPerTick: 12`
  - Line 61: `orbStepTicks: 60`
  - Consider reducing these if performance is still an issue

### Related Systems
- **`development_behavior_packs/chaos/scripts/chaos/features/links/transfer/pathfinder.js`**
  - Pathfinding logic - consider adding result caching here

## Performance Profiling

**Current Debug Stats Show**:
- `Time: 1941ms` - Total tick time (TARGET: <100ms)
- `Paths: 571 searches` - Pathfinding operations (high)
- `Orbs: 26` - Active visual orbs (reasonable)
- `In-flight: 23` - Active transfers (reasonable)

**Breakdown Needed**:
The debug stats already track:
- `msQueues` - Queue processing time
- `msInflight` - In-flight processing time
- `msFluxFx` - Flux FX time
- `msScan` - Scanning time
- `msPersist` - Persistence time
- `msTotal` - Total time

**Next Steps for Profiling**:
1. Check which component is taking the most time (likely `msPersist` or `msScan`)
2. Add more granular timing to identify bottlenecks
3. Focus optimization on the slowest component

## Implementation Order

1. **Start with DP Save Batching** (Priority 1) - Likely biggest impact
2. **Add pathfinding result caching** (Priority 2) - 571 searches is very high
3. **Improve cache TTL** (Priority 2) - Reduce redundant lookups
4. **Optimize scanning loop** (Priority 3) - Skip unnecessary prisms
5. **Code organization** (Priority 4) - For maintainability

## Testing

After each optimization:
1. Check debug stats for `Time` value - should decrease
2. Monitor for lag spikes - should be smoother
3. Verify transfers still work correctly
4. Check that no functionality is broken

## Notes

- **Debug messages are already cleaned up** - Only aggregated stats remain
- **System is functional** - Don't break existing functionality
- **Focus on performance** - The 2 second tick time is the critical issue
- **Minecraft Bedrock limitations** - DP saves are inherently slow, batching helps
- **Cache invalidation** - Must be careful when extending cache lifetime to invalidate on block changes
