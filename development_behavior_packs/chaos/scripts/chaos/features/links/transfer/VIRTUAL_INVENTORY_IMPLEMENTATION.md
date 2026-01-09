# Virtual Inventory System Implementation

## Overview

The Virtual Inventory Manager predicts future inventory state by accounting for pending operations:
- **In-flight transfers** heading to containers
- **Queued output items** waiting to be inserted  
- **Future: Queued input items** (when input queue system is implemented)

This prevents sending items to containers that will be full once pending operations complete, improving system efficiency and preventing failed transfers.

## Architecture

### Core Components

1. **Virtual Inventory Manager** (`core/virtualInventory.js`)
   - Tracks pending items per container by type
   - Calculates virtual capacity = current capacity - reservations - pending items
   - Updates state from in-flight transfers and output queues

2. **Extended Capacity Checks**
   - `getInsertCapacityWithReservations()` now accepts `virtualInventoryManager` parameter
   - `getInsertCapacityCached()` uses virtual inventory if manager is active
   - Type-specific capacity checks account for pending items of that type

3. **Integration Points**
   - Virtual inventory state updated each tick (after queues/in-flight process)
   - Capacity checks before starting transfers use virtual capacity
   - Cache disabled for capacity when virtual inventory is active (pending items change frequently)

## How It Works

### State Tracking

```javascript
// Pending items structure
Map<containerKey, {
  byType: Map<typeId, amount>,  // Pending items by type
  total: number                  // Total pending items
}>
```

### Update Flow

1. **Each Tick:**
   - Process queues (items may be inserted, reducing pending)
   - Process in-flight (items may finalize, reducing pending)
   - Update virtual inventory state from current inflight[] and queueByContainer
   - Scan for new transfers (uses virtual capacity)

2. **Capacity Check:**
   - Current capacity (from cache, accounts for reservations)
   - Subtract pending items (from virtual inventory)
   - Virtual capacity = current - pending
   - Only start transfer if virtual capacity >= desired amount

### Example Scenario

**Container A:**
- Current capacity: 32 slots available
- In-flight items: 16 items heading there
- Queued items: 8 items waiting to insert
- Virtual capacity: 32 - 16 - 8 = 8 slots

**When checking if container can accept 10 items:**
- Old system: ✅ Yes (32 > 10) → sends 10 items → container becomes full → 8 items fail
- New system: ❌ No (8 < 10) → doesn't send → waits until space available → all items succeed

## Benefits

1. **Prevents Overbooking**
   - No more failed transfers to containers that will be full
   - Reduces queue buildup
   - Better resource utilization

2. **Improved Efficiency**
   - Transfers only start when they will succeed
   - Reduces wasted pathfinding work
   - Better network utilization

3. **Accurate Predictions**
   - Accounts for all pending operations
   - Real-time state tracking
   - Type-specific accuracy

## Future Enhancements

1. **Input Queue Integration**
   - Track items queued for extraction from source containers
   - Account for source capacity reduction when queuing inputs
   - Complete end-to-end virtual inventory tracking

2. **Priority-Based Queueing**
   - Prioritize transfers based on virtual capacity
   - Higher priority for transfers that will succeed
   - Better load balancing

3. **Total Capacity Tracking**
   - Extend to total capacity checks (currently type-specific)
   - Update `fullContainers` set using virtual capacity
   - More accurate full container detection

## Configuration

Virtual inventory is **always active** when virtual inventory manager is created (currently always).

No configuration needed - automatically integrates with existing reservation system.

## Performance Impact

- **Memory**: Minimal (~100 bytes per container with pending items)
- **CPU**: O(1) lookups, O(n) updates (n = number of in-flight/queued items)
- **Expected**: Negligible overhead, significant reduction in failed transfers

## Testing

Test scenarios:
1. Fill container to near capacity
2. Start multiple transfers to same container
3. Verify virtual capacity prevents overbooking
4. Verify transfers succeed once pending items are inserted
5. Verify queue buildup is reduced
