# Code Flow Analysis - Queue System

## Execution Flow in `onTick()`

### Line-by-Line Flow

1. **Line 1097**: `onTick()` starts
2. **Line 1098**: `nowTick++` increments
3. **Lines 1101-1111**: Logs "[TICK X] onTick() is running!" (first 5 ticks) ✅ **WORKING**
4. **Lines 1113-1120**: Cache updates, reset
5. **Lines 1122-1161**: Process output queues and in-flight transfers
   - This processes the 54 inflight jobs that were loaded
6. **Lines 1163-1181**: Update virtual inventory state
7. **Lines 1183-1189**: **Queue Processing Section Starts** - Initialize variables
8. **Lines 1185-1198**: **NEW** Log entry into queue processing section (first 50 ticks)
9. **Lines 1200-1216**: Log queue status (first 50 ticks, then every 5 ticks)
10. **Lines 1218-1405**: Process input queues (if any exist)
11. **Lines 1424-1432**: **Scanning Section Starts** - Get prism keys
12. **Line 1427-1436**: **NEW** Check if prisms exist, log count, early return if 0
13. **Lines 1438-1457**: Check if should scan (queues empty OR dirty prisms)
14. **Lines 1460-1477**: If shouldn't scan, log and return early
15. **Lines 1479-1508**: Determine which prisms to scan
16. **Lines 1510-1580**: Loop through prisms and call `attemptTransferForPrism()`
17. **Lines 1582-1629**: Scan processing continues
18. **Lines 1630-1645**: Persistence saves
19. **End of function**

## Critical Points Where Execution Might Stop

### Point 1: Line 1427 - No Prisms Found
```javascript
const prismKeys = getPrismKeys();
if (prismKeys.length === 0) return; // EARLY RETURN HERE
```

**If this returns early**: 
- No scanning happens
- No queue creation happens
- No diagnostic logs appear

**How to detect**: Look for log message `[Flow] getPrismKeys() returned X prisms`

### Point 2: Line 1460 - Scanning Skipped (Queues Active)
```javascript
if (!shouldScan) {
  // ... logging ...
  return; // EARLY RETURN HERE
}
```

**If this returns early**:
- Scanning doesn't happen
- But queue processing should still happen
- Should see "[Scan] Skipped" message

### Point 3: Queue Processing Section (Lines 1218-1405)
- Only executes if `inputQueuesManager` exists AND `totalQueueSize > 0`
- If no queues exist, this section is skipped

## What `getPrismKeys()` Does

1. Gets network stamp (for caching)
2. Checks cache
3. If not cached, calls `loadBeamsMap(world)` to get all beam/prism keys
4. Filters to only return prisms (not other blocks)
5. Caches result

**Potential Issues**:
- `loadBeamsMap()` might return empty object
- No prisms in the map
- Prisms exist but aren't detected as prisms (block type mismatch)

## Expected Log Sequence (Working System)

For ticks 1-5, you should see:
1. `[TICK X] onTick() is running!` ✅ (You see this)
2. `[Flow] Entering queue processing section` ✅ (NEW - should appear)
3. `[Tick X] Queue: size=0, prisms=Y, manager=true` ✅ (NEW - should appear)
4. `[Flow] getPrismKeys() returned X prisms` ✅ (NEW - should appear)
5. `[Scan Tick X] queues=0, dirty=0, shouldScan=true, prisms=X` ✅ (NEW - should appear)
6. `[Scan] Starting scan: queues=0, dirty=0, prisms=X` ✅ (NEW - should appear)
7. `[Scan] Scanning prism ...` ✅ (NEW - should appear)

## Diagnostic Questions

1. **Are prisms being detected?**
   - Check: `[Flow] getPrismKeys() returned X prisms`
   - If X = 0, prisms aren't being found

2. **Is queue processing section being reached?**
   - Check: `[Flow] Entering queue processing section`
   - If not appearing, execution stops before line 1185

3. **Is scanning section being reached?**
   - Check: `[Flow] getPrismKeys() returned X prisms`
   - If not appearing, execution stops before line 1426

4. **Is scanning being skipped?**
   - Check: `[Scan] Skipped: queues=X active`
   - If appearing, queues exist and scanning is intentionally skipped

5. **Are items being found?**
   - Check: `[Scan] ✓ Found X item(s)`
   - If not appearing, items aren't in containers OR containers aren't being scanned

## Next Steps to Diagnose

Run the system and check the logs for:

1. Does `[Flow] Entering queue processing section` appear? 
   - NO → Execution stops before line 1185 (check for exceptions)
   - YES → Continue to #2

2. Does `[Flow] getPrismKeys() returned X prisms` appear?
   - NO → Execution stops before line 1426 (check for early return)
   - YES, X = 0 → No prisms found (check `loadBeamsMap()`)
   - YES, X > 0 → Continue to #3

3. Does `[Scan] Starting scan` appear?
   - NO → Check `[Scan] Skipped` message to see why
   - YES → Continue to #4

4. Does `[Scan] Scanning prism ...` appear?
   - NO → Scanning loop isn't executing (check budget/backoff)
   - YES → Continue to #5

5. Does `[Scan] ✓ Found X item(s)` appear?
   - NO → Items not in containers OR containers not found
   - YES → Continue to #6

6. Does `[Queue] ✓ Queue created` appear?
   - NO → Route finding failed OR queue creation failed
   - YES → Queues are being created successfully!
