// scripts/chaos/features/links/transfer/controller.js
import { ItemStack, MolangVariableMap } from "@minecraft/server";
import {
  DEFAULTS,
  PRISM_IDS,
  CRYSTALLIZER_ID,
  CRYSTAL_FLUX_WEIGHT,
  MAX_STEPS,
  SPEED_SCALE_MAX,
  PRISM_SPEED_BOOST_BASE,
  PRISM_SPEED_BOOST_PER_TIER,
  DP_BEAMS,
  isPrismBlock,
  getPrismTierFromTypeId,
  getPrismTypeIdForTier,
} from "./config.js";
import { mergeCfg } from "./utils.js";
import {
  loadBeamsMap,
  saveBeamsMap,
  loadInputLevels,
  saveInputLevels,
  loadOutputLevels,
  saveOutputLevels,
  loadPrismLevels,
  savePrismLevels,
} from "./storage.js";
import { loadInflightStateFromWorld, persistInflightStateToWorld } from "./inflight.js";
import { key, parseKey, getContainerKey, getContainerKeyFromInfo } from "./keys.js";
import {
  getAttachedInventoryInfo,
  getAllAdjacentInventories,
  getInventoryContainer,
  isFurnaceBlock,
  getFurnaceSlots,
  tryInsertAmountForContainer,
  tryInsertIntoInventories,
  getTotalCountForType,
  getRandomItemFromInventories,
  findInputSlotForContainer,
  decrementInputSlotSafe,
  decrementInputSlotsForType,
} from "./inventory.js";
import { getFilterContainer, filterOutputsByWhitelist, getFilterSet } from "./filters.js";
import {
  getInsertCapacityWithReservations,
  getReservedForContainer,
  reserveContainerSlot,
  releaseContainerSlot,
  clearReservations,
} from "./reservations.js";
import {
  validatePathStart,
  isPathBlock,
  isNodeBlock,
  findFirstPrismKeyInPath,
  buildNodePathSegments,
  buildFluxFxSegments,
  findDropLocation,
  pickWeightedRandomWithBias,
} from "./path.js";
import { findOutputRouteFromNode, findCrystallizerRouteFromOutput, findCrystallizerRouteFromPrism } from "./routes.js";
import { makeDirs, scanEdgeFromNode } from "./graph.js";
import { runTransferPipeline } from "./pipeline.js";
import { getFilterSetForBlock } from "../filters.js";
import { tryGenerateFluxOnTransfer, tryRefineFluxInTransfer, getFluxTier, isFluxTypeId } from "../../../flux.js";
import { addFluxForItem, getFluxValueForItem } from "../../../crystallizer.js";
import { fxFluxGenerate, queueFxParticle } from "../../../fx/fx.js";

