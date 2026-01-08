# Transfer System Optimization Proposal

## Current State Analysis

### What We're Currently Caching
1. **Block lookups** (TTL: 5 ticks) - Block existence and position
2. **Container info** (TTL: 10 ticks) - Container objects for blocks
3. **Insert capacity** (TTL: 3 ticks) - How much can be inserted into containers
4. **Total capacity** (TTL: 3 ticks) - Total container capacity
5. **Item counts** (TTL: 2 ticks) - Count of specific items in containers
6. **Dimension lookups** (TTL: 1000 ticks) - Dimension objects
7. **Pathfinding results** (TTL: 10-120 ticks) - Paths from prisms to outputs
8. **Prism key lists** (cached until network stamp changes)

### Current Performance Issues

1. **Every Tick Operations:**
   - Scans ALL prisms from beams map (even without inventories)
   - Checks inventory existence for every prism
   - Attempts both push AND pull for each prism
   - Pathfinding includes prisms without inventories as valid targets

2. **Pathfinding Inefficiencies:**
   - Pathfinder finds paths to ALL prisms/crystallizers, then filters by inventory AFTER
   - Network stamp changes invalidate ALL path caches (even unrelated paths)
   - No event-driven invalidation - paths expire by time, not by actual changes

3. **Redundant Work:**
   - Prisms without inventories are scanned every tick
   - Pathfinding searches through nodes that can't accept items
   - Both push and pull logic runs even when one would suffice

## Proposed Optimizations

### 1. Pre-filter Prisms by Inventory Status (HIGH IMPACT)

**Problem:** We scan all prisms every tick, including those without inventories.

**Solution:** 
- Maintain a separate list of "active prisms" (prisms with inventories)
- Only scan active prisms for transfers
- Update active list only when:
  - Prism is placed/broken
  - Adjacent blocks change (inventory added/removed)
  - Periodic validation (every 100 ticks)

**Implementation:**
```javascript
// New state
const activePrisms = new Set(); // Prisms with inventories
const prismInventoryStatus = new Map(); // prismKey -> hasInventories (boolean)
let lastInventoryValidationTick = 0;
const INVENTORY_VALIDATION_INTERVAL = 100;

// Only include prisms with inventories in scanning
function getActivePrismKeys() {
  // Validate periodically
  if ((nowTick - lastInventoryValidationTick) >= INVENTORY_VALIDATION_INTERVAL) {
    validateActivePrisms();
    lastInventoryValidationTick = nowTick;
  }
  return Array.from(activePrisms);
}

// Update on block changes
function onBlockChanged(blockKey, hasInventories) {
  if (hasInventories) {
    activePrisms.add(blockKey);
  } else {
    activePrisms.delete(blockKey);
  }
  prismInventoryStatus.set(blockKey, hasInventories);
}
```

**Expected Impact:** Reduces scanned prisms from 27 to only those with inventories (likely 10-15), cutting scan time by ~40-50%.

---

### 2. Event-Driven Path Invalidation (HIGH IMPACT)

**Problem:** Network stamp changes invalidate ALL paths, even when only one block changed.

**Solution:**
- Track which prisms are affected by block changes
- Only invalidate paths for affected prisms
- Use dependency graph: when block X changes, invalidate paths from prisms within N blocks

**Implementation:**
```javascript
// Track path dependencies
const pathDependencies = new Map(); // prismKey -> Set of blockKeys it depends on
const affectedPrisms = new Set(); // Prisms that need path recalculation

// When block changes
function onBlockChanged(blockKey) {
  // Find all prisms within 2 blocks that might be affected
  const affected = findPrismsInRadius(blockKey, 2);
  for (const prismKey of affected) {
    affectedPrisms.add(prismKey);
    invalidateInput(prismKey); // Invalidate pathfinder cache
  }
}

// Only recalculate paths for affected prisms
function findPathsForPrism(prismKey, nowTick) {
  // Check if this prism needs recalculation
  if (affectedPrisms.has(prismKey)) {
    affectedPrisms.delete(prismKey);
    // Force recalculation
    cache.delete(prismKey);
  }
  // ... rest of pathfinding
}
```

