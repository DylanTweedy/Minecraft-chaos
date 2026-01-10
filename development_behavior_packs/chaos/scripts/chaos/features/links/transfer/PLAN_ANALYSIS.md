# Plan Analysis: Potential Problems & Solutions

## Critical Issues

### 1. **Multiple Item Types Per Prism** 🔴 CRITICAL

**Problem:**
- Current system picks ONE random item type per prism (see `getRandomItemFromInventories()`)
- Plan queues only ONE item type per prism
- **Missing items**: If a prism has wood (64) + stone (64) + iron (64), we only queue wood
- Other item types never get transferred until wood is depleted

**Example:**
```
Prism A inventory: [wood: 64, stone: 64, iron: 64]
Scan finds: wood (picked randomly)
Queue: [{ itemTypeId: "wood", remainingAmount: 64 }]
Problem: Stone and iron never queued, never transferred
```

**Solutions:**
- **Option A**: Queue ALL item types found (one queue entry per type)
  - Pro: No items missed
  - Con: More queue entries, more complex management
- **Option B**: Queue one type, but re-scan when queue depletes (hybrid)
  - Pro: Simpler queue management
  - Con: Still need periodic scanning
- **Option C**: Queue by priority (filtered items first, then random)
  - Pro: Better for filtered/attuned prisms
  - Con: More complex logic

**Recommendation**: Option A - Queue all types, process in priority order

---

### 2. **Event Coverage Gap** 🔴 CRITICAL

**Problem:**
- Minecraft Bedrock API has NO direct inventory change events
- Only block change events (`playerPlaceBlock`, `playerBreakBlock`)
- **Hoppers/automation won't trigger events** - items can change without events
- **Player interactions might not detect all changes** - itemUseOn might miss some

**Example:**
```
Hopper feeds chest → items change → NO event fired
Player breaks/places blocks → events fired ✓
Player opens chest, takes items → itemUseOn fired? → might work
Automation system → NO events fired
```

**Impact:**
- Virtual inventory state will drift if only relying on events
- Validation becomes CRITICAL to catch missed changes

**Solutions:**
- **Option A**: Aggressive validation (every 50 ticks instead of 100)
  - Pro: Catches drift faster
  - Con: More expensive (validation = scanning)
- **Option B**: Hybrid approach - events + periodic scanning
  - Events mark dirty, but also periodic full scan every N ticks
  - Pro: Catches missed events
  - Con: Still some scanning overhead
- **Option C**: Track "last touched" timestamp for containers
  - If container hasn't been touched recently, assume stale
  - Pro: Smart validation scheduling
  - Con: Complex tracking

**Recommendation**: Option B - Events mark dirty, but periodic validation/scanning as fallback

---

### 3. **Lazy Scanning Race Condition** 🟡 MODERATE

**Problem:**
- Plan only scans when `inputQueues.getTotalQueueSize() === 0`
- If queues never empty (high throughput), new items never discovered
- Items added via hoppers/automation while queue processing won't be found

**Example:**
```
Tick 1: Queue created (64 items)
Tick 2-100: Queue processing (items depleting slowly)
Tick 50: Hopper adds 32 more items to inventory
Problem: New items never discovered until queue empties (tick 100+)
```

**Solutions:**
- **Option A**: Scan dirty prisms even when queue not empty (but limit)
  - Process queues first, then scan up to N dirty prisms
  - Pro: New items discovered even with active queues
  - Con: Some scanning overhead
- **Option B**: Check if new items added to existing queue entries
  - Validate queue entries periodically, detect new items
  - Pro: More targeted
  - Con: Complex validation logic
- **Option C**: Hybrid - events mark dirty, scan dirty even with queues
  - Events catch most changes, validation catches rest
  - Pro: Best coverage
  - Con: Most complex

**Recommendation**: Option A - Scan dirty prisms even with active queues (limited budget)

---

### 4. **Route Invalidation While Queued** 🟡 MODERATE

**Problem:**
- Queue entries cache routes
- Routes can become invalid while queued (prism broken, network changed)
- Using invalid route causes transfers to fail

**Example:**
```
Tick 1: Queue created with route [A→B→C]
Tick 2-10: Queue processing (transfer in progress)
Tick 5: Prism B broken
Tick 6: Transfer uses cached route [A→B→C] → FAILS (B doesn't exist)
```

