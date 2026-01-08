# Agent Handoff: Minecraft Bedrock Chaos Prism Transfer System

## Current Status: ❌ CRITICAL ISSUE - "No Prisms Found"

**The Problem**: The transfer system is not working because `getPrismKeys()` returns 0 prisms, even though prisms are visible in-game and should be registered in the beams map.

**Debug Output**: The debug messages show:
- `[Transfer] Inflight: 4 active transfers`
- `[Transfer] No prisms found! Tick: 300` (and similar for other ticks)

This indicates that:
1. There ARE inflight transfers (so prisms existed at some point)
2. But `getPrismKeys()` cannot find any prisms in the beams map right now

## Root Cause Investigation

The issue is in `getPrismKeys()` (controller.js, line ~680). This function:
1. Loads the beams map from world dynamic properties (`DP_BEAMS`)
2. Iterates through all keys in the map
3. Uses `resolveBlockInfoCached()` to look up each block
4. Filters to only return keys where `block.typeId === PRISM_ID`

**Hypothesis**: Either:
- The beams map is empty (prisms not being registered)
- Block lookups are failing (blocks removed, dimension issues, cache issues)
- Keys in map don't correspond to actual prisms (wrong block types)
- Key format mismatch between beam system and transfer system

## Recent Debugging Attempts

1. **Fixed `'stamp' is not defined` error** - moved `stamp` variable declaration outside if block
2. **Added fallback to `resolveBlockInfo()`** - direct block lookup if cache fails
3. **Enhanced debug messages in `getPrismKeys()`** - now shows:
   - Total keys in beams map
   - Number of prisms found
   - Number with wrong block type
   - Number of failed lookups
   - Number of parse failures
   - Sample debug for first 3 failures (every 200 ticks)

**But**: User reports "nothing" - either debug messages aren't showing or showing empty results.

## Architecture Overview

### Two Storage Systems (Potential Issue?)

There are TWO separate storage modules that both use `DP_BEAMS`:
1. **Beam System**: `beam/storage.js` - has `loadBeamsMap()`, `saveBeamsMap()`, `key()`, `parseKey()`
2. **Transfer System**: `transfer/storage.js` - also has `loadBeamsMap()` (imports `DP_BEAMS` from config)

Both should be loading from the same dynamic property, but they use different `key()` and `parseKey()` functions from different modules. The format appears identical (`dimId|x,y,z`), but worth verifying.

### Key Functions

**`getPrismKeys()`** (controller.js ~680):
- Loads beams map via `loadBeamsMap(world)` from `transfer/storage.js`
- Gets all keys from map: `Object.keys(map || {})`
- For each key:
  - Parses with `parseKey()` from `transfer/keys.js`
  - Looks up block with `resolveBlockInfoCached()` (uses cache)
  - Checks if `block.typeId === PRISM_ID`
- Returns array of prism keys

**`resolveBlockInfoCached()`** (controller.js ~205):
- Uses `blockCache` Map (cleared each tick)
- Parses key with `parseKey()` from `transfer/keys.js`
- Gets dimension with `getDimensionCached()` (also cached)
- Gets block with `dim.getBlock({ x, y, z })`
- Caches result (even null failures) for the tick

**`handlePrismPlaced()`** (beam/events.js ~123):
- Called when prism placed
- Creates key with `key()` from `beam/storage.js`
- Creates entry: `{ dimId, x, y, z, beams: [], kind: "prism" }`
- Saves to map: `map[prismKey] = entry`
- Calls `saveBeamsMap(world, map)` from `beam/storage.js`

### Cache System

**Cache Clearing**: `resetTickCaches()` (controller.js ~188) clears:
- `blockCache`
- `dimCache`
- `containerInfoCache`
- `containerCountCache`
- `cachedInputKeys` (if network stamp changed)

**Cache Issue**: Once a key fails lookup (returns null), it's cached as null for that tick. This means if a block lookup fails once, it won't retry until next tick. However, blocks might be valid but lookups might be failing due to timing, dimension issues, or coordinate rounding.

## Files to Investigate

