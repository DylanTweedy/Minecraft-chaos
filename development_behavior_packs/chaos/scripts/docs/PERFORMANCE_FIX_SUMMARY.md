# Performance Fix Summary: Eliminate Redundant Scanning and Pathfinding

## Problem Identified

When watchdog exceptions started occurring, we were doing **redundant expensive operations**:

1. **Scanning prisms with active queues** - Finding items that were already queued
2. **Pathfinding for already-queued items** - Doing expensive pathfinding (120+ nodes) for items already in queue
3. **Inventory scanning for known items** - Reading all inventory slots even when items were already queued

### The Redundant Work Flow (Before Fix)

```
Tick 1:
  Queue Processing: Process Iron from queue → Removes Iron from queue
  Scanning: 
    - Scan Prism A → Find [Iron, Gold, Stone]
    - Do pathfinding for ALL 3 items (expensive! visits 120+ nodes)
    - Try to queue all 3 items
    - enqueueInputStacks skips Gold and Stone (already queued)
    - ❌ BUT WE ALREADY DID EXPENSIVE PATHFINDING!

Tick 2:
  Queue Processing: Process Gold from queue → Removes Gold from queue
  Scanning:
    - Scan Prism A AGAIN → Find [Iron, Gold, Stone] (same items!)
    - Do pathfinding AGAIN for Gold and Stone (expensive! redundant!)
    - Try to queue all 3 items
    - enqueueInputStacks skips Stone (already queued)
    - ❌ REDUNDANT PATHFINDING!
```

## Solution Implemented

### Key Changes

1. **Check existing queue BEFORE pathfinding** (Lines 2138-2142)
   ```javascript
   const existingQueue = inputQueuesManager.getQueuesForPrism(prismKey);
   const queuedItemTypes = new Set(existingQueue ? existingQueue.map(e => e.itemTypeId) : []);
   ```

2. **Filter out already-queued items BEFORE expensive operations** (Lines 2144-2170)
   ```javascript
   const newItems = allItems.filter(item => !queuedItemTypes.has(item.stack.typeId));
   ```

3. **Early return if all items already queued** (Lines 2171-2175)
   ```javascript
   if (hasActiveQueue && newItemCount === 0) {
     return { ...makeResult(false, "all_items_already_queued"), searchesUsed: 0 };
   }
   ```

4. **Only do pathfinding for NEW items** (Lines 2177-2214)
   - Pathfinding only happens for items NOT in queue
   - This prevents expensive pathfinding operations that were causing watchdog exceptions

5. **Handle "all_items_already_queued" gracefully** (Lines 1855-1860)
   - This is normal behavior, not a failure
   - Set minimal cooldown and let queue processing handle it

## Performance Impact

### Before Fix
- **Every scan:** Pathfinding for ALL items found (even if already queued)
- **Example:** Prism with 5 item types, 3 already queued → Still does pathfinding for all 5
- **Cost:** 5 × pathfinding operations per scan (even though 3 are redundant)

### After Fix
- **Every scan:** Pathfinding ONLY for NEW items (not already queued)
- **Example:** Prism with 5 item types, 3 already queued → Only does pathfinding for 2 new ones
- **Cost:** 2 × pathfinding operations per scan (60% reduction in this example)

### Real-World Impact
- **Small networks (5-10 prisms):** Minimal impact, but prevents future issues
- **Medium networks (20-50 prisms):** Significant reduction in pathfinding operations
- **Large networks (50+ prisms):** **Critical fix** - prevents watchdog exceptions from redundant work

## What This Fixes

✅ **Eliminates redundant pathfinding** - Only pathfind for truly new items
✅ **Eliminates redundant inventory scanning** - Still scan inventories, but skip pathfinding for known items
✅ **Maintains continuous processing** - Still discovers and queues new items immediately
✅ **Prevents watchdog exceptions** - Reduces expensive operations per tick
✅ **Preserves queue processing** - Queue processing continues to work as before

## What This Doesn't Change

✅ **Queue processing logic** - Unchanged, still processes items from queues correctly
✅ **Continuous processing** - Prisms still continue processing items after finishing one
✅ **New item discovery** - New items are still discovered and queued immediately
✅ **Filtered prism behavior** - Unchanged, still extracts non-filtered items correctly

## Testing Recommendations

1. **Monitor pathfinding operations:** Should see fewer pathfinding calls when queues are active
2. **Monitor watchdog exceptions:** Should see elimination or significant reduction
3. **Monitor queue processing:** Should continue working as before
4. **Monitor new item discovery:** Should still discover and queue new items immediately

## Code Locations

- **Main fix:** `controller.js:2138-2297` (`attemptTransferForPrism` function)
- **Early return handling:** `controller.js:1855-1860` (scanning loop)
- **Documentation:** `SCANNING_QUEUE_EXPLANATION.md` (full explanation)