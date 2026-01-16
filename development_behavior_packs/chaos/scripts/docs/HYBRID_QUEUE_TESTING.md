# Hybrid Queue System - Testing Plan

## Overview
This document provides comprehensive testing scenarios for the Hybrid Queue System, including prioritized push for filtered prisms, queue re-creation fixes, and integration testing.

---

## Test Categories

### 1. Core Functionality Tests
Basic queue creation, processing, and transfer execution

### 2. Prioritized Push Tests
Filtered prism routing with 20x priority weight

### 3. Queue Re-creation Tests
Verifying non-filtered items can be queued even if queue exists

### 4. Filtered Prism Behavior Tests
Export and receive behavior for filtered prisms

### 5. Integration Tests
Combined scenarios with multiple systems

### 6. Edge Case Tests
Error handling, boundary conditions, and unusual scenarios

---

## Test Scenarios

### Test 1.1: Basic Queue Creation
**Priority**: High  
**Goal**: Verify items are queued when found during scanning

**Steps**:
1. Place items in a container adjacent to a prism
2. Wait for scanning to detect items
3. Check diagnostic logs for: `[Scan] ✓ Found X item(s)`
4. Verify: `[Queue] ✓ Queued X item type(s)`
5. Check: `totalQueueSize > 0` in debug messages

**Success Criteria**:
- ✅ Items are detected during scanning
- ✅ Queue is created with correct item types
- ✅ Queue size increases as expected

**Expected Logs**:
- `[Scan] ✓ Found X item(s) in prism <key>: <item summary>`
- `[Queue] ✓ Queued X item type(s) for prism <key>`

---

### Test 1.2: Queue Processing
**Priority**: High  
**Goal**: Verify queues are processed each tick

**Steps**:
1. Create queue with items (from Test 1.1)
2. Wait for queue processing (next tick)
3. Check diagnostic logs for: `[Queue] Active: X queues`
4. Verify: `[Queue] Summary: processed=X, transfers=X, remaining=X`

**Success Criteria**:
- ✅ Queues are processed each tick when they exist
- ✅ Queue entries are validated
- ✅ Transfers are attempted from queues

**Expected Logs**:
- `[Queue] Active: X queues, budget: transfer=X, search=X`
- `[Queue] Summary: processed=X, transfers=X, remaining=X`

---

### Test 2.1: Prioritized Push - Single Filtered Prism
**Priority**: High  
**Goal**: Verify filtered items route to filtered prisms preferentially

**Steps**:
1. Create two prisms: 
   - Prism A: Filtered (wants ItemA)
   - Prism B: Unfiltered
2. Place ItemA in a third prism (Prism C)
3. Scan and route ItemA multiple times (10+ times)
4. Count how many times ItemA goes to Prism A vs Prism B

**Success Criteria**:
- ✅ ItemA routes to filtered Prism A ~95%+ of the time (due to 20x weight)
- ✅ ItemA routes to unfiltered Prism B <5% of the time
- ✅ Filtered prism receives ItemA correctly

**Expected Behavior**:
- Filtered prisms get 20x weight, so probability is ~20/(20+1) = ~95.2%
- In 10 routes, expect 9-10 to go to filtered prism, 0-1 to unfiltered prism

---

### Test 2.2: Prioritized Push - Multiple Filtered Prisms
**Priority**: Medium  
**Goal**: Verify filtered items distribute among multiple filtered prisms

**Steps**:
1. Create multiple filtered prisms (3-5), all wanting ItemA
2. Place ItemA in source prism
3. Route ItemA multiple times (20+ times)
4. Count distribution across filtered prisms

**Success Criteria**:
- ✅ ItemA routes to one of the filtered prisms (not unfiltered prisms)
- ✅ Distribution is roughly even among filtered prisms (weighted random)
- ✅ All filtered prisms can receive ItemA over time

**Expected Behavior**:
- All filtered prisms have same 20x weight, so distribution should be roughly even
- Weighted random means some variance is expected

---

### Test 2.3: Prioritized Push in Queue Processing
**Priority**: High  
**Goal**: Verify prioritization works when processing queues

**Steps**:
1. Create queue with filtered item (ItemA)
2. Create filtered prism wanting ItemA
3. Process queue (route ItemA from queue)
4. Verify ItemA routes to filtered prism preferentially

**Success Criteria**:
- ✅ Queue processing uses same prioritization logic
- ✅ Filtered items from queues route to filtered prisms with 20x weight
- ✅ Same behavior as immediate transfers

---

### Test 3.1: Queue Re-creation - Non-filtered Items
**Priority**: High  
**Goal**: Verify non-filtered items can be queued even if queue exists

**Steps**:
1. Create filtered prism with filter for ItemA
2. Place ItemB (non-filtered) in filtered prism's inventory
3. Wait for queue creation (ItemB should be queued)
4. While queue is active, add more ItemB to inventory
5. Verify new ItemB items are also queued