### Primary Files

1. **`development_behavior_packs/chaos/scripts/chaos/features/links/transfer/controller.js`**
   - Line ~680: `getPrismKeys()` - the function returning 0
   - Line ~205: `resolveBlockInfoCached()` - block lookup function
   - Line ~188: `resetTickCaches()` - cache clearing
   - Line ~538: `onTick()` - main loop (calls `getPrismKeys()`)

2. **`development_behavior_packs/chaos/scripts/chaos/features/links/beam/storage.js`**
   - `key()`, `parseKey()` - key format for beam system
   - `loadBeamsMap()`, `saveBeamsMap()` - beam system storage

3. **`development_behavior_packs/chaos/scripts/chaos/features/links/transfer/storage.js`**
   - `loadBeamsMap()` - transfer system storage (loads from same `DP_BEAMS`)

4. **`development_behavior_packs/chaos/scripts/chaos/features/links/transfer/keys.js`**
   - `key()`, `parseKey()` - key format for transfer system
   - **CHECK**: Do these match beam/storage.js format?

5. **`development_behavior_packs/chaos/scripts/chaos/features/links/beam/events.js`**
   - Line ~123: `handlePrismPlaced()` - registers prisms in map
   - Line ~160: `registerBeamEvents()` - event subscriptions

### Config Files

6. **`development_behavior_packs/chaos/scripts/chaos/features/links/transfer/config.js`**
   - `DP_BEAMS` constant - verify matches beam system
   - `PRISM_ID = "chaos:prism"` - verify block ID

7. **`development_behavior_packs/chaos/scripts/chaos/features/links/beam/config.js`**
   - `DP_BEAMS` constant - verify matches transfer system
   - `PRISM_ID = "chaos:prism"` - verify block ID

## Investigation Steps

### Step 1: Verify Key Format Consistency

**Check**: Do `beam/storage.js` and `transfer/keys.js` use the same key format?

```javascript
// beam/storage.js
export function key(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}

// transfer/keys.js
export function key(dimId, x, y, z) {
  return `${dimId}|${x},${y},${z}`;
}
```

They should match. If they don't, prisms registered by beam system won't be found by transfer system.

### Step 2: Verify Beams Map is Being Populated

**Add debug to `handlePrismPlaced()`**:
- Log when prism is registered
- Log the key format being used
- Log the entry being saved

**Add debug to `getPrismKeys()` start**:
- Log `Object.keys(map || {})` count BEFORE filtering
- Log first few keys in map (to see format)
- This will show if map is empty or keys exist but aren't prisms

### Step 3: Verify Block Lookups Are Working

**Add direct block lookup test**:
- In `getPrismKeys()`, before using `resolveBlockInfoCached()`, try a direct lookup:
  ```javascript
  const testBlock = world.getDimension(parsed.dimId)?.getBlock({ x: parsed.x, y: parsed.y, z: parsed.z });
  ```
- Compare with cached lookup result
- This will show if cache is the problem

### Step 4: Check Debug Output

**The debug messages added should show**:
- Every 100 ticks: Count of keys, prisms found, wrong types, failed lookups
- Every 200 ticks: Sample failure messages (first 3)

**If debug shows nothing**, check:
- Is `debugEnabled` true? (from `transferLoop.js`)
- Are messages being sent to players? (should use `player.sendMessage()`)

### Step 5: Verify Prism Registration

**Check if prisms are actually being registered**:
- Place a new prism
- Check if `handlePrismPlaced()` is called (add debug)
- Check if entry is saved to map (add debug after `saveBeamsMap`)
- Immediately check if `getPrismKeys()` finds it

## Potential Issues

### Issue 1: Key Format Mismatch
**Symptom**: Beams map has entries, but `parseKey()` fails or keys don't match.
**Fix**: Ensure both systems use identical key format, or convert keys when loading.

### Issue 2: Cache Poisoning
**Symptom**: First lookup fails (maybe timing), then cached as null for rest of tick.
**Fix**: Don't cache null results, or retry failed lookups with direct lookup fallback (already added, but verify it's working).