**Expected Impact:** Reduces path searches from 200+ to only when needed (likely 5-20 per tick), cutting pathfinding time by 80-90%.

---

### 3. Filter Prisms Without Inventories in Pathfinding (MEDIUM IMPACT)

**Problem:** Pathfinder includes prisms without inventories as valid targets, then filters them out later.

**Solution:**
- Check inventory existence during pathfinding, not after
- Skip prisms without inventories as potential targets
- Cache inventory status per prism (TTL: 20 ticks)

**Implementation:**
```javascript
// In pathfinder.js - check inventories during search
if (edge.nodeType === "prism") {
  // Quick check: does this prism have inventories?
  const hasInventories = checkPrismHasInventories(edge.nodePos, dim);
  if (!hasInventories) {
    // Skip as target, but continue searching through it
    visited.add(nextKey);
    visitedCount++;
    queue.push({...});
    continue; // Don't add to outputs
  }
  
  // Has inventories - valid target
  outputs.push({...});
}
```

**Expected Impact:** Reduces pathfinding search space by excluding invalid targets early, cutting pathfinding time by 20-30%.

---

### 4. Push-Only or Pull-Only Model (MEDIUM IMPACT)

**Problem:** Each prism attempts both push and pull, doubling the work.

**Solution Options:**

**Option A: Configuration-Based**
- Add config: `prismMode: "push" | "pull" | "both"` (default: "both")
- Prisms can be configured per-instance or globally
- Simplifies logic per prism

**Option B: Smart Auto-Detection**
- If prism has items → push mode
- If prism has filter and no items → pull mode
- If prism has both → prefer push (simpler)

**Option C: Separate Prism Types**
- Input prisms (push only)
- Output prisms (pull only)
- Relay prisms (both, but only forward items)

**Recommendation:** Option B (Smart Auto-Detection) - simplest to implement, no config needed.

**Implementation:**
```javascript
function attemptTransferForPrism(prismKey, searchBudget) {
  const inventories = getAllAdjacentInventories(prismBlock, dim);
  if (!inventories || inventories.length === 0) return;
  
  const hasItems = hasAnyItems(inventories);
  const hasFilter = filterSet && filterSet.size > 0;
  
  // Smart mode selection
  if (hasItems) {
    // Push mode: send items out
    return attemptPushTransfer(...);
  } else if (hasFilter) {
    // Pull mode: request filtered items
    return attemptPullTransfer(...);
  }
  // No items, no filter: skip
  return { ok: false, reason: "no_action" };
}
```

**Expected Impact:** Reduces transfer attempts per prism by ~50%, cutting scan time by 20-30%.

---

### 5. Cache Inventory Status (LOW-MEDIUM IMPACT)

**Problem:** We check `getAllAdjacentInventories()` every tick for every prism.

**Solution:**
- Cache inventory status per prism (TTL: 20 ticks)
- Invalidate cache when adjacent blocks change
- Use cached status for filtering

**Implementation:**
```javascript
const prismInventoryCache = new Map(); // prismKey -> { hasInventories: bool, timestamp: number }
const PRISM_INVENTORY_CACHE_TTL = 20;

function getPrismHasInventories(prismKey) {
  const cached = prismInventoryCache.get(prismKey);
  if (cached && (nowTick - cached.timestamp) < PRISM_INVENTORY_CACHE_TTL) {
    return cached.hasInventories;
  }
  
  const info = resolveBlockInfo(prismKey);
  if (!info || !info.block) return false;
  
  const inventories = getAllAdjacentInventories(info.block, info.dim);
  const hasInventories = inventories && inventories.length > 0;
  
  prismInventoryCache.set(prismKey, {
    hasInventories,
    timestamp: nowTick
  });
  
  return hasInventories;
}
```