export function createNetworkTransferController(deps, opts) {
  const world = deps.world;
  const system = deps.system;
  const FX = deps.FX;
  const getSpeedForInput = deps.getSpeedForInput;
  const findPathForInput = deps.findPathForInput;
  const invalidateInput = deps.invalidateInput;
  const getPathStats = deps.getPathStats;
  const getNetworkStamp = deps.getNetworkStamp;

  const cfg = mergeCfg(DEFAULTS, opts);

  let cursor = 0;
  let tickId = null;
  let nowTick = 0;

  const nextAllowed = new Map();
  const inflight = [];
  const fluxFxInflight = [];
  let inflightDirty = false;
  let inflightStepDirty = false;
  let lastSaveTick = 0;
  
  // Priority queue: Track items ready to process (ticksUntilStep <= 0)
  // This avoids iterating all 100 items every tick
  const readyItems = new Set(); // Items that are ready to move this tick
  const nearReadyItems = new Set(); // Items that will be ready next tick (ticksUntilStep === 1)
  let needsRebuild = false; // Flag to rebuild queues when items are added/removed
  const transferCounts = new Map();
  let levelsDirty = false;
  const outputCounts = new Map();
  let outputLevelsDirty = false;
  const prismCounts = new Map();
  let prismLevelsDirty = false;
  // Unified save interval - batch all saves together
  const SAVE_INTERVAL_TICKS = 200;
  const queueByContainer = new Map();
  const fullContainers = new Set();
  let fullCursor = 0;
  let queueCursor = 0;
  const inputBackoff = new Map();
  
  // Queuing systems for expensive operations
  const pathfindingQueue = []; // Queue of prisms needing pathfinding
  const inventoryScanQueue = []; // Queue of prisms needing inventory validation
  const activePrisms = new Set(); // Prisms with inventories (pre-filtered)
  let lastInventoryValidationTick = 0;
  const INVENTORY_VALIDATION_INTERVAL = 100; // Validate active prisms every 100 ticks
  const debugEnabled = !!(cfg.debugTransferStats || FX?.debugTransferStats);
  const debugInterval = Math.max(20, Number(cfg.debugTransferStatsIntervalTicks || FX?.debugTransferStatsIntervalTicks) || 100);
  let lastDebugTick = 0;
  const debugState = {
    inputsScanned: 0,
    transfersStarted: 0,
    outputOptionsTotal: 0,
    outputOptionsMax: 0,
    orbSpawns: 0,
    orbFxSkipped: 0,
    fluxFxSpawns: 0,
    inputMapReloads: 0,
    blockLookups: 0,
    containerLookups: 0,
    inventoryScans: 0,
    dpSaves: 0,
    fluxGenChecks: 0,
    fluxGenHits: 0,
    fluxRefineCalls: 0,
    fluxRefined: 0,
    fluxMutated: 0,
    msQueues: 0,
    msInflight: 0,
    msFluxFx: 0,
    msScan: 0,
    msPersist: 0,
    msTotal: 0,
    // Granular timing breakdown
    msInflightPriorityQueue: 0, // Time updating priority queues
    msInflightBlockLookups: 0, // Time doing block lookups in tickInFlight
    msInflightPathValidation: 0, // Time validating paths
    msInflightPrismLogic: 0, // Time processing prism-specific logic
    msInflightOrbSpawning: 0, // Time spawning orbs
    msInflightMovement: 0, // Time for movement/step advancement
    msPathfinding: 0, // Time in pathfinding operations
    msInventoryScanning: 0, // Time scanning inventories
    msCacheOps: 0, // Time in cache operations
    msFinalizeJob: 0, // Time finalizing jobs
    // Granular Finalize timings
    msFinalizeBlockLookups: 0, // Time resolving block info in finalizeJob
    msFinalizeInventoryLookups: 0, // Time getting inventories in finalizeJob
    msFinalizeFluxRefine: 0, // Time in flux refinement
    msFinalizeItemInsertion: 0, // Time inserting items into inventories
    msFinalizeCrystalRoute: 0, // Time finding crystallizer routes
    msFinalizeFluxGenerate: 0, // Time generating flux
    msFinalizeQueueCleanup: 0, // Time cleaning up queues
    // Granular Scan timings
    msScanResolveBlock: 0, // Time resolving block info in scan loop
    msScanGetInventories: 0, // Time getting inventories in scan loop
    msScanGetItem: 0, // Time getting random item from inventories
    msScanAttemptTransfer: 0, // Time in attemptTransferForPrism
    msScanIntervalCalc: 0, // Time calculating intervals in scan loop
  };
  let cachedInputKeys = null;
  let cachedInputsStamp = null;
  let orbFxBudgetUsed = 0;
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
  
  // Optimization #4: Track if crystallizers exist in network (skip route lookup if none exist)
  let hasCrystallizersInNetwork = null; // null = unknown, true = exists, false = doesn't exist
  let lastCrystallizerCheckTick = -1000; // When we last checked for crystallizers
  const CRYSTALLIZER_CHECK_INTERVAL = 500; // Check every 500 ticks (25 seconds)
  
  // Optimization #3: Batch crystallizer route lookups per tick
  const pendingRouteLookups = new Map(); // prismKey -> { block, dimId, callback }
  const routeLookupResults = new Map(); // prismKey -> route (this tick only)
  
  // Cache TTL values (in ticks)
  const BLOCK_CACHE_TTL = 5; // Block lookups are expensive, cache for 5 ticks
  const CONTAINER_CACHE_TTL = 10; // Container info changes less frequently
  const CAPACITY_CACHE_TTL = 3; // Capacity can change with items, shorter cache
  const COUNT_CACHE_TTL = 2; // Item counts change frequently, very short cache
  const DIM_CACHE_TTL = 1000; // Dimensions never change, cache for a long time
  const PRISM_INVENTORY_CACHE_TTL = 20; // Inventory status changes when blocks change
  const PRISM_INVENTORY_LIST_CACHE_TTL = 15; // Performance #2: Increased from 5 to 15 ticks (items move slowly)
  const CONTAINER_CAPACITY_CACHE_TTL = 5; // Performance #2: Increased from 2 to 5 ticks (capacity doesn't change that frequently)

  function getBackoffTicks(level) {
    const safeLevel = Math.max(0, level | 0);
    const base = Math.max(0, cfg.backoffBaseTicks | 0);
    if (safeLevel <= 0 || base <= 0) return 0;
    const maxTicks = Math.max(base, cfg.backoffMaxTicks | 0);
    const scaled = base * Math.pow(2, Math.max(0, safeLevel - 1));
    return Math.min(maxTicks, Math.floor(scaled));
  }

  function bumpBackoff(inputKey) {
    if (!inputKey) return 0;
    const prev = inputBackoff.get(inputKey) || 0;
    const maxLevel = Math.max(0, cfg.backoffMaxLevel | 0);
    const next = Math.min(maxLevel, prev + 1);
    inputBackoff.set(inputKey, next);
    return next;
  }

  function clearBackoff(inputKey) {
    if (!inputKey) return;
    inputBackoff.delete(inputKey);
  }

  function resetDebugState() {
    debugState.inputsScanned = 0;
    debugState.transfersStarted = 0;
    debugState.outputOptionsTotal = 0;
    debugState.outputOptionsMax = 0;
    debugState.orbSpawns = 0;
    debugState.orbFxSkipped = 0;
    debugState.fluxFxSpawns = 0;
    debugState.inputMapReloads = 0;
    debugState.blockLookups = 0;
    debugState.containerLookups = 0;
    debugState.inventoryScans = 0;
    debugState.dpSaves = 0;
    debugState.fluxGenChecks = 0;
    debugState.fluxGenHits = 0;
    debugState.fluxRefineCalls = 0;
    debugState.fluxRefined = 0;
    debugState.fluxMutated = 0;
    debugState.msQueues = 0;
    debugState.msInflight = 0;
    debugState.msFluxFx = 0;
    debugState.msScan = 0;
    debugState.msPersist = 0;
    debugState.msTotal = 0;
    // Granular timing reset
    debugState.msInflightPriorityQueue = 0;
    debugState.msInflightBlockLookups = 0;
    debugState.msInflightPathValidation = 0;
    debugState.msInflightPrismLogic = 0;
    debugState.msInflightOrbSpawning = 0;
    debugState.msInflightMovement = 0;
    debugState.msPathfinding = 0;
    debugState.msInventoryScanning = 0;
    debugState.msCacheOps = 0;
    debugState.msFinalizeJob = 0;
    // Granular Finalize timing reset
    debugState.msFinalizeBlockLookups = 0;
    debugState.msFinalizeInventoryLookups = 0;
    debugState.msFinalizeFluxRefine = 0;
    debugState.msFinalizeItemInsertion = 0;
    debugState.msFinalizeCrystalRoute = 0;
    debugState.msFinalizeFluxGenerate = 0;
    debugState.msFinalizeQueueCleanup = 0;
    // Granular Scan timing reset
    debugState.msScanResolveBlock = 0;
    debugState.msScanGetInventories = 0;
    debugState.msScanGetItem = 0;
    debugState.msScanAttemptTransfer = 0;
    debugState.msScanIntervalCalc = 0;
  }

  // Cache cleanup state - only clean up periodically to avoid O(n) cost every tick
  let lastCacheCleanupTick = 0;
  const CACHE_CLEANUP_INTERVAL = 20; // Clean up every 20 ticks instead of every tick
  const MAX_CACHE_SIZE = 500; // Maximum entries per cache to prevent unbounded growth
  
  // Clear expired cache entries periodically instead of every tick
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
  
  // Function to invalidate specific cache entries (for block changes)
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
    } catch {
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
  
  // Expose cache invalidation function for external use (block change events)
  function invalidateCachesForBlockChange(blockKey) {
    invalidateCacheForBlock(blockKey);
    
    // Optimization #4: Reset crystallizer existence flag if a crystallizer block was changed
    try {
      const pos = parseKey(blockKey);
      if (pos) {
        const dim = getDimensionCached(pos.dimId);
        if (dim) {
          const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
          // If a crystallizer was added/removed, reset the flag
          if (block?.typeId === CRYSTALLIZER_ID || !block) {
            hasCrystallizersInNetwork = null; // Reset - need to rediscover
          }
        }
      }
    } catch {
      // Ignore
    }
    
    // Also invalidate pathfinder cache for affected prisms
    if (typeof invalidateInput === "function") {
      invalidateInput(blockKey);
      // Also invalidate adjacent prisms
      try {
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
      } catch {
        // Ignore
      }
    }
  }
  
  // Get cached inventory list for a prism (with TTL and invalidation)
  function getPrismInventoriesCached(prismKey, prismBlock, dim) {
    const cached = prismInventoryListCache.get(prismKey);
    const timestamp = prismInventoryListCacheTimestamps.get(prismKey);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < PRISM_INVENTORY_LIST_CACHE_TTL) {
      return cached; // Return cached inventory list
    }
    
    // Not cached or expired - scan and cache
    const inventories = getAllAdjacentInventories(prismBlock, dim);
    prismInventoryListCache.set(prismKey, inventories);
    prismInventoryListCacheTimestamps.set(prismKey, nowTick);
    
    // Also update the hasInventories cache
    const hasInventories = inventories && inventories.length > 0;
    prismInventoryCache.set(prismKey, hasInventories);
    prismInventoryCacheTimestamps.set(prismKey, nowTick);
    
    return inventories;
  }
  
  // Check if a prism has adjacent inventories (cached)
  function getPrismHasInventories(prismKey) {
    const cached = prismInventoryCache.get(prismKey);
    const timestamp = prismInventoryCacheTimestamps.get(prismKey);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < PRISM_INVENTORY_CACHE_TTL) {
      return cached;
    }
    
    // Queue for validation if not cached
    if (!inventoryScanQueue.includes(prismKey)) {
      inventoryScanQueue.push(prismKey);
    }
    
    // Return cached value if available, otherwise return false (will be updated when queue processes)
    return cached !== undefined ? cached : false;
  }
  
  // Process inventory scan queue (limited per tick)
  function processInventoryScanQueue() {
    const maxScansPerTick = 10; // Limit expensive inventory scans
    let processed = 0;
    const tStart = debugEnabled ? Date.now() : 0;

    while (inventoryScanQueue.length > 0 && processed < maxScansPerTick) {
      const prismKey = inventoryScanQueue.shift();
      if (!prismKey) continue;

      const tInfo = debugEnabled ? Date.now() : 0;
      const info = resolveBlockInfo(prismKey);
      if (debugEnabled) debugState.msCacheOps += (Date.now() - tInfo);
      if (!info || !info.block || !isPrismBlock(info.block)) {
        prismInventoryCache.set(prismKey, false);
        prismInventoryCacheTimestamps.set(prismKey, nowTick);
        activePrisms.delete(prismKey);
        processed++;
        continue;
      }

      const tScan = debugEnabled ? Date.now() : 0;
      const inventories = getAllAdjacentInventories(info.block, info.dim);
      if (debugEnabled) debugState.msInventoryScanning += (Date.now() - tScan);
      const hasInventories = inventories && inventories.length > 0;
      
      // Update both caches
      prismInventoryCache.set(prismKey, hasInventories);
      prismInventoryCacheTimestamps.set(prismKey, nowTick);
      prismInventoryListCache.set(prismKey, inventories);
      prismInventoryListCacheTimestamps.set(prismKey, nowTick);
      
      if (hasInventories) {
        activePrisms.add(prismKey);
      } else {
        activePrisms.delete(prismKey);
      }
      
      processed++;
    }
  }
  
  // Process pathfinding queue (limited per tick)
  function processPathfindingQueue() {
    const maxSearchesPerTick = 5; // Limit expensive pathfinding searches
    let processed = 0;
    const tStart = debugEnabled ? Date.now() : 0;

    while (pathfindingQueue.length > 0 && processed < maxSearchesPerTick) {
      const prismKey = pathfindingQueue.shift();
      if (!prismKey) continue;

      // Trigger pathfinding (will use cache if available)
      const tPath = debugEnabled ? Date.now() : 0;
      if (typeof findPathForInput === "function") {
        findPathForInput(prismKey, nowTick);
      }
      if (debugEnabled) debugState.msPathfinding += (Date.now() - tPath);

      processed++;
    }
    if (debugEnabled && tStart > 0) {
      // Already accumulated per-search above, but keep for completeness
    }
  }
  
  // Get active prisms (only those with inventories) - pre-filtered
  function getActivePrismKeys() {
    // Process queued inventory scans first (limited per tick)
    processInventoryScanQueue();
    
    // Validate active prisms periodically (not every tick)
    if ((nowTick - lastInventoryValidationTick) >= INVENTORY_VALIDATION_INTERVAL) {
      // Rebuild active prisms list from all prisms (expensive, so only every 100 ticks)
      const allPrisms = getPrismKeys();
      activePrisms.clear();
      // Limit validation to prevent spikes - validate max 10 prisms per validation cycle
      const maxValidatedPerCycle = 10;
      let validated = 0;
      for (const prismKey of allPrisms) {
        if (validated >= maxValidatedPerCycle) {
          // Queue remaining for next cycle
          if (!inventoryScanQueue.includes(prismKey)) {
            inventoryScanQueue.push(prismKey);
          }
          continue;
        }
        const hasInventories = getPrismHasInventories(prismKey);
        if (hasInventories) {
          activePrisms.add(prismKey);
        }
        validated++;
      }
      lastInventoryValidationTick = nowTick;
    }
    
    return Array.from(activePrisms);
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
      if (debugEnabled) debugState.blockLookups++;
      return info;
    } catch (err) {
      blockCache.set(blockKey, null);
      blockCacheTimestamps.set(blockKey, nowTick);
      return null;
    }
  }
  
  // Direct block lookup without cache (for debugging)
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
    } catch {
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
    if (debugEnabled) debugState.containerLookups++;
    return result;
  }

  function getTotalCountForTypeCached(containerKey, container, typeId) {
    const keyId = `${containerKey}|${typeId}`;
    const cached = totalCountCache.get(keyId);
    const timestamp = totalCountCacheTimestamps.get(keyId);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < COUNT_CACHE_TTL) {
      return cached;
    }
    if (debugEnabled) debugState.inventoryScans++;
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
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < CAPACITY_CACHE_TTL) {
      return cached;
    }
    if (debugEnabled) debugState.inventoryScans++;
    const info = resolveContainerInfoCached(containerKey);
    const capacity = getInsertCapacityWithReservations(containerKey, container, typeId, stack, info?.block);
    insertCapacityCache.set(keyId, capacity);
    insertCapacityCacheTimestamps.set(keyId, nowTick);
    return capacity;
  }

  function getContainerCapacityCached(containerKey, container) {
    const cached = totalCapacityCache.get(containerKey);
    const timestamp = totalCapacityCacheTimestamps.get(containerKey);
    if (cached !== undefined && timestamp !== undefined && (nowTick - timestamp) < CAPACITY_CACHE_TTL) {
      return cached;
    }
    if (debugEnabled) debugState.inventoryScans++;
    const info = resolveContainerInfoCached(containerKey);
    const capacity = getContainerCapacityWithReservations(containerKey, container, info?.block);
    totalCapacityCache.set(containerKey, capacity);
    totalCapacityCacheTimestamps.set(containerKey, nowTick);
    return capacity;
  }

  function getSpeed(block) {
    try {
      if (typeof getSpeedForInput === "function") {
        const s = getSpeedForInput(block);
        if (s && typeof s === "object") return s;
      }
    } catch (_) {}
    // Get tier from block typeId
    const level = isPrismBlock(block)
      ? getPrismTierFromTypeId(block.typeId)
      : 1;
    const scale = Math.pow(2, Math.max(0, level - 1));
    const interval = Math.max(1, Math.floor(cfg.perInputIntervalTicks / scale));
    return { intervalTicks: interval, amount: 1 };
  }

  function start() {
    if (tickId !== null) return;
    loadInflightState();
    loadLevelsState();
    loadOutputLevelsState();
    loadPrismLevelsState();
    tickId = system.runInterval(onTick, 1);
    
    // Debug: confirm transfer system started
    if (debugEnabled) {
      try {
        const msg = "[Transfer] Transfer system started! Debug enabled.";
        for (const player of world.getAllPlayers()) {
          if (typeof player.sendMessage === "function") player.sendMessage(msg);
        }
      } catch {}
    }
  }

  function stop() {
    if (tickId === null) return;
    // Save all state before stopping to prevent data loss
    persistAllIfNeeded();
    try { system.clearRun(tickId); } catch (_) {}
    tickId = null;
  }

  function loadInflightState() {
    loadInflightStateFromWorld(world, inflight, cfg);
    rebuildReservationsFromInflight();
    
    // Rebuild priority queues for loaded items
    readyItems.clear();
    nearReadyItems.clear();
    for (const job of inflight) {
      if (!job) continue;
      if (job.ticksUntilStep <= 0) {
        readyItems.add(job);
      } else if (job.ticksUntilStep === 1) {
        nearReadyItems.add(job);
      }
    }
    
    inflightDirty = false;
    lastSaveTick = nowTick;
  }


  function loadLevelsState() {
    const raw = loadInputLevels(world);
    transferCounts.clear();
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      transferCounts.set(k, n | 0);
    }
    levelsDirty = false;
  }

  function persistLevelsIfNeeded() {
    // Now handled by persistAllIfNeeded()
  }

  function loadOutputLevelsState() {
    const raw = loadOutputLevels(world);
    outputCounts.clear();
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      outputCounts.set(k, n | 0);
    }
    outputLevelsDirty = false;
  }

  function persistOutputLevelsIfNeeded() {
    // Now handled by persistAllIfNeeded()
  }

  function loadPrismLevelsState() {
    const raw = loadPrismLevels(world);
    prismCounts.clear();
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      prismCounts.set(k, n | 0);
    }
    prismLevelsDirty = false;
  }

  function persistPrismLevelsIfNeeded() {
    // Now handled by persistAllIfNeeded()
  }

  // Batched save function - saves all dirty data in one operation
  function persistAllIfNeeded() {
    // Special case: if inflight is empty and dirty, save immediately (critical for clearing state)
    if (inflightDirty && inflight.length === 0) {
      persistInflightStateToWorld(world, inflight);
      if (debugEnabled) debugState.dpSaves++;
      inflightDirty = false;
      inflightStepDirty = false;
      lastSaveTick = nowTick;
      return;
    }
    
    // Check if we need to save and if enough time has passed
    const needsSave = inflightDirty || inflightStepDirty || levelsDirty || outputLevelsDirty || prismLevelsDirty;
    if (!needsSave) return;
    
    // Check save interval - use shorter interval for inflight (more critical) or longer for levels
    const inflightInterval = Math.max(1, cfg.inflightSaveIntervalTicks | 0);
    const needsInflightSave = (inflightDirty || inflightStepDirty) && (nowTick - lastSaveTick) >= inflightInterval;
    const needsLevelsSave = (levelsDirty || outputLevelsDirty || prismLevelsDirty) && (nowTick - lastSaveTick) >= SAVE_INTERVAL_TICKS;
    
    if (!needsInflightSave && !needsLevelsSave) return;
    
    // Batch all saves into one operation
    let savesCount = 0;
    
    // Save inflight state (higher priority, shorter interval)
    if (needsInflightSave && (inflightDirty || inflightStepDirty)) {
      persistInflightStateToWorld(world, inflight);
      savesCount++;
      inflightDirty = false;
      inflightStepDirty = false;
    }
    
    // Save input levels
    if (needsLevelsSave && levelsDirty) {
      const obj = {};
      for (const [k, v] of transferCounts.entries()) obj[k] = v;
      saveInputLevels(world, obj);
      savesCount++;
      levelsDirty = false;
    }
    
    // Save output levels
    if (needsLevelsSave && outputLevelsDirty) {
      const obj = {};
      for (const [k, v] of outputCounts.entries()) obj[k] = v;
      saveOutputLevels(world, obj);
      savesCount++;
      outputLevelsDirty = false;
    }
    
    // Save prism levels
    if (needsLevelsSave && prismLevelsDirty) {
      const obj = {};
      for (const [k, v] of prismCounts.entries()) obj[k] = v;
      savePrismLevels(world, obj);
      savesCount++;
      prismLevelsDirty = false;
    }
    
    // Update last save tick if any save occurred
    if (savesCount > 0) {
      lastSaveTick = nowTick;
      if (debugEnabled) debugState.dpSaves += savesCount;
    }
  }

  function enqueuePendingForContainer(containerKey, itemTypeId, amount, outputKey, reservedTypeId) {
    if (!containerKey || !itemTypeId || amount <= 0) return;
    let queue = queueByContainer.get(containerKey);
    if (!queue) {
      queue = [];
      queueByContainer.set(containerKey, queue);
    }
    queue.push({ itemTypeId, amount, outputKey, reservedTypeId: reservedTypeId || itemTypeId });
    const info = resolveContainerInfoCached(containerKey);
    if (!isFurnaceBlock(info?.block)) fullContainers.add(containerKey);
  }

  function resolveContainerInfo(containerKey) {
    return resolveContainerInfoCached(containerKey);
  }

  function getContainerCapacityWithReservations(containerKey, container, containerBlock) {
    try {
      if (!containerKey || !container) return 0;
      const slots = getFurnaceSlots(container, containerBlock);
      const size = container.size;
      let stackRoom = 0;
      let emptySlots = 0;

      const indices = slots ? [slots.input, slots.fuel] : null;
      const loopCount = indices ? indices.length : size;
      for (let i = 0; i < loopCount; i++) {
        const slot = indices ? indices[i] : i;
        const it = container.getItem(slot);
        if (!it) {
          emptySlots++;
          continue;
        }
        const max = it.maxAmount || 64;
        if (it.amount < max) stackRoom += (max - it.amount);
      }

      const reservedTotal = getReservedForContainer(containerKey).total;
      const capacity = stackRoom + (emptySlots * 64);
      return Math.max(0, capacity - reservedTotal);
    } catch (_) {
      return 0;
    }
  }

  function tickOutputQueues() {
    let budget = Math.max(0, cfg.maxQueuedInsertsPerTick | 0);
    if (budget <= 0 || queueByContainer.size === 0) return;

    const keys = Array.from(queueByContainer.keys());
    while (budget > 0 && keys.length > 0) {
      if (queueCursor >= keys.length) queueCursor = 0;
      const containerKey = keys[queueCursor++];
      const queue = queueByContainer.get(containerKey);
      if (!queue || queue.length === 0) {
        queueByContainer.delete(containerKey);
        fullContainers.delete(containerKey);
        budget--;
        continue;
      }

      const info = resolveContainerInfo(containerKey);
      if (!info || !info.container) {
        while (queue.length > 0) {
          const job = queue.shift();
          const outInfo = job?.outputKey ? resolveBlockInfo(job.outputKey) : null;
          if (outInfo?.dim && outInfo?.block) {
            dropItemAt(outInfo.dim, outInfo.block.location, job.itemTypeId, job.amount);
          } else if (info?.dim) {
            dropItemAt(info.dim, info.pos, job.itemTypeId, job.amount);
          }
          releaseContainerSlot(containerKey, job.reservedTypeId || job.itemTypeId, job.amount);
        }
        queueByContainer.delete(containerKey);
        fullContainers.delete(containerKey);
        budget--;
        continue;
      }

      const job = queue[0];
      if (!job) {
        queue.shift();
        budget--;
        continue;
      }

      if (tryInsertAmountForContainer(info.container, info.block || null, job.itemTypeId, job.amount)) {
        queue.shift();
        releaseContainerSlot(containerKey, job.reservedTypeId || job.itemTypeId, job.amount);
        const outInfo = job.outputKey ? resolveBlockInfo(job.outputKey) : null;
        if (outInfo?.block && (isPrismBlock(outInfo.block) || outInfo.block.typeId === CRYSTALLIZER_ID)) {
          noteOutputTransfer(job.outputKey, outInfo.block);
        }
        if (queue.length === 0) {
          queueByContainer.delete(containerKey);
          fullContainers.delete(containerKey);
        }
      } else if (!isFurnaceBlock(info.block)) {
        fullContainers.add(containerKey);
      }
      budget--;
    }
  }

  function tickFullContainers() {
    const total = fullContainers.size;
    if (total === 0) return;
    let budget = Math.max(0, cfg.maxFullChecksPerTick | 0);
    if (budget <= 0) return;

    const keys = Array.from(fullContainers);
    while (budget-- > 0 && keys.length > 0) {
      if (fullCursor >= keys.length) fullCursor = 0;
      const containerKey = keys[fullCursor++];
      if (queueByContainer.has(containerKey)) continue;

      const info = resolveContainerInfo(containerKey);
      if (!info || !info.container) {
        fullContainers.delete(containerKey);
        continue;
      }
      const capacity = getContainerCapacityCached(containerKey, info.container);
      if (capacity > 0) fullContainers.delete(containerKey);
    }
  }

  function onTick() {
    nowTick++;
    resetTickCaches();
    orbFxBudgetUsed = 0;
    
    // Optimization #3: Clear batch route lookup results each tick (only valid for one tick)
    routeLookupResults.clear();
    
    // Optimization #4: Periodically check if crystallizers exist in network
    // If we've done many route lookups and all returned null, mark as no crystallizers
    if ((nowTick - lastCrystallizerCheckTick) >= CRYSTALLIZER_CHECK_INTERVAL) {
      // Check if cache has any non-null routes - if not, maybe no crystallizers exist
      // But be conservative - only mark as false if we're very confident
      if (crystallizerRouteCache.size > 20) {
        let foundAny = false;
        for (const [key, value] of crystallizerRouteCache.entries()) {
          if (value && value.route !== null && (nowTick - value.tick) < CRYSTALLIZER_ROUTE_CACHE_TTL) {
            foundAny = true;
            break;
          }
        }
        // If we've checked many prisms and never found a route, probably no crystallizers
        if (!foundAny && hasCrystallizersInNetwork === null) {
          hasCrystallizersInNetwork = false; // Tentatively mark as no crystallizers
          // Will be reset if we ever find one
        }
      }
      lastCrystallizerCheckTick = nowTick;
    }

    const tickStart = debugEnabled ? Date.now() : 0;

    if (debugEnabled) {
      runTransferPipeline([
        () => {
          const t0 = Date.now();
          tickOutputQueues();
          tickFullContainers();
          processInventoryScanQueue();
          processPathfindingQueue();
          debugState.msQueues += (Date.now() - t0);
        },
        () => {
          const t1 = Date.now();
          tickInFlight();
          debugState.msInflight += (Date.now() - t1);
        },
        () => {
          const t2 = Date.now();
          tickFluxFxInFlight();
          debugState.msFluxFx += (Date.now() - t2);
        },
      ]);
    } else {
      runTransferPipeline([
        () => {
          tickOutputQueues();
          tickFullContainers();
          processInventoryScanQueue();
          processPathfindingQueue();
        },
        tickInFlight,
        tickFluxFxInFlight,
      ]);
    }

    const scanStart = debugEnabled ? Date.now() : 0;
    // Use active prisms only (pre-filtered to only include those with inventories)
    const prismKeys = getActivePrismKeys();
    // Prism count tracked in aggregated stats (postDebugStats)
    if (prismKeys.length === 0) return;

    if (cursor >= prismKeys.length) cursor = 0;
    let scanned = 0;
    let transferBudget = cfg.maxTransfersPerTick;
    let searchBudget = cfg.maxSearchesPerTick;
    let transfersThisTick = 0;
    const scanLimit = Math.min(
      prismKeys.length,
      Math.max(1, cfg.maxPrismsScannedPerTick | 0)
    );

    while ((transferBudget > 0 || searchBudget > 0) && scanned < scanLimit) {
      const prismKey = prismKeys[cursor];
      cursor = (cursor + 1) % prismKeys.length;
      scanned++;

      const allowedAt = nextAllowed.has(prismKey) ? nextAllowed.get(prismKey) : 0;
      if (nowTick < allowedAt) continue;

      // Attempt transfer with budgeted searches
      const tAttempt = debugEnabled ? Date.now() : 0;
      const result = attemptTransferForPrism(prismKey, searchBudget);
      if (debugEnabled) debugState.msScanAttemptTransfer += (Date.now() - tAttempt);
      const searchesUsed = result?.searchesUsed || 0;
      searchBudget -= searchesUsed;
      
      // Track attempts in stats, don't spam chat

      const didTransfer = !!result?.ok;
      if (didTransfer) {
        transfersThisTick++;
        transferBudget--;
      }

      // Get block info for interval calculation (resolveBlockInfo uses cache internally)
      const tInterval = debugEnabled ? Date.now() : 0;
      const info = resolveBlockInfo(prismKey);
      if (debugEnabled) debugState.msScanResolveBlock += (Date.now() - tInterval);
      let interval = cfg.perPrismIntervalTicks;
      if (info && info.block) {
        const s = getSpeed(info.block);
        interval = Math.max(1, (s && s.intervalTicks) ? s.intervalTicks : cfg.perPrismIntervalTicks);
      }
      if (!didTransfer) {
        const reason = result?.reason;
        if (reason === "full" || reason === "no_options" || reason === "no_item" || reason === "no_search_budget") {
          const level = bumpBackoff(prismKey);
          interval += getBackoffTicks(level);
        }
      } else {
        clearBackoff(prismKey);
      }
      nextAllowed.set(prismKey, nowTick + interval);
      if (debugEnabled) debugState.msScanIntervalCalc += (Date.now() - tInterval);

      // If we're out of budgets, stop scanning
      if (transferBudget <= 0 && searchBudget <= 0) break;
    }
    if (debugEnabled) {
      debugState.inputsScanned += scanned;
      debugState.transfersStarted += transfersThisTick;
      debugState.msScan += (Date.now() - scanStart);
    }

    if (debugEnabled) {
      const t3 = Date.now();
      persistAllIfNeeded();
      debugState.msPersist += (Date.now() - t3);
      debugState.msTotal += (Date.now() - tickStart);
    } else {
      persistAllIfNeeded();
    }
    if (debugEnabled) postDebugStats(prismKeys.length);
  }

  function getPrismKeys() {
    try {
      let stamp = null;
      if (typeof getNetworkStamp === "function") {
        stamp = getNetworkStamp();
        if (cachedInputKeys && cachedInputsStamp === stamp) return cachedInputKeys;
      }
      
      // Check raw dynamic property size first
      let rawSize = 0;
      let rawData = null;
      try {
        rawData = world.getDynamicProperty(DP_BEAMS);
        rawSize = typeof rawData === "string" ? rawData.length : 0;
      } catch {}
      
      const map = loadBeamsMap(world);
      // Filter to only return actual prisms from beams map
      const allKeys = Object.keys(map || {});
      const prismKeys = [];
      let foundCount = 0;
      let missingCount = 0;
      let invalidCount = 0;
      let parseFailCount = 0;
      
      // Track map stats for aggregated debug output (no per-call messages)
      
      for (const k of allKeys) {
        // Quick filter: check if entry has kind="prism" (faster than block lookup)
        const entry = map[k];
        const hasPrismKind = entry && typeof entry === "object" && entry.kind === "prism";
        
        // First check if key parses
        const parsed = parseKey(k);
        if (!parsed) {
          parseFailCount++;
          continue;
        }
        
        // Skip block lookup if entry doesn't have prism kind (but still do lookup if kind is missing for backwards compat)
        if (entry && typeof entry === "object" && entry.kind && entry.kind !== "prism") {
          missingCount++;
          continue;
        }
        
        const info = resolveBlockInfoCached(k);
        if (!info) {
          invalidCount++;
          // Track lookup failures in stats, don't spam chat
          continue;
        }
        if (info && info.block && isPrismBlock(info.block)) {
          prismKeys.push(k);
          foundCount++;
        } else {
          missingCount++;
          // Track wrong block types in stats, don't spam chat
        }
      }
      
      // Track stats for aggregated debug output
      // Only show warnings for critical issues
      if (debugEnabled && prismKeys.length === 0 && inflight.length === 0 && nowTick % (debugInterval * 5) === 0) {
        // Only warn if no prisms AND no inflight transfers for extended period
        try {
          const msg = `[Transfer] WARNING: No prisms found in map (${allKeys.length} total keys). Check if prisms are registered.`;
          for (const player of world.getAllPlayers()) {
            if (typeof player.sendMessage === "function") player.sendMessage(msg);
          }
        } catch {}
      }
      
      // Warn about large map size (potential DP limit issue)
      if (rawSize > 100000 && nowTick % (debugInterval * 10) === 0) { // 100KB - warn every 10 debug intervals
        try {
          const warnMsg = `[Transfer] WARNING: Beams map is ${Math.round(rawSize/1024)}KB - may exceed DP size limit!`;
          for (const player of world.getAllPlayers()) {
            if (typeof player.sendMessage === "function") player.sendMessage(warnMsg);
          }
        } catch {}
      }
      
      // If no prisms found in beams map but we have inflight transfers, there might be prisms not in the map
      // This can happen if beams map gets cleared or prisms aren't registered yet
      if (prismKeys.length === 0 && inflight.length > 0) {
        // Try to find prisms from inflight transfer output keys
        const seenKeys = new Set();
        for (const job of inflight) {
          if (job.outputKey && !seenKeys.has(job.outputKey)) {
            seenKeys.add(job.outputKey);
            const info = resolveBlockInfoCached(job.outputKey);
            if (info && info.block && isPrismBlock(info.block)) {
              prismKeys.push(job.outputKey);
              foundCount++;
            }
          }
          if (job.prismKey && !seenKeys.has(job.prismKey)) {
            seenKeys.add(job.prismKey);
            const info = resolveBlockInfoCached(job.prismKey);
            if (info && info.block && isPrismBlock(info.block)) {
              prismKeys.push(job.prismKey);
              foundCount++;
            }
          }
        }
      }
      
      // Auto-cleanup stale entries if too many lookups are failing
      // Run cleanup more aggressively if no prisms found (every 100 ticks = 5 seconds)
      // Otherwise run every 600 ticks (30 seconds) if >50% of entries are stale
      if (prismKeys.length === 0 && invalidCount > allKeys.length * 0.5 && nowTick % 100 === 0) {
        cleanupStaleBeamsMapEntries();
      } else if (invalidCount > allKeys.length * 0.5 && nowTick % 600 === 0) {
        cleanupStaleBeamsMapEntries();
      }
      // Track high invalid count in stats, cleanup happens automatically
      
      if (typeof getNetworkStamp === "function" && stamp !== null) {
        cachedInputKeys = prismKeys;
        cachedInputsStamp = stamp;
      }
      if (debugEnabled) debugState.inputMapReloads++;
      
      // Prism count tracked in aggregated stats (postDebugStats) - no per-call messages
      return prismKeys;
    } catch (e) {
      // Track errors in stats, don't spam chat (only show critical errors)
      if (debugEnabled && nowTick % (debugInterval * 10) === 0) {
        try {
          const msg = `[Transfer] ERROR loading prisms: ${e?.message || "unknown"}`;
          for (const player of world.getAllPlayers()) {
            if (typeof player.sendMessage === "function") player.sendMessage(msg);
          }
        } catch {}
      }
      // Fallback: return empty array
      return [];
    }
  }

  // Cleanup function to remove stale entries from beams map
  function cleanupStaleBeamsMapEntries() {
    try {
      const map = loadBeamsMap(world);
      const allKeys = Object.keys(map || {});
      if (allKeys.length === 0) return;
      
      let removed = 0;
      let kept = 0;
      const cleaned = {};
      
      for (const k of allKeys) {
        const entry = map[k];
        if (!entry || typeof entry !== "object") {
          removed++;
          continue;
        }
        
        // Parse key to get coordinates
        const parsed = parseKey(k);
        if (!parsed) {
          removed++;
          continue;
        }
        
        // Check if block exists and is a prism
        const info = resolveBlockInfoDirect(k);
        if (info && info.error) {
          // Block doesn't exist or dimension invalid - remove entry
          removed++;
          continue;
        }
        
        if (info && info.block && isPrismBlock(info.block)) {
          // Valid prism - ensure connections array exists
          if (!Array.isArray(entry.connections)) {
            entry.connections = [];
          }
          cleaned[k] = entry;
          kept++;
        } else {
          // Block exists but isn't a prism - remove entry
          removed++;
        }
      }
      
      // Save cleaned map
      if (removed > 0) {
        saveBeamsMap(world, cleaned);
        
        // Clear caches so fresh lookups can happen
        resetTickCaches();
        
        if (debugEnabled) {
          try {
            const msg = `[Transfer] Cleanup: Removed ${removed} stale entries, kept ${kept} valid prisms (caches cleared)`;
            for (const player of world.getAllPlayers()) {
              if (typeof player.sendMessage === "function") player.sendMessage(msg);
            }
          } catch {}
        }
      } else if (kept === 0 && allKeys.length > 0) {
        // Map has entries but none are valid - might be completely stale
        if (debugEnabled) {
          try {
            const msg = `[Transfer] Cleanup: All ${allKeys.length} entries were stale - map cleared`;
            for (const player of world.getAllPlayers()) {
              if (typeof player.sendMessage === "function") player.sendMessage(msg);
            }
          } catch {}
        }
        // Clear the entire map if all entries are invalid
        saveBeamsMap(world, {});
        resetTickCaches();
      }
    } catch (err) {
      if (debugEnabled) {
        try {
          const msg = `[Transfer] Cleanup error: ${err?.message || String(err)}`;
          for (const player of world.getAllPlayers()) {
            if (typeof player.sendMessage === "function") player.sendMessage(msg);
          }
        } catch {}
      }
    }
  }

  // Scan nearby area for prisms (disabled - too expensive, use aggregated stats instead)
  function scanNearbyPrisms() {
    // Disabled to reduce lag - use aggregated stats instead
    return;
  }

  // Legacy function name
  function getInputKeys() {
    return getPrismKeys();
  }

  function resolveBlockInfo(inputKey) {
    // Try cached first
    const cached = resolveBlockInfoCached(inputKey);
    if (cached) return cached;
    
    // Fallback: try direct lookup if cache failed
    try {
      if (!inputKey) return null;
      const pos = parseKey(inputKey);
      if (!pos) return null;
      const dim = world.getDimension(pos.dimId);
      if (!dim) return null;
      const block = dim.getBlock({ x: pos.x, y: pos.y, z: pos.z });
      if (!block) return null;
      return { dim, block, pos };
    } catch {
      return null;
    }
  }

  function makeResult(ok, reason) {
    return { ok: !!ok, reason: reason || (ok ? "ok" : "fail") };
  }

  function getFilterForBlock(block) {
    try {
      const c = getFilterContainer(block);
      if (c) return c;
      return getFilterSetForBlock(world, block);
    } catch {
      return null;
    }
  }

  // Unified push/pull transfer for prisms with smart mode detection
  function attemptTransferForPrism(prismKey, searchBudget) {
    let searchesUsed = 0;
    const tResolve = debugEnabled ? Date.now() : 0;
    const prismInfo = resolveBlockInfo(prismKey);
    if (debugEnabled) debugState.msScanResolveBlock += (Date.now() - tResolve);
    if (!prismInfo) return { ...makeResult(false, "no_prism"), searchesUsed };

    const dim = prismInfo.dim;
    const prismBlock = prismInfo.block;
    if (!prismBlock || !isPrismBlock(prismBlock)) return { ...makeResult(false, "no_prism"), searchesUsed };

    // Quick check: does this prism have inventories? (cached)
    if (!getPrismHasInventories(prismKey)) {
      return { ...makeResult(false, "no_container"), searchesUsed };
    }

    // Get all adjacent inventories (multi-inventory support) - cached
    const tInv = debugEnabled ? Date.now() : 0;
    const inventories = getPrismInventoriesCached(prismKey, prismBlock, dim);
    if (debugEnabled) debugState.msScanGetInventories += (Date.now() - tInv);
    if (!inventories || inventories.length === 0) {
      // Invalidate cache if we got false positive
      prismInventoryCache.set(prismKey, false);
      prismInventoryCacheTimestamps.set(prismKey, nowTick);
      return { ...makeResult(false, "no_container"), searchesUsed };
    }

    // Get filter for this prism (attunement)
    const filter = getFilterForBlock(prismBlock);
    const filterSet = filter ? (filter instanceof Set ? filter : getFilterSet(filter)) : null;
    const hasFilter = filterSet && filterSet.size > 0;

    // PRIORITY: Always prioritize filtered pull transfers (demand-driven)
    // Then handle push if no pull happened
    if (hasFilter && searchBudget > 0) {
      // PULL MODE: Request filtered items from network (highest priority)
      const result = attemptPullTransfer(prismKey, prismBlock, dim, inventories, filterSet, searchBudget);
      if (result.ok) return result;
      searchesUsed += result.searchesUsed || 0;
      searchBudget -= result.searchesUsed || 0;
    }
    
    // PUSH MODE: Extract items from inventories and send to network (secondary priority)
    if (searchBudget > 0) {
      const tItem = debugEnabled ? Date.now() : 0;
      const randomItem = getRandomItemFromInventories(inventories, filterSet);
      if (debugEnabled) debugState.msScanGetItem += (Date.now() - tItem);
      if (randomItem) {
        const result = attemptPushTransfer(prismKey, prismBlock, dim, inventories, randomItem, filterSet, searchBudget);
        if (result.ok) {
          return result;
        }
        searchesUsed += result.searchesUsed || 0;
      }
    }

    return { ...makeResult(false, "no_transfer"), searchesUsed };
  }


  // Push transfer: extract items from this prism's inventories and send to other prisms
  function attemptPushTransfer(prismKey, prismBlock, dim, inventories, itemSource, filterSet, searchBudget) {
    let searchesUsed = 0;
    if (searchBudget <= 0) return { ...makeResult(false, "no_search_budget"), searchesUsed };

    // itemSource is { container, slot, stack, inventoryIndex }
    const sourceContainer = itemSource.container;
    const sourceSlot = itemSource.slot;
    const sourceStack = itemSource.stack;
    if (!sourceStack || sourceStack.amount <= 0) return { ...makeResult(false, "no_item"), searchesUsed };

    const prismInfo = resolveBlockInfo(prismKey);
    if (!prismInfo) return { ...makeResult(false, "no_prism"), searchesUsed };

    // Find path to target prism using pathfinder
    // Pathfinder has its own caching, so we call directly
    searchesUsed = 1;
    if (typeof findPathForInput !== "function") {
      return { ...makeResult(false, "no_pathfinder"), searchesUsed };
    }

    const options = findPathForInput(prismKey, nowTick);
    if (!options || !Array.isArray(options) || options.length === 0) {
      // Debug: no paths found (show every 100 ticks to reduce spam)
        // Track path finding failures in stats, don't spam chat
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "no_options"), searchesUsed };
    }
    
    // Debug: paths found (show occasionally)
    // Path finding stats tracked in aggregated output (no per-search messages)
    
    // Optimization #4: Track if crystallizers exist in network during pathfinding
    // Check if any of the pathfinding options are crystallizers
    for (const opt of options) {
      if (opt?.outputType === "crystal") {
        hasCrystallizersInNetwork = true; // Found a crystallizer in the network
        break;
      }
    }

    // Filter and categorize options: prioritize filtered requests, but include all valid options
    const prioritizedOptions = []; // Options with matching filters (highest priority)
    const otherOptions = []; // Options without filters or that don't match
    
    for (const opt of options) {
      if (!opt || !opt.outputKey) continue;
      const targetInfo = resolveBlockInfo(opt.outputKey);
      if (!targetInfo || !targetInfo.block) continue;

      // Crystallizers can always accept flux
      if (targetInfo.block.typeId === CRYSTALLIZER_ID) {
        // Optimization #4: Track crystallizer existence during pathfinding
        if (hasCrystallizersInNetwork !== true) {
          hasCrystallizersInNetwork = true; // Found a crystallizer in the network
        }
        if (isFluxTypeId(sourceStack.typeId)) {
          prioritizedOptions.push(opt); // Crystallizers are high priority for flux
        }
        continue;
      }

      // Prisms - check if they have space and matching filter
      if (isPrismBlock(targetInfo.block)) {
        const targetPrismKey = opt.outputKey; // Use the outputKey from the pathfinding result
        const targetInventories = getPrismInventoriesCached(targetPrismKey, targetInfo.block, targetInfo.dim);
        if (!targetInventories || targetInventories.length === 0) continue;

        const targetFilter = getFilterForBlock(targetInfo.block);
        const targetFilterSet = targetFilter ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter)) : null;
        
        // Prioritize if target has filter AND wants this item (they're requesting it)
        if (targetFilterSet && targetFilterSet.size > 0 && targetFilterSet.has(sourceStack.typeId)) {
          prioritizedOptions.push(opt); // High priority: filtered request
        } else if (!targetFilterSet || targetFilterSet.size === 0) {
          otherOptions.push(opt); // Lower priority: no filter (can accept anything)
        }
        // If target has filter but doesn't want this item, skip it
      }
    }

    // Combine: prioritized first, then others (for random distribution)
    const allValidOptions = prioritizedOptions.length > 0 
      ? prioritizedOptions.concat(otherOptions)
      : otherOptions;

    if (allValidOptions.length === 0) {
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "no_options"), searchesUsed };
    }

    if (debugEnabled) {
      debugState.outputOptionsTotal += allValidOptions.length;
      debugState.outputOptionsMax = Math.max(debugState.outputOptionsMax, allValidOptions.length);
    }

    const isFlux = isFluxTypeId(sourceStack.typeId);
    const previewLevel = getNextInputLevel(prismKey);
    let pathInfo = null;
    let outInfo = null;
    let outBlock = null;
    let outInventories = null;
    let containerKey = null;
    let transferAmount = 0;
    let sawFull = false;
    let outputType = "prism";

    let candidates = allValidOptions.slice();
    if (!isFlux) {
      candidates = candidates.filter((c) => (c?.outputType || "prism") !== "crystal");
    }
    if (candidates.length === 0) return { ...makeResult(false, "no_options"), searchesUsed };

    const available = sourceStack.amount;
    while (candidates.length > 0) {
      // Random selection with bias: prioritize filtered requests (higher weight)
      const pick = pickWeightedRandomWithBias(candidates, (opt) => {
        const type = opt?.outputType || "prism";
        if (isFlux && type === "crystal") return CRYSTAL_FLUX_WEIGHT;
        // Give higher weight to prioritized options (filtered requests)
        const isPrioritized = prioritizedOptions.includes(opt);
        return isPrioritized ? 5.0 : 1.0; // Filtered requests get 5x weight
      });
      if (!pick || !Array.isArray(pick.path) || pick.path.length === 0) break;
      if (pick.path.length > MAX_STEPS) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      if (!validatePathStart(dim, pick.path)) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      const info = resolveBlockInfo(pick.outputKey);
      if (!info || !info.block) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      const pickedType = pick.outputType || "prism";
      if (pickedType === "crystal") {
        if (info.block.typeId !== CRYSTALLIZER_ID) {
          candidates.splice(candidates.indexOf(pick), 1);
          continue;
        }
        const desiredAmount = getTransferAmount(previewLevel, sourceStack);
        const amount = Math.min(desiredAmount, available);
        if (amount <= 0) {
          candidates.splice(candidates.indexOf(pick), 1);
          continue;
        }
        pathInfo = pick;
        outInfo = info;
        outBlock = info.block;
        outInventories = null;
        containerKey = null;
        transferAmount = amount;
        outputType = "crystal";
        break;
      }

      if (!isPrismBlock(info.block)) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      // Get target prism's inventories
      const targetInventories = getAllAdjacentInventories(info.block, info.dim);
      if (!targetInventories || targetInventories.length === 0) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      // Check if we can insert into any of the target inventories (capacity check only, don't insert yet)
      let foundTarget = false;
      for (const targetInv of targetInventories) {
        if (!targetInv.container) continue;
        const targetContainerKey = getContainerKey(targetInv.entity || targetInv.block);
        if (!targetContainerKey) continue;

        // Skip if same container
        const sourceContainerKey = getContainerKey(inventories[itemSource.inventoryIndex].entity || inventories[itemSource.inventoryIndex].block);
        if (sourceContainerKey && targetContainerKey === sourceContainerKey) continue;

        if (fullContainers.has(targetContainerKey)) {
          sawFull = true;
          continue;
        }

        // Check capacity (don't insert yet - that happens during finalization)
        const desiredAmount = getTransferAmount(previewLevel, sourceStack);
        const capacity = getInsertCapacityWithReservations(targetContainerKey, targetInv.container, sourceStack.typeId, sourceStack, targetInv.block);
        if (capacity >= desiredAmount) {
          pathInfo = pick;
          outInfo = info;
          outBlock = info.block;
          outInventories = [targetInv];
          containerKey = targetContainerKey;
          transferAmount = desiredAmount;
          outputType = "prism";
          foundTarget = true;
          break;
        }
      }

      if (foundTarget) break;
      candidates.splice(candidates.indexOf(pick), 1);
    }

    if (!pathInfo || !outInfo || !outBlock) {
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, sawFull ? "full" : "no_options"), searchesUsed };
    }

    // Debug: validate path before extraction
    if (!validatePathStart(dim, pathInfo.path)) {
      if (debugEnabled) {
        try {
          const msg = `[Transfer] Path validation failed! Path length: ${pathInfo.path?.length || 0}`;
          for (const player of world.getAllPlayers()) {
            if (typeof player.sendMessage === "function") player.sendMessage(msg);
          }
        } catch {}
      }
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "path_invalid"), searchesUsed };
    }

    // Extract item from source inventory
    const current = sourceContainer.getItem(sourceSlot);
    if (!current || current.typeId !== sourceStack.typeId || current.amount < transferAmount) {
      return { ...makeResult(false, "no_item"), searchesUsed };
    }

    // Decrement from source
    const remaining = current.amount - transferAmount;
    if (remaining > 0) {
      try {
        const newStack = current.clone();
        newStack.amount = remaining;
        sourceContainer.setItem(sourceSlot, newStack);
      } catch {
        return { ...makeResult(false, "no_item"), searchesUsed };
      }
    } else {
      try {
        sourceContainer.setItem(sourceSlot, null);
      } catch {
        return { ...makeResult(false, "no_item"), searchesUsed };
      }
    }

    const suppressOrb = (outputType === "crystal" && isFluxTypeId(sourceStack.typeId));
    const firstStep = pathInfo.path[0];
    const prismPos = prismInfo.pos;
    const firstBlock = getBlockCached(prismPos.dimId, firstStep) || dim.getBlock({ x: firstStep.x, y: firstStep.y, z: firstStep.z });
    
    // Use node-based path (segments between prisms) - orbs move between nodes, not block-by-block
    // Visual speed scales with distance so all segments take the same time
    const nodePath = buildNodePathSegments(dim, pathInfo.path, prismPos);
    let travelPath = nodePath?.points || pathInfo.path;
    const segmentLengths = nodePath?.lengths || null;

    // Ensure path has at least 2 points (source and destination)
    if (!travelPath || travelPath.length < 2) {
      if (debugEnabled) {
        try {
          const msg = `[Transfer] Path too short! Length: ${travelPath?.length || 0}, using fallback`;
          for (const player of world.getAllPlayers()) {
            if (typeof player.sendMessage === "function") player.sendMessage(msg);
          }
        } catch {}
      }
      // Fallback: create a path with at least source and destination
      const destPos = pathInfo.outputPos || (pathInfo.path && pathInfo.path[pathInfo.path.length - 1]);
      if (destPos) {
        travelPath = [
          { x: prismPos.x, y: prismPos.y, z: prismPos.z },
          { x: destPos.x, y: destPos.y, z: destPos.z }
        ];
        // For fallback, assume segment length of 1
        if (!segmentLengths) {
          segmentLengths = [1];
        }
      } else {
        return { ...makeResult(false, "path_too_short"), searchesUsed };
      }
    }

    const pathPrismKey = findFirstPrismKeyInPath(dim, prismPos.dimId, pathInfo.path);
    const level = noteTransferAndGetLevel(prismKey, prismBlock);
    // stepTicks is constant per segment - visual speed scales with distance automatically
    const stepTicks = getOrbStepTicks(level);
    
    // Calculate initial speed boost from source prism tier
    const sourceTier = isPrismBlock(prismBlock) ? getPrismTierFromTypeId(prismBlock.typeId) : 1;
    const sourceBoost = PRISM_SPEED_BOOST_BASE + ((Math.max(1, sourceTier) - 1) * PRISM_SPEED_BOOST_PER_TIER);
    const initialSpeedScale = Math.min(SPEED_SCALE_MAX, 1.0 + sourceBoost);
    
    // Track transfer creation in debug stats (no per-transfer messages)
    if (debugEnabled) {
      debugState.transfersStarted++;
    }
    
    // Calculate initial delay - time scales with segment length
    // Visual speed is constant, so longer segments take longer
    // stepTicks is time per block, so multiply by segment length
    // Speed boost from source prism is already applied
    const segLen = segmentLengths?.[0] || 1;
    // Time per segment = time per block * number of blocks
    // Apply speed boost to make higher tier prisms faster
    const baseTicksPerBlock = Math.max(1, Math.floor(stepTicks / 4)); // Faster: divide by 4
    const ticksPerBlock = Math.max(1, Math.floor(baseTicksPerBlock / Math.max(0.1, initialSpeedScale)));
    const totalTicksForFirstSegment = ticksPerBlock * Math.max(1, segLen | 0);
    
    // Hard limit: don't create new transfers if we're already overloaded
    // Instead, queue the item for later insertion when capacity is available
    const maxInflight = cfg.maxInflight || 100;
    if (inflight.length >= maxInflight) {
      // Too many in-flight transfers - queue item instead of creating new transfer
      if (containerKey) {
        enqueuePendingForContainer(containerKey, sourceStack.typeId, transferAmount, pathInfo.outputKey, sourceStack.typeId);
      } else {
        // No container key - drop as fallback
        dropItemAt(dim, prismPos, sourceStack.typeId, transferAmount);
      }
      return { ...makeResult(false, "too_many_inflight"), searchesUsed };
    }
    
    const newJob = {
      dimId: prismPos.dimId,
      itemTypeId: sourceStack.typeId,
      amount: transferAmount,
      path: travelPath,
      stepIndex: 0,
      stepTicks: stepTicks,
      speedScale: initialSpeedScale,
      outputKey: pathInfo.outputKey,
      outputType: outputType,
      suppressOrb: suppressOrb,
      containerKey: containerKey,
      prismKey: pathPrismKey,
      startPos: { x: prismPos.x, y: prismPos.y, z: prismPos.z },
      level: level,
      segmentLengths: segmentLengths,
      ticksUntilStep: Math.max(1, totalTicksForFirstSegment),
      refinedItems: (outputType === "crystal" && isFluxTypeId(sourceStack.typeId))
        ? [{ typeId: sourceStack.typeId, amount: transferAmount }]
        : null,
    };
    
    inflight.push(newJob);
    
    // Add to priority queue based on ticksUntilStep
    if (newJob.ticksUntilStep <= 0) {
      readyItems.add(newJob);
    } else if (newJob.ticksUntilStep === 1) {
      nearReadyItems.add(newJob);
    }
    
    if (containerKey) {
      reserveContainerSlot(containerKey, sourceStack.typeId, transferAmount);
    }
    inflightDirty = true;

    return { ...makeResult(true, "ok"), searchesUsed };
  }

  // Pull transfer: request filtered items from network
  function attemptPullTransfer(prismKey, prismBlock, dim, inventories, filterSet, searchBudget) {
    let searchesUsed = 0;
    if (searchBudget <= 0) return { ...makeResult(false, "no_search_budget"), searchesUsed };
    if (!filterSet || filterSet.size === 0) return { ...makeResult(false, "no_filter"), searchesUsed };

    // For now, pull is complex - we'd need to scan the network for items
    // This is a placeholder - can be enhanced later with request system
    // For now, we'll just return false and let push handle transfers
    return { ...makeResult(false, "pull_not_implemented"), searchesUsed };
  }

  function tickInFlight() {
    if (inflight.length === 0) {
      readyItems.clear();
      nearReadyItems.clear();
      return;
    }

    // Performance optimization: Priority queue - only process ready items
    const maxInflight = cfg.maxInflight || 100;
    const baseLimit = 15; // Base limit for movement processing
    const overloaded = inflight.length > maxInflight * 0.8; // Overloaded if > 80% of max
    const maxProcessedPerTick = overloaded ? 10 : baseLimit; // Reduce to 10 when overloaded
    
    // Step 1: Process items from nearReadyItems (they become ready this tick)
    // Move them from nearReadyItems to readyItems and decrement timer
    const t0 = Date.now();
    const inflightSet = new Set(inflight); // Create Set once for O(1) lookups
    for (const job of nearReadyItems) {
      if (!job || !inflightSet.has(job)) {
        nearReadyItems.delete(job);
        continue;
      }
      job.ticksUntilStep--;
      if (job.ticksUntilStep <= 0) {
        nearReadyItems.delete(job);
        readyItems.add(job);
      }
    }
    
    // Step 2: Batch-decrement timers for items NOT in ready/nearReady sets
    // These are items with ticksUntilStep > 1 - just decrement, no other processing
    for (const job of inflight) {
      if (!job) continue;
      // Skip items already in ready/nearReady (they were handled above)
      if (readyItems.has(job) || nearReadyItems.has(job)) continue;
      
      // Fast path: Just decrement timer (cheap operation)
      job.ticksUntilStep--;
      
      // Move to appropriate queue based on new value
      if (job.ticksUntilStep <= 0) {
        readyItems.add(job);
      } else if (job.ticksUntilStep === 1) {
        nearReadyItems.add(job);
      }
    }
    if (debugEnabled) debugState.msInflightPriorityQueue += (Date.now() - t0);
    
    // Step 3: Process items ready to move (from readyItems set)
    // Only process a limited number per tick
    const itemsReadyToMove = Array.from(readyItems);
    readyItems.clear(); // Clear - we'll rebuild as we process
    
    let processed = 0;
    for (const job of itemsReadyToMove) {
      if (processed >= maxProcessedPerTick) break;
      
      // Verify job still exists (might have been removed)
      if (!inflightSet.has(job)) continue;
      
      const cur = job.path[job.stepIndex];
      const nextIdx = job.stepIndex + 1;
      if (nextIdx >= job.path.length) {
        // Job completing - handle immediately
        const tFinalize = Date.now();
        finalizeJob(job);
        if (debugEnabled) debugState.msFinalizeJob += (Date.now() - tFinalize);
        const idx = inflight.indexOf(job); // Only use indexOf when actually removing
        if (idx >= 0) inflight.splice(idx, 1);
        inflightSet.delete(job);
        readyItems.delete(job);
        nearReadyItems.delete(job);
        inflightDirty = true;
        processed++;
        continue;
      }
      
      const next = job.path[nextIdx];
      const tDim = Date.now();
      const dim = getDimensionCached(job.dimId);
      if (debugEnabled) debugState.msCacheOps += (Date.now() - tDim);
      if (!dim) {
        processed++;
        continue;
      }
      
      processed++;

      // Optimize: Only do expensive block lookups when necessary
      // In-flight orbs have paths already calculated - minimal validation needed
      const isFirstStep = job.stepIndex === 0;
      const isLastStep = nextIdx >= job.path.length - 1;
      const needsValidation = isFirstStep || isLastStep || (job.stepIndex % 10 === 0); // Validate every 10 steps
      
      let curBlock = null;
      let nextBlock = null;
      
      const tBlocks = Date.now();
      if (needsValidation) {
        // Validate path occasionally
        curBlock = getBlockCached(job.dimId, cur) || dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });
        nextBlock = getBlockCached(job.dimId, next) || dim.getBlock({ x: next.x, y: next.y, z: next.z });
        
        // Only check path validity if we validated
        if (job.stepIndex < job.path.length - 1 && curBlock && !isPathBlock(curBlock)) {
          dropItemAt(dim, cur, job.itemTypeId, job.amount);
          releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
          const idx = inflight.indexOf(job);
          if (idx >= 0) inflight.splice(idx, 1);
          inflightSet.delete(job);
          readyItems.delete(job);
          nearReadyItems.delete(job);
          inflightDirty = true;
          if (debugEnabled) debugState.msInflightBlockLookups += (Date.now() - tBlocks);
          if (debugEnabled) debugState.msInflightPathValidation += (Date.now() - tBlocks);
          continue;
        }
        if (nextIdx < job.path.length - 1 && nextBlock && !isPathBlock(nextBlock)) {
          dropItemAt(dim, cur, job.itemTypeId, job.amount);
          releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
          const idx = inflight.indexOf(job);
          if (idx >= 0) inflight.splice(idx, 1);
          inflightSet.delete(job);
          readyItems.delete(job);
          nearReadyItems.delete(job);
          inflightDirty = true;
          if (debugEnabled) debugState.msInflightBlockLookups += (Date.now() - tBlocks);
          if (debugEnabled) debugState.msInflightPathValidation += (Date.now() - tBlocks);
          continue;
        }
        if (debugEnabled) debugState.msInflightPathValidation += (Date.now() - tBlocks);
      } else {
        // Fast path: minimal lookups, just get blocks for prism checks
        curBlock = getBlockCached(job.dimId, cur);
        nextBlock = getBlockCached(job.dimId, next);
      }
      if (debugEnabled) debugState.msInflightBlockLookups += (Date.now() - tBlocks);
      
      // Prism-specific logic (only when we have the block)
      const tPrism = Date.now();
      if (curBlock && isPrismBlock(curBlock)) {
        if (job.refineOnPrism && isFluxTypeId(job.itemTypeId)) {
          applyPrismRefineToFxJob(job, curBlock);
        }
        if (job.stepIndex < job.path.length - 1) {
          notePrismPassage(key(job.dimId, cur.x, cur.y, cur.z), curBlock);
          applyPrismSpeedBoost(job, curBlock);
          if (isFluxTypeId(job.itemTypeId)) {
            applyPrismRefineToJob(job, curBlock);
          }
        }
      }
      if (debugEnabled) debugState.msInflightPrismLogic += (Date.now() - tPrism);

      const baseTicks = job.stepTicks || cfg.orbStepTicks;
      // Apply speed boost to logical speed (faster movement = fewer ticks per segment)
      const stepTicks = Math.max(1, Math.floor(baseTicks / Math.max(0.1, job.speedScale || 1)));
      
      // Get segment length - determines how long this segment takes
      // Visual speed is constant, so longer segments take longer
      const segLen = job.segmentLengths?.[job.stepIndex] || 1;
      
      // Calculate logical time for this segment (in ticks)
      // Use smaller ticks per block to make movement faster
      const ticksPerBlock = Math.max(1, Math.floor(stepTicks / 4)); // Faster: divide by 4
      const logicalTicks = ticksPerBlock * Math.max(1, segLen | 0);
      
      // Spawn orb when item moves to next step (ONLY when moving to new segment)
      const tOrb = Date.now();
      if (!job.suppressOrb) {
        const orbCurBlock = curBlock || getBlockCached(job.dimId, cur);
        const orbNextBlock = nextBlock || getBlockCached(job.dimId, next);
        if (spawnOrbStep(dim, cur, next, job.level, orbCurBlock, orbNextBlock, job.itemTypeId, segLen, logicalTicks, job.speedScale || 1.0)) {
          if (debugEnabled) debugState.orbSpawns++;
        }
      }
      if (debugEnabled) debugState.msInflightOrbSpawning += (Date.now() - tOrb);
      
      // Advance step
      const tMove = Date.now();
      job.stepIndex = nextIdx;
      // Time per segment scales with length (longer segments = more time)
      // Speed boost already applied via stepTicks reduction
      job.ticksUntilStep = logicalTicks;
      inflightStepDirty = true;
      
      // Update priority queues based on new ticksUntilStep
      // Job was already removed from readyItems (cleared at start of Step 3)
      // Add to appropriate queue for next cycle
      if (job.ticksUntilStep <= 0) {
        // Edge case: immediately ready again (shouldn't happen but handle it)
        readyItems.add(job);
      } else if (job.ticksUntilStep === 1) {
        nearReadyItems.add(job);
      }
      // Otherwise ticksUntilStep > 1, item goes back to "waiting" pool (not in any queue)
      if (debugEnabled) debugState.msInflightMovement += (Date.now() - tMove);
    }
  }

  function tickFluxFxInFlight() {
    if (fluxFxInflight.length === 0) return;
    
    // Limit processing per tick to prevent spikes
    const maxProcessedPerTick = 15; // Process max 15 flux FX jobs per tick
    let processed = 0;
    
    for (let i = fluxFxInflight.length - 1; i >= 0 && processed < maxProcessedPerTick; i--) {
      const job = fluxFxInflight[i];
      job.ticksUntilStep--;
      if (job.ticksUntilStep > 0) {
        processed++;
        continue;
      }
      processed++;

      const nextIdx = job.stepIndex + 1;
      if (nextIdx >= job.path.length) {
        finalizeFluxFxJob(job);
        fluxFxInflight.splice(i, 1);
        continue;
      }

      const dim = getDimensionCached(job.dimId);
      if (!dim) {
        fluxFxInflight.splice(i, 1);
        continue;
      }

      const cur = job.path[job.stepIndex];
      const next = job.path[nextIdx];
      const curBlock = getBlockCached(job.dimId, cur) || dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });
      const nextBlock = getBlockCached(job.dimId, next) || dim.getBlock({ x: next.x, y: next.y, z: next.z });
      if (isPrismBlock(curBlock)) {
        applyPrismSpeedBoost(job, curBlock);
        if (job.refineOnPrism && isFluxTypeId(job.itemTypeId)) {
          applyPrismRefineToFxJob(job, curBlock);
        }
      }
      const segLen = job.segmentLengths?.[job.stepIndex] || 1;
      const baseTicks = job.stepTicks || cfg.orbStepTicks;
      const stepTicks = Math.max(1, Math.floor(baseTicks / Math.max(0.1, job.speedScale || 1)));
      // Use smaller ticks per block to make movement faster
      const ticksPerBlock = Math.max(1, Math.floor(stepTicks / 4)); // Faster: divide by 4
      const logicalTicks = ticksPerBlock * Math.max(1, segLen | 0);
      if (spawnOrbStep(dim, cur, next, job.level, curBlock, nextBlock, job.itemTypeId, segLen, logicalTicks, job.speedScale || 1.0) && debugEnabled) {
        debugState.fluxFxSpawns++;
      }
      job.stepIndex = nextIdx;
      job.ticksUntilStep = logicalTicks;
    }
  }

  function finalizeFluxFxJob(job) {
    try {
      const dim = getDimensionCached(job.dimId);
      if (!dim) return;

      if (job.crystalKey) {
        if (job.skipCrystalAdd) return;
        const itemsToConvert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
          ? job.refinedItems
          : [{ typeId: job.itemTypeId, amount: job.amount }];
        let added = 0;
        for (const entry of itemsToConvert) {
          const value = getFluxValueForItem(entry.typeId);
          if (value > 0) {
            const gained = addFluxForItem(job.crystalKey, entry.typeId, entry.amount);
            if (gained > 0) added += gained;
          } else {
            dropItemAt(dim, job.dropPos || { x: 0, y: 0, z: 0 }, entry.typeId, entry.amount);
          }
        }
        if (added > 0) {
          const p = parseKey(job.crystalKey);
          if (p) {
            const block = dim.getBlock({ x: p.x, y: p.y, z: p.z });
            if (block) fxFluxGenerate(block, FX);
          }
        }
        return;
      }

      if (job.containerKey) {
        const info = resolveContainerInfo(job.containerKey);
        const itemsToInsert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
          ? job.refinedItems
          : [{ typeId: job.itemTypeId, amount: job.amount }];
        if (info?.container) {
          let allInserted = true;
          for (const entry of itemsToInsert) {
            if (!tryInsertAmountForContainer(info.container, info.block || null, entry.typeId, entry.amount)) {
              allInserted = false;
              enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, null, entry.typeId);
            }
          }
          if (allInserted) return;
        } else {
          for (const entry of itemsToInsert) {
            enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, null, entry.typeId);
          }
        }
        return;
      }

      if (job.suppressDrop) return;
      if (job.dropPos) {
        dropItemAt(dim, job.dropPos, job.itemTypeId, job.amount);
      }
    } catch {
      // ignore
    }
  }

  function postDebugStats(inputCount) {
    if ((nowTick - lastDebugTick) < debugInterval) return;
    lastDebugTick = nowTick;

    const pathStats = (typeof getPathStats === "function") ? getPathStats() : null;

    let queuedContainers = 0;
    let queuedEntries = 0;
    let queuedItems = 0;
    let queuedMax = 0;
    for (const queue of queueByContainer.values()) {
      if (!queue) continue;
      queuedContainers++;
      queuedEntries += queue.length;
      queuedMax = Math.max(queuedMax, queue.length);
      for (const job of queue) {
        queuedItems += Math.max(0, job?.amount | 0);
      }
    }

    // Cleaner, more readable network stats
    const parts = [];
    parts.push(`Prisms: ${inputCount}`);
    parts.push(`Transfers: ${debugState.transfersStarted}`);
    parts.push(`In-flight: ${inflight.length}`);
    if (queuedEntries > 0) {
      parts.push(`Queued: ${queuedEntries} items`);
    }
    
    if (pathStats && pathStats.searches > 0) {
      parts.push(`Paths: ${pathStats.searches} searches`);
    }
    
    // Show in-flight count as "orbs" since each in-flight item should have one visible orb
    // The actual spawn count is misleading (shows spawns per interval, not visible count)
    if (inflight.length > 0) {
      parts.push(`Orbs: ${inflight.length}`);
    }
    
    if (fluxFxInflight.length > 0) {
      parts.push(`Flux FX: ${fluxFxInflight.length}`);
    }
    
    // Show total time
    if (debugState.msTotal > 5) {
      parts.push(`Time: ${debugState.msTotal}ms`);
    }

    const msg = `[Transfer] ${parts.join(" | ")}`;

    for (const player of world.getAllPlayers()) {
      try {
        if (typeof player.sendMessage === "function") {
          player.sendMessage(msg);
        }
      } catch {
        // ignore
      }
    }

    // Detailed timing breakdown on second line (only if total time is significant)
    if (debugState.msTotal > 10) {
      const timingParts = [];
      if (debugState.msInflight > 1) {
        timingParts.push(`Inflight: ${debugState.msInflight}ms`);
      }
      if (debugState.msInflightPriorityQueue > 0.5) {
        timingParts.push(`PQ: ${debugState.msInflightPriorityQueue.toFixed(1)}ms`);
      }
      if (debugState.msInflightBlockLookups > 0.5) {
        timingParts.push(`Blocks: ${debugState.msInflightBlockLookups.toFixed(1)}ms`);
      }
      if (debugState.msInflightPathValidation > 0.5) {
        timingParts.push(`PathVal: ${debugState.msInflightPathValidation.toFixed(1)}ms`);
      }
      if (debugState.msInflightPrismLogic > 0.5) {
        timingParts.push(`Prism: ${debugState.msInflightPrismLogic.toFixed(1)}ms`);
      }
      if (debugState.msInflightOrbSpawning > 0.5) {
        timingParts.push(`Orbs: ${debugState.msInflightOrbSpawning.toFixed(1)}ms`);
      }
      if (debugState.msInflightMovement > 0.5) {
        timingParts.push(`Move: ${debugState.msInflightMovement.toFixed(1)}ms`);
      }
      if (debugState.msPathfinding > 1) {
        timingParts.push(`Pathfind: ${debugState.msPathfinding}ms`);
      }
      if (debugState.msInventoryScanning > 1) {
        timingParts.push(`InvScan: ${debugState.msInventoryScanning}ms`);
      }
      if (debugState.msCacheOps > 1) {
        timingParts.push(`Cache: ${debugState.msCacheOps}ms`);
      }
      if (debugState.msFinalizeJob > 1) {
        timingParts.push(`Finalize: ${debugState.msFinalizeJob}ms`);
      }
      if (debugState.msFinalizeBlockLookups > 1) {
        timingParts.push(`FinalizeBlocks: ${debugState.msFinalizeBlockLookups.toFixed(1)}ms`);
      }
      if (debugState.msFinalizeInventoryLookups > 1) {
        timingParts.push(`FinalizeInv: ${debugState.msFinalizeInventoryLookups.toFixed(1)}ms`);
      }
      if (debugState.msFinalizeFluxRefine > 1) {
        timingParts.push(`FinalizeRefine: ${debugState.msFinalizeFluxRefine.toFixed(1)}ms`);
      }
      if (debugState.msFinalizeItemInsertion > 1) {
        timingParts.push(`FinalizeInsert: ${debugState.msFinalizeItemInsertion.toFixed(1)}ms`);
      }
      if (debugState.msFinalizeCrystalRoute > 1) {
        timingParts.push(`FinalizeRoute: ${debugState.msFinalizeCrystalRoute.toFixed(1)}ms`);
      }
      if (debugState.msFinalizeFluxGenerate > 1) {
        timingParts.push(`FinalizeFlux: ${debugState.msFinalizeFluxGenerate.toFixed(1)}ms`);
      }
      if (debugState.msFinalizeQueueCleanup > 1) {
        timingParts.push(`FinalizeQueue: ${debugState.msFinalizeQueueCleanup.toFixed(1)}ms`);
      }
      if (debugState.msScan > 1) {
        timingParts.push(`Scan: ${debugState.msScan}ms`);
      }
      if (debugState.msScanAttemptTransfer > 1) {
        timingParts.push(`ScanAttempt: ${debugState.msScanAttemptTransfer.toFixed(1)}ms`);
      }
      if (debugState.msScanResolveBlock > 1) {
        timingParts.push(`ScanResolve: ${debugState.msScanResolveBlock.toFixed(1)}ms`);
      }
      if (debugState.msScanGetInventories > 1) {
        timingParts.push(`ScanInv: ${debugState.msScanGetInventories.toFixed(1)}ms`);
      }
      if (debugState.msScanGetItem > 1) {
        timingParts.push(`ScanItem: ${debugState.msScanGetItem.toFixed(1)}ms`);
      }
      if (debugState.msScanIntervalCalc > 1) {
        timingParts.push(`ScanInterval: ${debugState.msScanIntervalCalc.toFixed(1)}ms`);
      }
      if (debugState.msPersist > 1) {
        timingParts.push(`Persist: ${debugState.msPersist}ms`);
      }
      
      if (timingParts.length > 0) {
        const timingMsg = `[Transfer] Timings: ${timingParts.join(" | ")}`;
        for (const player of world.getAllPlayers()) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(timingMsg);
            }
          } catch {
            // ignore
          }
        }
      }
    }

    resetDebugState();
  }

  function finalizeJob(job) {
    // Prevent double-finalization
    if (job._finalized) {
      // Track double-finalization in stats, don't spam chat
      return;
    }
    job._finalized = true;
    
    // Track finalization in debug stats (no per-transfer messages)
    // Stats are aggregated in postDebugStats()
    
    if (job?.outputType === "crystal") {
      if (job.skipCrystalAdd) return;
      const tBlock = debugEnabled ? Date.now() : 0;
      const outInfo = resolveBlockInfo(job.outputKey);
      if (debugEnabled) debugState.msFinalizeBlockLookups += (Date.now() - tBlock);
      if (!outInfo || !outInfo.block || outInfo.block.typeId !== CRYSTALLIZER_ID) {
        // Track crystallizer missing in stats, don't spam chat
        const dim = getDimensionCached(job.dimId);
        if (dim) {
          const fallback = job.path[job.path.length - 1] || job.startPos;
          if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
        }
        return;
      }

      const itemsToConvert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
        ? job.refinedItems
        : [{ typeId: job.itemTypeId, amount: job.amount }];

      let added = 0;
      for (const entry of itemsToConvert) {
        const value = getFluxValueForItem(entry.typeId);
        if (value > 0) {
          const gained = addFluxForItem(job.outputKey, entry.typeId, entry.amount);
          if (gained > 0) added += gained;
        } else {
          dropItemAt(outInfo.dim, outInfo.block.location, entry.typeId, entry.amount);
        }
      }
      if (added > 0) fxFluxGenerate(outInfo.block, FX);
      return;
    }

    if (!job.containerKey) {
      // Track in stats, don't spam chat
      const dim = getDimensionCached(job.dimId);
      if (dim) {
        const fallback = job.path[job.path.length - 1] || job.startPos;
        if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
      }
      return;
    }
    const tBlock1 = debugEnabled ? Date.now() : 0;
    const outInfo = resolveBlockInfo(job.outputKey);
    if (debugEnabled) debugState.msFinalizeBlockLookups += (Date.now() - tBlock1);
    if (!outInfo) {
      // Track in stats, don't spam chat
      const dim = getDimensionCached(job.dimId);
      if (dim) {
        const fallback = job.path[job.path.length - 1] || job.startPos;
        if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
      }
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      return;
    }

    const outBlock = outInfo.block;
    // Target is now a prism (or crystallizer)
    if (!outBlock || (!isPrismBlock(outBlock) && outBlock.typeId !== CRYSTALLIZER_ID)) {
      // Track in stats, don't spam chat
      dropItemAt(outInfo.dim, outBlock?.location || outInfo.pos, job.itemTypeId, job.amount);
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      return;
    }

    // For prisms, use multi-inventory support
    let outInventories = null;
    let outContainerInfo = null; // Initialize for use in flux generation
    if (isPrismBlock(outBlock)) {
      const outPrismKey = job.outputKey; // Use the outputKey from the job
      const tInv = debugEnabled ? Date.now() : 0;
      outInventories = getPrismInventoriesCached(outPrismKey, outBlock, outInfo.dim);
      if (debugEnabled) debugState.msFinalizeInventoryLookups += (Date.now() - tInv);
      if (!outInventories || outInventories.length === 0) {
        // Debug: no inventories
        if (debugEnabled) {
          try {
            const msg = `[Transfer] No inventories adjacent to target prism! Dropping item`;
            for (const player of world.getAllPlayers()) {
              if (typeof player.sendMessage === "function") player.sendMessage(msg);
            }
          } catch {}
        }
        dropItemAt(outInfo.dim, outBlock.location, job.itemTypeId, job.amount);
        releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
        return;
      }
      // For prisms, use first inventory for flux generation
      if (outInventories.length > 0) {
        outContainerInfo = {
          container: outInventories[0].container,
          block: outInventories[0].block,
          entity: outInventories[0].entity
        };
      }
    } else {
      // Crystallizer - use old method for now
      outContainerInfo = getAttachedInventoryInfo(outBlock, outInfo.dim);
      if (!outContainerInfo || !outContainerInfo.container) {
        dropItemAt(outInfo.dim, outBlock.location, job.itemTypeId, job.amount);
        releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
        return;
      }
      outInventories = [{ container: outContainerInfo.container, block: outContainerInfo.block, entity: outContainerInfo.entity }];
    }

    let itemsToInsert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    if (!job.refinedItems && job.prismKey) {
      const tRefine = debugEnabled ? Date.now() : 0;
      const prismInfo = resolveBlockInfo(job.prismKey);
      if (debugEnabled) {
        debugState.fluxRefineCalls++;
        debugState.msFinalizeBlockLookups += (Date.now() - tRefine);
      }
      const tRefine2 = debugEnabled ? Date.now() : 0;
      const refined = tryRefineFluxInTransfer({
        prismBlock: prismInfo?.block,
        itemTypeId: job.itemTypeId,
        amount: job.amount,
        FX: FX,
      });
      if (debugEnabled) debugState.msFinalizeFluxRefine += (Date.now() - tRefine2);
      if (debugEnabled && refined) {
        debugState.fluxRefined += Math.max(0, refined.refined | 0);
        debugState.fluxMutated += Math.max(0, refined.mutated | 0);
      }
      if (refined?.items?.length) itemsToInsert = refined.items;
    }

    let allInserted = true;
    const tInsert = debugEnabled ? Date.now() : 0;
    for (const entry of itemsToInsert) {
      // Use multi-inventory insert for prisms
      if (isPrismBlock(outBlock)) {
        // Get filter for target prism to determine if it wants this item
        // Optimization: Cache filter lookup if same block is used multiple times
        const targetFilter = getFilterForBlock(outBlock);
        const targetFilterSet = targetFilter ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter)) : null;
        const inserted = tryInsertIntoInventories(outInventories, entry.typeId, entry.amount, targetFilterSet);
        if (!inserted) {
          // Track insertion failures in stats, don't spam chat
          allInserted = false;
          enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, job.outputKey, job.itemTypeId);
        }
      } else {
        // Crystallizer - use old method
        const outContainerInfo = { container: outInventories[0].container, block: outInventories[0].block, entity: outInventories[0].entity };
        const inserted = tryInsertAmountForContainer(outContainerInfo.container, outContainerInfo.block || null, entry.typeId, entry.amount);
        if (!inserted) {
          // Track insertion failures in stats, don't spam chat
          allInserted = false;
          enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, job.outputKey, job.itemTypeId);
        }
      }
    }
    if (debugEnabled) debugState.msFinalizeItemInsertion += (Date.now() - tInsert);

    // Invalidate inventory cache for the destination prism when items are inserted
    if (isPrismBlock(outBlock) && job.outputKey) {
      prismInventoryListCache.delete(job.outputKey);
      prismInventoryListCacheTimestamps.delete(job.outputKey);
    }
    
    if (allInserted) {
      // Track successful insertions in stats, don't spam chat
      
      // Remove any pending queue entries for this container/item to prevent duplicate insertions
      const tQueue = debugEnabled ? Date.now() : 0;
      if (job.containerKey && queueByContainer.has(job.containerKey)) {
        const queue = queueByContainer.get(job.containerKey);
        if (queue && Array.isArray(queue)) {
          // Optimization: Use filter + slice instead of splice in reverse loop for better performance
          // Only remove matching entries, keep rest
          const beforeLen = queue.length;
          const filtered = queue.filter(q => 
            !(q && q.itemTypeId === job.itemTypeId && q.outputKey === job.outputKey)
          );
          if (filtered.length !== beforeLen) {
            queue.length = 0;
            queue.push(...filtered);
          }
          if (queue.length === 0) {
            queueByContainer.delete(job.containerKey);
            fullContainers.delete(job.containerKey);
          }
        }
      }
      if (debugEnabled) debugState.msFinalizeQueueCleanup += (Date.now() - tQueue);
      
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      if (isPrismBlock(outBlock)) {
        // For prisms, note transfer for leveling
        noteOutputTransfer(job.outputKey, outBlock);
      }
      if (debugEnabled) debugState.fluxGenChecks++;
      
      // Optimization #1 & #4: Skip route lookup if we know no crystallizers exist OR if output is not a prism
      let crystalRoute = null;
      const shouldLookupRoute = (() => {
        // Optimization #4: Skip entirely if we know no crystallizers exist
        if (hasCrystallizersInNetwork === false) return false;
        
        // Optimization #1: Only lookup route if output is a prism (crystallizers don't need routes)
        if (!isPrismBlock(outBlock)) return false; // Crystallizers don't need routes
        
        // Even tier 1 has 1% flux generation chance, so we should still check if crystallizers might exist
        return true; // Lookup route
      })();
      
      const tCrystalRoute = debugEnabled ? Date.now() : 0;
      if (shouldLookupRoute) {
        // Optimization #3: Check if we already looked up route for this prism this tick (batching)
        const crystalRouteKey = job.outputKey;
        const batchedResult = routeLookupResults.get(crystalRouteKey);
        if (batchedResult !== undefined) {
          crystalRoute = batchedResult;
        } else {
          // Not batched this tick - check cache or lookup
          const cachedRoute = crystallizerRouteCache.get(crystalRouteKey);
          if (cachedRoute && (nowTick - cachedRoute.tick) <= CRYSTALLIZER_ROUTE_CACHE_TTL) {
            crystalRoute = cachedRoute.route;
          } else {
            // Not cached or expired - find route and cache
            crystalRoute = isPrismBlock(outBlock) 
              ? findCrystallizerRouteFromPrism(outBlock, job.dimId)
              : findCrystallizerRouteFromOutput(outBlock, job.dimId);
            // Cache the result (even if null, to avoid repeated expensive lookups)
            crystallizerRouteCache.set(crystalRouteKey, {
              route: crystalRoute,
              tick: nowTick,
            });
          }
          
          // Batch result for this tick (so other jobs finishing same tick can reuse)
          routeLookupResults.set(crystalRouteKey, crystalRoute);
          
          // Update global crystallizer existence flag
          if (hasCrystallizersInNetwork === null && crystalRoute !== null) {
            hasCrystallizersInNetwork = true; // Found at least one crystallizer
          }
        }
      } else {
        crystalRoute = null; // Skip lookup entirely
      }
      if (debugEnabled) debugState.msFinalizeCrystalRoute += (Date.now() - tCrystalRoute);
      
      // Only generate flux if we have a valid container
      if (outContainerInfo && outContainerInfo.container) {
        const tFlux = debugEnabled ? Date.now() : 0;
        // Optimization: Cache start block lookup - job.startPos might not be needed every time
        const startBlock = job.startPos ? (getBlockCached(job.dimId, job.startPos) || outInfo.dim.getBlock(job.startPos)) : null;
        const fluxGenerated = tryGenerateFluxOnTransfer({
          outputBlock: outBlock,
          destinationInventory: outContainerInfo.container,
          inputBlock: startBlock,
          path: job.path,
          getAttachedInventoryInfo,
          getBlockAt: (pos, dim) => {
            if (!pos) return null;
            const dimId = dim?.id || job.dimId;
            return getBlockCached(dimId, pos);
          },
          scheduleFluxTransferFx: enqueueFluxTransferFx,
          scheduleFluxTransferFxPositions: enqueueFluxTransferFxPositions,
          getContainerKey,
          transferLevel: job.level,
          transferStepTicks: job.stepTicks || cfg.orbStepTicks,
          transferSpeedScale: 1.0,
          FX: FX,
          consumeFluxOutput: !!crystalRoute,
        });
        if (debugEnabled) debugState.msFinalizeFluxGenerate += (Date.now() - tFlux);
        if (debugEnabled && fluxGenerated > 0) debugState.fluxGenHits++;
        if (fluxGenerated > 0 && crystalRoute) {
          if (typeof enqueueFluxTransferFxPositions === "function") {
            enqueueFluxTransferFxPositions(
              crystalRoute.path,
              crystalRoute.outputIndex,
              crystalRoute.targetIndex,
              "chaos:flux_1",
              job.level,
              {
                amount: fluxGenerated,
                dimId: job.dimId,
                suppressDrop: true,
                refineOnPrism: true,
                crystalKey: key(job.dimId, crystalRoute.crystalPos.x, crystalRoute.crystalPos.y, crystalRoute.crystalPos.z),
                stepTicks: job.stepTicks || cfg.orbStepTicks,
                speedScale: 1.0,
              }
            );
          }
        }
      }
      return;
    } else {
      // Some items failed to insert - they're queued, but we still need to release the reservation
      // The queued items will be inserted by tickOutputQueues()
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      return;
    }
  }

  function findPrismsInPath(path, dimId) {
    try {
      if (!Array.isArray(path) || path.length === 0) return [];
      const prisms = [];
      for (const p of path) {
        if (!p) continue;
        const b = getBlockCached(dimId, p);
        if (b && isPrismBlock(b)) prisms.push(b);
      }
      return prisms;
    } catch {
      return [];
    }
  }

  function applyPrismRefineChain(items, prismBlocks, speedScale) {
    let list = Array.isArray(items) ? items.slice() : [];
    if (!prismBlocks || prismBlocks.length === 0) return list;
    const scale = Math.max(0.1, Number(speedScale) || 1.0);
    for (const prismBlock of prismBlocks) {
      if (!prismBlock) continue;
      const next = [];
      for (const entry of list) {
        if (!entry || !isFluxTypeId(entry.typeId)) {
          next.push(entry);
          continue;
        }
        if (debugEnabled) debugState.fluxRefineCalls++;
        const refined = tryRefineFluxInTransfer({
          prismBlock,
          itemTypeId: entry.typeId,
          amount: entry.amount,
          FX: FX,
          speedScale: scale,
        });
        if (debugEnabled && refined) {
          debugState.fluxRefined += Math.max(0, refined.refined | 0);
          debugState.fluxMutated += Math.max(0, refined.mutated | 0);
        }
        if (refined?.items?.length) next.push(...refined.items);
        else next.push(entry);
      }
      list = next;
    }
    return list;
  }

  function applyPrismRefineToJob(job, prismBlock) {
    const items = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    let refined = applyPrismRefineChain(items, [prismBlock], job.speedScale);
    if (job.outputType === "crystal") {
      const exotics = [];
      const filtered = [];
      for (const entry of refined) {
        if (!entry) continue;
        if (isFluxTypeId(entry.typeId)) {
          filtered.push(entry);
        } else {
          exotics.push(entry);
        }
      }
      if (exotics.length > 0) sendExoticsToOutput(prismBlock, job, exotics);
      refined = filtered;
      job.skipCrystalAdd = refined.length === 0;
    }
    job.refinedItems = refined;
    if (refined && refined.length > 0 && refined[0]?.typeId) {
      job.itemTypeId = refined[0].typeId;
    }
  }

  function applyPrismRefineToFxJob(job, prismBlock) {
    const items = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    let refined = applyPrismRefineChain(items, [prismBlock], job.speedScale);
    if (job.crystalKey) {
      const exotics = [];
      const filtered = [];
      for (const entry of refined) {
        if (!entry) continue;
        if (isFluxTypeId(entry.typeId)) {
          filtered.push(entry);
        } else {
          exotics.push(entry);
        }
      }
      if (exotics.length > 0) sendExoticsToOutput(prismBlock, job, exotics);
      refined = filtered;
      job.skipCrystalAdd = refined.length === 0;
    }
    job.refinedItems = refined;
    if (refined && refined.length > 0 && refined[0]?.typeId) {
      job.itemTypeId = refined[0].typeId;
    }
  }

  function applyPrismSpeedBoost(job, prismBlock) {
    try {
      const level = isPrismBlock(prismBlock) ? getPrismTierFromTypeId(prismBlock.typeId) : 1;
      // Calculate additive boost: tier 1 = 0%, tier 2 = 5%, tier 3 = 10%, tier 4 = 15%, tier 5 = 20%
      const boost = PRISM_SPEED_BOOST_BASE + ((Math.max(1, level) - 1) * PRISM_SPEED_BOOST_PER_TIER);
      const current = Math.max(0.1, Number(job.speedScale) || 1.0);
      // Add boost to current speed (1.0 + boost), not multiply
      // Tier 1: 1.0 + 0.0 = 1.0, Tier 2: 1.0 + 0.05 = 1.05, etc.
      job.speedScale = Math.min(SPEED_SCALE_MAX, current + boost);
    } catch {
      // ignore
    }
  }

  function sendExoticsToOutput(prismBlock, job, exotics) {
    try {
      if (!prismBlock || !job || !Array.isArray(exotics) || exotics.length === 0) return;
      const route = findOutputRouteFromNode(prismBlock, job.dimId);
      if (!route) {
        for (const entry of exotics) {
          dropItemAt(prismBlock.dimension, prismBlock.location, entry.typeId, entry.amount);
        }
        return;
      }

      const outInfo = resolveBlockInfo(route.outputKey);
      const outBlock = outInfo?.block;
      const cInfo = outBlock ? getAttachedInventoryInfo(outBlock, outInfo.dim) : null;
      const containerKey = getContainerKeyFromInfo(cInfo);

      for (const entry of exotics) {
        let scheduled = false;
        if (containerKey && typeof enqueueFluxTransferFxPositions === "function") {
          enqueueFluxTransferFxPositions(
            route.path,
            route.startIndex,
            route.endIndex,
            entry.typeId,
            job.level || 1,
            {
              amount: entry.amount,
              dimId: job.dimId,
              containerKey,
              dropPos: outBlock?.location || prismBlock.location,
            }
          );
          scheduled = true;
        }
        if (!scheduled) {
          if (cInfo?.container && containerKey) {
            if (!tryInsertAmountForContainer(cInfo.container, cInfo.block || null, entry.typeId, entry.amount)) {
              enqueuePendingForContainer(containerKey, entry.typeId, entry.amount, route.outputKey, entry.typeId);
            }
          } else {
            dropItemAt(prismBlock.dimension, prismBlock.location, entry.typeId, entry.amount);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  function findOutputRouteFromNode(startBlock, dimId) {
    try {
      if (!startBlock || !dimId) return null;
      const dim = startBlock.dimension;
      if (!dim) return null;
      const startPos = startBlock.location;
      const startKey = key(dimId, startPos.x, startPos.y, startPos.z);

      const queue = [];
      let qIndex = 0;
      const visited = new Set();
      const parent = new Map();
      queue.push({ nodePos: { x: startPos.x, y: startPos.y, z: startPos.z }, nodeType: "prism", key: startKey });
      visited.add(startKey);

      while (qIndex < queue.length && visited.size < CRYSTAL_ROUTE_MAX_NODES) {
        const cur = queue[qIndex++];
        const dirs = makeDirs();
        for (const d of dirs) {
          const edge = scanEdgeFromNode(dim, cur.nodePos, d, cur.nodeType);
          if (!edge) continue;
          const nextKey = key(dimId, edge.nodePos.x, edge.nodePos.y, edge.nodePos.z);
          if (visited.has(nextKey)) continue;
          visited.add(nextKey);
          parent.set(nextKey, {
            prevKey: cur.key,
            edgePath: edge.path,
            nodePos: { x: edge.nodePos.x, y: edge.nodePos.y, z: edge.nodePos.z },
            nodeType: edge.nodeType,
          });

          // Target prisms (or crystallizers)
          if (edge.nodeType === "prism" || edge.nodeType === "crystal") {
            const outBlock = dim.getBlock(edge.nodePos);
            if (!outBlock || (!isPrismBlock(outBlock) && outBlock.typeId !== CRYSTALLIZER_ID)) {
              continue;
            }
            
            // For prisms, check if they have inventories
            if (isPrismBlock(outBlock)) {
              const outPrismKey = nextKey; // Use the key from the search
              const inventories = getPrismInventoriesCached(outPrismKey, outBlock, dim);
              if (!inventories || inventories.length === 0) {
                continue;
              }
            } else {
              // Crystallizer - always valid
            }
            return buildOutputRoute(startKey, nextKey, parent);
          }

          queue.push({ nodePos: edge.nodePos, nodeType: edge.nodeType, key: nextKey });
          if (visited.size >= CRYSTAL_ROUTE_MAX_NODES) break;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function buildOutputRoute(startKey, targetKey, parent) {
    try {
      const steps = [];
      let curKey = targetKey;
      while (curKey && curKey !== startKey) {
        const info = parent.get(curKey);
        if (!info) break;
        steps.push(info);
        curKey = info.prevKey;
      }
      if (curKey !== startKey) return null;
      steps.reverse();

      const parsedStart = parseKey(startKey);
      if (!parsedStart) return null;
      const forward = [{ x: parsedStart.x, y: parsedStart.y, z: parsedStart.z }];
      for (const step of steps) {
        if (Array.isArray(step.edgePath) && step.edgePath.length > 0) {
          for (const p of step.edgePath) forward.push({ x: p.x, y: p.y, z: p.z });
        }
        forward.push({ x: step.nodePos.x, y: step.nodePos.y, z: step.nodePos.z });
      }
      if (forward.length < 2) return null;

      const reversed = forward.slice().reverse();
      const outputPos = reversed[0];
      return {
        path: reversed,
        startIndex: reversed.length - 1,
        endIndex: 0,
        outputKey: targetKey,
        outputPos: { x: outputPos.x, y: outputPos.y, z: outputPos.z },
      };
    } catch {
      return null;
    }
  }

  // Legacy function - now works with prisms
  function findCrystallizerRouteFromOutput(prismBlock, dimId) {
    return findCrystallizerRouteFromPrism(prismBlock, dimId);
  }

  function noteTransferAndGetLevel(inputKey, block) {
    const blockLevel = isPrismBlock(block) ? getPrismTierFromTypeId(block.typeId) : 1;
    const minCount = getMinCountForLevel(blockLevel, cfg.levelStep);
    const stored = transferCounts.has(inputKey) ? transferCounts.get(inputKey) : 0;
    const storedLevel = getLevelForCount(stored, cfg.levelStep, cfg.maxLevel);
    const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const next = current + 1;
    transferCounts.set(inputKey, next);
    levelsDirty = true;
    const level = getLevelForCount(next, cfg.levelStep, cfg.maxLevel);
    updateBlockLevel(block, level);
    return level;
  }

  function getNextInputLevel(inputKey) {
    const current = transferCounts.has(inputKey) ? transferCounts.get(inputKey) : 0;
    return getLevelForCount(current + 1, cfg.levelStep, cfg.maxLevel);
  }

  function getLevelForCount(count, step, maxLevel) {
    const base = Math.max(1, step | 0);
    const cap = Math.max(1, maxLevel | 0);
    let needed = base;
    let total = 0;
    const c = Math.max(0, count | 0);
    for (let lvl = 1; lvl <= cap; lvl++) {
      total += needed;
      if (c < total) return lvl;
      needed *= 2;
    }
    return cap;
  }

  function getMinCountForLevel(level, step) {
    const base = Math.max(1, step | 0);
    const lvl = Math.max(1, level | 0);
    let needed = base;
    let total = 0;
    for (let i = 1; i < lvl; i++) {
      total += needed;
      needed *= 2;
    }
    return total;
  }

  function getTransferAmount(level, stack) {
    const maxItems = Math.max(1, cfg.maxItemsPerOrb | 0);
    const lvl = Math.max(1, level | 0);
    const maxStack = Math.max(1, stack?.maxAmount || 64);
    const cap = Math.min(maxItems, maxStack);
    if (lvl <= 1) return 1;
    const steps = Math.max(0, (cfg.maxLevel | 0) - lvl);
    const desired = Math.floor(cap / Math.pow(2, steps));
    return Math.max(1, Math.min(cap, desired));
  }

  function getOrbStepTicks(level) {
    const safeLevel = Math.max(1, level | 0);
    const base = Math.max(1, cfg.orbStepTicks | 0);
    const minTicks = Math.max(1, cfg.minOrbStepTicks | 0);
    const scale = Math.pow(2, Math.max(0, safeLevel - 1));
    return Math.max(minTicks, Math.floor(base / scale));
  }

  function updateBlockLevel(block, level) {
    // This is now handled by updatePrismBlockLevel for unified prisms
    return updatePrismBlockLevel(block, level);
  }

  function notePrismPassage(prismKey, block) {
    const prismStep = Number.isFinite(cfg.prismLevelStep) ? cfg.prismLevelStep : (cfg.levelStep * 2);
    const blockLevel = isPrismBlock(block) ? getPrismTierFromTypeId(block.typeId) : 1;
    const minCount = getMinCountForLevel(blockLevel, prismStep);
    const stored = prismCounts.has(prismKey) ? prismCounts.get(prismKey) : 0;
    const storedLevel = getLevelForCount(stored, prismStep, cfg.maxLevel);
    const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const next = current + 1;
    prismCounts.set(prismKey, next);
    prismLevelsDirty = true;
    const level = getLevelForCount(next, prismStep, cfg.maxLevel);
    updatePrismBlockLevel(block, level);
  }

  function updatePrismBlockLevel(block, level) {
    try {
      if (!block || !isPrismBlock(block)) return;
      const safeLevel = Math.max(1, Math.min(5, Math.floor(level || 1)));
      const newTypeId = getPrismTypeIdForTier(safeLevel);
      
      // Check if already at correct tier
      const currentTier = getPrismTierFromTypeId(block.typeId);
      if (currentTier === safeLevel) return;
      
      // Get current block location and states
      const loc = block.location;
      const dim = block.dimension;
      if (!dim || !loc) return;
      
      // Replace block with new tier (no state preservation needed - prisms use same texture on all sides)
      try {
        dim.setBlock(loc, newTypeId);
      } catch {
        return; // Failed to replace block
      }
      
      // Spawn level up effect on the new block
      const updatedBlock = dim.getBlock(loc);
      if (updatedBlock) spawnLevelUpBurst(updatedBlock);
    } catch {
      // ignore
    }
  }

  function noteOutputTransfer(outputKey, block) {
    const blockLevel = isPrismBlock(block) ? getPrismTierFromTypeId(block.typeId) : 1;
    const minCount = getMinCountForLevel(blockLevel, cfg.levelStep);
    const stored = outputCounts.has(outputKey) ? outputCounts.get(outputKey) : 0;
    const storedLevel = getLevelForCount(stored, cfg.levelStep, cfg.maxLevel);
    const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const next = current + 1;
    outputCounts.set(outputKey, next);
    outputLevelsDirty = true;
    const level = getLevelForCount(next, cfg.levelStep, cfg.maxLevel);
    updateOutputBlockLevel(block, level);
  }

  // Legacy function - prisms are now handled by updatePrismBlockLevel
  function updateOutputBlockLevel(block, level) {
    // This is now handled by updatePrismBlockLevel for unified prisms
    return updatePrismBlockLevel(block, level);
  }

  function rebuildReservationsFromInflight() {
    clearReservations();
    for (const job of inflight) {
      if (!job || !job.containerKey || !job.itemTypeId) continue;
      const amt = Math.max(1, job.amount | 0);
      reserveContainerSlot(job.containerKey, job.itemTypeId, amt);
    }
  }

  function spawnOrbStep(dim, from, to, level, fromBlock, toBlock, itemTypeId, lengthSteps, logicalTicks, speedScale = 1.0) {
    try {
      if (!FX || !FX.particleTransferItem) return false;
      let fxId = FX.particleTransferItem;
      if (itemTypeId && FX?.particleExoticOrbById && FX.particleExoticOrbById[itemTypeId]) {
        fxId = FX.particleExoticOrbById[itemTypeId] || fxId;
      } else if (itemTypeId && FX?.particleFluxOrbByTier && Array.isArray(FX.particleFluxOrbByTier)) {
        const tier = getFluxTier(itemTypeId);
        if (tier > 0) {
          const idx = tier - 1;
          fxId = FX.particleFluxOrbByTier[idx] || fxId;
        }
      }
      const maxOrbFx = Math.max(0, cfg.maxOrbFxPerTick | 0);
      if (maxOrbFx > 0 && orbFxBudgetUsed >= maxOrbFx) {
        if (debugEnabled) debugState.orbFxSkipped++;
        return false; // Return false when budget exceeded, not true
      }
      if (maxOrbFx > 0) orbFxBudgetUsed++;
      const dir = normalizeDir(from, to);
      if (!dir) return false;

      const molang = new MolangVariableMap();
      
      // Calculate distance for this segment
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      const dist = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz));
      
      // Calculate visual lifetime from logical time to keep them in sync
      // logicalTicks is the time in ticks, convert to seconds (20 ticks = 1 second)
      const lifetime = Math.max(0.05, logicalTicks / 20);
      
      // Calculate visual speed from distance and lifetime
      // This ensures visual and logical are perfectly in sync
      // Speed will scale with distance to maintain constant appearance
      const speed = dist / lifetime;
      
      // Get tier from source prism (fromBlock) for orb color tinting
      // This ensures orbs are colored based on the tier of the prism that fired them
      const sourceTier = fromBlock && isPrismBlock(fromBlock) 
        ? getPrismTierFromTypeId(fromBlock.typeId)
        : level; // Fallback to job level if fromBlock is not a prism
      
      const color = isFluxTypeId(itemTypeId)
        ? { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }
        : getOrbColor(sourceTier);
      if (typeof molang.setSpeedAndDirection === "function") {
        molang.setSpeedAndDirection("variable.chaos_move", speed, dir);
      }
      molang.setFloat("variable.chaos_move.speed", speed);
      molang.setFloat("variable.chaos_move.direction_x", dir.x);
      molang.setFloat("variable.chaos_move.direction_y", dir.y);
      molang.setFloat("variable.chaos_move.direction_z", dir.z);
      molang.setFloat("variable.chaos_color_r", color.r);
      molang.setFloat("variable.chaos_color_g", color.g);
      molang.setFloat("variable.chaos_color_b", color.b);
      molang.setFloat("variable.chaos_color_a", color.a);
      molang.setFloat("variable.chaos_lifetime", lifetime);

      const pos = {
        x: from.x + 0.5,
        y: from.y + 0.5,
        z: from.z + 0.5,
      };
      queueFxParticle(dim, fxId, pos, molang);
      if (debugEnabled) debugState.orbSpawns++;
      return true;
    } catch {
      return false;
    }
  }

  function enqueueFluxTransferFx(pathBlocks, startIndex, endIndex, itemTypeId, level, insertInfo) {
    try {
      if (!Array.isArray(pathBlocks) || pathBlocks.length < 2) return;
      if (fluxFxInflight.length >= Math.max(1, cfg.maxFluxFxInFlight | 0)) return;
      const s = Math.max(0, startIndex | 0);
      const e = Math.max(0, endIndex | 0);
      if (s <= e) return;
      const dimId = pathBlocks[s]?.dimension?.id;
      if (!dimId) return;

      const path = [];
      for (let i = s; i >= e; i--) {
        const b = pathBlocks[i];
        if (!b) continue;
        const loc = b.location;
        if (!loc) continue;
        path.push({ x: loc.x, y: loc.y, z: loc.z });
      }
      if (path.length < 2) return;

      const lvl = Math.max(1, level | 0);
      const segments = buildFluxFxSegments(getDimensionCached(dimId), path);
      if (!segments || segments.points.length < 2) return;
      fluxFxInflight.push({
        dimId,
        itemTypeId,
        amount: Math.max(1, insertInfo?.amount | 0),
        containerKey: insertInfo?.containerKey || null,
        dropPos: insertInfo?.dropPos || null,
        suppressDrop: !!insertInfo?.suppressDrop,
        refineOnPrism: !!insertInfo?.refineOnPrism,
        crystalKey: insertInfo?.crystalKey || null,
        refinedItems: insertInfo?.refineOnPrism
          ? [{ typeId: itemTypeId, amount: Math.max(1, insertInfo?.amount | 0) }]
          : null,
        path: segments.points,
        segmentLengths: segments.lengths,
        stepIndex: 0,
        stepTicks: (insertInfo?.stepTicks || getOrbStepTicks(lvl)),
        speedScale: (insertInfo?.speedScale || 1.0),
        ticksUntilStep: 0,
        level: lvl,
      });
    } catch {
      // ignore
    }
  }

  function enqueueFluxTransferFxPositions(pathPositions, startIndex, endIndex, itemTypeId, level, insertInfo) {
    try {
      if (!Array.isArray(pathPositions) || pathPositions.length < 2) return;
      if (fluxFxInflight.length >= Math.max(1, cfg.maxFluxFxInFlight | 0)) return;
      const s = Math.max(0, startIndex | 0);
      const e = Math.max(0, endIndex | 0);
      if (s <= e) return;
      const dimId = insertInfo?.dimId || pathPositions[s]?.dimId || null;
      if (!dimId) return;

      const path = [];
      for (let i = s; i >= e; i--) {
        const p = pathPositions[i];
        if (!p) continue;
        path.push({ x: p.x, y: p.y, z: p.z });
      }
      if (path.length < 2) return;

      const lvl = Math.max(1, level | 0);
      const segments = buildFluxFxSegments(getDimensionCached(dimId), path);
      if (!segments || segments.points.length < 2) return;
      fluxFxInflight.push({
        dimId,
        itemTypeId,
        amount: Math.max(1, insertInfo?.amount | 0),
        containerKey: insertInfo?.containerKey || null,
        dropPos: insertInfo?.dropPos || null,
        suppressDrop: !!insertInfo?.suppressDrop,
        refineOnPrism: !!insertInfo?.refineOnPrism,
        crystalKey: insertInfo?.crystalKey || null,
        refinedItems: insertInfo?.refineOnPrism
          ? [{ typeId: itemTypeId, amount: Math.max(1, insertInfo?.amount | 0) }]
          : null,
        path: segments.points,
        segmentLengths: segments.lengths,
        stepIndex: 0,
        stepTicks: (insertInfo?.stepTicks || getOrbStepTicks(lvl)),
        speedScale: (insertInfo?.speedScale || 1.0),
        ticksUntilStep: 0,
        level: lvl,
      });
    } catch {
      // ignore
    }
  }

  function spawnLevelUpBurst(block) {
    try {
      if (!block) return;
      const dim = block.dimension;
      const particleId = FX?.particleSuccess || FX?.particleBeamOutputBurst;
      if (!dim || !particleId) return;

      const count = Math.max(1, cfg.levelUpBurstCount | 0);
      const radius = Math.max(0, Number(cfg.levelUpBurstRadius) || 0.35);
      const base = block.location;
      for (let i = 0; i < count; i++) {
        const ox = (Math.random() * 2 - 1) * radius;
        const oy = (Math.random() * 2 - 1) * radius;
        const oz = (Math.random() * 2 - 1) * radius;
        queueFxParticle(dim, particleId, {
          x: base.x + 0.5 + ox,
          y: base.y + 0.6 + oy,
          z: base.z + 0.5 + oz,
        });
      }
    } catch {
      // ignore
    }
  }

  function normalizeDir(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(len) || len <= 0.0001) return null;
    return { x: dx / len, y: dy / len, z: dz / len };
  }

  function getOrbColor(level) {
    const lvl = Math.min(cfg.maxLevel | 0, Math.max(1, level | 0));
    const palette = [
      { r: 0.78, g: 0.8, b: 0.84, a: 1.0 }, // L1 iron
      { r: 1.0, g: 0.78, b: 0.2, a: 1.0 },  // L2 gold
      { r: 0.2, g: 0.9, b: 0.9, a: 1.0 },   // L3 diamond
      { r: 0.2, g: 0.2, b: 0.24, a: 1.0 },  // L4 netherite
      { r: 0.85, g: 0.65, b: 1.0, a: 1.0 }, // L5 masterwork
    ];
    return palette[lvl - 1] || palette[0];
  }

  function dropItemAt(dim, loc, typeId, amount) {
    try {
      const dropLoc = findDropLocation(dim, loc);
      const amt = Math.max(1, amount | 0);
      let remaining = amt;
      let maxStack = 64;
      try {
        const probe = new ItemStack(typeId, 1);
        maxStack = probe.maxAmount || 64;
      } catch {}
      while (remaining > 0) {
        const n = Math.min(maxStack, remaining);
        dim.spawnItem(new ItemStack(typeId, n), dropLoc);
        remaining -= n;
      }
    } catch {
      // ignore
    }
  }

  return { 
    start, 
    stop,
    invalidateCachesForBlockChange // Expose for block change events
  };
}
