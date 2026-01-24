// scripts/chaos/features/logistics/core/cache.js
import { CRYSTALLIZER_ID, isPrismBlock } from "../config.js";
import { key, parseKey } from "../keys.js";
import { getAllAdjacentInventories, getInventoryContainer } from "../util/inventoryAdapter.js";
import { getInsertCapacityWithReservations } from "../util/inventoryAdapter.js";

export function createCacheManager(deps, cfg) {
  const world = deps.world;
  const getContainerCapacityWithReservations = deps.getContainerCapacityWithReservations;
  const getTotalCountForType = deps.getTotalCountForType;
  const invalidateInput = deps.invalidateInput || null; // Optional callback for pathfinder invalidation
  const debugEnabled = deps.debugEnabled || false;
  const debugState = deps.debugState || null;
  // Capacity reservations are handled in inventoryAdapter.js

  let nowTick = 0;

  // Cache maps and timestamps
  const blockCache = new Map();
  const blockCacheTimestamps = new Map();
  const containerInfoCache = new Map();
  const containerInfoCacheTimestamps = new Map();
  const insertCapacityCache = new Map();
  const insertCapacityCacheTimestamps = new Map();
  const totalCapacityCache = new Map();
  const totalCapacityCacheTimestamps = new Map();
  const totalCountCache = new Map();
  const totalCountCacheTimestamps = new Map();
  const dimCache = new Map();
  const dimCacheTimestamps = new Map();
  const prismInventoryCache = new Map(); // prismKey -> { hasInventories: bool, timestamp: number }
  const prismInventoryCacheTimestamps = new Map();
  const prismInventoryListCache = new Map(); // prismKey -> { inventories: Array, timestamp: number }
  const prismInventoryListCacheTimestamps = new Map();
  const containerCapacityCache = new Map(); // containerKey -> { typeId -> capacity, timestamp: number }
  const containerCapacityCacheTimestamps = new Map();
  // Cache for crystallizer route lookups (expensive pathfinding operation)
  const crystallizerRouteCache = new Map(); // prismKey -> { route: object | null, tick: number }
  const CRYSTALLIZER_ROUTE_CACHE_TTL = 50; // Routes to crystallizers don't change often, cache for 50 ticks
  let inventoryDiagCollector = null;

  // Cache TTL values (in ticks)
  const BLOCK_CACHE_TTL = 5; // Block lookups are expensive, cache for 5 ticks
  const CONTAINER_CACHE_TTL = 10; // Container info changes less frequently
  const CAPACITY_CACHE_TTL = 3; // Capacity can change with items, shorter cache
  const COUNT_CACHE_TTL = 2; // Item counts change frequently, very short cache
  const DIM_CACHE_TTL = 1000; // Dimensions never change, cache for a long time
  const PRISM_INVENTORY_CACHE_TTL = 20; // Inventory status changes when blocks change
  const PRISM_INVENTORY_LIST_CACHE_TTL = 15; // Performance #2: Increased from 5 to 15 ticks (items move slowly)
  const CONTAINER_CAPACITY_CACHE_TTL = 5; // Performance #2: Increased from 2 to 5 ticks (capacity doesn't change that frequently)

  // Cache cleanup state - only clean up periodically to avoid O(n) cost every tick
  let lastCacheCleanupTick = 0;
  const CACHE_CLEANUP_INTERVAL = 20; // Clean up every 20 ticks instead of every tick
  const MAX_CACHE_SIZE = 500; // Maximum entries per cache to prevent unbounded growth

  function updateTick(tick) {
    nowTick = tick;
  }

  function resetTickCaches() {
    // Only do expensive cleanup every N ticks
    if ((nowTick - lastCacheCleanupTick) < CACHE_CLEANUP_INTERVAL) {
      return; // Skip cleanup this tick
    }
    lastCacheCleanupTick = nowTick;
    
    // Helper to clean cache with size limit
    function cleanCache(cache, timestamps, ttl, maxSize) {
      // If cache is too large, clear oldest entries first
      if (cache.size > maxSize) {
        const entries = Array.from(timestamps.entries()).sort((a, b) => a[1] - b[1]);
        const toRemove = cache.size - maxSize;
        for (let i = 0; i < toRemove; i++) {
          const key = entries[i][0];
          cache.delete(key);
          timestamps.delete(key);
        }
      }
      
      // Clear expired entries (limit iterations to prevent lag spikes)
      let cleaned = 0;
      const maxCleanupPerCycle = 50;
      for (const [key, timestamp] of timestamps.entries()) {
        if ((nowTick - timestamp) >= ttl) {
          cache.delete(key);
          timestamps.delete(key);
          if (++cleaned >= maxCleanupPerCycle) break;
        }
      }
    }
    
    cleanCache(blockCache, blockCacheTimestamps, BLOCK_CACHE_TTL, MAX_CACHE_SIZE);
    cleanCache(containerInfoCache, containerInfoCacheTimestamps, CONTAINER_CACHE_TTL, MAX_CACHE_SIZE);
    cleanCache(insertCapacityCache, insertCapacityCacheTimestamps, CAPACITY_CACHE_TTL, MAX_CACHE_SIZE);
    cleanCache(totalCapacityCache, totalCapacityCacheTimestamps, CAPACITY_CACHE_TTL, MAX_CACHE_SIZE);
    cleanCache(totalCountCache, totalCountCacheTimestamps, COUNT_CACHE_TTL, MAX_CACHE_SIZE);
    cleanCache(prismInventoryCache, prismInventoryCacheTimestamps, PRISM_INVENTORY_CACHE_TTL, MAX_CACHE_SIZE);
    cleanCache(prismInventoryListCache, prismInventoryListCacheTimestamps, PRISM_INVENTORY_LIST_CACHE_TTL, MAX_CACHE_SIZE);
    
    // Clean crystallizer route cache (uses Map with tick field, so custom cleanup)
    const maxCleanupPerCycle = 50;
    if (crystallizerRouteCache.size > MAX_CACHE_SIZE) {
      const entries = Array.from(crystallizerRouteCache.entries()).sort((a, b) => a[1].tick - b[1].tick);
      const toRemove = crystallizerRouteCache.size - MAX_CACHE_SIZE;
      for (let i = 0; i < toRemove; i++) {
        crystallizerRouteCache.delete(entries[i][0]);
      }
    }
    let cleaned = 0;
    for (const [key, value] of crystallizerRouteCache.entries()) {
      if ((nowTick - value.tick) >= CRYSTALLIZER_ROUTE_CACHE_TTL) {
        crystallizerRouteCache.delete(key);
        if (++cleaned >= maxCleanupPerCycle) break;
      }
    }
    
    // Dimension cache is small, no size limit needed
    cleaned = 0;
    for (const [key, timestamp] of dimCacheTimestamps.entries()) {
      if ((nowTick - timestamp) >= DIM_CACHE_TTL) {
        dimCache.delete(key);
        dimCacheTimestamps.delete(key);
        if (++cleaned >= maxCleanupPerCycle) break;
      }
    }
  }

  function invalidateCacheForBlock(blockKey) {
    blockCache.delete(blockKey);
    blockCacheTimestamps.delete(blockKey);
    containerInfoCache.delete(blockKey);
    containerInfoCacheTimestamps.delete(blockKey);
    // Invalidate prism inventory cache for this block (it might be a prism or adjacent to one)
    prismInventoryCache.delete(blockKey);
    prismInventoryCacheTimestamps.delete(blockKey);
    prismInventoryListCache.delete(blockKey);
    prismInventoryListCacheTimestamps.delete(blockKey);
    // Invalidate crystallizer route cache for this block (route might have changed)
    crystallizerRouteCache.delete(blockKey);
    
    // Also invalidate adjacent prisms' inventory cache (they might have lost/gained an adjacent inventory)
    try {
      const pos = parseKey(blockKey);
      if (pos) {
        const dim = getDimensionCached(pos.dimId);
        if (dim) {
          // Check all 6 adjacent positions for prisms
          const dirs = [
            { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
            { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
            { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }
          ];
          for (const d of dirs) {
            const adjKey = key(pos.dimId, pos.x + d.x, pos.y + d.y, pos.z + d.z);
            const adjBlock = dim.getBlock({ x: pos.x + d.x, y: pos.y + d.y, z: pos.z + d.z });
            if (adjBlock && isPrismBlock(adjBlock)) {
              // Invalidate this adjacent prism's inventory cache
              prismInventoryCache.delete(adjKey);
              prismInventoryCacheTimestamps.delete(adjKey);
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors in cache invalidation
    }
    
    // Also clear related capacity/count caches
    for (const key of insertCapacityCache.keys()) {
      if (key.includes(blockKey)) {
        insertCapacityCache.delete(key);
        insertCapacityCacheTimestamps.delete(key);
      }
    }
    for (const key of totalCapacityCache.keys()) {
      if (key.includes(blockKey)) {
        totalCapacityCache.delete(key);
        totalCapacityCacheTimestamps.delete(key);
      }
    }
    for (const key of totalCountCache.keys()) {
      if (key.includes(blockKey)) {
        totalCountCache.delete(key);
        totalCountCacheTimestamps.delete(key);
      }
    }
  }

  function invalidateCachesForBlockChange(blockKey) {
    invalidateCacheForBlock(blockKey);
    
    // Also invalidate pathfinder cache for affected prisms
    if (invalidateInput && typeof invalidateInput === "function") {
      try {
        invalidateInput(blockKey);
        // Also invalidate adjacent prisms
        const pos = parseKey(blockKey);
        if (pos) {
          const dim = getDimensionCached(pos.dimId);
          if (dim) {
            const dirs = [
              { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
              { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
              { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }
            ];
            for (const d of dirs) {
              const adjKey = key(pos.dimId, pos.x + d.x, pos.y + d.y, pos.z + d.z);
              const adjBlock = dim.getBlock({ x: pos.x + d.x, y: pos.y + d.y, z: pos.z + d.z });
              if (adjBlock && isPrismBlock(adjBlock)) {
                invalidateInput(adjKey);
              }
            }
          }
        }
      } catch (e) {
        // Ignore errors in invalidation
      }
    }
  }

  function getDimensionCached(dimId) {
    if (!dimId) return null;
    const cached = dimCache.get(dimId);
    const timestamp = dimCacheTimestamps.get(dimId);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < DIM_CACHE_TTL) {
      return cached;
    }
    const dim = world.getDimension(dimId);
    dimCache.set(dimId, dim || null);
    dimCacheTimestamps.set(dimId, nowTick);
    return dim || null;
  }

  function resolveBlockInfoCached(blockKey) {
    try {
      if (!blockKey) return null;
      const cached = blockCache.get(blockKey);
      const timestamp = blockCacheTimestamps.get(blockKey);
      if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < BLOCK_CACHE_TTL) {
        return cached;
      }
      const pos = parseKey(blockKey);
      if (!pos) {
        blockCache.set(blockKey, null);
        blockCacheTimestamps.set(blockKey, nowTick);
        return null;
      }
      const dim = getDimensionCached(pos.dimId);
      if (!dim) {
        blockCache.set(blockKey, null);
        blockCacheTimestamps.set(blockKey, nowTick);
        return null;
      }
      const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
      if (!block) {
        blockCache.set(blockKey, null);
        blockCacheTimestamps.set(blockKey, nowTick);
        return null;
      }
      const info = { dim, block, pos };
      blockCache.set(blockKey, info);
      blockCacheTimestamps.set(blockKey, nowTick);
      if (debugEnabled && debugState) debugState.blockLookups++;
      return info;
    } catch (err) {
      blockCache.set(blockKey, null);
      blockCacheTimestamps.set(blockKey, nowTick);
      return null;
    }
  }

  function resolveBlockInfoDirect(blockKey) {
    try {
      if (!blockKey) return null;
      const pos = parseKey(blockKey);
      if (!pos) return null;
      const dim = world.getDimension(pos.dimId);
      if (!dim) return { error: "dimension_not_found", dimId: pos.dimId };
      const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
      if (!block) return { error: "block_not_found", pos };
      return { dim, block, pos };
    } catch (err) {
      return { error: "exception", message: err?.message || String(err) };
    }
  }

  function getBlockCached(dimId, pos) {
    try {
      if (!dimId || !pos) return null;
      const blockKey = key(dimId, pos.x, pos.y, pos.z);
      const info = resolveBlockInfoCached(blockKey);
      return info?.block || null;
    } catch (e) {
      return null;
    }
  }

  function resolveContainerInfoCached(containerKey) {
    if (!containerKey) return null;
    const cached = containerInfoCache.get(containerKey);
    const timestamp = containerInfoCacheTimestamps.get(containerKey);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < CONTAINER_CACHE_TTL) {
      return cached;
    }
    const info = resolveBlockInfoCached(containerKey);
    if (!info || !info.block) {
      containerInfoCache.set(containerKey, null);
      containerInfoCacheTimestamps.set(containerKey, nowTick);
      return null;
    }
    const container = getInventoryContainer(info.block);
    if (!container) {
      containerInfoCache.set(containerKey, null);
      containerInfoCacheTimestamps.set(containerKey, nowTick);
      return null;
    }
    const result = { dim: info.dim, block: info.block, container, pos: info.pos };
    containerInfoCache.set(containerKey, result);
    containerInfoCacheTimestamps.set(containerKey, nowTick);
    if (debugEnabled && debugState) debugState.containerLookups++;
    return result;
  }

  function getTotalCountForTypeCached(containerKey, container, typeId) {
    const keyId = `${containerKey}|${typeId}`;
    const cached = totalCountCache.get(keyId);
    const timestamp = totalCountCacheTimestamps.get(keyId);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < COUNT_CACHE_TTL) {
      return cached;
    }
    if (debugEnabled && debugState) debugState.inventoryScans++;
    const total = getTotalCountForType(container, typeId);
    totalCountCache.set(keyId, total);
    totalCountCacheTimestamps.set(keyId, nowTick);
    return total;
  }

  function getInsertCapacityCached(containerKey, container, typeId, stack) {
    const maxStack = Math.max(1, stack?.maxAmount || 64);
    const keyId = `${containerKey}|${typeId}|${maxStack}`;
    const cached = insertCapacityCache.get(keyId);
    const timestamp = insertCapacityCacheTimestamps.get(keyId);
    // Reservations can change at any time (inflight/queues), so we compute fresh.
    if (debugEnabled && debugState) debugState.inventoryScans++;
    const info = resolveContainerInfoCached(containerKey);
    const capacity = getInsertCapacityWithReservations(containerKey, container, typeId, stack, info?.block);
    return capacity;
  }

  function getContainerCapacityCached(containerKey, container) {
    const cached = totalCapacityCache.get(containerKey);
    const timestamp = totalCapacityCacheTimestamps.get(containerKey);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < CAPACITY_CACHE_TTL) {
      return cached;
    }
    if (debugEnabled && debugState) debugState.inventoryScans++;
    const info = resolveContainerInfoCached(containerKey);
    const capacity = getContainerCapacityWithReservations(containerKey, container, info?.block);
    totalCapacityCache.set(containerKey, capacity);
    totalCapacityCacheTimestamps.set(containerKey, nowTick);
    return capacity;
  }

  function getPrismInventoriesCached(prismKey, prismBlock, dim) {
    const cached = prismInventoryListCache.get(prismKey);
    const timestamp = prismInventoryListCacheTimestamps.get(prismKey);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < PRISM_INVENTORY_LIST_CACHE_TTL) {
      return cached; // Return cached inventory list
    }
    
    // Not cached or expired - scan and cache
    const inventories = getAllAdjacentInventories(prismBlock, dim, {
      prismKey,
      report: inventoryDiagCollector,
    });
    prismInventoryListCache.set(prismKey, inventories);
    prismInventoryListCacheTimestamps.set(prismKey, nowTick);
    
    // Also update the hasInventories cache
    const hasInventories = inventories && inventories.length > 0;
    prismInventoryCache.set(prismKey, hasInventories);
    prismInventoryCacheTimestamps.set(prismKey, nowTick);
    
    return inventories;
  }

  function getPrismHasInventories(prismKey) {
    const cached = prismInventoryCache.get(prismKey);
    const timestamp = prismInventoryCacheTimestamps.get(prismKey);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < PRISM_INVENTORY_CACHE_TTL) {
      return cached;
    }
    // Return cached value if available, otherwise return false (will be updated when queue processes)
    return cached !== undefined ? cached : false;
  }

  return {
    updateTick,
    getPrismInventoriesCached,
    getPrismHasInventories,
    setInventoryDiagnosticsCollector(fn) {
      inventoryDiagCollector = typeof fn === "function" ? fn : null;
    },
    resolveBlockInfoCached,
    resolveBlockInfoDirect,
    getBlockCached,
    getDimensionCached,
    resolveContainerInfoCached,
    getTotalCountForTypeCached,
    getInsertCapacityCached,
    getContainerCapacityCached,
    invalidateCacheForBlock,
    invalidateCachesForBlockChange,
    resetTickCaches,
    // Expose crystallizer route cache for controller use
    getCrystallizerRouteCache: () => crystallizerRouteCache,
    getCrystallizerRouteCacheTTL: () => CRYSTALLIZER_ROUTE_CACHE_TTL,
  };
}