**Expected Impact:** Reduces expensive inventory scans by 80-90%, cutting scan time by 10-15%.

---

## Implementation Priority

### Phase 1: Quick Wins (Implement First)
1. **Filter prisms without inventories in pathfinding** - Easy, high impact
2. **Cache inventory status** - Easy, medium impact
3. **Smart push/pull detection** - Medium difficulty, medium impact

**Expected Total Impact:** 40-50% reduction in tick time

### Phase 2: Major Refactoring (Implement Second)
4. **Pre-filter active prisms** - Medium difficulty, high impact
5. **Event-driven path invalidation** - High difficulty, high impact

**Expected Total Impact:** Additional 50-60% reduction (combined with Phase 1: 70-80% total reduction)

---

## Push-Only vs Pull-Only Analysis

### Push-Only Model
**Pros:**
- Simpler logic: items flow from source to destination
- Easier to understand and debug
- Natural flow: "I have items, where can they go?"

**Cons:**
- Requires sources to actively push
- May miss items in remote locations
- Less flexible for filtered requests

### Pull-Only Model
**Pros:**
- Demand-driven: only pull when needed
- Better for filtered/attuned systems
- Can aggregate from multiple sources

**Cons:**
- More complex: need to find sources
- May create "starvation" if no sources available
- Harder to balance load

### Recommendation: **Hybrid with Smart Detection**
- Use push when items are available (simpler, more efficient)
- Use pull when filter is set but no items (demand-driven)
- This gives best of both worlds without complexity

---

## What We Should Cache vs Not Cache

### Should Cache (Long TTL):
- ✅ **Prism inventory status** (20 ticks) - Changes only when blocks change
- ✅ **Pathfinding results** (until network changes) - Expensive to compute
- ✅ **Block existence** (5 ticks) - Rarely changes
- ✅ **Dimension objects** (1000 ticks) - Never changes

### Should NOT Cache (Check Every Time):
- ❌ **Item counts in containers** - Changes constantly
- ❌ **Container capacity** - Changes as items move
- ❌ **Insert capacity** - Depends on current state

### Current Caching Issues:
- We're caching item counts (TTL: 2 ticks) - too short to be useful
- We're caching capacity (TTL: 3 ticks) - changes too frequently
- Better approach: Don't cache these, but cache the expensive inventory lookup

---

## Expected Performance Gains

### Current: ~1700ms per tick
### After Phase 1: ~850-1000ms per tick (40-50% reduction)
### After Phase 2: ~340-510ms per tick (70-80% reduction)

### Breakdown:
- **Scanning:** 1700ms → 340ms (80% reduction)
  - Pre-filtering: -40%
  - Inventory caching: -15%
  - Push/pull optimization: -25%
- **Pathfinding:** 200+ searches → 5-20 searches (90% reduction)
  - Event-driven invalidation: -80%
  - Filter during search: -10%
- **Other:** Minimal impact (already optimized)

---

## Migration Strategy

1. **Add new systems alongside old ones** (feature flags)
2. **Test with small network first** (5-10 prisms)
3. **Gradually enable optimizations** (one at a time)
4. **Monitor performance metrics** (tick time, searches, transfers)
5. **Remove old code** once stable

---

## Questions to Consider

1. **Do we need bidirectional transfers?** Or can prisms be input-only or output-only?
2. **How often do inventories actually change?** If rare, longer cache TTLs are safe
3. **Can we batch path invalidations?** Instead of immediate, queue for next tick
4. **Should crystallizers be treated differently?** They always accept, no inventory check needed

---

## Next Steps

1. Review this proposal
2. Decide on push/pull model preference
3. Implement Phase 1 optimizations
4. Test and measure impact
5. Implement Phase 2 if needed
6. Fine-tune based on results
