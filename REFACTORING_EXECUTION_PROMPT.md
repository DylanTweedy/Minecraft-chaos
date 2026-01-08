# Transfer Folder Cleanup and Controller.js Refactoring - Execution Prompt

## Objective

Refactor the transfer folder to break down `controller.js` (3,401 lines) into focused modules and organize files into logical subfolders. Remove duplicates, legacy code, and optimize as we go.

## Current State

- **controller.js**: 3,401 lines, only exports 3 functions, handles too many responsibilities
- **16 files** in transfer folder (some very small, need consolidation)
- **Code duplication**: Route functions exist in both controller.js and routes.js
- **Legacy code**: Several unused/deprecated functions need removal

## Target Structure

```
transfer/
├── index.js, controller.js, config.js, keys.js, utils.js (root)
├── core/ (cache.js, queues.js, inflightProcessor.js, finalize.js)
├── pathfinding/ (graph.js, path.js, pathfinder.js, routes.js)
├── inventory/ (inventory.js, filters.js, reservations.js)
├── persistence/ (storage.js, inflight.js)
└── systems/ (levels.js, refinement.js, fx.js)
```

## Implementation Phases

### Phase 0: Quick Wins

1. **Remove legacy functions from controller.js**:
   - Delete `scanNearbyPrisms()` (line ~1505, disabled, replaced by getActivePrismKeys)
   - Delete `noteTransferAndGetLevel()` (line ~3095, deprecated, replaced by notePrismPassage)
   - Delete `updateOutputBlockLevel()` (line ~3241, deprecated, replaced by updatePrismBlockLevel)
   - Delete `getInputKeys()` (line ~1511, legacy wrapper, unused)
   - Add TODO comment to `attemptPullTransfer()` (line ~1930, placeholder for future)

2. **Merge small utilities**:
   - Move `runTransferPipeline()` from `pipeline.js` to `utils.js`
   - Move `resolveBlockInfoStatic()` from `adapter.js` to `utils.js`
   - Delete `pipeline.js` and `adapter.js`
   - Update imports: controller.js (line 64), inflight.js (line 4)

### Phase 1: Organize Structure

1. **Create subfolders**: `core/`, `pathfinding/`, `inventory/`, `persistence/`, `systems/`

2. **Move existing files**:
   - `graph.js`, `path.js`, `pathfinder.js`, `routes.js` → `pathfinding/`
   - `inventory.js`, `filters.js`, `reservations.js` → `inventory/`
   - `storage.js`, `inflight.js` → `persistence/`

3. **Update imports in controller.js**:
   - `./graph.js` → `./pathfinding/graph.js`
   - `./path.js` → `./pathfinding/path.js`
   - `./pathfinder.js` → `./pathfinding/pathfinder.js`
   - `./routes.js` → `./pathfinding/routes.js`
   - `./inventory.js` → `./inventory/inventory.js`
   - `./filters.js` → `./inventory/filters.js`
   - `./reservations.js` → `./inventory/reservations.js`
   - `./storage.js` → `./persistence/storage.js`
   - `./inflight.js` → `./persistence/inflight.js`

4. **Update index.js** module list with new paths

5. **Test**: Verify imports resolve correctly

### Phase 2: Extract Cache Module (CRITICAL - Do First)

**Create `core/cache.js`** - Extract all cache-related code from controller.js:

**Extract these cache maps and timestamps**:
- `blockCache`, `blockCacheTimestamps`
- `containerInfoCache`, `containerInfoCacheTimestamps`
- `insertCapacityCache`, `insertCapacityCacheTimestamps`
- `totalCapacityCache`, `totalCapacityCacheTimestamps`
- `totalCountCache`, `totalCountCacheTimestamps`
- `dimCache`, `dimCacheTimestamps`
- `prismInventoryCache`, `prismInventoryCacheTimestamps`
- `prismInventoryListCache`, `prismInventoryListCacheTimestamps`
- `containerCapacityCache`, `containerCapacityCacheTimestamps`
- `crystallizerRouteCache`

**Extract these functions**:
- `resetTickCaches()` (line ~295)
- `invalidateCacheForBlock()` (line ~364)
- `invalidateCachesForBlockChange()` (line ~426)
- `getPrismInventoriesCached()` (line ~476)
- `getPrismHasInventories()` (line ~497)
- `getDimensionCached()` (line ~612)
- `resolveBlockInfoCached()` (line ~625)
- `resolveBlockInfoDirect()` (line ~664)
- `getBlockCached()` (line ~679)
- `resolveContainerInfoCached()` (line ~690)
- `getTotalCountForTypeCached()` (line ~716)
- `getInsertCapacityCached()` (line ~730)
- `getContainerCapacityCached()` (line ~746)

**API Design**:
```javascript
export function createCacheManager(deps, cfg) {
  let nowTick = 0;
  // All cache maps and timestamps...
  
  return {
    updateTick(tick) { nowTick = tick; },
    getPrismInventoriesCached(prismKey, prismBlock, dim) { /* ... */ },
    getPrismHasInventories(prismKey) { /* ... */ },
    resolveBlockInfoCached(blockKey) { /* ... */ },
    resolveBlockInfoDirect(blockKey) { /* ... */ },
    getBlockCached(dimId, pos) { /* ... */ },
    getDimensionCached(dimId) { /* ... */ },
    resolveContainerInfoCached(containerKey) { /* ... */ },
    getTotalCountForTypeCached(containerKey, container, typeId) { /* ... */ },
    getInsertCapacityCached(containerKey, container, typeId, stack) { /* ... */ },
    getContainerCapacityCached(containerKey, container) { /* ... */ },
    invalidateCacheForBlock(blockKey) { /* ... */ },
    invalidateCachesForBlockChange(blockKey) { /* ... */ },
    resetTickCaches() { /* ... */ },
  };
}
```