**Solutions:**
- **Option A**: Validate route before each transfer
  - Check if all blocks in route still exist
  - Pro: Prevents failures
  - Con: Route validation overhead
- **Option B**: Re-queue if route invalid
  - Find new route, re-queue entry
  - Pro: Automatic recovery
  - Con: Might create loops if no route exists
- **Option C**: Invalidate route on block changes
  - Events mark route as invalid, re-find before using
  - Pro: Proactive
  - Con: Complex event tracking

**Recommendation**: Option A + C - Validate before use, invalidate on events

---

### 5. **Virtual Inventory State Drift** 🟡 MODERATE

**Problem:**
- Per-type totals lose slot-specific granularity
- Multiple slots with same type = accurate
- But slot-specific issues (full slots, partial stacks) not tracked

**Example:**
```
Container: [wood: 64, wood: 32, wood: 1] = 97 wood total
Virtual: { wood: 97 } ✓ Accurate for totals
But: Can't track which slot has space (slot 1 full, slot 2 has 32, slot 3 has 1)
Issue: Might try to insert 64 into slot that only has 1 space
```

**Impact:**
- Capacity checks might be inaccurate for slot-specific operations
- But per-type is sufficient for "can this container accept X items of type Y?"

**Solutions:**
- **Option A**: Keep per-type (simpler, sufficient for capacity checks)
  - Pro: Simple, low memory
  - Con: Less accurate for slot-specific operations
- **Option B**: Track per-slot (more accurate, more memory)
  - Pro: More accurate
  - Con: Higher memory usage, more complex
- **Option C**: Hybrid - per-type with slot hints
  - Track totals + "has empty slots" flag
  - Pro: Balance
  - Con: Still some inaccuracy

**Recommendation**: Option A - Per-type is sufficient for capacity checks, slot-specific operations use actual inventory

---

### 6. **Validation Overhead** 🟡 MODERATE

**Problem:**
- Validation requires scanning inventories (expensive)
- Plan validates every 100 ticks
- If validating all containers, could take 50-100ms+ per validation cycle
- Validation itself might cause performance issues

**Example:**
```
100 containers with virtual state
Validation: Scan all 100 containers = 100 inventory scans
Each scan: ~0.5-1ms = 50-100ms total per validation cycle
Validation every 100 ticks = adds 0.5-1ms per tick on average
```

**Solutions:**
- **Option A**: Validate only containers with pending items
  - Only validate if virtual state predicts pending operations
  - Pro: Fewer validations
  - Con: Might miss drift in idle containers
- **Option B**: Validate in batches (10 per tick)
  - Spread validation over 10 ticks (10 containers per tick)
  - Pro: Smooth overhead
  - Con: Slower drift detection
- **Option C**: Validate on-demand (when capacity check fails)
  - If virtual capacity says full but actual insert succeeds → validate
  - Pro: Only validate when needed
  - Con: Reactive, not proactive

**Recommendation**: Option B - Batch validation (10 per tick), prioritize containers with pending items

---

### 7. **Queue Entry Validation Complexity** 🟡 MODERATE

**Problem:**
- Queue entries need validation (slot still has items, route still valid, etc.)
- Validation overhead might be similar to just scanning
- Complex validation logic might be error-prone

**Example:**
```
Queue entry: { itemTypeId: "wood", slot: 2, remainingAmount: 64 }
Validation: Check slot 2 has wood, check route valid, check destination available
Overhead: ~3-5 checks per entry = might be similar to just scanning
```

**Solutions:**
- **Option A**: Simple validation (just check slot exists and has items)
  - Quick check before using queue entry
  - Pro: Fast
  - Con: Might miss route changes
- **Option B**: Comprehensive validation (slot + route + destination)
  - Full validation before each transfer
  - Pro: Accurate
  - Con: Expensive
- **Option C**: Lazy validation (validate only when needed)
  - Try transfer, if fails then validate and re-queue
  - Pro: Only validate on failure
  - Con: Reactive, might cause failed transfers

**Recommendation**: Option A + B hybrid - Quick slot check always, full route check periodically

---

### 8. **Multi-Inventory Tracking** 🟡 MODERATE

**Problem:**
- Prisms can have multiple containers attached
- Virtual inventory tracks per-container, not per-prism
- Queue tracks per-prism
- Mismatch: Need to track which containers belong to which prism

