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
    debugState.msInflight = 0;
    debugState.msFluxFx = 0;
    debugState.msScan = 0;
    debugState.msPersist = 0;
    debugState.msTotal = 0;
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
    try {
      loadInflightState();
    } catch (err) {
      logError("Error loading inflight state", err);
    }
    try {
      loadLevelsState();
    } catch (err) {
      logError("Error loading levels state", err);
    }
    try {
      loadOutputLevelsState();
    } catch (err) {
      logError("Error loading output levels state", err);
    }
    try {
      loadPrismLevelsState();
    } catch (err) {
      logError("Error loading prism levels state", err);
    }
    try {
      tickId = system.runInterval(onTick, 1);
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
      loadInflightStateFromWorld(world, inflight, cfg);
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
      virtualInventoryManager.updateState(inflight, queueState.queueByContainer);
    }

    const scanStart = debugEnabled ? Date.now() : 0;
    const prismKeys = getPrismKeys();
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
    }
    if (debugEnabled) postDebugStats(prismKeys.length);
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

        // Calculate desired transfer amount
        const desiredAmount = (levelsManager && typeof levelsManager.getTransferAmount === "function")
          ? levelsManager.getTransferAmount(previewLevel, sourceStack)
          : 1;

        // Check virtual capacity before attempting insertion
        // This accounts for in-flight items and queued items to prevent overbooking
        // getInsertCapacityCached already accounts for virtual inventory if manager is active
        const virtualCapacity = cacheManager.getInsertCapacityCached(targetContainerKey, targetInv.container, sourceStack.typeId, sourceStack);
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
    if ((nowTick - lastDebugTick) < debugInterval) return;
    lastDebugTick = nowTick;

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
    const timingBreakdown = `TIMING: Total=${debugState.msTotal}ms | Cache=${debugState.msCache || 0}ms | Queues=${debugState.msQueues}ms | Inflight=${debugState.msInflight}ms | FluxFX=${debugState.msFluxFx}ms | Scan=${debugState.msScan}ms | Persist=${debugState.msPersist}ms`;

    const msg =
      `Chaos Transfer | inputs=${inputCount} scanned=${debugState.inputsScanned} ` +
      `xfer=${debugState.transfersStarted} inflight=${inflight.length} ` +
      `fluxFx=${fluxFxInflight.length}/${cfg.maxFluxFxInFlight | 0} ` +
      `orbFx=${debugState.orbSpawns} orbFxSkip=${debugState.orbFxSkipped} fluxFxSp=${debugState.fluxFxSpawns} ` +
      `mapReloads=${debugState.inputMapReloads} ` +
      `fluxGen=${debugState.fluxGenHits}/${debugState.fluxGenChecks} refine=${debugState.fluxRefined}/${debugState.fluxMutated}/${debugState.fluxRefineCalls} ` +
      `blk=${debugState.blockLookups} cont=${debugState.containerLookups} inv=${debugState.inventoryScans} dp=${debugState.dpSaves} ` +
      `qC=${queuedContainers} qE=${queuedEntries} qI=${queuedItems} qMax=${queuedMax} ` +
      `full=${queueState.fullContainers.size} opts=${debugState.outputOptionsTotal}/${debugState.outputOptionsMax} ` +
      timingLabel +
      bfsLabel +
      ` | ${timingBreakdown}`;

    for (const player of world.getAllPlayers()) {
      try {
        if (typeof player.sendMessage === "function") {
          player.sendMessage(msg);
        }
      } catch {
        // ignore
      }
    }

    resetDebugState();
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
