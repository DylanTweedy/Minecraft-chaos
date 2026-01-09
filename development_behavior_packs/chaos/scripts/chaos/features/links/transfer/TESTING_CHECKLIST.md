# Transfer System Testing Checklist

## ✅ Pre-Testing Setup

- [ ] Load the world with the refactored transfer system
- [ ] Verify no console errors on startup
- [ ] Check that debug timing messages appear in chat (every 100 ticks by default)
- [ ] Verify timing format: `TIMING: Total=Xms | Cache=Xms | Queues=Xms | Inflight=Xms | FluxFX=Xms | Scan=Xms | Persist=Xms`

---

## 1. Basic Transfer Functionality

### 1.1 Simple Push Transfer
- [ ] Place a prism with an inventory (chest/furnace) containing items
- [ ] Place another prism with an empty inventory nearby
- [ ] Verify items transfer from source to destination
- [ ] Check that items are removed from source inventory
- [ ] Check that items appear in destination inventory
- [ ] Verify timing messages show reasonable values (< 50ms total typically)

### 1.2 Multi-Item Transfer
- [ ] Place multiple item types in source prism inventory
- [ ] Verify different item types transfer correctly
- [ ] Check that item amounts are preserved
- [ ] Verify no items are lost or duplicated

### 1.3 Long-Distance Transfer
- [ ] Create a network with prisms spanning multiple chunks
- [ ] Place items in source prism
- [ ] Verify items travel through intermediate prisms
- [ ] Check that items reach destination correctly
- [ ] Monitor timing - should still be reasonable even for long paths

---

## 2. Cache System

### 2.1 Cache Performance
- [ ] Watch debug messages for `blk=` (block lookups) count
- [ ] Verify block lookups decrease after initial scan (caching working)
- [ ] Break and replace a prism block
- [ ] Verify cache invalidates (lookups increase temporarily)
- [ ] Check `msCache` timing - should be minimal (< 5ms typically)

### 2.2 Cache Invalidation
- [ ] Place items in a prism inventory
- [ ] Verify transfer finds the inventory (cache hit)
- [ ] Remove the inventory block
- [ ] Verify system detects the change (cache invalidated)
- [ ] Check that no errors occur when accessing removed inventory

---

## 3. Pathfinding & Routing

### 3.1 Basic Pathfinding
- [ ] Create a simple network: Prism A → Prism B → Prism C
- [ ] Place items in Prism A
- [ ] Verify items route through Prism B to Prism C
- [ ] Check debug messages for `opts=` (output options) - should show available routes

### 3.2 Multiple Routes
- [ ] Create network with multiple paths to destination
- [ ] Verify system chooses a valid route
- [ ] Check that items don't get stuck in loops
- [ ] Verify `opts=` shows multiple options when available

### 3.3 Crystallizer Routes
- [ ] Place a crystallizer in the network
- [ ] Place flux items in a prism
- [ ] Verify flux routes to crystallizer
- [ ] Check that flux is processed correctly

---

## 4. Inventory Management

### 4.1 Multi-Inventory Support
- [ ] Attach multiple containers (chest + furnace) to a prism
- [ ] Place items in both containers
- [ ] Verify items from both containers can transfer
- [ ] Check that system correctly identifies all attached inventories

### 4.2 Filter/Attunement
- [ ] Attune a prism to specific item types
- [ ] Place both filtered and unfiltered items in source
- [ ] Verify only filtered items transfer to attuned prism
- [ ] Verify unfiltered items transfer to unattuned prisms

### 4.3 Full Container Handling
- [ ] Fill a destination container completely
- [ ] Attempt to transfer items to it
- [ ] Verify system detects full container (`full=` in debug)
- [ ] Check that items queue for later insertion
- [ ] Remove some items from container
- [ ] Verify queued items insert automatically

---

## 5. In-Flight Transfers

### 5.1 Orb Movement
- [ ] Start a transfer and watch the orb
- [ ] Verify orb moves along the path correctly
- [ ] Check that orb speed matches prism tier
- [ ] Verify orb reaches destination
- [ ] Check `msInflight` timing - should be reasonable

### 5.2 Multiple In-Flight Transfers
- [ ] Start multiple transfers simultaneously
- [ ] Verify all orbs move independently
- [ ] Check that no transfers interfere with each other
- [ ] Verify all transfers complete successfully
- [ ] Monitor `inflight=` count in debug messages

### 5.3 Transfer Completion
- [ ] Start a transfer
- [ ] Verify item appears in destination when orb arrives
- [ ] Check that reservation is released
- [ ] Verify no items are lost during transfer

---

## 6. Level/XP System

### 6.1 Prism Leveling
- [ ] Place items in a prism and let transfers occur
- [ ] Monitor `xfer=` count in debug messages
- [ ] Verify prism levels up after sufficient transfers
- [ ] Check that prism tier block ID changes (if applicable)
- [ ] Verify level-up burst FX appears

### 6.2 Transfer Amount Scaling
- [ ] Level up a prism
- [ ] Verify higher-level prisms transfer more items per transfer
- [ ] Check that `getTransferAmount()` scales correctly
- [ ] Monitor `stepTicks=` in debug - should decrease with level

### 6.3 Persistence
- [ ] Level up some prisms
- [ ] Save and reload the world
- [ ] Verify prism levels are preserved
- [ ] Check that transfer counts persist (`dp=` saves in debug)

---

## 7. FX System

### 7.1 Orb Spawning
- [ ] Start transfers and watch for orbs
- [ ] Verify orbs spawn at correct positions
- [ ] Check orb colors match item types
- [ ] Monitor `orbFx=` count in debug messages
- [ ] Verify `msFluxFx` timing is reasonable