**Example:**
```
Prism A has: [chest1, chest2, furnace]
Chest1: { wood: 64 }
Chest2: { stone: 64 }
Furnace: { iron: 64 }

Queue: [{ prismKey: "A", itemTypeId: "wood", containerKey: "chest1", ... }]
Problem: Need to track that chest1 belongs to prism A
If chest1 broken: Mark prism A dirty, but which queue entry affected?
```

**Solutions:**
- **Option A**: Track container→prism mapping
  - Map<containerKey, prismKey> to find which prism owns container
  - Pro: Direct lookup
  - Con: Need to maintain mapping
- **Option B**: Queue tracks both containerKey and prismKey
  - Queue entry has both, can invalidate by either
  - Pro: No mapping needed
  - Con: Queue entries larger
- **Option C**: Validate queue entries lazily
  - Only check when processing, invalidate if container/prism missing
  - Pro: Simple
  - Con: Reactive

**Recommendation**: Option B - Queue entries track both, can invalidate by either

---

### 9. **Initial State Discovery** 🟡 MODERATE

**Problem:**
- On startup, no queues exist, no dirty prisms marked
- How do we discover initial state?
- If we wait for events, existing items might never be found

**Example:**
```
World loads with 100 prisms, 50 have items
No queues, no dirty flags
Events only fire on changes (not on load)
Problem: Existing items never discovered until something changes
```

**Solutions:**
- **Option A**: Initial scan on startup
  - Scan all prisms once on startup to populate queues
  - Pro: Discover all items
  - Con: One-time startup cost (acceptable)
- **Option B**: Mark all prisms dirty on startup
  - First tick scans all dirty prisms (all prisms)
  - Pro: Simple
  - Con: One-time startup scan
- **Option C**: Lazy discovery (wait for first event)
  - Only scan when first change detected
  - Pro: Zero startup cost
  - Con: Existing items might never be found

**Recommendation**: Option A or B - One-time initial scan is acceptable for startup

---

### 10. **Dirty Flag Cleanup** 🟡 MODERATE

**Problem:**
- Dirty flags accumulate over time
- Need cleanup mechanism to prevent unbounded growth
- Old dirty flags that never get scanned will accumulate

**Example:**
```
Prism marked dirty but never scanned (queue always full)
Dirty flag persists forever
Memory leak: dirtyPrisms Set grows unbounded
```

**Solutions:**
- **Option A**: Age-based cleanup (remove old dirty flags)
  - If dirty for >N ticks, remove flag (assume stale)
  - Pro: Prevents unbounded growth
  - Con: Might miss some changes
- **Option B**: Limit dirty set size
  - If dirtyPrisms.size > MAX, remove oldest
  - Pro: Bounded memory
  - Con: Might drop important dirty flags
- **Option C**: Periodic full scan as fallback
  - Every 1000 ticks, scan all prisms (not just dirty)
  - Pro: Catches missed changes
  - Con: Periodic scanning overhead

**Recommendation**: Option C - Periodic full scan as safety net (every 1000 ticks = minimal overhead)

---

### 11. **Virtual Inventory Update Timing** 🟡 MODERATE

**Problem:**
- Plan says "update actual state only on events/scans"
- But when do we update pending items?
- Timing mismatch: actual state updated rarely, pending updated each tick

**Example:**
```
Tick 1: Scan finds { wood: 64 } → actual state updated
Tick 2-50: Pending items updated each tick (in-flight + queued)
Tick 25: Player takes 32 wood → NO event → actual state still says 64
Tick 50: Validation finds drift → actual state updated
Problem: Virtual capacity wrong for 25 ticks (thinks has 64, actually has 32)
```

**Solutions:**
- **Option A**: Update actual state on validation failures
  - When validation detects drift, immediately update actual state
  - Pro: Accurate after drift
  - Con: Still wrong until validation
- **Option B**: Update actual state when queue entries validate
  - When validating queue entry, also update actual state for that container
  - Pro: More frequent updates
  - Con: Validation overhead
- **Option C**: Track "last touched" timestamp
  - If container not touched recently, assume stale, rescan
  - Pro: Smart scheduling
  - Con: Complex

**Recommendation**: Option A + periodic validation - Update on validation failures, validate frequently

---

### 12. **Queue Processing Order** 🟡 LOW-MODERATE