### Issue 3: Coordinate Rounding
**Symptom**: Keys saved with one precision, parsed with another.
**Fix**: Both systems use `x | 0` to floor coordinates, should match.

### Issue 4: Dimension ID Format
**Symptom**: Dimension IDs don't match between systems.
**Fix**: Verify both use `dimension.id` consistently.

### Issue 5: Beams Map Not Persisting
**Symptom**: Prisms registered but map is empty on next tick.
**Fix**: Check `saveBeamsMap()` is actually saving, and `loadBeamsMap()` is loading correctly.

### Issue 6: Debug Not Enabled
**Symptom**: No debug output at all.
**Fix**: Check `transferLoop.js` - `debugTransferStats` should be `true`.

## Code Changes Made

1. **Fixed `stamp` scope error** in `getPrismKeys()` - moved declaration outside if block
2. **Added fallback in `resolveBlockInfo()`** - direct lookup if cache fails (but `getPrismKeys()` uses `resolveBlockInfoCached()`, not `resolveBlockInfo()`)
3. **Enhanced debug in `getPrismKeys()`**:
   - Added `parseFailCount` tracking
   - Added sample failure messages (every 200 ticks, first 3)
   - Enhanced main debug message with all counts

## Next Steps

1. **Verify debug is enabled**: Check `transferLoop.js` has `debugTransferStats: true`
2. **Check beams map directly**: Add debug to log raw map contents and key count
3. **Test key format**: Log keys from both systems side-by-side
4. **Test direct lookup**: Bypass cache and do direct block lookups
5. **Verify prism registration**: Add debug to `handlePrismPlaced()` to confirm prisms are being saved

## Key Questions to Answer

1. **Is the beams map empty?** - Check `Object.keys(map || {}).length` at start of `getPrismKeys()`
2. **Are keys being parsed correctly?** - Check `parseFailCount` in debug output
3. **Are block lookups failing?** - Check `invalidCount` in debug output
4. **Are wrong block types in map?** - Check `missingCount` in debug output
5. **Are prisms being registered?** - Add debug to `handlePrismPlaced()`
6. **Is debug actually enabled?** - Check `transferLoop.js` and verify messages appear

## Files Structure

```
development_behavior_packs/chaos/scripts/chaos/
├── bootstrap/
│   └── transferLoop.js (starts transfer system, sets debug flag)
├── features/links/
│   ├── beam/
│   │   ├── config.js (PRISM_ID, DP_BEAMS for beam system)
│   │   ├── storage.js (key, parseKey, loadBeamsMap for beam system)
│   │   └── events.js (handlePrismPlaced - registers prisms)
│   └── transfer/
│       ├── config.js (PRISM_ID, DP_BEAMS for transfer system)
│       ├── keys.js (key, parseKey for transfer system)
│       ├── storage.js (loadBeamsMap for transfer system)
│       └── controller.js (getPrismKeys, resolveBlockInfoCached) ⭐ MAIN FILE
```

## Important Notes

- **Both systems use `DP_BEAMS`**: Beam and transfer systems should be loading from the same dynamic property
- **Key format must match**: Both `beam/storage.js` and `transfer/keys.js` use `dimId|x,y,z` format
- **Cache is cleared each tick**: Failed lookups are cached as null for that tick only
- **Debug uses `player.sendMessage()`**: Must iterate `world.getAllPlayers()` to send messages
- **Prisms are registered on placement**: `handlePrismPlaced()` should be called automatically via events

## Debug Commands

To check if debug is working, the code should output messages every 100 ticks like:
```
[Transfer] DEBUG: 2 keys in beams map, 0 prisms found, 0 wrong type, 2 lookup failed, 0 parse failed. Inflight: 4
```

If no messages appear, either:
- Debug is disabled (`debugTransferStats: false` in `transferLoop.js`)
- Messages aren't reaching players
- Code isn't executing (check if `onTick()` is being called)

Start by adding a simple debug message at the very start of `getPrismKeys()` to verify it's being called, then work backwards to find where it's failing.