**Success Criteria**:
- ✅ Initial ItemB is queued correctly
- ✅ Additional ItemB items are queued even though queue exists
- ✅ Queue contains multiple entries for ItemB (or aggregated amounts)
- ✅ All ItemB items are exported eventually

**Expected Logs**:
- `[Scan] ✓ Found X item(s)` when new items added
- `[Queue] ✓ Queued X item type(s)` even if queue exists
- Queue size increases or amounts update

---

### Test 3.2: Queue Re-creation - Filtered Items Skipped
**Priority**: High  
**Goal**: Verify filtered items are NOT queued (routed via prioritized push instead)

**Steps**:
1. Create filtered prism with filter for ItemA
2. Place ItemA (filtered) in filtered prism's inventory
3. Check if ItemA is queued
4. Verify ItemA routes immediately via prioritized push instead

**Success Criteria**:
- ✅ ItemA is NOT queued (filtered items skip queueing)
- ✅ ItemA routes immediately when found during scanning
- ✅ ItemA routes to filtered prisms with 20x priority

**Expected Behavior**:
- Filtered items should NOT appear in queue
- Filtered items should route immediately during scanning
- Filtered items should prefer filtered prisms

---

### Test 4.1: Filtered Prism Export Behavior
**Priority**: High  
**Goal**: Verify filtered prisms export all non-filtered items continuously

**Steps**:
1. Create filtered prism with filter for ItemA
2. Place multiple non-filtered items (ItemB, ItemC, ItemD) in filtered prism
3. Verify all non-filtered items are queued
4. Wait for exports to complete
5. Add more non-filtered items while queue is active
6. Verify new items are also queued and exported

**Success Criteria**:
- ✅ All non-filtered items are queued when found
- ✅ Items are exported continuously (not blocked by active queue)
- ✅ New items are added to queue even if queue exists
- ✅ Filtered items (ItemA) are NOT queued, route via prioritized push

---

### Test 4.2: Filtered Prism Receive Behavior
**Priority**: High  
**Goal**: Verify filtered prisms receive filtered items via prioritized push

**Steps**:
1. Create filtered prism with filter for ItemA
2. Place ItemA in another prism (unfiltered)
3. Wait for scanning and routing
4. Verify ItemA routes to filtered prism preferentially
5. Verify ItemA appears in filtered prism's inventory

**Success Criteria**:
- ✅ ItemA routes to filtered prism ~95%+ of the time
- ✅ ItemA arrives in filtered prism's inventory
- ✅ Prioritized push works correctly

---

### Test 4.3: Mixed Operations - Export and Receive Simultaneously
**Priority**: High  
**Goal**: Verify filtered prisms can export and receive simultaneously

**Steps**:
1. Create filtered prism with filter for ItemA
2. Place ItemB (non-filtered) in filtered prism's inventory (for export)
3. Place ItemA (filtered) in another prism (for receiving)
4. Verify both operations work simultaneously:
   - ItemB queues and exports
   - ItemA routes to filtered prism via prioritized push

**Success Criteria**:
- ✅ ItemB is queued and exported correctly
- ✅ ItemA routes to filtered prism via prioritized push
- ✅ Both operations work within budget constraints
- ✅ No conflicts or interference

**Expected Behavior**:
- Queue processing and prioritized push routing work independently
- Both use separate budgets (queue budget vs search budget)
- System handles both operations gracefully

---

### Test 5.1: Integration with Virtual Inventory
**Priority**: Medium  
**Goal**: Verify prioritized push works with virtual inventory

**Steps**:
1. Create filtered prism with filter for ItemA
2. Fill filtered prism's inventory almost full (leave space for ItemA)
3. Create in-flight transfers heading to filtered prism
4. Place ItemA in source prism
5. Verify virtual inventory correctly predicts capacity
6. Verify ItemA routes to filtered prism only if virtual capacity allows

**Success Criteria**:
- ✅ Virtual inventory tracks incoming transfers
- ✅ Prioritized push respects virtual capacity
- ✅ Items don't route to full destinations

---

### Test 5.2: Integration with Event-Driven Scanning
**Priority**: Medium  
**Goal**: Verify prioritized push works with dirty prism scanning

**Steps**:
1. Create filtered prism with filter for ItemA
2. Place ItemA in another prism
3. Break and replace container adjacent to source prism (mark dirty)
4. Verify dirty prism is scanned
5. Verify ItemA routes to filtered prism when dirty prism is scanned

**Success Criteria**:
- ✅ Dirty prisms are scanned when queues exist
- ✅ Items found during dirty scans route correctly
- ✅ Prioritized push works for items found in dirty scans

---

### Test 6.1: Edge Case - Multiple Filtered Prisms with Different Filters
**Priority**: Medium  
**Goal**: Verify prioritization works with multiple different filters

