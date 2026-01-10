# Scanning and Queue System Explanation

## Overview
This document explains how the scanning and queue system works, and identifies the potential watchdog issues.

## How It Currently Works

### Phase 1: Queue Processing (Lines 1325-1640)
**When:** Every tick, BEFORE scanning
**What:** Processes items from input queues that were created in previous ticks
**How:**
1. Loops through all prisms that have active queues
2. Gets next queue entry (one item type per prism, or more for filtered prisms)
3. Finds path/route if not cached (expensive pathfinding operation)
4. Transfers the item from the queue
5. Updates queue entry (reduces `remainingAmount` or removes if depleted)

**Key Point:** Items in queues are ALREADY FOUND and have routes. We're just executing the transfers.

### Phase 2: Scanning (Lines 1755-1940)
**When:** Every tick, AFTER queue processing
**What:** Scans prisms to find NEW items and queue them for future processing
**How:**
1. Loops through prisms (up to `maxPrismsScannedPerTick`)
2. Checks if prism has cooldown (skips if on cooldown)
3. Calls `attemptTransferForPrism(prismKey)` which:
   - Scans ALL inventories for ALL items (expensive: `container.getItem()` for every slot)
   - Does pathfinding for ALL items found (expensive: `findPathForInput()` - can visit 120+ nodes)
   - Queues ALL items found (via `enqueueInputStacks()`)
   - `enqueueInputStacks()` skips items that are already queued (line 63 in inputQueues.js)

## THE PROBLEM: Redundant Work

### Issue #1: Scanning Prisms That Already Have Queues
**Problem:** We're scanning prisms that already have active queues, even though:
- Items are already found
- Routes may already be cached in queue entries
- Queue processing is already handling these items

**Example Flow:**
```
Tick 1:
  - Scan Prism A → Find items [Iron, Gold, Stone]
  - Do pathfinding for all 3 items (expensive!)
  - Queue all 3 items
  - Queue processing: Transfer Iron (removes Iron from queue)

Tick 2:
  - Queue processing: Transfer Gold (removes Gold from queue)
  - Scan Prism A AGAIN → Find items [Iron, Gold, Stone] (same items!)
  - Do pathfinding AGAIN for Gold and Stone (expensive! redundant!)
  - Try to queue all 3 items (Iron gets skipped, Gold gets skipped, Stone gets queued)
  - But wait - Gold was just transferred, so it might still be in the prism!
```

### Issue #2: Pathfinding Even When Items Are Already Queued
**Problem:** In `attemptTransferForPrism()`, we do pathfinding for ALL items found, even if they're already queued:
- Line 2182: `findPathForInput(prismKey, nowTick)` - This is EXPENSIVE (visits 120+ nodes)
- Line 2189-2215: We create routes for all items
- Line 2232: We queue items (but `enqueueInputStacks` skips already-queued types)
- **But we already did the expensive pathfinding!**

### Issue #3: Scanning ALL Inventories Every Time
**Problem:** We scan ALL inventories and ALL slots every time we scan a prism:
- Line 2145-2167: Loop through all inventories and all slots
- Calls `container.getItem(slot)` for EVERY slot (expensive I/O)
- Even if we skip already-queued items later, we still did all the inventory scanning

## What Happened When Watchdog Exceptions Started

### Before the Recent Changes:
1. **Scanning was SKIPPED when queues existed** (line 1757: `shouldScan = scanQueueSize === 0`)
   - This was GOOD - it prevented redundant work
   - But it meant prisms wouldn't discover NEW items until queues were empty

2. **Problem:** Prisms would process one item, then wait for queues to empty before scanning again
   - This caused the "prism doesn't continue balancing" issue you reported

### After Recent Changes (to fix continuous processing):
1. **Scanning ALWAYS happens** (line 1759: `shouldScan = true`)
   - This fixes continuous processing
   - BUT it re-introduces the redundant work problem!

2. **Now we're doing:**
   - Scanning prisms with active queues (redundant)
   - Pathfinding for already-queued items (redundant)
   - Inventory scanning for items we already know about (redundant)

3. **Result:** Watchdog exceptions because:
   - We're doing expensive pathfinding every tick
   - We're scanning inventories even when items are already queued
   - This adds up to a lot of work per tick

## The Root Cause

**We're trying to solve two conflicting goals:**
1. **Continuous Processing:** Prisms should continue processing items after finishing one
2. **Performance:** We shouldn't do redundant work (scanning/pathfinding for already-queued items)

**Current Solution (BAD):**
- Always scan → Fixes continuous processing but causes watchdog issues
- Skip already-queued items in queue → Prevents duplicate queues but doesn't prevent redundant scanning/pathfinding

## Better Solution

### Option 1: Smart Scanning (Recommended)
Only scan prisms that DON'T have active queues, OR only scan for items NOT in queue:
```
if (hasActiveQueue) {
  // Skip expensive scanning - queue processing handles it
  // BUT: Allow scanning dirty prisms (items changed)
  if (!isDirty) continue;
  // OR: Only scan for items NOT in queue
}
```

### Option 2: Incremental Queue Updates
When scanning, only add NEW items to queue (items not already queued):
- Skip items already in queue (current behavior)
- But also: Skip expensive pathfinding if item is already queued
- Check queue BEFORE doing pathfinding

### Option 3: Hybrid Approach
- Scan prisms with active queues but ONLY for items NOT in queue
- Use cached routes from existing queue entries
- Only do pathfinding for truly new items

## Recommended Fix

**The fix should be in `attemptTransferForPrism()`:**
1. Check if items are already queued BEFORE doing expensive operations
2. Skip pathfinding for already-queued items
3. Only queue truly new items

**Specifically:**
- Before line 2176 (pathfinding), check if items are already queued
- Only do pathfinding for items NOT in queue
- This prevents expensive pathfinding operations that are redundant

## Current Behavior Summary

**What We're Scanning For:**
- ALL items in ALL inventories of a prism
- Even if those items are already queued
- Even if those items are being transferred

**When We Queue Items:**
- Every time we scan a prism (if items found)
- Even if items are already queued (they get skipped in `enqueueInputStacks`)
- Even while items are being transferred from queue

**The Redundancy:**
- Pathfinding: Done even if items already queued ✅ (expensive, redundant)
- Inventory scanning: Done even if items already queued ✅ (expensive, redundant)
- Queue creation: Skipped if already queued ✅ (good, prevents duplicates)

**The Fix Needed:**
- Check queue BEFORE pathfinding ❌ (not currently done)
- Check queue BEFORE inventory scanning ❌ (not currently done)
- Only scan for items NOT in queue ❌ (not currently done)