**Update controller.js**:
- Import and create cache manager
- Replace all cache function calls with cache manager methods
- Call `cacheManager.updateTick(nowTick)` each tick

### Phase 3: Optimize Routes.js

**Update `pathfinding/routes.js`**:
- Import `getPrismInventoriesCached` from `../core/cache.js`
- Update `findPrismRouteFromNode()` (line ~8) to use cached inventory checks instead of `getAllAdjacentInventories()` directly
- Pass cache manager to route functions or import the function directly

**Remove duplicates from controller.js**:
- Delete `findOutputRouteFromNode()` (line ~2990)
- Delete `buildOutputRoute()` (line ~3051)
- Delete `findCrystallizerRouteFromOutput()` (line ~3090)
- Update call sites to use routes.js versions (already imported at line 62)

### Phase 4: Extract Remaining Modules

**Extract in dependency order**:

1. **`systems/levels.js`** - Extract level/XP functions:
   - `notePrismPassage()`, `getNextInputLevel()`, `getLevelForCount()`, `getMinCountForLevel()`
   - `getTransferAmount()`, `getOrbStepTicks()`
   - `updatePrismBlockLevel()`
   - Controller maintains state maps, module operates on them

2. **`systems/fx.js`** - Extract FX/orb spawning:
   - `spawnOrbStep()`, `enqueueFluxTransferFx()`, `enqueueFluxTransferFxPositions()`
   - `spawnLevelUpBurst()`, `normalizeDir()`, `getOrbColor()`

3. **`systems/refinement.js`** - Extract refinement logic:
   - `applyPrismRefineChain()`, `applyPrismRefineToJob()`, `applyPrismRefineToFxJob()`
   - `applyPrismSpeedBoost()`, `sendExoticsToOutput()`, `findPrismsInPath()`

4. **`core/finalize.js`** - Extract job finalization:
   - `finalizeJob()`, `finalizeFluxFxJob()`
   - Use routes.js for crystallizer route finding

5. **`core/queues.js`** - Extract queue management:
   - `readyItems`, `nearReadyItems`, `queueByContainer`, `fullContainers`
   - `tickOutputQueues()`, `tickFullContainers()`, `enqueuePendingForContainer()`

6. **`core/inflightProcessor.js`** - Extract in-flight processing:
   - `tickInFlight()`, `tickFluxFxInFlight()`
   - Job movement and step advancement logic

### Phase 5: Simplify Controller.js

**After all extractions, controller.js should only contain**:
- Main tick loop (`onTick()`)
- State initialization and persistence (load/save functions)
- Transfer initiation (`attemptTransferForPrism()`, `attemptPushTransfer()`)
- Module coordination (create managers, pass dependencies)
- Debug stats aggregation (`postDebugStats()`)
- State management (inflight[], transferCounts, outputCounts, prismCounts maps)

**Target**: Reduce from 3,401 lines to ~800-1000 lines

### Phase 6: Update External Imports

**Update `bootstrap/transferLoop.js`**:
- Change import from `transferSystem.js` to `transfer/index.js`
- Path: `"../features/links/transferSystem.js"` → `"../features/links/transfer/index.js"`

**Delete `features/links/transferSystem.js`** (compatibility layer not needed)

**No changes needed** for 10 files importing from `transfer/config.js` (stays in root):
- systems/cleanupOnBreak.js, features/links/beam/queue.js, features/links/beam/validation.js
- systems/linkVision.js, systems/filterInteract.js, features/links/beamSim.js
- tiers.js, prestige.js, features/links/beam/events.js, features/links/beam/rebuild.js

## Key Decisions

1. **State Management**: Controller maintains state (inflight[], maps), modules receive it as parameters
2. **Cache Manager**: Extract first, needed by routes.js optimization
3. **No Backward Compatibility**: Migrate all external code, delete transferSystem.js
4. **No Subfolder Index Files**: Use full paths for clarity
5. **Keys.js Stays in Root**: Widely used across all subfolders

## Testing Checklist

After each phase:
- [ ] Imports resolve correctly
- [ ] Transfer system starts
- [ ] Basic transfers work
- [ ] Cache invalidation works
- [ ] In-flight transfers process correctly
- [ ] Level/XP progression works
- [ ] FX/orb spawning works
- [ ] Route finding works
- [ ] Debug stats accurate

## Important Notes

- **Extract cache.js FIRST** - routes.js needs it for optimization
- **Move files BEFORE extracting** - avoids double import updates
- **Controller maintains state** - modules operate on it, don't own it
- **Test incrementally** - verify after each phase
- **Commit after each major phase** - easier rollback if needed

## Files to Delete

- `pipeline.js` (merge into utils.js)
- `adapter.js` (merge into utils.js)
- `transferSystem.js` (compatibility layer)

## Files to Create

- `core/cache.js`
- `core/queues.js`
- `core/inflightProcessor.js`
- `core/finalize.js`
- `systems/levels.js`
- `systems/fx.js`
- `systems/refinement.js`

## Expected Outcome

- Controller.js: 3,401 lines → ~800-1000 lines (70% reduction)
- Better organization: 5 logical subfolders
- Improved performance: Cached route finding
- Cleaner codebase: No duplicates, no legacy code
- Easier maintenance: Single responsibility modules