**Steps**:
1. Create multiple filtered prisms:
   - Prism A: Filter for ItemA
   - Prism B: Filter for ItemB
   - Prism C: Filter for ItemA and ItemB
2. Place ItemA in source prism
3. Route ItemA multiple times
4. Verify ItemA routes to Prism A or Prism C (both have ItemA filter)
5. Verify ItemA does NOT route to Prism B (no ItemA filter)

**Success Criteria**:
- ✅ ItemA routes to prisms with ItemA filter only
- ✅ Prism C (has both filters) can receive ItemA
- ✅ Prism B (different filter) does NOT receive ItemA

---

### Test 6.2: Edge Case - Filtered Items in Filtered Prisms
**Priority**: Medium  
**Goal**: Verify filtered items in filtered prisms route correctly

**Steps**:
1. Create two filtered prisms, both with filter for ItemA:
   - Prism A: Has ItemA in inventory
   - Prism B: Empty, wants ItemA
2. Scan Prism A (has ItemA)
3. Verify ItemA does NOT get queued (it's filtered)
4. Verify ItemA routes immediately via prioritized push to Prism B
5. Verify ItemA appears in Prism B

**Success Criteria**:
- ✅ Filtered items in filtered prisms are NOT queued
- ✅ Filtered items route immediately via prioritized push
- ✅ Items route to other filtered prisms with matching filter

---

### Test 6.3: Edge Case - Budget Exhaustion
**Priority**: Low  
**Goal**: Verify system handles budget exhaustion gracefully

**Steps**:
1. Create many filtered prisms and source prisms
2. Create many queues and transfers
3. Monitor budgets in debug messages
4. Verify system doesn't crash when budgets exhausted
5. Verify operations resume when budgets available

**Success Criteria**:
- ✅ System handles budget exhaustion gracefully
- ✅ Operations pause when budgets exhausted
- ✅ Operations resume when budgets available
- ✅ No crashes or errors

---

## Testing Checklist

### Pre-Testing Setup
- [ ] Load world with Hybrid Queue System enabled
- [ ] Verify no console errors on startup
- [ ] Check debug messages appear (every 20 ticks by default)
- [ ] Verify timing format: `TIMING: Total=Xms | ... | InputQueues=Xms ...`

### Core Functionality
- [ ] Test 1.1: Basic Queue Creation
- [ ] Test 1.2: Queue Processing

### Prioritized Push
- [ ] Test 2.1: Single Filtered Prism
- [ ] Test 2.2: Multiple Filtered Prisms
- [ ] Test 2.3: Prioritized Push in Queue Processing

### Queue Re-creation
- [ ] Test 3.1: Non-filtered Items
- [ ] Test 3.2: Filtered Items Skipped

### Filtered Prism Behavior
- [ ] Test 4.1: Export Behavior
- [ ] Test 4.2: Receive Behavior
- [ ] Test 4.3: Mixed Operations

### Integration
- [ ] Test 5.1: Virtual Inventory Integration
- [ ] Test 5.2: Event-Driven Scanning Integration

### Edge Cases
- [ ] Test 6.1: Multiple Different Filters
- [ ] Test 6.2: Filtered Items in Filtered Prisms
- [ ] Test 6.3: Budget Exhaustion

---

## Success Criteria

The Hybrid Queue System is working correctly if:
- ✅ All basic queue operations work (creation, processing, transfer)
- ✅ Filtered items route to filtered prisms ~95%+ of the time
- ✅ Non-filtered items can be queued even if queue exists
- ✅ Filtered prisms export non-filtered items continuously
- ✅ Filtered prisms receive filtered items via prioritized push
- ✅ Both export and receive operations work simultaneously
- ✅ System handles edge cases gracefully
- ✅ No crashes or errors occur
- ✅ Performance remains reasonable (< 50ms total typically)

---

## Debug Logging Reference

### Key Log Messages to Monitor

**Queue Creation**:
- `[Scan] ✓ Found X item(s) in prism <key>: <summary>`
- `[Queue] ✓ Queued X item type(s) for prism <key>`

**Queue Processing**:
- `[Queue] Active: X queues, budget: transfer=X, search=X`
- `[Queue] Summary: processed=X, transfers=X, remaining=X`

**Route Selection** (Extended Debug):
- Route selection uses weighted random - check distribution matches expected (~95% to filtered prisms)

**Timing**:
- `TIMING: Total=Xms | InputQueues=Xms | ...`
- InputQueues timing should be reasonable (< 10ms typically)

---

## Notes

- Debug messages appear every 20 ticks by default (configurable via `debugTransferStatsIntervalTicks`)
- Extended debug messages (route selection details) require extended debug enabled
- Prioritized push uses weighted random, so results may vary slightly from exact percentages
- 20x weight means filtered prisms get ~95.2% probability: 20/(20+1) = 0.952
- In testing, expect 9-10 out of 10 routes to go to filtered prism (not 100% guaranteed due to randomness)