### 7.2 Flux FX
- [ ] Transfer flux items
- [ ] Verify flux FX particles appear
- [ ] Check `fluxFxSp=` count in debug
- [ ] Verify FX doesn't lag the system

### 7.3 Level-Up Burst
- [ ] Level up a prism
- [ ] Verify level-up burst particles appear
- [ ] Check that burst doesn't cause performance issues

---

## 8. Refinement System

### 8.1 Prism Refinement
- [ ] Create a refinement chain (multiple prisms in path)
- [ ] Place items in source prism
- [ ] Verify items are refined as they pass through prisms
- [ ] Check that refined items reach destination

### 8.2 Speed Boost
- [ ] Place refined prisms in a transfer path
- [ ] Verify transfers move faster through refined prisms
- [ ] Check `stepTicks=` decreases with refinement
- [ ] Monitor timing - should improve with refinement

### 8.3 Exotic Routing
- [ ] Set up exotic item routing
- [ ] Verify exotic items route to correct destinations
- [ ] Check that routing logic works correctly

---

## 9. Queue System

### 9.1 Output Queues
- [ ] Fill a destination container
- [ ] Attempt to transfer more items
- [ ] Verify items queue for later insertion
- [ ] Check `qC=`, `qE=`, `qI=` in debug messages
- [ ] Remove items from container
- [ ] Verify queued items insert automatically
- [ ] Monitor `msQueues` timing

### 9.2 Full Container Detection
- [ ] Fill multiple containers
- [ ] Verify system tracks all full containers (`full=` in debug)
- [ ] Check that system retries when space becomes available
- [ ] Verify no items are lost

---

## 10. Persistence & State Management

### 10.1 In-Flight Persistence
- [ ] Start a transfer
- [ ] Save world before transfer completes
- [ ] Reload world
- [ ] Verify transfer continues from where it left off
- [ ] Check `dpSaves=` count in debug
- [ ] Monitor `msPersist` timing

### 10.2 Level Persistence
- [ ] Level up prisms
- [ ] Save and reload world
- [ ] Verify all levels are preserved
- [ ] Check that transfer counts persist

### 10.3 State Recovery
- [ ] Create transfers and queues
- [ ] Save and reload
- [ ] Verify all state recovers correctly
- [ ] Check that no errors occur on reload

---

## 11. Performance & Timing

### 11.1 Overall Performance
- [ ] Monitor `msTot=` (total time) in debug messages
- [ ] Verify total time stays reasonable (< 50ms typically, < 100ms under load)
- [ ] Check that system doesn't lag with many prisms
- [ ] Verify timing doesn't degrade over time

### 11.2 Module Timing Breakdown
- [ ] Check `msCache` - should be minimal (< 5ms)
- [ ] Check `msQueues` - should be reasonable (< 10ms typically)
- [ ] Check `msInflight` - scales with number of in-flight transfers
- [ ] Check `msFluxFx` - should be minimal unless many FX
- [ ] Check `msScan` - scales with number of prisms scanned
- [ ] Check `msPersist` - should be minimal unless saving

### 11.3 Load Testing
- [ ] Create a large network (20+ prisms)
- [ ] Start multiple simultaneous transfers
- [ ] Verify system handles load gracefully
- [ ] Check that timing remains reasonable
- [ ] Verify no crashes or errors occur

---

## 12. Error Handling

### 12.1 Missing Blocks
- [ ] Break a prism during an active transfer
- [ ] Verify system handles missing block gracefully
- [ ] Check that no errors appear in console
- [ ] Verify in-flight transfers are cleaned up

### 12.2 Missing Inventories
- [ ] Remove an inventory during transfer
- [ ] Verify system detects and handles the change
- [ ] Check that transfers reroute or cancel appropriately
- [ ] Verify no items are lost

### 12.3 Invalid States
- [ ] Create edge cases (empty networks, isolated prisms)
- [ ] Verify system handles gracefully
- [ ] Check that debug messages continue to work
- [ ] Verify no crashes occur

---

## 13. Debug Messages Verification

### 13.1 Message Format
- [ ] Verify debug messages appear every 100 ticks (default)
- [ ] Check that timing breakdown is clear and readable
- [ ] Verify all counters are updating correctly
- [ ] Check that message doesn't overflow chat

### 13.2 Counter Accuracy
- [ ] Manually count transfers and compare to `xfer=`
- [ ] Verify `inflight=` matches actual in-flight transfers
- [ ] Check that `scanned=` reflects prisms scanned
- [ ] Verify `opts=` shows correct route options

---

## 14. Integration Testing

### 14.1 With Other Systems
- [ ] Test with beam system (if applicable)
- [ ] Verify no conflicts with other chaos systems
- [ ] Check that crystallizer integration works
- [ ] Verify flux generation/refinement integration

### 14.2 World Save/Load
- [ ] Perform all above tests
- [ ] Save world
- [ ] Reload world
- [ ] Verify everything continues working
- [ ] Check that all state is preserved

---

## 🎯 Success Criteria

The refactored system is working correctly if:
- ✅ All basic transfers work
- ✅ Timing messages show reasonable values (< 50ms total typically)
- ✅ No console errors occur
- ✅ Cache system reduces lookups over time
- ✅ In-flight transfers complete successfully
- ✅ Level/XP system works
- ✅ FX spawns correctly
- ✅ State persists across saves
- ✅ System handles errors gracefully
- ✅ Performance is acceptable under load

---

## 📝 Notes

- Debug messages appear every 100 ticks by default (configurable via `debugTransferStatsIntervalTicks`)
- Timing is cumulative over the interval, then reset
- All timing values are in milliseconds
- If timing exceeds 100ms consistently, investigate performance bottlenecks
- Monitor `msTot` as the primary performance indicator