**Problem:**
- Plan doesn't specify queue processing order
- FIFO vs priority-based vs random
- Affects fairness and throughput

**Example:**
```
Prism A: Queue [wood: 64, stone: 64, iron: 64]
Processing order matters:
- FIFO: Process wood first, stone/iron wait
- Priority: Process filtered items first
- Random: Unpredictable
```

**Solutions:**
- **Option A**: FIFO (first queued, first processed)
  - Simple, fair
  - Pro: Predictable
  - Con: Might not be optimal
- **Option B**: Priority-based (filtered items first)
  - Process items matching filters first
  - Pro: Better for filtered/attuned systems
  - Con: More complex
- **Option C**: Round-robin (process one item from each type)
  - Process wood(1), stone(1), iron(1), then repeat
  - Pro: Fair across types
  - Con: More complex

**Recommendation**: Option A - FIFO is simplest, can enhance later if needed

---

### 13. **Route Reuse Strategy** 🟡 LOW-MODERATE

**Problem:**
- Plan caches routes in queue entries
- Route reuse reduces pathfinding, but routes might be suboptimal
- Same route used for entire stack might not be best for later items

**Example:**
```
Queue: { itemTypeId: "wood", route: [A→B→C], remainingAmount: 64 }
First transfer: Uses route [A→B→C] ✓
Second transfer: Route [A→B→C] still valid, but maybe [A→D→C] is shorter now
Problem: Stuck with initial route, might miss better routes
```

**Solutions:**
- **Option A**: Reuse route until invalid
  - Use cached route unless invalidated
  - Pro: Fast, simple
  - Con: Might miss better routes
- **Option B**: Re-find route periodically (every N transfers)
  - Re-validate route, re-find if better available
  - Pro: Better routes
  - Con: Pathfinding overhead
- **Option C**: Re-find route when destination changes
  - If destination becomes full, re-find route to new destination
  - Pro: Adaptive
  - Con: Complex

**Recommendation**: Option A - Reuse route until invalid, re-find only on failure

---

### 14. **Capacity Prediction Accuracy** 🟡 LOW

**Problem:**
- Virtual capacity = current - reservations - pending
- But capacity calculation itself might be inaccurate (slot-specific issues)
- Per-type totals might miss slot-level details

**Example:**
```
Container: [wood: 64, wood: 64, wood: 64, empty, empty]
Actual capacity: 2 slots (128 items)
Virtual capacity: 3 slots × 64 = 192 items (overestimated)
Issue: Might queue more items than can fit
```

**Solutions:**
- **Option A**: Use conservative estimates (underestimate capacity)
  - Account for slot fragmentation in capacity calculation
  - Pro: Prevents overbooking
  - Con: Underutilizes space
- **Option B**: Use actual capacity check when queuing
  - Check actual capacity before queuing, not just virtual
  - Pro: Accurate
  - Con: Requires scanning (defeats purpose?)
- **Option C**: Track slot-level state (not just per-type)
  - More accurate but more complex
  - Pro: Accurate
  - Con: Complex, more memory

**Recommendation**: Option A - Conservative estimates, validate on actual insert failures

---

### 15. **Memory Leaks** 🟡 LOW

**Problem:**
- Virtual inventory state persists indefinitely
- Queue entries accumulate if never processed
- Dirty flags accumulate if never scanned
- Old state never cleaned up

**Example:**
```
Container broken → virtual state remains in memory forever
Queue entry for deleted prism → remains forever
Dirty flag for broken prism → remains forever
Memory leak: Maps/Sets grow unbounded
```

**Solutions:**
- **Option A**: Cleanup on container/prism removal
  - Events mark containers/prisms as removed, clean up state
  - Pro: Immediate cleanup
  - Con: Need to track removals
- **Option B**: Age-based cleanup
  - Remove entries not touched for >N ticks
  - Pro: Automatic cleanup
  - Con: Might remove active but idle entries
- **Option C**: Size-based cleanup
  - If Maps/Sets exceed size limit, remove oldest
  - Pro: Bounded memory
  - Con: Might remove active entries

**Recommendation**: Option A + B - Cleanup on events, age-based cleanup as fallback

---

## Architectural Concerns

### 16. **State Synchronization Complexity** 🟡 MODERATE

**Problem:**
- Multiple state systems: queues, virtual inventory, dirty flags, in-flight
- Need to keep all synchronized
- Complex dependency graph

