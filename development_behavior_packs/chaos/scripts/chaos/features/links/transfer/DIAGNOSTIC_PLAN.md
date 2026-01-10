# Hybrid Queue System - Diagnostic Plan

## Current Situation
The Hybrid Queue System has been implemented (Phases 1-4) but is not working. We need to systematically diagnose why transfers aren't happening.

---

## Step 1: Add Diagnostic Logging

### Priority: Add logging to trace the flow

**Location**: `controller.js` - `onTick()` function

**What to log**:
1. **Queue Creation** (when items are found):
   ```javascript
   if (debugEnabled && inputQueuesManager) {
     console.log(`[Queue] Prism ${prismKey}: Found ${allItems.length} items, queued ${routesByType.size} types`);
   }
   ```

2. **Queue Processing** (each tick):
   ```javascript
   if (debugEnabled && inputQueuesManager) {
     const totalQueueSize = inputQueuesManager.getTotalQueueSize();
     if (totalQueueSize > 0) {
       console.log(`[Queue] Processing: totalQueueSize=${totalQueueSize}, processing ${inputQueueProcessed} entries`);
     }
   }
   ```

3. **Queue Entry Processing** (for each entry):
   ```javascript
   if (debugEnabled) {
     console.log(`[Queue] Processing entry: prism=${prismKey}, item=${queueEntry.itemTypeId}, remaining=${queueEntry.remainingAmount}`);
   }
   ```

4. **Transfer Attempts** (from queues):
   ```javascript
   if (debugEnabled) {
     console.log(`[Queue] Transfer result: ${transferResult.ok ? 'SUCCESS' : 'FAILED'} (${transferResult.reason}), amount=${transferResult.amount || 0}`);
   }
   ```

5. **Scanning Decisions**:
   ```javascript
   if (debugEnabled) {
     console.log(`[Scan] Decision: queues=${totalQueueSize}, dirty=${dirtyPrismsCount}, shouldScan=${shouldScan}, scanDirtyOnly=${scanDirtyOnly}`);
   }
   ```

---

## Step 2: Verify Queue Creation

### Check: Are items being queued when found?

**Test Points**:
1. Place items in a container next to a prism
2. Check if `enqueueInputStacks()` is called
3. Check if `inputQueuesManager.getTotalQueueSize() > 0`

**Potential Issues**:
- Queue creation logic not executing (scanning not finding items)
- Queue creation condition failing (`hasQueueForPrism` check)
- Route finding failing (no routes = no queue)

**Fix if needed**:
- Verify `attemptTransferForPrism()` queue creation path executes
- Check if `inputQueuesManager` is null/undefined
- Verify route finding works

---

## Step 3: Verify Queue Processing

### Check: Are queues being processed each tick?

**Test Points**:
1. Check if `totalQueueSize > 0` in queue processing section
2. Check if queue processing loop executes
3. Check if `getNextQueueEntry()` returns entries

**Potential Issues**:
- Queues not being processed (logic not executing)
- Queue entries invalid (validation failing)
- No queue entries found (queues empty or wrong prism)

**Fix if needed**:
- Verify queue processing section executes
- Check validation logic
- Verify queue entry retrieval

---

## Step 4: Verify Transfer Execution

### Check: Are transfers happening from queues?

**Test Points**:
1. Check if `attemptPushTransferWithDestination()` is called
2. Check if it returns success
3. Check if inflight jobs are created

**Potential Issues**:
- Transfer function not called
- Transfer function failing (capacity, validation, etc.)
- Inflight jobs not created

**Fix if needed**:
- Verify transfer function logic
- Check capacity calculations
- Verify inflight job creation

---

## Step 5: Check Integration Points

### Virtual Inventory
- Is `virtualInventoryManager` created? (Check for errors)
- Does `updateState()` get called?
- Does `getVirtualCapacity()` return correct values?

### Lazy Scanning
- Does `totalQueueSize > 0` prevent scanning?
- Are dirty prisms being scanned when queues exist?

### Event Handlers
- Do event handlers fire?
- Are prisms marked dirty correctly?

---

## Step 6: Common Issues to Check

### Issue 1: Queue Processing Budget Exhausted
**Symptom**: Queues exist but not processed
**Check**: `inputQueueTransferBudget` and `inputQueueSearchBudget` values
**Fix**: Increase budgets or check why they're exhausted

### Issue 2: Route Finding Failing
**Symptom**: Items found but not queued (no routes)
**Check**: Does `findPathForInput()` return results?
**Fix**: Verify pathfinding works, check network connectivity

### Issue 3: Virtual Capacity Blocking
**Symptom**: Transfers attempted but cancelled
**Check**: `getVirtualCapacity()` return values
**Fix**: Verify virtual inventory calculations

### Issue 4: Queue Entry Validation Failing
**Symptom**: Queue entries invalidated immediately
**Check**: `validateInputQueue()` results
**Fix**: Check validation logic, container/slot validity

### Issue 5: Queue Entry Updates Not Working
**Symptom**: Queue entries not depleting
**Check**: `updateQueueEntry()` calls and `remainingAmount` updates
**Fix**: Verify queue entry update logic

---

## Quick Diagnostic Commands

Add these to chat for quick checks:

```javascript
// Check queue status
const totalQueueSize = inputQueuesManager?.getTotalQueueSize() || 0;
console.log(`Total queue size: ${totalQueueSize}`);

// Check dirty prisms
const dirtyPrisms = virtualInventoryManager?.getDirtyPrisms() || new Set();
console.log(`Dirty prisms: ${dirtyPrisms.size}`);

// Check if queues exist for a specific prism
const hasQueue = inputQueuesManager?.hasQueueForPrism(prismKey) || false;
console.log(`Prism ${prismKey} has queue: ${hasQueue}`);
```

---

## Expected Flow (Working System)

1. **Item Found** → Queue created with route
2. **Next Tick** → Queue processed
3. **Queue Entry** → Validated, route found/cached
4. **Transfer** → Attempted, inflight job created
5. **Queue Updated** → Entry depleted or removed
6. **Repeat** → Until queue empty
7. **Scanning Resumes** → When queues empty

---

## Next Steps

1. **Add diagnostic logging** (Step 1)
2. **Run system and observe logs**
3. **Identify where flow breaks**
4. **Fix identified issues**
5. **Repeat until working**
