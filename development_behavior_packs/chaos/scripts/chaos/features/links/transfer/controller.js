// scripts/chaos/features/links/transfer/controller.js
import { ItemStack, MolangVariableMap } from "@minecraft/server";
import {
  DEFAULTS,
  PRISM_ID,
  CRYSTALLIZER_ID,
  CRYSTAL_FLUX_WEIGHT,
  MAX_STEPS,
  SPEED_SCALE_MAX,
  PRISM_SPEED_BOOST_BASE,
  PRISM_SPEED_BOOST_PER_TIER,
  isPrismBlock,
  getPrismTierFromTypeId,
} from "./config.js";
import { mergeCfg } from "./utils.js";
import {
  loadBeamsMap,
  loadInputLevels,
  saveInputLevels,
  loadOutputLevels,
  saveOutputLevels,
  loadPrismLevels,
  savePrismLevels,
} from "./persistence/storage.js";
import { loadInflightStateFromWorld, persistInflightStateToWorld } from "./persistence/inflight.js";
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
} from "./inventory/inventory.js";
import { getFilterContainer, filterOutputsByWhitelist, getFilterSet } from "./inventory/filters.js";
import {
  getInsertCapacityWithReservations,
  getReservedForContainer,
  reserveContainerSlot,
  releaseContainerSlot,
  clearReservations,
} from "./inventory/reservations.js";
import { calculateBalancedTransferAmount } from "./inventory/balance.js";
import {
  validatePathStart,
  isPathBlock,
  isNodeBlock,
  findFirstPrismKeyInPath,
  buildNodePathSegments,
  buildFluxFxSegments,
  findDropLocation,
  pickWeightedRandomWithBias,
} from "./pathfinding/path.js";
import { findOutputRouteFromNode, findCrystallizerRouteFromPrism } from "./pathfinding/routes.js";
import { runTransferPipeline } from "./utils.js";
import { getFilterSetForBlock } from "../filters.js";
// Fixed import paths: from transfer/controller.js to chaos/ root is 3 levels up, not 4
import { tryGenerateFluxOnTransfer, tryRefineFluxInTransfer, getFluxTier, isFluxTypeId } from "../../../flux.js";
import { addFluxForItem, getFluxValueForItem } from "../../../crystallizer.js";
import { fxFluxGenerate, queueFxParticle } from "../../../fx/fx.js";
import { createCacheManager } from "./core/cache.js";
import { createLevelsManager } from "./systems/levels.js";
import { createFxManager } from "./systems/fx.js";
import { createRefinementManager } from "./systems/refinement.js";
import { createFinalizeManager } from "./core/finalize.js";
import { createQueuesManager } from "./core/queues.js";
import { createInflightProcessorManager } from "./core/inflightProcessor.js";
import { createVirtualInventoryManager } from "./core/virtualInventory.js";
import { createInputQueuesManager } from "./core/inputQueues.js";
import { hasLensOrGoggles, hasExtendedDebug } from "../../../core/debugGroups.js";
import { isHoldingLens } from "../../../items/insightLens.js";
import { isWearingGoggles } from "../../../items/insightGoggles.js";

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
  const transferCounts = new Map();
  let levelsDirty = false;
  let lastLevelsSaveTick = 0;
  const outputCounts = new Map();
  let outputLevelsDirty = false;
  let lastOutputLevelsSaveTick = 0;
  const prismCounts = new Map();
  let prismLevelsDirty = false;
  let lastPrismLevelsSaveTick = 0;
  const queueByContainer = new Map();
  const fullContainers = new Set();
  let fullCursor = 0;
  let queueCursor = 0;
  const inputBackoff = new Map();
  // Force debug enabled if config says so (don't let FX override it)
  const debugEnabled = !!(cfg.debugTransferStats === true || FX?.debugTransferStats === true);
  const debugInterval = Math.max(20, Number(cfg.debugTransferStatsIntervalTicks || FX?.debugTransferStatsIntervalTicks) || 100);
  
  // Debug status is now only shown when debug groups are enabled (via postDebugStats or Insight menu)
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
    msCache: 0,
    msQueues: 0,
    msInflight: 0,
    msFluxFx: 0,
    msScan: 0,
    msPersist: 0,
    msTotal: 0,
    // Timing stats
    transferStartTicks: [],
    transferCompleteTicks: [],
    stepTicksTotal: 0,
    stepTicksCount: 0,
    stepTicksMin: Infinity,
    stepTicksMax: 0,
    segmentStepsTotal: 0,
    segmentStepsCount: 0,
  };
  let cachedInputKeys = null;
  let cachedInputsStamp = null;
  const orbFxBudgetUsed = { value: 0 };

  // Helper function for error handling during manager creation
  function handleManagerCreationError(managerName, err) {
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        if (typeof player.sendMessage === "function") {
          player.sendMessage(`§c[Chaos Transfer] Error creating ${managerName}: ${err?.message || String(err)}`);
        }
      }
    } catch {}
    throw err; // Re-throw to bubble up to transferLoop.js catch handler
  }

  // Helper function for non-fatal error logging (doesn't re-throw)
  function logError(message, err) {
    try {
      const players = world.getAllPlayers();
      for (const player of players) {
        if (typeof player.sendMessage === "function") {
          player.sendMessage(`§c[Chaos Transfer] ${message}: ${err?.message || String(err)}`);
        }
      }
    } catch {}
  }

  // Create virtual inventory manager first (needed by cache manager for capacity calculations)
  let virtualInventoryManager;
  try {
    virtualInventoryManager = createVirtualInventoryManager(cfg, {
      getContainerKey,
    });
    if (!virtualInventoryManager) {
      throw new Error("createVirtualInventoryManager returned null - check cfg and deps parameters");
    }
  } catch (err) {
    handleManagerCreationError("virtualInventoryManager", err);
  }

  // Define getContainerCapacityWithReservations before creating cache manager (it needs this function)
  // This function now uses virtual inventory manager to account for pending items
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

      const reserved = getReservedForContainer(containerKey);
      const reservedTotal = reserved.total;
      const currentCapacity = stackRoom + (emptySlots * 64);
      const capacityAfterReservations = Math.max(0, currentCapacity - reservedTotal);
      
      // Account for virtual inventory (pending items) if manager available
      if (virtualInventoryManager && typeof virtualInventoryManager.getVirtualCapacity === "function") {
        return virtualInventoryManager.getVirtualCapacity(
          containerKey,
          capacityAfterReservations,
          reservedTotal,
          null, // no type-specific, use total
          reservedTotal
        );
      }
      
      return capacityAfterReservations;
    } catch (_) {
      return 0;
    }
  }

  // Create cache manager with required dependencies
  let cacheManager;
  try {
    cacheManager = createCacheManager(
      {
        world,
        getContainerCapacityWithReservations,
        getTotalCountForType,
        invalidateInput,
        debugEnabled,
        debugState,
        virtualInventoryManager, // Pass virtual inventory manager to cache
      },
      cfg
    );
    if (!cacheManager) {
      throw new Error("createCacheManager returned null or undefined");
    }
  } catch (err) {
    handleManagerCreationError("cacheManager", err);
  }

  // Create levelsManager first (without spawnLevelUpBurst - it's optional and will be added later)
  let levelsManager;
  try {
    levelsManager = createLevelsManager(
      cfg,
      {
        prismCounts,
        transferCounts,
        outputCounts,
        prismLevelsDirty: { set: (v) => { prismLevelsDirty = v; } },
      },
      {} // spawnLevelUpBurst will be handled via direct call to fxManager
    );
    if (!levelsManager) {
      throw new Error("createLevelsManager returned null - check cfg and state parameters");
    }
  } catch (err) {
    handleManagerCreationError("levelsManager", err);
  }

  // Create FX manager - needs getOrbStepTicks from levels manager
  let fxManager;
  try {
    if (!cacheManager || typeof cacheManager.getDimensionCached !== "function") {
      throw new Error("cacheManager.getDimensionCached is not a function");
    }
    if (!levelsManager || typeof levelsManager.getOrbStepTicks !== "function") {
      throw new Error("levelsManager.getOrbStepTicks is not a function");
    }
    fxManager = createFxManager(cfg, {
      FX,
      debugEnabled,
      debugState,
      getDimensionCached: cacheManager.getDimensionCached.bind(cacheManager),
      getOrbStepTicks: levelsManager.getOrbStepTicks.bind(levelsManager),
      orbFxBudgetUsed: orbFxBudgetUsed,
      fluxFxInflight,
    });
    if (!fxManager) {
      throw new Error("createFxManager returned null - check cfg and deps parameters");
    }
  } catch (err) {
    handleManagerCreationError("fxManager", err);
  }

  // Recreate levelsManager with spawnLevelUpBurst from FX manager
  // Note: getOrbStepTicks is a pure function (only depends on cfg), so fxManager's bound reference still works
  try {
    const spawnLevelUpBurst = (fxManager && typeof fxManager.spawnLevelUpBurst === "function")
      ? fxManager.spawnLevelUpBurst.bind(fxManager)
      : (() => {}); // Fallback to no-op if not available
    levelsManager = createLevelsManager(
      cfg,
      {
        prismCounts,
        transferCounts,
        outputCounts,
        prismLevelsDirty: { set: (v) => { prismLevelsDirty = v; } },
      },
      { spawnLevelUpBurst }
    );
    if (!levelsManager) {
      throw new Error("createLevelsManager (recreate) returned null - check cfg and state parameters");
    }
  } catch (err) {
    handleManagerCreationError("levelsManager (recreate)", err);
  }

  // Create queues manager - manages queue state internally (needed by other managers)
  let queuesManager;
  try {
    if (!cacheManager || typeof cacheManager.resolveContainerInfoCached !== "function") {
      throw new Error("cacheManager.resolveContainerInfoCached is not a function");
    }
    queuesManager = createQueuesManager(cfg, {
      cacheManager,
      resolveBlockInfo,
      dropItemAt,
      noteOutputTransfer,
    });
    if (!queuesManager) {
      throw new Error("createQueuesManager returned null - check cfg and deps parameters");
    }
    // Initialize with existing state (if any - for persistence)
    queuesManager.initializeState(queueByContainer, fullContainers);
  } catch (err) {
    handleManagerCreationError("queuesManager", err);
  }

  // Create input queue manager - needs world, getContainerKey, getContainerKeyFromInfo, isPathBlock
  let inputQueuesManager;
  try {
    inputQueuesManager = createInputQueuesManager(cfg, {
      world,
      getContainerKey,
      getContainerKeyFromInfo,
      isPathBlock,
    });
    if (!inputQueuesManager) {
      throw new Error("createInputQueuesManager returned null - check cfg and deps parameters");
    }
  } catch (err) {
    handleManagerCreationError("inputQueuesManager", err);
  }

  // Create refinement manager - needs fxManager and cacheManager
  let refinementManager;
  try {
    if (!cacheManager || typeof cacheManager.getPrismInventoriesCached !== "function") {
      throw new Error("cacheManager.getPrismInventoriesCached is not a function");
    }
    if (!fxManager || typeof fxManager.enqueueFluxTransferFxPositions !== "function") {
      throw new Error("fxManager.enqueueFluxTransferFxPositions is not a function");
    }
    refinementManager = createRefinementManager(cfg, {
      FX,
      cacheManager,
      resolveBlockInfo,
      dropItemAt,
      fxManager,
      enqueuePendingForContainer: queuesManager.enqueuePendingForContainer.bind(queuesManager),
    });
    if (!refinementManager) {
      throw new Error("createRefinementManager returned null - check cfg and deps parameters");
    }
  } catch (err) {
    handleManagerCreationError("refinementManager", err);
  }

  // Create finalize manager - needs fxManager, refinementManager, and other dependencies
  let finalizeManager;
  try {
    if (!cacheManager || typeof cacheManager.getDimensionCached !== "function") {
      throw new Error("cacheManager.getDimensionCached is not a function");
    }
    if (!fxManager || typeof fxManager.enqueueFluxTransferFx !== "function") {
      throw new Error("fxManager.enqueueFluxTransferFx is not a function");
    }
    finalizeManager = createFinalizeManager(cfg, {
      world,
      FX,
      cacheManager,
      resolveBlockInfo,
      dropItemAt,
      getFilterForBlock,
      enqueuePendingForContainer: queuesManager.enqueuePendingForContainer.bind(queuesManager),
      fxManager,
      getContainerKey,
      debugEnabled,
      debugState,
      noteOutputTransfer,
      resolveContainerInfo: queuesManager.resolveContainerInfo.bind(queuesManager),
    });
    if (!finalizeManager) {
      throw new Error("createFinalizeManager returned null - check cfg and deps parameters");
    }
  } catch (err) {
    handleManagerCreationError("finalizeManager", err);
  }

  // Create inflight processor manager - needs all other managers
  let inflightProcessorManager;
  try {
    if (!cacheManager || typeof cacheManager.getDimensionCached !== "function") {
      throw new Error("cacheManager.getDimensionCached is not a function");
    }
    if (!levelsManager || typeof levelsManager.notePrismPassage !== "function") {
      throw new Error("levelsManager.notePrismPassage is not a function");
    }
    if (!refinementManager || typeof refinementManager.applyPrismSpeedBoost !== "function") {
      throw new Error("refinementManager.applyPrismSpeedBoost is not a function");
    }
    if (!fxManager || typeof fxManager.spawnOrbStep !== "function") {
      throw new Error("fxManager.spawnOrbStep is not a function");
    }
    if (!finalizeManager || typeof finalizeManager.finalizeJob !== "function") {
      throw new Error("finalizeManager.finalizeJob is not a function");
    }
    inflightProcessorManager = createInflightProcessorManager(cfg, {
      cacheManager,
      dropItemAt,
      levelsManager,
      refinementManager,
      fxManager,
      finalizeManager,
      debugEnabled,
      debugState,
    });
    if (!inflightProcessorManager) {
      throw new Error("createInflightProcessorManager returned null - check cfg and deps parameters");
    }
  } catch (err) {
    handleManagerCreationError("inflightProcessorManager", err);
  }

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

  // Helper function to send diagnostic messages (basic debug visibility)
  function sendDiagnosticMessage(message, group = null) {
    if (!debugEnabled) return;
    try {
      for (const player of world.getAllPlayers()) {
        try {
          // Check basic lens/goggles visibility - use direct detection (bypass cache which may be stale)
          const hasLensDirect = isHoldingLens(player) || isWearingGoggles(player);
          if (!hasLensDirect) continue;
          
          // If group specified, check extended debugging
          if (group && !hasExtendedDebug(player, group)) continue;
          
          // Add prefix for extended debug messages to make them clearly identifiable
          const prefix = group ? "§7[EXT] " : "§7";
          
          if (typeof player.sendMessage === "function") {
            player.sendMessage(`${prefix}${message}`);
          }
        } catch {}
      }
    } catch {}
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
    debugState.msCache = 0;
    debugState.msQueues = 0;
    debugState.msInputQueues = 0;
    debugState.msInflight = 0;
    debugState.msFluxFx = 0;
    debugState.msScan = 0;
    debugState.msPersist = 0;
    debugState.msTotal = 0;
    // Balance distribution debug stats
    debugState.balanceTransfers = 0;
    debugState.balanceCancelled = 0;
    debugState.balanceFallback = 0;
    debugState.balanceAmount = 0;
    debugState.balanceCancelReason = null;
  }

  function getSpeed(block) {
    try {
      if (typeof getSpeedForInput === "function") {
        const s = getSpeedForInput(block);
        if (s && typeof s === "object") return s;
      }
    } catch (_) {}
    // Prisms now use tier block IDs, not state
    let level = 1;
    if (block) {
      if (isPrismBlock(block)) {
        level = getPrismTierFromTypeId(block);
      } else {
        level = (block?.permutation?.getState("chaos:level") | 0) || 1;
      }
    }
    const scale = Math.pow(2, Math.max(0, level - 1));
    const interval = Math.max(1, Math.floor(cfg.perInputIntervalTicks / scale));
    return { intervalTicks: interval, amount: 1 };
  }

  function start() {
    if (tickId !== null) return;
    if (!levelsManager) {
      logError("ERROR: Cannot start - levelsManager is null!", new Error("levelsManager is null"));
      return; // Don't start if levelsManager is null
    }
    
    // Retry loading persistence with exponential backoff (for world load scenarios)
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelays = [5, 10, 20]; // ticks to wait before retry
    
    function attemptLoadWithRetry(loadFn, name, retryIndex = 0) {
      try {
        loadFn();
      } catch (err) {
        if (retryIndex < maxRetries) {
          // Retry after delay
          system.runTimeout(() => {
            attemptLoadWithRetry(loadFn, name, retryIndex + 1);
          }, retryDelays[retryIndex] || 20);
        } else {
          logError(`Error loading ${name} (after ${maxRetries} retries)`, err);
        }
      }
    }
    
    // Attempt to load state with retries
    attemptLoadWithRetry(() => loadInflightState(), "inflight state");
    attemptLoadWithRetry(() => loadLevelsState(), "levels state");
    attemptLoadWithRetry(() => loadOutputLevelsState(), "output levels state");
    attemptLoadWithRetry(() => loadPrismLevelsState(), "prism levels state");
    
    try {
      tickId = system.runInterval(onTick, 1);
      
      // PHASE 3: Event-driven scanning - mark prisms dirty when adjacent containers change
      // Helper: Find adjacent prisms and mark them dirty
      function markAdjacentPrismsDirty(dim, loc, reason = "container_changed") {
        try {
          if (!dim || !loc) return;
          
          const dirs = [
            { dx: 1, dy: 0, dz: 0 },
            { dx: -1, dy: 0, dz: 0 },
            { dx: 0, dy: 0, dz: 1 },
            { dx: 0, dy: 0, dz: -1 },
            { dx: 0, dy: 1, dz: 0 },
            { dx: 0, dy: -1, dz: 0 },
          ];
          
          for (const d of dirs) {
            const x = loc.x + d.dx;
            const y = loc.y + d.dy;
            const z = loc.z + d.dz;
            try {
              const block = dim.getBlock({ x, y, z });
              if (block && isPrismBlock(block)) {
                const prismKey = key(dim.id, x, y, z);
                if (virtualInventoryManager && typeof virtualInventoryManager.markPrismDirty === "function") {
                  virtualInventoryManager.markPrismDirty(prismKey, reason);
                }
                // Also invalidate cache for this prism
                if (typeof invalidateInput === "function") {
                  invalidateInput(prismKey);
                }
                if (cacheManager && typeof cacheManager.invalidatePrismInventories === "function") {
                  cacheManager.invalidatePrismInventories(prismKey);
                }
              }
            } catch {
              // Ignore errors for individual blocks
            }
          }
        } catch {
          // Ignore errors
        }
      }
      
      // PHASE 3: Event-driven scanning - mark prisms dirty when adjacent containers change
      // Event handler: Player places block
      if (world.afterEvents && world.afterEvents.playerPlaceBlock && typeof world.afterEvents.playerPlaceBlock.subscribe === "function") {
        try {
          world.afterEvents.playerPlaceBlock.subscribe((ev) => {
            try {
              const block = ev.block;
              if (!block) return;
              
              // Check if block has inventory (container)
              const container = getInventoryContainer(block);
              if (container || isFurnaceBlock(block)) {
                // Mark adjacent prisms dirty
                markAdjacentPrismsDirty(block.dimension, block.location, "player_placed_container");
                // Invalidate cache for this location
                if (cacheManager && typeof cacheManager.invalidateBlock === "function") {
                  cacheManager.invalidateBlock(block.dimension.id, block.location);
                }
              }
            } catch {
              // Ignore errors
            }
          });
        } catch (err) {
          logError("Error subscribing to playerPlaceBlock", err);
        }
      }
      
      // Event handler: Player breaks block
      if (world.afterEvents && world.afterEvents.playerBreakBlock && typeof world.afterEvents.playerBreakBlock.subscribe === "function") {
        try {
          world.afterEvents.playerBreakBlock.subscribe((ev) => {
            try {
              const block = ev.brokenBlockPermutation;
              if (!block) return;
              
              // Check if broken block had inventory (we need to check the location)
              const loc = ev.block.location;
              const dim = ev.dimension;
              if (loc && dim) {
                // Check if there was a container here (by checking if adjacent prisms exist)
                // We'll mark adjacent prisms dirty regardless, as breaking a container affects them
                markAdjacentPrismsDirty(dim, loc, "player_broke_container");
                // Invalidate cache for this location
                if (cacheManager && typeof cacheManager.invalidateBlock === "function") {
                  cacheManager.invalidateBlock(dim.id, loc);
                }
              }
            } catch {
              // Ignore errors
            }
          });
        } catch (err) {
          logError("Error subscribing to playerBreakBlock", err);
        }
      }
      
      // Event handler: Entity places block (hoppers, etc.)
      // Note: entityPlaceBlock may not be available in all API versions
      if (world.afterEvents && world.afterEvents.entityPlaceBlock && typeof world.afterEvents.entityPlaceBlock.subscribe === "function") {
        try {
          world.afterEvents.entityPlaceBlock.subscribe((ev) => {
            try {
              const block = ev.block;
              if (!block) return;
              
              // Check if block has inventory
              const container = getInventoryContainer(block);
              if (container || isFurnaceBlock(block)) {
                // Mark adjacent prisms dirty
                markAdjacentPrismsDirty(block.dimension, block.location, "entity_placed_container");
                // Invalidate cache for this location
                if (cacheManager && typeof cacheManager.invalidateBlock === "function") {
                  cacheManager.invalidateBlock(block.dimension.id, block.location);
                }
              }
            } catch {
              // Ignore errors
            }
          });
        } catch (err) {
          logError("Error subscribing to entityPlaceBlock", err);
        }
      }
      
      // Debug message is now only sent when players have debug groups enabled (via postDebugStats)
    } catch (err) {
      logError("Error starting tick interval", err);
    }
  }

  function stop() {
    if (tickId === null) return;
    try { system.clearRun(tickId); } catch (_) {}
    tickId = null;
  }

  function loadInflightState() {
    try {
      // Clear any existing inflight state first to prevent stale jobs
      const oldInflightCount = inflight.length;
      const oldFluxFxCount = fluxFxInflight.length;
      inflight.length = 0;
      fluxFxInflight.length = 0;
      loadInflightStateFromWorld(world, inflight, cfg);
      
      // Validate loaded inflight jobs - remove any that are at or past the end of their path
      // (they would complete immediately and might create flux FX jobs incorrectly)
      let removedCount = 0;
      for (let i = inflight.length - 1; i >= 0; i--) {
        const job = inflight[i];
        if (!job || !job.path || !Array.isArray(job.path)) {
          inflight.splice(i, 1);
          removedCount++;
          continue;
        }
        // If job is at or past the end of its path, complete it immediately instead of removing
        // This ensures it finishes properly and doesn't get reloaded
        if (job.stepIndex >= job.path.length) {
          try {
            finalizeManager.finalizeJob(job);
          } catch (err) {
            // If finalization fails, just remove it
            // Failed to finalize stale job - silently continue
          }
          inflight.splice(i, 1);
          removedCount++;
          continue;
        }
        // Reset ticksUntilStep if it's invalid (might be 0 or negative from save)
        if (!Number.isFinite(job.ticksUntilStep) || job.ticksUntilStep <= 0) {
          job.ticksUntilStep = job.stepTicks || cfg.orbStepTicks;
        }
      }
      
      // Log what we loaded/cleared
      if (debugEnabled && (oldInflightCount > 0 || oldFluxFxCount > 0 || inflight.length > 0 || removedCount > 0)) {
        for (const player of world.getAllPlayers()) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(`§7[Chaos Transfer] Loaded ${inflight.length} inflight jobs (cleared ${oldInflightCount}, removed ${removedCount} stale)`);
            }
          } catch {}
        }
      }
      rebuildReservationsFromInflight();
      inflightDirty = false;
      lastSaveTick = nowTick;
    } catch (err) {
      // If loading fails, just start with empty state
      inflight.length = 0;
      inflightDirty = false;
      lastSaveTick = nowTick;
      throw err; // Re-throw so start() can catch it
    }
  }

  function persistInflightIfNeeded() {
    if (!inflightDirty && !inflightStepDirty) return;
    if (inflightDirty && inflight.length === 0) {
      persistInflightStateToWorld(world, inflight);
      if (debugEnabled) debugState.dpSaves++;
      inflightDirty = false;
      inflightStepDirty = false;
      lastSaveTick = nowTick;
      return;
    }
    const interval = Math.max(1, cfg.inflightSaveIntervalTicks | 0);
    if ((nowTick - lastSaveTick) < interval) return;
    persistInflightStateToWorld(world, inflight);
    if (debugEnabled) debugState.dpSaves++;
    inflightDirty = false;
    inflightStepDirty = false;
    lastSaveTick = nowTick;
  }

  // Generic helper for loading counts state
  function loadCountsState(loadFn, countsMap, setDirty, setLastSaveTick) {
    try {
      const raw = loadFn(world);
      countsMap.clear();
      for (const [k, v] of Object.entries(raw)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) continue;
        countsMap.set(k, n | 0);
      }
      setDirty(false);
      setLastSaveTick(nowTick);
    } catch (err) {
      // If loading fails, just start with empty state
      countsMap.clear();
      setDirty(false);
      setLastSaveTick(nowTick);
      throw err; // Re-throw so start() can catch it
    }
  }

  // Generic helper for persisting counts state
  function persistCountsIfNeeded(getDirty, getLastSaveTick, setDirty, setLastSaveTick, countsMap, saveFn, minInterval = 200) {
    if (!getDirty() && (nowTick - getLastSaveTick()) < minInterval) return;
    const obj = {};
    for (const [k, v] of countsMap.entries()) obj[k] = v;
    saveFn(world, obj);
    if (debugEnabled) debugState.dpSaves++;
    setDirty(false);
    setLastSaveTick(nowTick);
  }

  function loadLevelsState() {
    loadCountsState(
      loadInputLevels,
      transferCounts,
      (v) => { levelsDirty = v; },
      (v) => { lastLevelsSaveTick = v; }
    );
  }

  function persistLevelsIfNeeded() {
    persistCountsIfNeeded(
      () => levelsDirty,
      () => lastLevelsSaveTick,
      (v) => { levelsDirty = v; },
      (v) => { lastLevelsSaveTick = v; },
      transferCounts,
      saveInputLevels
    );
  }

  function loadOutputLevelsState() {
    loadCountsState(
      loadOutputLevels,
      outputCounts,
      (v) => { outputLevelsDirty = v; },
      (v) => { lastOutputLevelsSaveTick = v; }
    );
  }

  function persistOutputLevelsIfNeeded() {
    persistCountsIfNeeded(
      () => outputLevelsDirty,
      () => lastOutputLevelsSaveTick,
      (v) => { outputLevelsDirty = v; },
      (v) => { lastOutputLevelsSaveTick = v; },
      outputCounts,
      saveOutputLevels
    );
  }

  function loadPrismLevelsState() {
    loadCountsState(
      loadPrismLevels,
      prismCounts,
      (v) => { prismLevelsDirty = v; },
      (v) => { lastPrismLevelsSaveTick = v; }
    );
  }

  function persistPrismLevelsIfNeeded() {
    persistCountsIfNeeded(
      () => prismLevelsDirty,
      () => lastPrismLevelsSaveTick,
      (v) => { prismLevelsDirty = v; },
      (v) => { lastPrismLevelsSaveTick = v; },
      prismCounts,
      savePrismLevels
    );
  }

  // resolveContainerInfo is now provided by queuesManager
  function resolveContainerInfo(containerKey) {
    return queuesManager.resolveContainerInfo(containerKey);
  }

  function onTick() {
    nowTick++;
    
    // SUPER SIMPLE UNCONDITIONAL TEST - Always send on first 5 ticks to confirm onTick is running
    if (nowTick <= 5) {
      try {
        for (const player of world.getAllPlayers()) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(`§e[TICK ${nowTick}] onTick() is running!`);
            }
          } catch {}
        }
      } catch {}
    }
    
    const tickStart = debugEnabled ? Date.now() : 0;
    const cacheStart = debugEnabled ? Date.now() : 0;
    cacheManager.updateTick(nowTick);
    cacheManager.resetTickCaches();
    if (debugEnabled) {
      debugState.msCache = (debugState.msCache || 0) + (Date.now() - cacheStart);
    }
    orbFxBudgetUsed.value = 0;

    // Process existing queues and in-flight transfers first
    if (debugEnabled) {
      runTransferPipeline([
        () => {
          const t0 = Date.now();
          queuesManager.tickOutputQueues();
          queuesManager.tickFullContainers();
          debugState.msQueues += (Date.now() - t0);
        },
        () => {
          const t1 = Date.now();
          const result = inflightProcessorManager.tickInFlight(inflight, nowTick);
          if (result) {
            inflightDirty = result.inflightDirty || inflightDirty;
            inflightStepDirty = result.inflightStepDirty || inflightStepDirty;
          }
          debugState.msInflight += (Date.now() - t1);
        },
        () => {
          const t2 = Date.now();
          inflightProcessorManager.tickFluxFxInFlight(fluxFxInflight, debugState);
          debugState.msFluxFx += (Date.now() - t2);
        },
      ]);
    } else {
      runTransferPipeline([
        queuesManager.tickOutputQueues.bind(queuesManager),
        queuesManager.tickFullContainers.bind(queuesManager),
        () => {
          const result = inflightProcessorManager.tickInFlight(inflight, nowTick);
          if (result) {
            inflightDirty = result.inflightDirty || inflightDirty;
            inflightStepDirty = result.inflightStepDirty || inflightStepDirty;
          }
        },
        () => {
          inflightProcessorManager.tickFluxFxInFlight(fluxFxInflight, debugState);
        },
      ]);
    }

    // Update virtual inventory state AFTER processing queues/in-flight
    // This ensures virtual inventory reflects current state (items that just finalized are no longer pending)
    // Then we can accurately predict future capacity for new transfers
    if (virtualInventoryManager && typeof virtualInventoryManager.updateState === "function") {
      const queueState = queuesManager.getState();
      // Get input queues for virtual inventory (if available)
      let inputQueueByPrism = null;
      if (inputQueuesManager && typeof inputQueuesManager.getQueuesForPrism === "function") {
        inputQueueByPrism = new Map();
        const prismKeys = getPrismKeys();
        for (const prismKey of prismKeys) {
          const queues = inputQueuesManager.getQueuesForPrism(prismKey);
          if (queues && queues.length > 0) {
            inputQueueByPrism.set(prismKey, queues);
          }
        }
      }
      virtualInventoryManager.updateState(inflight, queueState.queueByContainer, inputQueueByPrism);
    }

    // PHASE 1: Process input queues first (lazy scanning - only scan when queues empty)
    const inputQueueStart = debugEnabled ? Date.now() : 0;
    let inputQueueProcessed = 0;
    let inputQueueTransferBudget = cfg.maxTransfersPerTick;
    let inputQueueSearchBudget = cfg.maxSearchesPerTick;
    let inputQueueTransfersThisTick = 0;
    
    // ALWAYS log every tick (first 20 ticks, then every 10 ticks) to verify system is running
    // This is TRULY UNCONDITIONAL - doesn't require lens/goggles OR extended debug groups
    if (nowTick <= 20 || nowTick % 10 === 0) {
      try {
        for (const player of world.getAllPlayers()) {
          try {
            if (typeof player.sendMessage !== "function") continue;
            const hasLensDirect = isHoldingLens(player) || isWearingGoggles(player);
            const hasTransferDebug = hasExtendedDebug(player, "transfer");
            const totalQueueSize = inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function" 
              ? inputQueuesManager.getTotalQueueSize() 
              : -1;
            // UNCONDITIONAL message - always send to all players
            player.sendMessage(`§e[Queue Tick ${nowTick}] size=${totalQueueSize}, manager=${!!inputQueuesManager}, budget=${inputQueueTransferBudget}/${inputQueueSearchBudget}, lens=${hasLensDirect}, debug=${hasTransferDebug}`);
          } catch (err) {
            // Log errors but continue
            console.warn(`[Queue] Error sending tick message:`, err);
          }
        }
      } catch (err) {
        console.warn(`[Queue] Error in tick logging:`, err);
      }
    }
    
    if (inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function") {
      const totalQueueSize = inputQueuesManager.getTotalQueueSize();
      
      // Basic visibility: Show when queues are active
      if (totalQueueSize > 0) {
        sendDiagnosticMessage(`[Queue] Active queues: ${totalQueueSize}`, null); // null = basic visibility
      }
      
      // Process input queues if they exist
      if (totalQueueSize > 0) {
        // Always log when processing queues (not throttled)
        sendDiagnosticMessage(`[Queue] Processing queues: totalQueueSize=${totalQueueSize}, budget: transfer=${inputQueueTransferBudget}, search=${inputQueueSearchBudget}`, "transfer");
        const prismKeys = getPrismKeys();
        sendDiagnosticMessage(`[Queue] Prisms to check: ${prismKeys.length}`, "transfer");
        if (prismKeys.length > 0) {
          // Process queues for prisms that have them
          for (const prismKey of prismKeys) {
            if (inputQueueTransferBudget <= 0 && inputQueueSearchBudget <= 0) {
              sendDiagnosticMessage(`[Queue] Budget exhausted: transfer=${inputQueueTransferBudget}, search=${inputQueueSearchBudget}`, "transfer");
              break;
            }
            if (!inputQueuesManager.hasQueueForPrism(prismKey)) continue;
            
            sendDiagnosticMessage(`[Queue] Prism ${prismKey} has queue, processing...`, "transfer");
            
            const prismInfo = resolveBlockInfo(prismKey);
            if (!prismInfo) continue;
            
            const dim = prismInfo.dim;
            const prismBlock = prismInfo.block;
            if (!prismBlock || !isPrismBlock(prismBlock)) continue;
            
            // Get filter for this prism
            const filter = getFilterForBlock(prismBlock);
            const filterSet = filter ? (filter instanceof Set ? filter : getFilterSet(filter)) : null;
            
            // Get next queue entry for this prism
            const queueEntry = inputQueuesManager.getNextQueueEntry(prismKey, filterSet);
            if (!queueEntry) {
              if (debugEnabled && inputQueuesManager.hasQueueForPrism(prismKey)) {
                sendDiagnosticMessage(`[Queue] Prism ${prismKey}: no queue entry found (hasQueue=true but getNextQueueEntry=null)`);
              }
              continue;
            }
            
            // DIAGNOSTIC: Log queue entry processing (extended debug)
            sendDiagnosticMessage(`[Queue] Processing entry: prism=${prismKey}, item=${queueEntry.itemTypeId}, remaining=${queueEntry.remainingAmount}, container=${queueEntry.containerKey}, slot=${queueEntry.slot}`, "transfer");
            
            // Validate queue entry
            const isValid = inputQueuesManager.validateInputQueue(queueEntry, nowTick);
            if (!isValid) {
              // Entry invalid - remove it
              sendDiagnosticMessage(`[Queue] Entry invalid: prism=${prismKey}, item=${queueEntry.itemTypeId} - removing`, "transfer");
              inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
              continue;
            }
            
            // Get inventories for this prism
            const inventories = cacheManager.getPrismInventoriesCached(prismKey, prismBlock, dim);
            if (!inventories || inventories.length === 0) continue;
            
            // Find the item source from the queue entry
            let itemSource = null;
            for (const inv of inventories) {
              if (!inv.container) continue;
              const containerKey = getContainerKey(inv.entity || inv.block);
              if (containerKey === queueEntry.containerKey) {
                // Found the container - get the item from the slot
                const item = inv.container.getItem(queueEntry.slot);
                if (item && item.typeId === queueEntry.itemTypeId && item.amount > 0) {
                  itemSource = {
                    container: inv.container,
                    slot: queueEntry.slot,
                    stack: item,
                    inventoryIndex: inventories.indexOf(inv),
                  };
                  break;
                }
              }
            }
            
            if (!itemSource || !itemSource.stack) {
              // Item no longer in slot - invalidate queue entry
              inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
              continue;
            }
            
            // Use cached route if available, otherwise find new route
            let route = queueEntry.cachedRoute;
            let destinationKey = queueEntry.lastDestination;
            
            if (!route || route.length === 0 || !destinationKey) {
              // Need to find route
              if (inputQueueSearchBudget <= 0) {
                sendDiagnosticMessage(`[Queue] No search budget for route finding: prism=${prismKey}, item=${queueEntry.itemTypeId}`, "transfer");
                continue;
              }
              
              sendDiagnosticMessage(`[Queue] Finding route: prism=${prismKey}, item=${queueEntry.itemTypeId}, searchBudget=${inputQueueSearchBudget}`, "transfer");
              
              const pathResult = findPathForInput(prismKey, nowTick);
              if (!pathResult || !Array.isArray(pathResult) || pathResult.length === 0) {
                // No route found - invalidate entry
                sendDiagnosticMessage(`[Queue] No route found: prism=${prismKey}, item=${queueEntry.itemTypeId} - invalidating entry`, "transfer");
                inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
                continue;
              }
              
              sendDiagnosticMessage(`[Queue] Route found: prism=${prismKey}, item=${queueEntry.itemTypeId}, options=${pathResult.length}`, "transfer");
              
              // Pick a destination from the path results
              const pick = pickWeightedRandomWithBias(pathResult, (opt) => {
                const type = opt?.outputType || "prism";
                if (isFluxTypeId(itemSource.stack.typeId) && type === "crystal") return CRYSTAL_FLUX_WEIGHT;
                return 1.0;
              });
              
              if (pick && Array.isArray(pick.path) && pick.path.length > 0) {
                route = pick.path;
                destinationKey = pick.outputKey;
                inputQueuesManager.setCachedRoute(prismKey, queueEntry.itemTypeId, route);
                queueEntry.lastDestination = destinationKey;
              } else {
                continue;
              }
              
              inputQueueSearchBudget--;
            }
            
            // Get destination info
            const destInfo = resolveBlockInfo(destinationKey);
            if (!destInfo || !destInfo.block) {
              // Destination invalid - clear route and try again next time
              queueEntry.cachedRoute = null;
              queueEntry.lastDestination = null;
              continue;
            }
            
            // Attempt transfer using the queue entry
            const transferResult = attemptPushTransferWithDestination(
              prismKey,
              prismBlock,
              dim,
              inventories,
              itemSource,
              { ...destInfo, key: destinationKey },
              route,
              filterSet,
              queueEntry
            );
            
            // DIAGNOSTIC: Log transfer result (extended debug)
            sendDiagnosticMessage(`[Queue] Transfer result: prism=${prismKey}, item=${queueEntry.itemTypeId}, ok=${transferResult.ok}, reason=${transferResult.reason || 'unknown'}, amount=${transferResult.amount || 0}, searchesUsed=${transferResult.searchesUsed || 0}`, "transfer");
            
            if (transferResult.ok) {
              inputQueueTransfersThisTick++;
              inputQueueTransferBudget--;
              inputQueueSearchBudget -= transferResult.searchesUsed || 0;
              
              // Update queue entry with transferred amount
              inputQueuesManager.updateQueueEntry(prismKey, queueEntry.itemTypeId, transferResult.amount || 1);
              inputQueueProcessed++;
              
              sendDiagnosticMessage(`[Queue] Transfer SUCCESS: updated queue entry, remaining budget: transfer=${inputQueueTransferBudget}, search=${inputQueueSearchBudget}`, "transfer");
            } else {
              inputQueueSearchBudget -= transferResult.searchesUsed || 0;
              sendDiagnosticMessage(`[Queue] Transfer FAILED: reason=${transferResult.reason || 'unknown'}, remaining budget: transfer=${inputQueueTransferBudget}, search=${inputQueueSearchBudget}`, "transfer");
            }
          }
        }
      }
      
      // Summary: Log queue processing results (always log)
      if (totalQueueSize > 0) {
        sendDiagnosticMessage(`[Queue] Processed: entries=${inputQueueProcessed}, transfers=${inputQueueTransfersThisTick}, remaining=${inputQueuesManager.getTotalQueueSize()}`, "transfer");
      }
    } else {
      // Log when no queues exist (every 100 ticks to avoid spam)
      if (nowTick % 100 === 0) {
        sendDiagnosticMessage(`[Queue] No active queues (totalQueueSize=0)`, "transfer");
      }
    }
    
    if (debugEnabled) {
      debugState.msInputQueues = (debugState.msInputQueues || 0) + (Date.now() - inputQueueStart);
    }

    // PHASE 4: Lazy scanning - only scan when input queues are empty (or dirty prisms exist)
    const scanStart = debugEnabled ? Date.now() : 0;
    const prismKeys = getPrismKeys();
    if (prismKeys.length === 0) return;
    
    // PHASE 4: Lazy scanning - only scan when input queues are empty OR dirty prisms exist
    // Check if we should scan (queues empty OR dirty prisms exist)
    const totalQueueSize = inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function"
      ? inputQueuesManager.getTotalQueueSize()
      : 0;
    
    // Get dirty prisms (if virtual inventory supports it)
    let dirtyPrisms = null;
    let dirtyPrismsCount = 0;
    if (virtualInventoryManager && typeof virtualInventoryManager.getDirtyPrisms === "function") {
      dirtyPrisms = virtualInventoryManager.getDirtyPrisms();
      dirtyPrismsCount = dirtyPrisms ? dirtyPrisms.size : 0;
    }
    
    // Scan if: queues are empty OR dirty prisms exist
    const shouldScan = totalQueueSize === 0 || dirtyPrismsCount > 0;
    
    // DIAGNOSTIC: Log scanning decision - UNCONDITIONAL (always send to all players)
    if (nowTick <= 20 || nowTick % 10 === 0 || !shouldScan || dirtyPrismsCount > 0) {
      try {
        for (const player of world.getAllPlayers()) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(`§7[Scan Tick ${nowTick}] Decision: queues=${totalQueueSize}, dirty=${dirtyPrismsCount}, shouldScan=${shouldScan}, prisms=${prismKeys.length}`);
            }
          } catch {}
        }
      } catch {}
      // Also send via diagnostic message for extended debug users
      sendDiagnosticMessage(`[Scan] Decision: queues=${totalQueueSize}, dirty=${dirtyPrismsCount}, shouldScan=${shouldScan}, scanDirtyOnly=${totalQueueSize > 0 && dirtyPrismsCount > 0}`, "transfer");
    }
    
    if (!shouldScan) {
      // Skip scanning - queues are active and no dirty prisms
      debugState.msScan += (Date.now() - scanStart);
      // Log frequently - UNCONDITIONAL
      if (nowTick <= 20 || nowTick % 10 === 0) {
        try {
          for (const player of world.getAllPlayers()) {
            try {
              if (typeof player.sendMessage === "function") {
                player.sendMessage(`§7[Scan] Skipped: queues active (${totalQueueSize}), no dirty prisms`);
              }
            } catch {}
          }
        } catch {}
        sendDiagnosticMessage(`[Scan] Skipped: queues active (${totalQueueSize}), no dirty prisms`, "transfer");
      }
      return;
    }
    
    // If queues exist but dirty prisms also exist, limit scanning to dirty prisms only (with limited budget)
    const scanDirtyOnly = totalQueueSize > 0 && dirtyPrismsCount > 0;
    const dirtyScanBudget = scanDirtyOnly ? Math.min(cfg.maxPrismsScannedPerTick || 5, dirtyPrismsCount) : Infinity;
    
    if (scanDirtyOnly) {
      sendDiagnosticMessage(`[Scan] Scanning dirty prisms only: budget=${dirtyScanBudget}, dirtyCount=${dirtyPrismsCount}`, "transfer");
    }

    if (cursor >= prismKeys.length) cursor = 0;
    let scanned = 0;
    let transferBudget = cfg.maxTransfersPerTick;
    let searchBudget = cfg.maxSearchesPerTick;
    let transfersThisTick = 0;
    
    // Determine scan limit and which prisms to scan
    let prismsToScan = null;
    let scanLimit = 0;
    
    if (scanDirtyOnly && dirtyPrisms && dirtyPrisms.size > 0) {
      // Scan only dirty prisms (limited budget)
      prismsToScan = Array.from(dirtyPrisms);
      scanLimit = Math.min(dirtyScanBudget, prismsToScan.length);
    } else {
      // Scan all prisms (normal behavior)
      prismsToScan = prismKeys;
      scanLimit = Math.min(
        prismKeys.length,
        Math.max(1, cfg.maxPrismsScannedPerTick | 0)
      );
    }

    while ((transferBudget > 0 || searchBudget > 0) && scanned < scanLimit && scanned < prismsToScan.length) {
      const prismKey = prismsToScan[scanDirtyOnly ? scanned : (cursor % prismsToScan.length)];
      if (!scanDirtyOnly) {
        cursor = (cursor + 1) % prismsToScan.length;
      }
      scanned++;
      
      // Clear dirty flag after scanning (if virtual inventory supports it)
      if (scanDirtyOnly && virtualInventoryManager && typeof virtualInventoryManager.clearPrismDirty === "function") {
        virtualInventoryManager.clearPrismDirty(prismKey);
      }

      const allowedAt = nextAllowed.has(prismKey) ? nextAllowed.get(prismKey) : 0;
      if (nowTick < allowedAt) continue;

      // Attempt transfer with budgeted searches
      const result = attemptTransferForPrism(prismKey, searchBudget);
      const searchesUsed = result?.searchesUsed || 0;
      searchBudget -= searchesUsed;

      const didTransfer = !!result?.ok;
      if (didTransfer) {
        transfersThisTick++;
        transferBudget--;
      }

      const info = resolveBlockInfo(prismKey);
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

      // If we're out of budgets, stop scanning
      if (transferBudget <= 0 && searchBudget <= 0) break;
    }
    if (debugEnabled) {
      debugState.inputsScanned += scanned;
      debugState.transfersStarted += transfersThisTick;
      debugState.msScan += (Date.now() - scanStart);
    }

    const persistStart = debugEnabled ? Date.now() : 0;
    persistInflightIfNeeded();
    persistLevelsIfNeeded();
    persistOutputLevelsIfNeeded();
    persistPrismLevelsIfNeeded();
    if (debugEnabled) {
      debugState.msPersist += (Date.now() - persistStart);
      debugState.msTotal += (Date.now() - tickStart);
      // Always try to post debug stats (it will check interval internally)
      try {
        postDebugStats(prismKeys.length);
      } catch (err) {
        // If postDebugStats fails, send error message
        for (const player of world.getAllPlayers()) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(`§c[Chaos Transfer] Error in postDebugStats: ${err?.message || String(err)}`);
            }
          } catch {}
        }
      }
    } else {
      // Debug is disabled - send message every 100 ticks to confirm
      if (nowTick % 100 === 0) {
        for (const player of world.getAllPlayers()) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(`§c[Chaos Transfer] DEBUG IS DISABLED! cfg.debugTransferStats=${cfg.debugTransferStats}, FX.debugTransferStats=${FX?.debugTransferStats}`);
            }
          } catch {}
        }
      }
    }
  }

  function getPrismKeys() {
    try {
      if (typeof getNetworkStamp === "function") {
        const stamp = getNetworkStamp();
        if (cachedInputKeys && cachedInputsStamp === stamp) return cachedInputKeys;
        const map = loadBeamsMap(world);
        // Filter to only return actual prisms
        const allKeys = Object.keys(map || {});
        const prismKeys = [];
        for (const k of allKeys) {
          const info = cacheManager.resolveBlockInfoCached(k);
          if (info && info.block && isPrismBlock(info.block)) {
            prismKeys.push(k);
          }
        }
        cachedInputKeys = prismKeys;
        cachedInputsStamp = stamp;
        if (debugEnabled) debugState.inputMapReloads++;
        return cachedInputKeys;
      }
    } catch {
      // ignore
    }
    const map = loadBeamsMap(world);
    const allKeys = Object.keys(map || {});
    const prismKeys = [];
    for (const k of allKeys) {
      const info = cacheManager.resolveBlockInfoCached(k);
      if (info && info.block && info.block.typeId === PRISM_ID) {
        prismKeys.push(k);
      }
    }
    return prismKeys;
  }

  // Legacy function name

  function resolveBlockInfo(inputKey) {
    return cacheManager.resolveBlockInfoCached(inputKey);
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

  // Unified push/pull transfer for prisms
  function attemptTransferForPrism(prismKey, searchBudget) {
    let searchesUsed = 0;
    const prismInfo = resolveBlockInfo(prismKey);
    if (!prismInfo) return { ...makeResult(false, "no_prism"), searchesUsed };

    const dim = prismInfo.dim;
    const prismBlock = prismInfo.block;
    if (!prismBlock || !isPrismBlock(prismBlock)) return { ...makeResult(false, "no_prism"), searchesUsed };

    // Get all adjacent inventories (multi-inventory support)
    const inventories = cacheManager.getPrismInventoriesCached(prismKey, prismBlock, dim);
    if (!inventories || inventories.length === 0) return { ...makeResult(false, "no_container"), searchesUsed };

    // Get filter for this prism (attunement)
    const filter = getFilterForBlock(prismBlock);
    const filterSet = filter ? (filter instanceof Set ? filter : getFilterSet(filter)) : null;
    const hasFilter = filterSet && filterSet.size > 0;

    // TRY PUSH: Extract items from inventories and send to network
    // - If unattuned: push random items
    // - If attuned: push items NOT in filter
    
    // PHASE 1: If input queues enabled, queue items instead of transferring immediately
    // Queue items when scanning finds them (only if no queue exists for this prism yet)
    if (inputQueuesManager && typeof inputQueuesManager.hasQueueForPrism === "function" && 
        !inputQueuesManager.hasQueueForPrism(prismKey)) {
      // No queue exists yet - find all items and queue them
      // Log when scanning starts for this prism - UNCONDITIONAL (first 20 ticks or every 10 ticks)
      if (nowTick <= 20 || nowTick % 10 === 0) {
        try {
          for (const player of world.getAllPlayers()) {
            try {
              if (typeof player.sendMessage === "function") {
                player.sendMessage(`§b[Scan] Checking prism ${prismKey}: inventories=${inventories.length}, searchBudget=${searchBudget}`);
              }
            } catch {}
          }
        } catch {}
        sendDiagnosticMessage(`[Scan] Checking prism ${prismKey} for items: inventories=${inventories.length}, searchBudget=${searchBudget}`, "transfer");
      }
      
      // Scan for items (regardless of budget - we need to know if items exist)
      const allItems = [];
      for (const inv of inventories) {
        if (!inv.container) continue;
        const size = inv.container.size;
        for (let slot = 0; slot < size; slot++) {
          const item = inv.container.getItem(slot);
          if (!item || item.amount <= 0) continue;
          
          // Check filter (if attuned, only queue items NOT in filter)
          if (filterSet && filterSet.size > 0 && filterSet.has(item.typeId)) {
            continue; // Skip filtered items (they should be pulled, not pushed)
          }
          
          allItems.push({
            container: inv.container,
            slot: slot,
            stack: item,
            inventoryIndex: inventories.indexOf(inv),
            entity: inv.entity,
            block: inv.block,
          });
        }
      }
      
      // ALWAYS log item count found (not throttled) - UNCONDITIONAL
      if (allItems.length > 0) {
        const itemSummary = allItems.map(i => `${i.stack.typeId}x${i.stack.amount}`).join(", ");
        try {
          for (const player of world.getAllPlayers()) {
            try {
              if (typeof player.sendMessage === "function") {
                player.sendMessage(`§a[Scan] ✓ Found ${allItems.length} item(s) in prism ${prismKey}: ${itemSummary}`);
              }
            } catch {}
          }
        } catch {}
        sendDiagnosticMessage(`[Scan] ✓ Found ${allItems.length} item(s) in prism ${prismKey}: ${itemSummary}`, "transfer");
      } else if (nowTick <= 20 || nowTick % 50 === 0) {
        try {
          for (const player of world.getAllPlayers()) {
            try {
              if (typeof player.sendMessage === "function") {
                player.sendMessage(`§7[Scan] No items found in prism ${prismKey} (inventories=${inventories.length})`);
              }
            } catch {}
          }
        } catch {}
        sendDiagnosticMessage(`[Scan] No items found in prism ${prismKey} (inventories=${inventories.length}, hasFilter=${hasFilter})`, "transfer");
      }
      
      if (allItems.length > 0 && searchBudget > 0) {
        // DIAGNOSTIC: Log when items are found (always log - not throttled)
        sendDiagnosticMessage(`[Queue] Found ${allItems.length} items in prism ${prismKey}, finding routes...`, "transfer");
        
        // Find routes for all item types
        searchesUsed = 1;
        const pathResult = findPathForInput(prismKey, nowTick);
        if (pathResult && Array.isArray(pathResult) && pathResult.length > 0) {
          // Always log route found (not throttled)
          sendDiagnosticMessage(`[Queue] Found ${pathResult.length} route options for prism ${prismKey}`, "transfer");
          // Create routes map by item type (use first route found for each type)
          const routesByType = new Map();
          for (const item of allItems) {
            if (!routesByType.has(item.stack.typeId) && pathResult.length > 0) {
              // Pick a route for this item type
              const pick = pickWeightedRandomWithBias(pathResult, (opt) => {
                const type = opt?.outputType || "prism";
                if (isFluxTypeId(item.stack.typeId) && type === "crystal") return CRYSTAL_FLUX_WEIGHT;
                return 1.0;
              });
              if (pick && Array.isArray(pick.path) && pick.path.length > 0) {
                routesByType.set(item.stack.typeId, {
                  path: pick.path,
                  outputKey: pick.outputKey,
                });
              }
            }
          }
          
          // Queue all items with their routes
          if (routesByType.size > 0) {
            // Convert routes to just paths for queue (store outputKey separately)
            const routesMap = new Map();
            for (const [typeId, routeInfo] of routesByType.entries()) {
              routesMap.set(typeId, routeInfo.path);
              // Store outputKey in queue entry's lastDestination
            }
            
            // DIAGNOSTIC: Log queue creation (always log - not throttled)
            sendDiagnosticMessage(`[Queue] Creating queue: prism=${prismKey}, items=${allItems.length}, types=${routesByType.size}`, "transfer");
            
            inputQueuesManager.enqueueInputStacks(prismKey, allItems, routesMap);
            
            // Store outputKeys in queue entries
            for (const item of allItems) {
              const routeInfo = routesByType.get(item.stack.typeId);
              if (routeInfo) {
                const queue = inputQueuesManager.getQueuesForPrism(prismKey);
                const entry = queue?.find(e => e.itemTypeId === item.stack.typeId);
                if (entry) {
                  entry.lastDestination = routeInfo.outputKey;
                }
              }
            }
            
            // DIAGNOSTIC: Log queue creation result (always log - not throttled)
            const queueSize = inputQueuesManager.getTotalQueueSize();
            sendDiagnosticMessage(`[Queue] ✓ Queue created: prism=${prismKey}, totalQueueSize=${queueSize}`, "transfer");
            
            // Return success - items are queued
            return { ...makeResult(true, "queued"), searchesUsed };
          } else {
            // DIAGNOSTIC: Log when no routes found (extended debug)
            sendDiagnosticMessage(`[Queue] No routes found: prism=${prismKey}, items=${allItems.length}, pathResult=${pathResult?.length || 0}`, "transfer");
          }
        }
      }
    }
    
    // Fallback: If no queue manager or queue already exists, use old immediate transfer
    const randomItem = getRandomItemFromInventories(inventories, filterSet);
    if (randomItem && searchBudget > 0) {
      const result = attemptPushTransfer(prismKey, prismBlock, dim, inventories, randomItem, filterSet, searchBudget);
      if (result.ok) return result;
      searchesUsed += result.searchesUsed || 0;
      searchBudget -= result.searchesUsed || 0;
    }

    // TRY PULL: Request filtered items from network (only if attuned and no push happened)
    if (hasFilter && searchBudget > 0) {
      const result = attemptPullTransfer(prismKey, prismBlock, dim, inventories, filterSet, searchBudget);
      if (result.ok) return result;
      searchesUsed += result.searchesUsed || 0;
    }

    return { ...makeResult(false, "no_transfer"), searchesUsed };
  }

  // Legacy function name
  function attemptTransferOne(inputKey) {
    const result = attemptTransferForPrism(inputKey, cfg.maxSearchesPerTick);
    return makeResult(result.ok, result.reason);
  }

  // Helper: Attempt transfer with known destination and route (used by queue processing)
  function attemptPushTransferWithDestination(prismKey, prismBlock, dim, inventories, itemSource, destInfo, route, filterSet, queueEntry) {
    const sourceContainer = itemSource.container;
    const sourceSlot = itemSource.slot;
    const sourceStack = itemSource.stack;
    const outBlock = destInfo.block;
    const outInfo = destInfo;

    // Determine output type
    let outputType = "prism";
    if (outBlock.typeId === CRYSTALLIZER_ID) {
      outputType = "crystal";
    } else if (!isPrismBlock(outBlock)) {
      return { ...makeResult(false, "invalid_destination"), amount: 0 };
    }

    // Get target inventories
    let outInventories = null;
    let containerKey = null;
    const destKey = destInfo.key || destInfo.outputKey || "";
    if (outputType === "crystal") {
      const outContainerInfo = getAttachedInventoryInfo(outBlock, destInfo.dim);
      if (!outContainerInfo || !outContainerInfo.container) {
        return { ...makeResult(false, "no_container"), amount: 0 };
      }
      outInventories = [{ container: outContainerInfo.container, block: outContainerInfo.block, entity: outContainerInfo.entity }];
      containerKey = null; // Crystallizers don't use container keys
    } else {
      outInventories = cacheManager.getPrismInventoriesCached(destKey, outBlock, destInfo.dim);
      if (!outInventories || outInventories.length === 0) {
        return { ...makeResult(false, "no_container"), amount: 0 };
      }
      // Find first valid container for containerKey
      for (const inv of outInventories) {
        if (inv.container) {
          containerKey = getContainerKey(inv.entity || inv.block);
          break;
        }
      }
    }

    // Check capacity and calculate transfer amount (same logic as attemptPushTransfer)
    const targetFilter = getFilterForBlock(outBlock);
    const targetFilterSet = targetFilter ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter)) : null;
    const isFilteredDestination = targetFilterSet && targetFilterSet.size > 0;

    const targetInv = outInventories[0];
    if (!targetInv || !targetInv.container) {
      return { ...makeResult(false, "no_container"), amount: 0 };
    }

    const targetContainerKey = getContainerKey(targetInv.entity || targetInv.block);
    const sourceContainerKey = getContainerKey(inventories[itemSource.inventoryIndex].entity || inventories[itemSource.inventoryIndex].block);
    if (sourceContainerKey && targetContainerKey === sourceContainerKey) {
      return { ...makeResult(false, "same_container"), amount: 0 };
    }

    const queueState = queuesManager.getState();
    if (queueState.fullContainers.has(targetContainerKey)) {
      return { ...makeResult(false, "full"), amount: 0 };
    }

    const virtualCapacity = cacheManager.getInsertCapacityCached(targetContainerKey, targetInv.container, sourceStack.typeId, sourceStack);
    const previewLevel = levelsManager ? levelsManager.getNextInputLevel(prismKey) : 1;

    let desiredAmount = 1;
    if (isFilteredDestination) {
      desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
        ? levelsManager.getTransferAmount(previewLevel, sourceStack)
        : 1;
    } else {
      if (cfg.useBalanceDistribution !== false) {
        const sourceCount = getTotalCountForType(sourceContainer, sourceStack.typeId);
        const destCount = getTotalCountForType(targetInv.container, sourceStack.typeId);

        if (!sourceCount || sourceCount <= 0) {
          desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
            ? levelsManager.getTransferAmount(previewLevel, sourceStack)
            : 1;
        } else {
          let adjustedSourceCount = sourceCount;
          let adjustedDestCount = destCount;
          if (virtualInventoryManager && typeof virtualInventoryManager.getPendingForContainer === "function") {
            const sourcePending = virtualInventoryManager.getPendingForContainer(sourceContainerKey, sourceStack.typeId) || 0;
            const destPending = virtualInventoryManager.getPendingForContainer(targetContainerKey, sourceStack.typeId) || 0;
            adjustedSourceCount = Math.max(0, sourceCount - sourcePending);
            adjustedDestCount = destCount + destPending;
          }

          const maxTransfer = (cfg.balanceCapByLevel && levelsManager && typeof levelsManager.getTransferAmount === "function")
            ? levelsManager.getTransferAmount(previewLevel, sourceStack)
            : Infinity;

          const balanceResult = calculateBalancedTransferAmount(
            adjustedSourceCount,
            adjustedDestCount,
            sourceStack.amount,
            virtualCapacity,
            {
              minTransfer: cfg.balanceMinTransfer || 1,
              maxTransfer: maxTransfer,
            }
          );

          if (balanceResult.cancelled) {
            if (sourceCount > destCount && virtualCapacity > 0 && sourceStack.amount > 0) {
              desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
                ? Math.min(levelsManager.getTransferAmount(previewLevel, sourceStack), virtualCapacity, sourceStack.amount)
                : Math.min(1, virtualCapacity, sourceStack.amount);
            } else {
              return { ...makeResult(false, "balanced"), amount: 0 };
            }
          } else {
            desiredAmount = balanceResult.amount;
          }
        }
      } else {
        desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
          ? levelsManager.getTransferAmount(previewLevel, sourceStack)
          : 1;
      }
    }

    if (virtualCapacity < desiredAmount) {
      return { ...makeResult(false, "full"), amount: 0 };
    }

    const transferAmount = Math.min(desiredAmount, sourceStack.amount, virtualCapacity);
    if (transferAmount <= 0) {
      return { ...makeResult(false, "no_amount"), amount: 0 };
    }

    // Validate path start
    if (!validatePathStart(dim, route)) {
      return { ...makeResult(false, "invalid_path"), amount: 0 };
    }

    // Decrement from source
    const remaining = sourceStack.amount - transferAmount;
    if (remaining > 0) {
      try {
        const newStack = sourceStack.clone();
        newStack.amount = remaining;
        sourceContainer.setItem(sourceSlot, newStack);
      } catch {
        return { ...makeResult(false, "no_item"), amount: 0 };
      }
    } else {
      try {
        sourceContainer.setItem(sourceSlot, null);
      } catch {
        return { ...makeResult(false, "no_item"), amount: 0 };
      }
    }

    // Create inflight job (same as attemptPushTransfer)
    const suppressOrb = (outputType === "crystal" && isFluxTypeId(sourceStack.typeId));
    const prismPos = prismInfo.pos;
    const nodePath = buildNodePathSegments(dim, route, prismPos);
    const travelPath = nodePath?.points || route;
    const segmentLengths = nodePath?.lengths || null;

    const pathPrismKey = findFirstPrismKeyInPath(dim, prismPos.dimId, route);
    if (levelsManager && typeof levelsManager.notePrismPassage === "function") {
      levelsManager.notePrismPassage(prismKey, prismBlock);
    }

    const prismTier = isPrismBlock(prismBlock) ? getPrismTierFromTypeId(prismBlock) : 1;
    const baseStepTicks = (levelsManager && typeof levelsManager.getOrbStepTicks === "function")
      ? levelsManager.getOrbStepTicks(prismTier)
      : cfg.orbStepTicks;

    if (debugEnabled) {
      debugState.transferStartTicks.push(nowTick);
      debugState.stepTicksTotal += baseStepTicks;
      debugState.stepTicksCount++;
      if (baseStepTicks < debugState.stepTicksMin) debugState.stepTicksMin = baseStepTicks;
      if (baseStepTicks > debugState.stepTicksMax) debugState.stepTicksMax = baseStepTicks;
      if (segmentLengths && segmentLengths.length > 0) {
        debugState.segmentStepsTotal += segmentLengths.length;
        debugState.segmentStepsCount++;
      }
    }

    inflight.push({
      dimId: prismPos.dimId,
      itemTypeId: sourceStack.typeId,
      amount: transferAmount,
      path: travelPath,
      stepIndex: 0,
      stepTicks: baseStepTicks,
      speedScale: 1.0,
      outputKey: destKey,
      outputType: outputType,
      suppressOrb: suppressOrb,
      containerKey: containerKey,
      prismKey: pathPrismKey,
      startPos: { x: prismPos.x, y: prismPos.y, z: prismPos.z },
      level: previewLevel,
      segmentLengths: segmentLengths,
      ticksUntilStep: 0,
      startTick: debugEnabled ? nowTick : null,
      refinedItems: (outputType === "crystal" && isFluxTypeId(sourceStack.typeId))
        ? [{ typeId: sourceStack.typeId, amount: transferAmount }]
        : null,
    });

    if (containerKey) {
      reserveContainerSlot(containerKey, sourceStack.typeId, transferAmount);
    }
    inflightDirty = true;

    return { ...makeResult(true, "ok"), amount: transferAmount, searchesUsed: 0 };
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
    searchesUsed = 1;
    // Use findPathForInput (legacy name, but now works with prisms via pathfinder update)
    if (typeof findPathForInput !== "function") {
      return { ...makeResult(false, "no_pathfinder"), searchesUsed };
    }

    const options = findPathForInput(prismKey, nowTick);
    if (!options || !Array.isArray(options) || options.length === 0) {
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "no_options"), searchesUsed };
    }

    // Filter options to prioritize prisms that want this item (matching filters)
    const filteredOptions = [];
    for (const opt of options) {
      if (!opt || !opt.outputKey) continue;
      const targetInfo = resolveBlockInfo(opt.outputKey);
      if (!targetInfo || !targetInfo.block) continue;

      // Crystallizers can always accept flux
      if (targetInfo.block.typeId === CRYSTALLIZER_ID) {
        if (isFluxTypeId(sourceStack.typeId)) {
          filteredOptions.push(opt);
        }
        continue;
      }

      // Prisms - check if they have space and matching filter
      if (isPrismBlock(targetInfo.block)) {
        const targetInventories = cacheManager.getPrismInventoriesCached(opt.outputKey, targetInfo.block, targetInfo.dim);
        if (!targetInventories || targetInventories.length === 0) continue;

        const targetFilter = getFilterForBlock(targetInfo.block);
        const targetFilterSet = targetFilter ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter)) : null;
        
        // If target has filter, prioritize if this item matches (they want it)
        // If target has no filter, they can accept any item
        if (!targetFilterSet || targetFilterSet.size === 0 || targetFilterSet.has(sourceStack.typeId)) {
          filteredOptions.push(opt);
        }
      }
    }

    if (filteredOptions.length === 0) {
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "no_options"), searchesUsed };
    }

    if (debugEnabled) {
      debugState.outputOptionsTotal += filteredOptions.length;
      debugState.outputOptionsMax = Math.max(debugState.outputOptionsMax, filteredOptions.length);
    }

    const isFlux = isFluxTypeId(sourceStack.typeId);
    if (!levelsManager || typeof levelsManager.getNextInputLevel !== "function") {
      return { ...makeResult(false, "no_levels_manager"), searchesUsed };
    }
    const previewLevel = levelsManager.getNextInputLevel(prismKey);
    let pathInfo = null;
    let outInfo = null;
    let outBlock = null;
    let outInventories = null;
    let containerKey = null;
    let transferAmount = 0;
    let sawFull = false;
    let outputType = "prism";

    let candidates = filteredOptions.slice();
    if (!isFlux) {
      candidates = candidates.filter((c) => (c?.outputType || "prism") !== "crystal");
    }
    if (candidates.length === 0) return { ...makeResult(false, "no_options"), searchesUsed };

    const available = sourceStack.amount;
    while (candidates.length > 0) {
      const pick = pickWeightedRandomWithBias(candidates, (opt) => {
        const type = opt?.outputType || "prism";
        if (isFlux && type === "crystal") return CRYSTAL_FLUX_WEIGHT;
        return 1.0;
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
        const desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
          ? levelsManager.getTransferAmount(previewLevel, sourceStack)
          : 1;
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

      // Get target prism's inventories (use cached version)
      const targetInventories = cacheManager.getPrismInventoriesCached(pick.outputKey, info.block, info.dim);
      if (!targetInventories || targetInventories.length === 0) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }

      // Check if we can insert into any of the target inventories
      let foundTarget = false;
      for (const targetInv of targetInventories) {
        if (!targetInv.container) continue;
        const targetContainerKey = getContainerKey(targetInv.entity || targetInv.block);
        if (!targetContainerKey) continue;

        // Skip if same container
        const sourceContainerKey = getContainerKey(inventories[itemSource.inventoryIndex].entity || inventories[itemSource.inventoryIndex].block);
        if (sourceContainerKey && targetContainerKey === sourceContainerKey) continue;

        const queueState = queuesManager.getState();
        if (queueState.fullContainers.has(targetContainerKey)) {
          sawFull = true;
          continue;
        }

        // Check if destination has filter (filtered = fill, unfiltered = balance)
        const targetFilter = getFilterForBlock(info.block);
        const targetFilterSet = targetFilter ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter)) : null;
        const isFilteredDestination = targetFilterSet && targetFilterSet.size > 0;

        // Get available capacity (accounting for virtual inventory)
        // This accounts for in-flight items and queued items to prevent overbooking
        const virtualCapacity = cacheManager.getInsertCapacityCached(targetContainerKey, targetInv.container, sourceStack.typeId, sourceStack);

        // Calculate desired transfer amount based on destination type
        let desiredAmount = 1;
        
        if (isFilteredDestination) {
          // FILTERED: Fill to capacity (prioritized, use level-based amounts)
          desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
            ? levelsManager.getTransferAmount(previewLevel, sourceStack)
            : 1;
        } else {
          // UNFILTERED: 50/50 balance distribution (if enabled)
          if (cfg.useBalanceDistribution !== false) {
            // Get source and destination counts for balance calculation
            const sourceContainer = itemSource.container;
            const sourceCount = getTotalCountForType(sourceContainer, sourceStack.typeId);
            const destCount = getTotalCountForType(targetInv.container, sourceStack.typeId);
            
            // Safety check: if source count is 0 or invalid, use fallback
            if (!sourceCount || sourceCount <= 0) {
              // Source has no items of this type - use level-based amount as fallback
              desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
                ? levelsManager.getTransferAmount(previewLevel, sourceStack)
                : 1;
            } else {

            // Account for pending items in balance calculation (if virtual inventory manager available)
            let adjustedSourceCount = sourceCount;
            let adjustedDestCount = destCount;
            if (virtualInventoryManager && typeof virtualInventoryManager.getPendingForContainer === "function") {
              const sourcePending = virtualInventoryManager.getPendingForContainer(sourceContainerKey, sourceStack.typeId) || 0;
              const destPending = virtualInventoryManager.getPendingForContainer(targetContainerKey, sourceStack.typeId) || 0;
              adjustedSourceCount = Math.max(0, sourceCount - sourcePending); // Items leaving
              adjustedDestCount = destCount + destPending; // Items arriving
            }

            // Calculate balanced transfer amount
            const maxTransfer = (cfg.balanceCapByLevel && levelsManager && typeof levelsManager.getTransferAmount === "function")
              ? levelsManager.getTransferAmount(previewLevel, sourceStack)
              : Infinity;

            const balanceResult = calculateBalancedTransferAmount(
              adjustedSourceCount,
              adjustedDestCount,
              sourceStack.amount, // Available in source stack
              virtualCapacity,     // Available capacity in destination
              {
                minTransfer: cfg.balanceMinTransfer || 1,
                maxTransfer: maxTransfer,
              }
            );

            if (balanceResult.cancelled) {
              // Balance cancelled - check if we should still transfer
              // If source has more than dest (even if balance says cancel), transfer at least 1 item
              // This ensures items always flow from high to low
              if (sourceCount > destCount && virtualCapacity > 0 && sourceStack.amount > 0) {
                // Source has more - transfer at least 1 item (or level-based amount)
                desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
                  ? Math.min(levelsManager.getTransferAmount(previewLevel, sourceStack), virtualCapacity, sourceStack.amount)
                  : Math.min(1, virtualCapacity, sourceStack.amount);
                
                if (debugEnabled) {
                  debugState.balanceCancelled = (debugState.balanceCancelled || 0) + 1;
                  debugState.balanceCancelReason = balanceResult.reason;
                  debugState.balanceFallback = (debugState.balanceFallback || 0) + 1;
                }
              } else {
                // No capacity, items, or source doesn't have more - skip this destination
                if (debugEnabled) {
                  debugState.balanceCancelled = (debugState.balanceCancelled || 0) + 1;
                  debugState.balanceCancelReason = balanceResult.reason;
                }
                continue; // Try next destination
              }
            } else {
              desiredAmount = balanceResult.amount;
              if (debugEnabled) {
                debugState.balanceTransfers = (debugState.balanceTransfers || 0) + 1;
                debugState.balanceAmount = (debugState.balanceAmount || 0) + balanceResult.amount;
              }
            }
            } // Close the else block for sourceCount > 0 check
          } else {
            // Balance distribution disabled - use level-based amounts
            desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
              ? levelsManager.getTransferAmount(previewLevel, sourceStack)
              : 1;
          }
        }

        // Check virtual capacity before attempting insertion
        if (virtualCapacity < desiredAmount) {
          sawFull = true;
          continue; // Container doesn't have enough virtual capacity (accounting for pending items)
        }

        // Try to insert
        const inserted = tryInsertIntoInventories([targetInv], sourceStack.typeId, desiredAmount, null); // No filter check here - already filtered above
        if (inserted) {
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

    if (!validatePathStart(dim, pathInfo.path)) {
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "no_options"), searchesUsed };
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
    const firstBlock = cacheManager.getBlockCached(prismPos.dimId, firstStep) || dim.getBlock({ x: firstStep.x, y: firstStep.y, z: firstStep.z });
    const nodePath = buildNodePathSegments(dim, pathInfo.path, prismPos);
    const travelPath = nodePath?.points || pathInfo.path;
    const segmentLengths = nodePath?.lengths || null;

    const pathPrismKey = findFirstPrismKeyInPath(dim, prismPos.dimId, pathInfo.path);
    // Note that this prism started a transfer (counts toward prism leveling)
    if (levelsManager && typeof levelsManager.notePrismPassage === "function") {
      levelsManager.notePrismPassage(prismKey, prismBlock);
    }
    // Get level from prism block for orb step ticks (prisms now use tier block IDs, not state)
    const prismTier = isPrismBlock(prismBlock) ? getPrismTierFromTypeId(prismBlock) : 1;
    const baseStepTicks = (levelsManager && typeof levelsManager.getOrbStepTicks === "function")
      ? levelsManager.getOrbStepTicks(prismTier)
      : cfg.orbStepTicks;
    
    if (debugEnabled) {
      debugState.transferStartTicks.push(nowTick);
      debugState.stepTicksTotal += baseStepTicks;
      debugState.stepTicksCount++;
      if (baseStepTicks < debugState.stepTicksMin) debugState.stepTicksMin = baseStepTicks;
      if (baseStepTicks > debugState.stepTicksMax) debugState.stepTicksMax = baseStepTicks;
      if (segmentLengths && segmentLengths.length > 0) {
        debugState.segmentStepsTotal += segmentLengths.length;
        debugState.segmentStepsCount++;
      }
    }
    
    inflight.push({
      dimId: prismPos.dimId,
      itemTypeId: sourceStack.typeId,
      amount: transferAmount,
      path: travelPath,
      stepIndex: 0,
      stepTicks: baseStepTicks,
      speedScale: 1.0,
      outputKey: pathInfo.outputKey,
      outputType: outputType,
      suppressOrb: suppressOrb,
      containerKey: containerKey,
      prismKey: pathPrismKey,
      startPos: { x: prismPos.x, y: prismPos.y, z: prismPos.z },
      level: previewLevel,
      segmentLengths: segmentLengths,
      ticksUntilStep: 0,
      startTick: debugEnabled ? nowTick : null,
      refinedItems: (outputType === "crystal" && isFluxTypeId(sourceStack.typeId))
        ? [{ typeId: sourceStack.typeId, amount: transferAmount }]
        : null,
    });
    
    if (containerKey) {
      reserveContainerSlot(containerKey, sourceStack.typeId, transferAmount);
    }
    inflightDirty = true;

    return { ...makeResult(true, "ok"), searchesUsed };
  }

  // Pull transfer: request filtered items from network
  // TODO: Implement pull-based transfer system for filtered item requests
  // This will require scanning the network for items matching the filter whitelist
  // and routing them to requesting prisms. Currently push-only transfers are used.
  function attemptPullTransfer(prismKey, prismBlock, dim, inventories, filterSet, searchBudget) {
    let searchesUsed = 0;
    if (searchBudget <= 0) return { ...makeResult(false, "no_search_budget"), searchesUsed };
    if (!filterSet || filterSet.size === 0) return { ...makeResult(false, "no_filter"), searchesUsed };

    // For now, pull is complex - we'd need to scan the network for items
    // This is a placeholder - can be enhanced later with request system
    // For now, we'll just return false and let push handle transfers
    return { ...makeResult(false, "pull_not_implemented"), searchesUsed };
  }

  function postDebugStats(inputCount) {
    // Check if enough ticks have passed
    const ticksSinceLastDebug = nowTick - lastDebugTick;
    
    // On first call, initialize lastDebugTick
    if (lastDebugTick === 0) {
      lastDebugTick = nowTick;
      return; // Skip stats on first call, start timing from here
    }
    
    if (ticksSinceLastDebug < debugInterval) {
      return; // Not time yet
    }
    lastDebugTick = nowTick;
    
    // Always send debug messages, even if no prisms found
    try {
      // Ensure we have valid values
      const safeInputCount = inputCount || 0;
      
      const pathStats = (typeof getPathStats === "function") ? getPathStats() : null;

    let queuedContainers = 0;
    let queuedEntries = 0;
    let queuedItems = 0;
    let queuedMax = 0;
    const queueState = queuesManager.getState();
    for (const queue of queueState.queueByContainer.values()) {
      if (!queue) continue;
      queuedContainers++;
      queuedEntries += queue.length;
      queuedMax = Math.max(queuedMax, queue.length);
      for (const job of queue) {
        queuedItems += Math.max(0, job?.amount | 0);
      }
    }

    const bfsLabel = pathStats
      ? ` bfs=${pathStats.searches}:${pathStats.visitedTotal}/${pathStats.visitedMax} out=${pathStats.outputsTotal}/${pathStats.outputsMax}`
      : "";

    // Calculate timing stats
    const avgStepTicks = debugState.stepTicksCount > 0 ? Math.round(debugState.stepTicksTotal / debugState.stepTicksCount) : 0;
    const minStepTicks = debugState.stepTicksMin === Infinity ? 0 : debugState.stepTicksMin;
    const maxStepTicks = debugState.stepTicksMax;
    const avgTransferTicks = debugState.transferCompleteTicks.length > 0 
      ? Math.round(debugState.transferCompleteTicks.reduce((a, b) => a + b, 0) / debugState.transferCompleteTicks.length)
      : 0;
    const maxTransferTicks = debugState.transferCompleteTicks.length > 0
      ? Math.max(...debugState.transferCompleteTicks)
      : 0;
    const avgSegments = debugState.segmentStepsCount > 0 
      ? (debugState.segmentStepsTotal / debugState.segmentStepsCount).toFixed(1)
      : "0";

    const timingLabel = ` stepTicks=${minStepTicks}/${avgStepTicks}/${maxStepTicks}` +
      ` xferTicks=${avgTransferTicks}/${maxTransferTicks}` +
      ` segs=${avgSegments}`;

    // Timing breakdown: show total and per-module times
    const timingBreakdown = `TIMING: Total=${debugState.msTotal}ms | Cache=${debugState.msCache || 0}ms | Queues=${debugState.msQueues}ms | InputQueues=${debugState.msInputQueues || 0}ms | Inflight=${debugState.msInflight}ms | FluxFX=${debugState.msFluxFx}ms | Scan=${debugState.msScan}ms | Persist=${debugState.msPersist}ms`;

    // Balance distribution debug info
    const balanceInfo = (debugState.balanceTransfers || debugState.balanceCancelled || debugState.balanceFallback)
      ? ` balance=${debugState.balanceTransfers || 0}/${debugState.balanceCancelled || 0}/${debugState.balanceFallback || 0} balAmt=${debugState.balanceAmount || 0} balCancel=${debugState.balanceCancelReason || "none"}`
      : "";

    // Build the stats message
    const msg =
      `Chaos Transfer | inputs=${safeInputCount} scanned=${debugState.inputsScanned || 0} ` +
      `xfer=${debugState.transfersStarted} inflight=${inflight.length} ` +
      `fluxFx=${fluxFxInflight.length}/${cfg.maxFluxFxInFlight | 0} ` +
      `orbFx=${debugState.orbSpawns} orbFxSkip=${debugState.orbFxSkipped} fluxFxSp=${debugState.fluxFxSpawns} ` +
      `mapReloads=${debugState.inputMapReloads} ` +
      `fluxGen=${debugState.fluxGenHits}/${debugState.fluxGenChecks} refine=${debugState.fluxRefined}/${debugState.fluxMutated}/${debugState.fluxRefineCalls} ` +
      `blk=${debugState.blockLookups} cont=${debugState.containerLookups} inv=${debugState.inventoryScans} dp=${debugState.dpSaves} ` +
      `qC=${queuedContainers} qE=${queuedEntries} qI=${queuedItems} qMax=${queuedMax} ` +
      `full=${queueState.fullContainers.size} opts=${debugState.outputOptionsTotal}/${debugState.outputOptionsMax}` +
      balanceInfo +
      ` ${timingLabel}` +
      bfsLabel +
      ` | ${timingBreakdown}`;

    // Send to players who have transfer/prism debug group enabled
    const players = world.getAllPlayers();
    if (players.length === 0) {
      // No players online - skip sending but still reset state
      resetDebugState();
      return;
    }
    
    let sentCount = 0;
    for (const player of players) {
      try {
        // Check basic lens/goggles visibility (stats are basic debug)
        if (!hasInsight(player)) continue;
        
        if (typeof player.sendMessage === "function") {
          player.sendMessage(msg);
          sentCount++;
        }
      } catch (err) {
        // Send error to player (they have debug enabled, so show errors)
        try {
          if (typeof player.sendMessage === "function") {
            player.sendMessage(`§c[Chaos Transfer] Error sending stats: ${err?.message || String(err)}`);
          }
        } catch {}
      }
    }
    
    // If no messages were sent but there are players, it's likely no one has lens/goggles enabled
    // This is normal behavior, not an error

    resetDebugState();
    } catch (err) {
      // Catch any errors in postDebugStats to prevent breaking the tick loop
      // Send error to all players (errors should always be visible)
      try {
        for (const player of world.getAllPlayers()) {
          try {
            if (typeof player.sendMessage === "function") {
              player.sendMessage(`§c[Chaos Transfer] Error in debug stats: ${err?.message || String(err)}`);
            }
          } catch {}
        }
      } catch {}
    }
  }

  function noteOutputTransfer(outputKey, block) {
    // Legacy function - outputs now use unified prism system
    // For prisms, use notePrismPassage instead
    if (!levelsManager) return; // Guard against null levelsManager
    if (isPrismBlock(block)) {
      if (typeof levelsManager.notePrismPassage === "function") {
        levelsManager.notePrismPassage(outputKey, block);
      }
    } else {
      // Legacy output blocks (if any) - use levels manager functions
      if (typeof levelsManager.getMinCountForLevel !== "function" || typeof levelsManager.getLevelForCount !== "function") return;
      const blockLevel = (block?.permutation?.getState("chaos:level") | 0) || 1;
      const minCount = levelsManager.getMinCountForLevel(blockLevel, cfg.levelStep);
      const stored = outputCounts.has(outputKey) ? outputCounts.get(outputKey) : 0;
      const storedLevel = levelsManager.getLevelForCount(stored, cfg.levelStep, cfg.maxLevel);
      const current = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
      const next = current + 1;
      outputCounts.set(outputKey, next);
      outputLevelsDirty = true;
      const level = levelsManager.getLevelForCount(next, cfg.levelStep, cfg.maxLevel);
      try {
        const perm = block.permutation;
        if (perm) {
          const current = perm.getState("chaos:level");
          if ((current | 0) !== (level | 0)) {
            block.setPermutation(perm.withState("chaos:level", level));
            if (fxManager && typeof fxManager.spawnLevelUpBurst === "function") {
              fxManager.spawnLevelUpBurst(block);
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }


  function rebuildReservationsFromInflight() {
    try {
      clearReservations();
      if (!Array.isArray(inflight)) return; // Guard against invalid inflight
      for (const job of inflight) {
        if (!job || !job.containerKey || !job.itemTypeId) continue;
        const amt = Math.max(1, job.amount | 0);
        reserveContainerSlot(job.containerKey, job.itemTypeId, amt);
      }
    } catch (err) {
      // If rebuilding fails, just clear reservations and continue
      try {
        clearReservations();
      } catch {}
    }
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

  function getCacheManager() {
    return cacheManager || null;
  }

  return { start, stop, getCacheManager };
}