**Example:**
```
Item transferred → update in-flight → update virtual inventory pending → update queue remainingAmount
Item arrives → update virtual inventory actual → clear reservation → update queue
Container broken → mark dirty → invalidate queue → clear virtual inventory → clear reservations
Many moving parts, easy to miss updates
```

**Solution**: Clear state update flow, single source of truth for each piece of state

---

### 17. **Validation vs Scanning Trade-off** 🟡 MODERATE

**Problem:**
- Validation requires scanning (expensive)
- If validation is too frequent, overhead approaches full scanning
- If validation is too rare, state drift accumulates

**Balance:**
- Validation every 100 ticks = ~1% overhead per tick (acceptable)
- Validation every 50 ticks = ~2% overhead per tick (might be too much)
- Validation every 200 ticks = ~0.5% overhead but more drift

**Solution**: Start with 100 ticks, adjust based on testing

---

### 18. **Edge Case: Rapid Changes** 🟡 LOW-MODERATE

**Problem:**
- If container changes rapidly (hoppers adding/removing items constantly)
- Events might fire faster than we can process
- Dirty flags might never clear

**Example:**
```
Hopper adding/removing items every tick
Event fires every tick → mark dirty every tick
Queue processes, but container changes again before scanned
Dirty flag never clears, system keeps trying to scan
```

**Solution**: Rate limiting - don't mark dirty if already marked in last N ticks

---

## Summary of Critical Issues

### Must Fix Before Implementation:

1. **Multiple Item Types** (Issue #1) - Queue all types, not just one
2. **Event Coverage Gap** (Issue #2) - Add periodic scanning as fallback
3. **Lazy Scanning Race** (Issue #3) - Scan dirty prisms even with active queues (limited)

### Should Fix During Implementation:

4. **Route Invalidation** (Issue #4) - Validate routes before use
5. **Validation Overhead** (Issue #6) - Batch validation (10 per tick)
6. **Multi-Inventory Tracking** (Issue #8) - Queue entries track both containerKey and prismKey

### Nice to Have / Can Fix Later:

7. **Virtual Inventory Drift** (Issue #5) - Per-type is acceptable, validate frequently
8. **Queue Validation** (Issue #7) - Simple validation is sufficient
9. **Initial State** (Issue #9) - One-time startup scan
10. **Dirty Flag Cleanup** (Issue #10) - Periodic full scan as fallback

---

## Recommended Changes to Plan

### Change 1: Queue All Item Types

**Modify Phase 1:**
- When scanning prism, find ALL item types, queue ALL of them
- Queue structure: `Map<prismKey, Array<InputQueueEntry>>` where array has one entry per item type
- Process queues in priority order (filtered items first, then random)

### Change 2: Hybrid Event + Periodic Scanning

**Modify Phase 3 & 4:**
- Events mark dirty (primary)
- Periodic full scan every 1000 ticks as fallback (safety net)
- Scan dirty prisms even when queue not empty (limited budget: max 2 dirty prisms per tick)

### Change 3: Validation Batching

**Modify Phase 5:**
- Validate in batches: 10 containers per tick
- Spread validation over 10 ticks (100 containers validated per 100-tick cycle)
- Prioritize containers with pending items

### Change 4: Route Validation

**Add to Phase 1:**
- Validate route before each transfer
- Quick check: verify all blocks in route still exist
- If invalid, re-find route or re-queue entry

### Change 5: State Cleanup

**Add to all phases:**
- Cleanup virtual inventory state when containers removed (via events)
- Age-based cleanup: remove entries not touched for >1000 ticks
- Size-based limits: max 500 containers in virtual inventory state

---

## Risk Assessment

**High Risk:**
- Event coverage gap → state drift → failed transfers
- Multiple item types → items missed → incomplete transfers

**Medium Risk:**
- Validation overhead → performance issues
- Route invalidation → failed transfers
- State synchronization → bugs

**Low Risk:**
- Memory leaks → long-term issues (fixable)
- Queue processing order → fairness issues (not critical)

---

## Testing Priorities

1. **Multiple Item Types** - Test with prism having 3+ different item types
2. **Event Coverage** - Test with hoppers/automation (no events)
3. **Queue Depletion** - Test with high-throughput scenarios
4. **Route Invalidation** - Test with network topology changes
5. **Validation Accuracy** - Test validation detects drift correctly
