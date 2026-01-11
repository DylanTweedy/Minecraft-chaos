// scripts/chaos/features/links/transfer/controller.js

// Minecraft API
import { ItemStack, MolangVariableMap } from "@minecraft/server";

// Config & constants
import {
  DEFAULTS,
  CRYSTALLIZER_ID,
  CRYSTAL_FLUX_WEIGHT,
  MAX_STEPS,
  SPEED_SCALE_MAX,
  PRISM_SPEED_BOOST_BASE,
  PRISM_SPEED_BOOST_PER_TIER,
  isPrismBlock,
  getPrismTier,
} from "./config.js";

// Core orchestration
import { createTransferPipeline } from "./core/pipeline.js";
import { createAdjacentPrismDirtyMarker } from "./core/dirtyPrisms.js";
import { subscribeTransferDirtyEvents } from "./core/transferEvents.js";
import { createCacheManager } from "./core/cache.js";
import { createFinalizeManager } from "./core/finalize.js";
import { createQueuesManager } from "./core/queues.js";
import { createInflightProcessorManager } from "./core/inflightProcessor.js";
import { createVirtualInventoryManager } from "./core/virtualInventory.js";
import { createInputQueuesManager } from "./core/inputQueues.js";

// Systems
import { createLevelsManager } from "./systems/levels.js";
import { createFxManager } from "./systems/fx.js";
import { createRefinementManager } from "./systems/refinement.js";

// Utilities
import { mergeCfg, runTransferPipeline } from "./utils.js";
import { key, parseKey, getContainerKey, getContainerKeyFromInfo } from "./keys.js";

// Persistence
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

// Inventory & containers
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

// Pathfinding & routing
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

// Tracing
import {
  getTraceKey,
  isTracing,
  markDirty as traceMarkDirty,
  clearDirty as traceClearDirty,
  noteScan as traceNoteScan,
  noteError as traceNoteError,
  noteQueueSize as traceNoteQueueSize,
  noteCooldown as traceNoteCooldown,
} from "../../../core/trace.js";

// Cross-feature filters
import { getFilterSetForBlock } from "../filters.js";

// Flux / crystallizer / FX (chaos root is 3 levels up)
import { tryGenerateFluxOnTransfer, tryRefineFluxInTransfer, getFluxTier, isFluxTypeId } from "../../../flux.js";
import { addFluxForItem, getFluxValueForItem } from "../../../crystallizer.js";
import { fxFluxGenerate, queueFxParticle } from "../../../fx/fx.js";

// Debug UX
import { hasInsight, hasExtendedDebug } from "../../../core/debugGroups.js";
import { isHoldingLens } from "../../../items/insightLens.js";
import { isWearingGoggles } from "../../../items/insightGoggles.js";

export function createNetworkTransferController(deps, opts) {
  // Deps (keep names identical)
  const {
    world,
    system,
    FX,
    getSpeedForInput,
    findPathForInput,
    invalidateInput,
    getPathStats,
    getNetworkStamp,
  } = deps;

  const cfg = mergeCfg(DEFAULTS, opts);

  // Helper function for safe message sending (handles all errors gracefully)
  // Must be defined early so it can be used throughout initialization
  // This function MUST NEVER throw - wrap everything in try-catch
  function sendInitMessage(message) {
    try {
      const msgStr = message != null ? String(message) : "";
      if (!msgStr) return;

      // Safely get players
      let players;
      try {
        if (!world || typeof world.getAllPlayers !== "function") return;
        players = world.getAllPlayers();
      } catch {
        return;
      }

      if (!players) return;

      // Support iterable OR array-like
      let iterable;
      try {
        if (typeof players[Symbol.iterator] === "function") {
          iterable = players;
        } else if (typeof players.length === "number") {
          iterable = Array.from({ length: players.length }, (_, i) => players[i]);
        } else {
          return;
        }
      } catch {
        return;
      }

      // Iterate and send messages (never let one player break the loop)
      try {
        for (const player of iterable) {
          try {
            if (player && typeof player.sendMessage === "function") {
              player.sendMessage(msgStr);
            }
          } catch {
            // ignore per-player failures
          }
        }
      } catch {
        // ignore iteration failures
      }
    } catch {
      // Ignore ALL errors - initialization logging should never break the system
    }
  }

  // INIT DEBUG: Controller creation started (delayed to ensure world is ready)
  try {
    sendInitMessage("§b[Init] Creating NetworkTransferController...");

    const hasWorld = !!world && typeof world === "object";
    const hasSystem = !!system && typeof system === "object";
    const hasFX = !!FX && typeof FX === "object";
    const hasPathfinder = typeof findPathForInput === "function";

    sendInitMessage(
      "§b[Init] Dependencies: world=" +
        hasWorld +
        ", system=" +
        hasSystem +
        ", FX=" +
        hasFX +
        ", pathfinder=" +
        hasPathfinder
    );
  } catch {
    // Ignore - initialization messages are optional
  }

    // Tick / loop state
  let cursor = 0;
  let tickId = null;
  let nowTick = 0;

  // Controller lifecycle state
  const controllerState = { eventsSubscribed: false };
  let unsubscribeEvents = null;

  // Cooldowns & scheduling
  const nextAllowed = new Map();
  const nextQueueTransferAllowed = new Map(); // per-prism queue transfer interval gating (tier-based)
  const inputBackoff = new Map();

  // Inflight state (orbs + FX orbs)
  const inflight = [];
  const fluxFxInflight = [];
  let inflightDirty = false;
  let inflightStepDirty = false;
  let lastSaveTick = 0;

  // Levels / stats persistence state
  const transferCounts = new Map();
  let levelsDirty = false;
  let lastLevelsSaveTick = 0;

  const outputCounts = new Map();
  let outputLevelsDirty = false;
  let lastOutputLevelsSaveTick = 0;

  const prismCounts = new Map();
  let prismLevelsDirty = false;
  let lastPrismLevelsSaveTick = 0;

  // Queues
  const queueByContainer = new Map();
  const fullContainers = new Set();
  let fullCursor = 0;
  let queueCursor = 0;

  // Debug config & state
  // Force debug enabled if config says so (don't let FX override it)
  const debugEnabled = !!(cfg.debugTransferStats === true || FX?.debugTransferStats === true);
  const debugInterval = Math.max(
    20,
    Number(cfg.debugTransferStatsIntervalTicks || FX?.debugTransferStatsIntervalTicks) || 100
  );

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
    msInputQueues: 0,
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
    // Balance distribution debug stats (used in resetDebugState + balance code)
    balanceTransfers: 0,
    balanceCancelled: 0,
    balanceFallback: 0,
    balanceAmount: 0,
    balanceCancelReason: null,
  };

  // Cached inputs & FX budgets
  let cachedInputKeys = null;
  let cachedInputsStamp = null;
  const orbFxBudgetUsed = { value: 0 };

  // Internal helper: safe init log (never throws)
  function safeInitLog(prefix, message, err) {
    try {
      const prefixStr = String(prefix || "§c[Chaos Transfer]");
      const msgStr = String(message || "Error");
      const errMsg = err ? ((err && err.message) ? String(err.message) : String(err)) : "";
      const full = errMsg ? (prefixStr + " " + msgStr + ": " + errMsg) : (prefixStr + " " + msgStr);
      sendInitMessage(full);
    } catch {
      // ignore logging errors
    }
  }

  // Helper function for error handling during manager creation (fatal; re-throws)
  function handleManagerCreationError(managerName, err) {
    safeInitLog("§c[Chaos Transfer]", "Error creating " + String(managerName || "unknown"), err);
    throw err; // bubble to transferLoop.js catch handler
  }

  // Helper function for non-fatal error logging (doesn't re-throw)
  function logError(message, err) {
    safeInitLog("§c[Chaos Transfer]", String(message || "Error"), err);
  }

  // INIT DEBUG: Creating managers
  sendInitMessage("§b[Init] Step 1/8: Creating virtualInventoryManager...");

    // Create virtual inventory manager first (needed by cache manager for capacity calculations)
  let virtualInventoryManager;
  try {
    virtualInventoryManager = createVirtualInventoryManager(cfg, { getContainerKey });
    if (!virtualInventoryManager) {
      throw new Error("createVirtualInventoryManager returned null - check cfg and deps parameters");
    }
    // INIT DEBUG: Success
    sendInitMessage("§a[Init] ✓ virtualInventoryManager created");
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

      // Furnace rule: only count input+fuel (not output). Non-furnace: count all slots.
      const indices = slots ? [slots.input, slots.fuel] : null;
      const loopCount = indices ? indices.length : size;

      let stackRoom = 0;
      let emptySlots = 0;

      for (let i = 0; i < loopCount; i++) {
        const slotIndex = indices ? indices[i] : i;
        const it = container.getItem(slotIndex);

        if (!it) {
          emptySlots++;
          continue;
        }

        const max = it.maxAmount || 64;
        if (it.amount < max) stackRoom += (max - it.amount);
      }

      // Reservations (be defensive: treat missing as 0)
      const reserved = getReservedForContainer(containerKey);
      const reservedTotal = reserved && typeof reserved.total === "number" ? reserved.total : 0;

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

  // INIT DEBUG: Cache manager
  sendInitMessage("§b[Init] Step 2/8: Creating cacheManager...");

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
    // INIT DEBUG: Success
    sendInitMessage("§a[Init] ✓ cacheManager created");
  } catch (err) {
    handleManagerCreationError("cacheManager", err);
  }

   function createOrFail(stepLabel, managerName, factoryFn) {
    try {
      const manager = factoryFn();
      if (!manager) throw new Error(managerName + " factory returned null/undefined");
      sendInitMessage("§a[Init] ✓ " + stepLabel);
      return manager;
    } catch (err) {
      handleManagerCreationError(managerName, err);
      return null; // unreachable, but keeps control-flow obvious
    }
  }

  // INIT DEBUG: Levels manager (first time)
  sendInitMessage("§b[Init] Step 3/8: Creating levelsManager (initial)...");

  // Create levelsManager first (without spawnLevelUpBurst - optional and added later)
  let levelsManager = createOrFail(
    "levelsManager (initial) created",
    "levelsManager",
    () =>
      createLevelsManager(
        cfg,
        {
          prismCounts,
          transferCounts,
          outputCounts,
          prismLevelsDirty: { set: (v) => { prismLevelsDirty = v; } },
        },
        {} // spawnLevelUpBurst will be handled via direct call to fxManager
      )
  );

  // INIT DEBUG: FX manager
  sendInitMessage("§b[Init] Step 4/8: Creating fxManager...");

  // Create FX manager - needs getOrbStepTicks from levels manager
  let fxManager = createOrFail(
    "fxManager created",
    "fxManager",
    () => {
      if (!cacheManager || typeof cacheManager.getDimensionCached !== "function") {
        throw new Error("cacheManager.getDimensionCached is not a function");
      }
      if (!levelsManager || typeof levelsManager.getOrbStepTicks !== "function") {
        throw new Error("levelsManager.getOrbStepTicks is not a function");
      }

      return createFxManager(cfg, {
        FX,
        debugEnabled,
        debugState,
        getDimensionCached: cacheManager.getDimensionCached.bind(cacheManager),
        getOrbStepTicks: levelsManager.getOrbStepTicks.bind(levelsManager),
        orbFxBudgetUsed,
        fluxFxInflight,
      });
    }
  );

  // INIT DEBUG: Levels manager (recreate)
  sendInitMessage("§b[Init] Step 5/8: Recreating levelsManager (with spawnLevelUpBurst)...");

  // Recreate levelsManager with spawnLevelUpBurst from FX manager
  // Note: getOrbStepTicks is treated as pure (cfg-only), so fxManager's bound reference still works.
  levelsManager = createOrFail(
    "levelsManager (recreated) created",
    "levelsManager (recreate)",
    () => {
      const spawnLevelUpBurst =
        fxManager && typeof fxManager.spawnLevelUpBurst === "function"
          ? fxManager.spawnLevelUpBurst.bind(fxManager)
          : () => {};

      return createLevelsManager(
        cfg,
        {
          prismCounts,
          transferCounts,
          outputCounts,
          prismLevelsDirty: { set: (v) => { prismLevelsDirty = v; } },
        },
        { spawnLevelUpBurst }
      );
    }
  );

  // INIT DEBUG: Queues manager
  sendInitMessage("§b[Init] Step 6/8: Creating queuesManager...");

  // Create queues manager - manages queue state internally (needed by other managers)
  let queuesManager = createOrFail(
    "queuesManager created and initialized",
    "queuesManager",
    () => {
      if (!cacheManager || typeof cacheManager.resolveContainerInfoCached !== "function") {
        throw new Error("cacheManager.resolveContainerInfoCached is not a function");
      }

      const mgr = createQueuesManager(cfg, {
        cacheManager,
        resolveBlockInfo,
        dropItemAt,
        noteOutputTransfer,
      });

      // Initialize with existing state (if any - for persistence)
      mgr.initializeState(queueByContainer, fullContainers);
      return mgr;
    }
  );


   // INIT DEBUG: Input queues manager
  sendInitMessage("§b[Init] Step 7/8: Creating inputQueuesManager...");

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
    sendInitMessage("§a[Init] ✓ inputQueuesManager created");
  } catch (err) {
    handleManagerCreationError("inputQueuesManager", err);
  }

  // INIT DEBUG: Refinement manager
  sendInitMessage("§b[Init] Step 8/8: Creating refinementManager, finalizeManager, inflightProcessorManager...");

  // Bind queuesManager methods ONCE, but use non-colliding local names
  const enqueuePendingForContainerBound =
    queuesManager && typeof queuesManager.enqueuePendingForContainer === "function"
      ? queuesManager.enqueuePendingForContainer.bind(queuesManager)
      : null;

  const resolveContainerInfoBound =
    queuesManager && typeof queuesManager.resolveContainerInfo === "function"
      ? queuesManager.resolveContainerInfo.bind(queuesManager)
      : null;

  // Create refinement manager - needs fxManager and cacheManager
  let refinementManager;
  try {
    if (!cacheManager || typeof cacheManager.getPrismInventoriesCached !== "function") {
      throw new Error("cacheManager.getPrismInventoriesCached is not a function");
    }
    if (!fxManager || typeof fxManager.enqueueFluxTransferFxPositions !== "function") {
      throw new Error("fxManager.enqueueFluxTransferFxPositions is not a function");
    }
    if (!enqueuePendingForContainerBound) {
      throw new Error("queuesManager.enqueuePendingForContainer is not a function");
    }

    refinementManager = createRefinementManager(cfg, {
      FX,
      cacheManager,
      resolveBlockInfo,
      dropItemAt,
      fxManager,
      enqueuePendingForContainer: enqueuePendingForContainerBound,
    });
    if (!refinementManager) {
      throw new Error("createRefinementManager returned null - check cfg and deps parameters");
    }
    sendInitMessage("§a[Init] ✓ refinementManager created");
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
    if (!enqueuePendingForContainerBound) {
      throw new Error("queuesManager.enqueuePendingForContainer is not a function");
    }
    if (!resolveContainerInfoBound) {
      throw new Error("queuesManager.resolveContainerInfo is not a function");
    }

    finalizeManager = createFinalizeManager(cfg, {
      world,
      FX,
      cacheManager,
      resolveBlockInfo,
      dropItemAt,
      getFilterForBlock,
      enqueuePendingForContainer: enqueuePendingForContainerBound,
      fxManager,
      getContainerKey,
      debugEnabled,
      debugState,
      noteOutputTransfer,
      resolveContainerInfo: resolveContainerInfoBound,
    });
    if (!finalizeManager) {
      throw new Error("createFinalizeManager returned null - check cfg and deps parameters");
    }
    sendInitMessage("§a[Init] ✓ finalizeManager created");
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
    sendInitMessage("§a[Init] ✓ inflightProcessorManager created");
  } catch (err) {
    handleManagerCreationError("inflightProcessorManager", err);
  }

  // INIT DEBUG: All managers created
  sendInitMessage("§a[Init] ✓ All managers created! Controller ready.");

    // Pipeline runner (controller becomes a thin orchestrator)
  const pipeline = createTransferPipeline({
    name: "Transfer",
    phases: [
      {
        name: "Guards",
        warnMs: 10,
        run: (ctx) => {
          // Placeholder (currently inert).
          // Return { stop: true, reason: "..." } to early-out.
        },
      },
      {
        name: "Caches",
        warnMs: 20,
        run: (ctx) => {
          // Placeholder (later: cache update + reset tick caches, etc.)
        },
      },
      {
        name: "InputQueues",
        warnMs: 30,
        run: (ctx) => {
          // Placeholder (later: input queue processing).
        },
      },
      {
        name: "Scan",
        warnMs: 50,
        run: (ctx) => {
          // Placeholder (later: discover + enqueue).
        },
      },
      {
        name: "Inflight",
        warnMs: 30,
        run: (ctx) => {
          // Placeholder (later: inflight tick).
        },
      },
      {
        name: "Persist",
        warnMs: 40,
        run: (ctx) => {
          // Placeholder (later: persistence).
        },
      },
      {
        name: "PostDebug",
        warnMs: 10,
        run: (ctx) => {
          // Placeholder (later: summary stats).
        },
      },
    ],
  });

  const markAdjacentPrismsDirty = createAdjacentPrismDirtyMarker({
    virtualInventoryManager,
    invalidateInput,
    cacheManager,
  });

  unsubscribeEvents = subscribeTransferDirtyEvents({
    world,
    cacheManager,
    markAdjacentPrismsDirty,
    getInventoryContainer,
    isFurnaceBlock,
    logError,
    debugLog: (m) => sendInitMessage("§7" + String(m ?? "")),
    state: controllerState,
  });

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

    // Fast bailouts: avoid any string work / iteration when there are no players.
    let players;
    try {
      players = world.getAllPlayers();
      if (!players || players.length === 0) return;
    } catch {
      return;
    }

    // Only build the string once.
    const msg = String(message ?? "");
    if (!msg) return;

    // Send only to players who can actually see it.
    for (const player of players) {
      try {
        const hasLensDirect = isHoldingLens(player) || isWearingGoggles(player);
        if (!hasLensDirect) continue;

        if (group && !hasExtendedDebug(player, group)) continue;

        const prefix = group ? "§7[EXT] " : "§7";
        player.sendMessage(prefix + msg);
      } catch {}
    }
  }

  function shouldEmitForPrism(prismKey) {
    const tk = getTraceKey();
    if (!tk) return true; // no trace active => normal behaviour
    return prismKey === tk; // trace active => only emit for that prism
  }
  function resetDebugState() {
    const zeroKeys = [
      // Counters
      "inputsScanned",
      "transfersStarted",
      "outputOptionsTotal",
      "outputOptionsMax",
      "orbSpawns",
      "orbFxSkipped",
      "fluxFxSpawns",
      "inputMapReloads",
      "blockLookups",
      "containerLookups",
      "inventoryScans",
      "dpSaves",
      "fluxGenChecks",
      "fluxGenHits",
      "fluxRefineCalls",
      "fluxRefined",
      "fluxMutated",

      // Timings (ms)
      "msCache",
      "msQueues",
      "msInputQueues",
      "msInflight",
      "msFluxFx",
      "msScan",
      "msPersist",
      "msTotal",

      // Balance distribution debug stats
      "balanceTransfers",
      "balanceCancelled",
      "balanceFallback",
      "balanceAmount",
    ];

    for (const k of zeroKeys) debugState[k] = 0;
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
        level = getPrismTier(block);
      } else {
        const perm = block.permutation;
        level = (perm?.getState("chaos:level") | 0) || 1;
      }
    }

    const scale = Math.pow(2, Math.max(0, level - 1));
    const interval = Math.max(1, Math.floor(cfg.perInputIntervalTicks / scale));
    return { intervalTicks: interval, amount: 1 };
  }

  function start() {
    // INIT DEBUG: Start function called
    try {
      const hasLevels = !!levelsManager;
      sendInitMessage("§b[Init] start() called - tickId=" + tickId + ", levelsManager=" + hasLevels);
    } catch {}

    if (tickId !== null) {
      try {
        sendInitMessage("§e[Init] Already started (tickId=" + tickId + ") - skipping");
      } catch {}
      return;
    }

    if (!levelsManager) {
      logError("ERROR: Cannot start - levelsManager is null!", new Error("levelsManager is null"));
      return; // Don't start if levelsManager is null
    }

    // INIT DEBUG: Loading persistence
    sendInitMessage("§b[Init] Loading persistence (inflight, levels)...");

    // Retry loading persistence with exponential backoff (for world load scenarios)
    const maxRetries = 3;
    const retryDelays = [5, 10, 20]; // ticks to wait before retry

    function attemptLoadWithRetry(loadFn, name, retryIndex = 0) {
      // INIT DEBUG: Loading attempt
      try {
        const attemptNum = retryIndex + 1;
        const maxAttempts = maxRetries + 1;
        const nameStr = String(name || "unknown");
        sendInitMessage("§b[Init] Loading " + nameStr + " (attempt " + attemptNum + "/" + maxAttempts + ")...");
      } catch {}

      try {
        loadFn();

        // INIT DEBUG: Success
        try {
          const nameStr = String(name || "unknown");
          sendInitMessage("§a[Init] ✓ " + nameStr + " loaded successfully");
        } catch {}
      } catch (err) {
        if (retryIndex < maxRetries) {
          const delay = retryDelays[retryIndex] || 20;

          // INIT DEBUG: Retrying
          try {
            const nameStr = String(name || "unknown");
            const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
            sendInitMessage("§e[Init] " + nameStr + " failed (" + errMsg + "), retrying in " + delay + " ticks...");
          } catch {}

          // Retry after delay
          try {
            system.runTimeout(() => {
              attemptLoadWithRetry(loadFn, name, retryIndex + 1);
            }, delay);
          } catch {
            logError("Error scheduling retry for " + (name || "unknown"), err);
          }
        } else {
          try {
            const nameStr = String(name || "unknown");
            logError("Error loading " + nameStr + " (after " + maxRetries + " retries)", err);
          } catch {}
        }
      }
    }

    // Attempt to load state with retries
    attemptLoadWithRetry(() => loadInflightState(), "inflight state");
    attemptLoadWithRetry(() => loadLevelsState(), "levels state");
    attemptLoadWithRetry(() => loadOutputLevelsState(), "output levels state");
    attemptLoadWithRetry(() => loadPrismLevelsState(), "prism levels state");

    // INIT DEBUG: Persistence loaded, starting tick loop
    sendInitMessage("§b[Init] Persistence loaded. Starting tick loop (runInterval)...");
    try {
      tickId = system.runInterval(onTick, 1);

      // INIT DEBUG: Tick loop started
      try {
        const inflightLen = (inflight && inflight.length) ? inflight.length : 0;
        const fluxFxLen = (fluxFxInflight && fluxFxInflight.length) ? fluxFxInflight.length : 0;
        sendInitMessage(
          "§a[Init] ✓ Tick loop started! tickId=" +
            tickId +
            ", inflight=" +
            inflightLen +
            ", fluxFxInflight=" +
            fluxFxLen
        );
      } catch {}

      // --- Event-driven invalidation / scanning hooks ---

      // Player places block
      if (
        world.afterEvents &&
        world.afterEvents.playerPlaceBlock &&
        typeof world.afterEvents.playerPlaceBlock.subscribe === "function"
      ) {
        try {
          world.afterEvents.playerPlaceBlock.subscribe((ev) => {
            try {
              const block = ev.block;
              if (!block) return;

              const container = getInventoryContainer(block);
              if (container || isFurnaceBlock(block)) {
                markAdjacentPrismsDirty(
                  block.dimension,
                  block.location,
                  "player_placed_container"
                );

                if (cacheManager && typeof cacheManager.invalidateBlock === "function") {
                  cacheManager.invalidateBlock(block.dimension.id, block.location);
                }
              }
            } catch {}
          });
        } catch (err) {
          logError("Error subscribing to playerPlaceBlock", err);
        }
      }

      // Player breaks block
      if (
        world.afterEvents &&
        world.afterEvents.playerBreakBlock &&
        typeof world.afterEvents.playerBreakBlock.subscribe === "function"
      ) {
        try {
          world.afterEvents.playerBreakBlock.subscribe((ev) => {
            try {
              const loc = ev.block?.location;
              const dim = ev.dimension;
              if (!loc || !dim) return;

              // Breaking containers affects adjacent prisms regardless of type
              markAdjacentPrismsDirty(dim, loc, "player_broke_container");

              if (cacheManager && typeof cacheManager.invalidateBlock === "function") {
                cacheManager.invalidateBlock(dim.id, loc);
              }
            } catch {}
          });
        } catch (err) {
          logError("Error subscribing to playerBreakBlock", err);
        }
      }

      // Entity places block (hoppers, etc.)
      // Note: may not exist in all API versions
      if (
        world.afterEvents &&
        world.afterEvents.entityPlaceBlock &&
        typeof world.afterEvents.entityPlaceBlock.subscribe === "function"
      ) {
        try {
          world.afterEvents.entityPlaceBlock.subscribe((ev) => {
            try {
              const block = ev.block;
              if (!block) return;

              const container = getInventoryContainer(block);
              if (container || isFurnaceBlock(block)) {
                markAdjacentPrismsDirty(
                  block.dimension,
                  block.location,
                  "entity_placed_container"
                );

                if (cacheManager && typeof cacheManager.invalidateBlock === "function") {
                  cacheManager.invalidateBlock(block.dimension.id, block.location);
                }
              }
            } catch {}
          });
        } catch (err) {
          logError("Error subscribing to entityPlaceBlock", err);
        }
      }

      // Debug messages are emitted later via postDebugStats only
    } catch (err) {
      logError("Error starting tick interval", err);
    }
  }

  function stop() {
    if (tickId === null) return;

    try {
      system.clearRun(tickId);
    } catch {}

    tickId = null;

    try {
      if (typeof unsubscribeEvents === "function") {
        unsubscribeEvents();
      }
    } catch {}

    unsubscribeEvents = null;
  }
    function loadInflightState() {
    try {
      // INIT DEBUG
      try {
        sendInitMessage("§b[Init] loadInflightState() called - before load");
      } catch {}

      // Clear any existing inflight state first to prevent stale jobs
      const oldInflightCount = inflight.length;
      const oldFluxFxCount = fluxFxInflight.length; // kept for parity / future logging
      inflight.length = 0;
      fluxFxInflight.length = 0;

      // INIT DEBUG
      try {
        sendInitMessage("§b[Init] Calling loadInflightStateFromWorld...");
      } catch {}

      loadInflightStateFromWorld(world, inflight, cfg);

      // INIT DEBUG
      try {
        const inflightLen = inflight.length || 0;
        sendInitMessage("§b[Init] After loadInflightStateFromWorld: inflight.length=" + inflightLen);
      } catch {}

      // Validate loaded inflight jobs - remove any that are invalid or past the end of their path
      // (they would complete immediately and might create flux FX jobs incorrectly)
      let removedCount = 0;

      for (let i = inflight.length - 1; i >= 0; i--) {
        const job = inflight[i];

        // Invalid job shape
        if (!job || !job.path || !Array.isArray(job.path)) {
          inflight.splice(i, 1);
          removedCount++;
          continue;
        }

        // If job is at or past the end of its path, attempt to finalize, then remove
        if ((job.stepIndex | 0) >= job.path.length) {
          try {
            // finalizeManager should exist by the time start() calls loadInflightState()
            finalizeManager.finalizeJob(job);
          } catch {
            // If finalization fails, just remove it silently
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

      // INIT DEBUG: Always log what we loaded/cleared (unconditional)
      try {
        const inflightLen = inflight.length || 0;
        sendInitMessage(
          "§7[Chaos Transfer] Loaded " +
            inflightLen +
            " inflight jobs (cleared " +
            oldInflightCount +
            ", removed " +
            removedCount +
            " stale)"
        );
      } catch {}

      rebuildReservationsFromInflight();
      inflightDirty = false;
      inflightStepDirty = false;
      lastSaveTick = nowTick;

      // INIT DEBUG
      try {
        sendInitMessage("§a[Init] loadInflightState() completed successfully");
      } catch {}
    } catch (err) {
      // INIT DEBUG
      try {
        const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown error");
        sendInitMessage("§c[Init] loadInflightState() ERROR: " + errMsg);
      } catch {}

      // If loading fails, just start with empty state
      inflight.length = 0;
      fluxFxInflight.length = 0;
      inflightDirty = false;
      inflightStepDirty = false;
      lastSaveTick = nowTick;

      throw err; // Re-throw so start() can catch it
    }
  }

  function persistInflightIfNeeded() {
    if (!inflightDirty && !inflightStepDirty) return;

    // If we’re dirty but empty, persist immediately to clear world state
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

    // Check inflight size - skip save if too large (prevent watchdog)
    // Estimate size: each entry is roughly 500-1000 bytes when stringified
    const estimatedSize = inflight.length * 800;

    if (estimatedSize > 400000) {
      // Avoid template literals to keep message formatting consistent
      sendDiagnosticMessage(
        "[PERF] ⚠ SKIPPING inflight save: Too large (" +
          inflight.length +
          " entries, ~" +
          Math.round(estimatedSize / 1024) +
          "KB)",
        "transfer"
      );

      // Still clear dirty flags to prevent retrying every tick
      inflightDirty = false;
      inflightStepDirty = false;
      lastSaveTick = nowTick;
      return;
    }

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
  function persistCountsIfNeeded(
    getDirty,
    getLastSaveTick,
    setDirty,
    setLastSaveTick,
    countsMap,
    saveFn,
    minInterval = 200
  ) {
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
      (v) => {
        levelsDirty = v;
      },
      (v) => {
        lastLevelsSaveTick = v;
      }
    );
  }

  function persistLevelsIfNeeded() {
    persistCountsIfNeeded(
      () => levelsDirty,
      () => lastLevelsSaveTick,
      (v) => {
        levelsDirty = v;
      },
      (v) => {
        lastLevelsSaveTick = v;
      },
      transferCounts,
      saveInputLevels
    );
  }

  function loadOutputLevelsState() {
    loadCountsState(
      loadOutputLevels,
      outputCounts,
      (v) => {
        outputLevelsDirty = v;
      },
      (v) => {
        lastOutputLevelsSaveTick = v;
      }
    );
  }

  function persistOutputLevelsIfNeeded() {
    persistCountsIfNeeded(
      () => outputLevelsDirty,
      () => lastOutputLevelsSaveTick,
      (v) => {
        outputLevelsDirty = v;
      },
      (v) => {
        lastOutputLevelsSaveTick = v;
      },
      outputCounts,
      saveOutputLevels
    );
  }

  function loadPrismLevelsState() {
    loadCountsState(
      loadPrismLevels,
      prismCounts,
      (v) => {
        prismLevelsDirty = v;
      },
      (v) => {
        lastPrismLevelsSaveTick = v;
      }
    );
  }

  function persistPrismLevelsIfNeeded() {
    persistCountsIfNeeded(
      () => prismLevelsDirty,
      () => lastPrismLevelsSaveTick,
      (v) => {
        prismLevelsDirty = v;
      },
      (v) => {
        lastPrismLevelsSaveTick = v;
      },
      prismCounts,
      savePrismLevels
    );
  }

  // resolveContainerInfo is now provided by queuesManager
  // NOTE: keep this name only if there isn't already a const/let with the same identifier in this scope.
  function resolveContainerInfo(containerKey) {
    return queuesManager.resolveContainerInfo(containerKey);
  }

  // Track tick timing to detect watchdog issues
  let lastTickEndTime = 0;
  let consecutiveLongTicks = 0;
  let emergencyDisableTicks = 0; // Track how many ticks to skip

  function onTick() {
    nowTick++;

    // EMERGENCY SAFEGUARD: Check if previous tick was too long - skip this tick if so
    if (lastTickEndTime > 0) {
      const timeSinceLastTick = Date.now() - lastTickEndTime;

      // If last tick ended more than 50ms ago, we might be in watchdog territory
      // Skip this entire tick to avoid compounding the problem
      if (timeSinceLastTick > 50 && consecutiveLongTicks > 2) {
        consecutiveLongTicks++;

        if ((consecutiveLongTicks % 10) === 0) {
          try {
            const players = world.getAllPlayers();
            for (const player of players) {
              if (player && typeof player.sendMessage === "function") {
                player.sendMessage(
                  "§c[PERF] ⚠⚠⚠ EMERGENCY SKIP: " +
                    consecutiveLongTicks +
                    " consecutive long ticks detected, skipping tick " +
                    nowTick
                );
                break;
              }
            }
          } catch {}
        }

        lastTickEndTime = Date.now();
        return; // Skip entire tick to avoid watchdog
      }
    }

    // Optional startup ping (only visible to players with lens/goggles + extended debug group "transfer")
    if (nowTick <= 5) {
      sendDiagnosticMessage("[Init] onTick() running (tick=" + nowTick + ")", "transfer");
    }

    const tickStart = Date.now();

    // --- CACHES phase ---
    const cacheStart = Date.now();
    cacheManager.updateTick(nowTick);
    cacheManager.resetTickCaches();

    const cacheTime = Date.now() - cacheStart;
    if (debugEnabled) {
      debugState.msCache = (debugState.msCache || 0) + cacheTime;
    }

    orbFxBudgetUsed.value = 0;

    // PERF: Log cache update timing if it's slow (>5ms) or every 200 ticks
    if (cacheTime > 5 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage("[PERF] Cache: " + cacheTime + "ms", "transfer");
    }

    // Process existing queues and in-flight transfers first
    const queuesStart = Date.now();

    // Local helper to avoid duplicating perf logging patterns.
    // Keep name unique to avoid collisions in this giant scope.
    function _perfLogIfNeeded(label, ms, extra) {
      if (ms > 10 || ((nowTick % 200) === 0 && nowTick > 0)) {
        if (extra) {
          sendDiagnosticMessage("[PERF] " + label + ": " + ms + "ms (" + extra + ")", "transfer");
        } else {
          sendDiagnosticMessage("[PERF] " + label + ": " + ms + "ms", "transfer");
        }
      }
    }

    // --- QUEUES + INFLIGHT phase ---
    if (debugEnabled) {
      runTransferPipeline([
        () => {
          const t0 = Date.now();
          queuesManager.tickOutputQueues();
          queuesManager.tickFullContainers();
          const queueTime = Date.now() - t0;

          debugState.msQueues += queueTime;
          _perfLogIfNeeded("OutputQueues", queueTime, null);
        },
        () => {
          const t1 = Date.now();
          const result = inflightProcessorManager.tickInFlight(inflight, nowTick);

          if (result) {
            inflightDirty = result.inflightDirty || inflightDirty;
            inflightStepDirty = result.inflightStepDirty || inflightStepDirty;
          }

          const inflightTime = Date.now() - t1;
          debugState.msInflight += inflightTime;

          _perfLogIfNeeded("Inflight", inflightTime, String(inflight.length) + " jobs");
        },
        () => {
          const t2 = Date.now();
          inflightProcessorManager.tickFluxFxInFlight(fluxFxInflight, debugState);
          const fluxFxTime = Date.now() - t2;

          debugState.msFluxFx += fluxFxTime;

          _perfLogIfNeeded("FluxFX", fluxFxTime, String(fluxFxInflight.length) + " jobs");
        },
      ]);
    } else {
      const queueStart = Date.now();
      queuesManager.tickOutputQueues();
      queuesManager.tickFullContainers();
      const queueTime = Date.now() - queueStart;

      _perfLogIfNeeded("OutputQueues", queueTime, null);

      const inflightStart = Date.now();
      const result = inflightProcessorManager.tickInFlight(inflight, nowTick);

      if (result) {
        inflightDirty = result.inflightDirty || inflightDirty;
        inflightStepDirty = result.inflightStepDirty || inflightStepDirty;
      }

      const inflightTime = Date.now() - inflightStart;
      _perfLogIfNeeded("Inflight", inflightTime, String(inflight.length) + " jobs");

      const fluxFxStart = Date.now();
      inflightProcessorManager.tickFluxFxInFlight(fluxFxInflight, debugState);
      const fluxFxTime = Date.now() - fluxFxStart;

      _perfLogIfNeeded("FluxFX", fluxFxTime, String(fluxFxInflight.length) + " jobs");
    }

    const queuesTotalTime = Date.now() - queuesStart;
    if (queuesTotalTime > 20 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage(
        "[PERF] Queues+Inflight Total: " + queuesTotalTime + "ms",
        "transfer"
      );
    }
    const virtualInvStart = Date.now();

    try {
      if (!virtualInventoryManager || typeof virtualInventoryManager.updateState !== "function") {
        // No virtual inventory manager available - nothing to do
      } else {
        const queueState = queuesManager.getState();

        // Get input queues for virtual inventory (if available)
        let inputQueueByPrism = null;

        const prismKeysStart = Date.now();
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

        const prismKeysTime = Date.now() - prismKeysStart;
        if (prismKeysTime > 10 || ((nowTick % 200) === 0 && nowTick > 0)) {
          sendDiagnosticMessage(
            "[PERF] GetPrismKeys (virtualInv): " + prismKeysTime + "ms",
            "transfer"
          );
        }

        const updateStart = Date.now();
        virtualInventoryManager.updateState(inflight, queueState.queueByContainer, inputQueueByPrism);
        const updateTime = Date.now() - updateStart;

        if (updateTime > 10 || ((nowTick % 200) === 0 && nowTick > 0)) {
          sendDiagnosticMessage(
            "[PERF] VirtualInv.updateState: " + updateTime + "ms",
            "transfer"
          );
        }
      }
    } catch (err) {
      const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
      sendInitMessage("§c[Flow] Tick " + nowTick + ": ERROR in virtual inventory update: " + errMsg);
    }

    const virtualInvTime = Date.now() - virtualInvStart;
    if (virtualInvTime > 15 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage("[PERF] VirtualInv Total: " + virtualInvTime + "ms", "transfer");
    }
        const inputQueueStart = Date.now();
    let inputQueueProcessed = 0;
    let inputQueueTransferBudget = cfg.maxTransfersPerTick;
    let inputQueueSearchBudget = cfg.maxSearchesPerTick;
    let inputQueueTransfersThisTick = 0;
    let inputQueueMaxEntryTime = 0; // Track max time for a single queue entry processing
    let inputQueueTotalEntries = 0; // Count total entries processed

    // Aggregate failures by reason and item for summary logging (reduce spam)
    const failureCounts = new Map(); // Map<"reason:itemType", count>

    // DIAGNOSTIC: Log queue status (disabled - was too spammy, use extended debug instead)
    // Removed per-tick queue status logging to reduce chat spam

    if (inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function") {
      const totalQueueSize = inputQueuesManager.getTotalQueueSize();

      // Process input queues if they exist
      if (totalQueueSize > 0) {
        // Only log queue status occasionally (every 200 ticks) to reduce clutter
        const shouldLogQueueStatus = (nowTick <= 3 || (nowTick % 200) === 0);
        if (shouldLogQueueStatus) {
          sendDiagnosticMessage("[Queue] Active: " + totalQueueSize + " queues", "transfer");
        }

        const prismKeys = getPrismKeys();
        if (prismKeys.length > 0) {
          // Process queues for prisms that have them
          for (const prismKey of prismKeys) {
            if (inputQueueTransferBudget <= 0 && inputQueueSearchBudget <= 0) {
              // Only log budget exhaustion occasionally
              if ((nowTick % 100) === 0) {
                sendDiagnosticMessage(
                  "[Queue] Budget exhausted: transfer=" +
                    inputQueueTransferBudget +
                    ", search=" +
                    inputQueueSearchBudget,
                  "transfer"
                );
              }
              break;
            }

            if (!inputQueuesManager.hasQueueForPrism(prismKey)) continue;

            // Don't log every prism processing - too spammy

            const prismInfo = resolveBlockInfo(prismKey);
            if (!prismInfo) continue;

            const dim = prismInfo.dim;
            const prismBlock = prismInfo.block;
            if (!prismBlock || !isPrismBlock(prismBlock)) continue;

            // Apply tier-based transfer interval (conservative scaling for performance)
            // Higher tiers = faster checks (fewer ticks between transfers)
            // Formula uses conservative scaling to avoid performance impact
            const prismTier = getPrismTier(prismBlock);
            const baseInterval = cfg.perPrismIntervalTicks || 5; // Base for tier 5
            // Conservative tier scaling: interval = baseInterval * (7 - tier * 1.2)
            // This gives: T1=~23, T2=~18, T3=~13, T4=~8, T5=5 ticks
            const tierInterval = Math.max(1, Math.floor(baseInterval * (7 - prismTier * 1.2)));

            const allowedAt = nextQueueTransferAllowed.has(prismKey)
              ? nextQueueTransferAllowed.get(prismKey)
              : 0;

            if (nowTick < allowedAt) {
              // Prism is on cooldown - skip this tick
              continue;
            }

            // Get filter for this prism
            const filter = getFilterForBlock(prismBlock);
            const filterSet = filter
              ? (filter instanceof Set ? filter : getFilterSet(filter))
              : null;

            // For filtered prisms, reduce interval further to extract non-filtered items faster
            const isFilteredPrism = !!(filterSet && filterSet.size > 0);
            const effectiveInterval = isFilteredPrism
              ? Math.max(1, Math.floor(tierInterval * 0.6))
              : tierInterval;

            // For filtered prisms, allow processing multiple entries per tick
            const maxEntriesPerTick = isFilteredPrism ? 3 : 1;
            let entriesProcessedThisPrism = 0;

            // Track consecutive failures to prevent infinite loops
            let consecutiveFailures = 0;
            const maxConsecutiveFailures = 5;

            // Get inventories for this prism (do this once outside the loop)
            const inventories = cacheManager.getPrismInventoriesCached(prismKey, prismBlock, dim);
            if (!inventories || inventories.length === 0) continue;

            // Process multiple entries for filtered prisms, single entry for others
            const prismQueueStart = Date.now();

            while (
              entriesProcessedThisPrism < maxEntriesPerTick &&
              inputQueueTransferBudget > 0 &&
              inputQueueSearchBudget > 0 &&
              inputQueuesManager.hasQueueForPrism(prismKey) &&
              consecutiveFailures < maxConsecutiveFailures
            ) {
              const entryStart = Date.now();
              inputQueueTotalEntries++;

              // Get next queue entry for this prism
              const queueEntry = inputQueuesManager.getNextQueueEntry(prismKey, filterSet);
              if (!queueEntry) {
                // No more entries for this prism
                break;
              }

              // Validate queue entry
              const isValid = inputQueuesManager.validateInputQueue(queueEntry, nowTick);
              if (!isValid) {
                // Entry invalid - remove and try next
                inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
                consecutiveFailures++;
                continue;
              }

              // Reset failure counter on valid entry
              consecutiveFailures = 0;

              // Find the item source from the queue entry
              let itemSource = null;

              for (const inv of inventories) {
                if (!inv.container) continue;

                const containerKey = getContainerKey(inv.entity || inv.block);
                if (containerKey !== queueEntry.containerKey) continue;

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

              if (!itemSource || !itemSource.stack) {
                // Item no longer in slot - invalidate queue entry and try next
                inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
                consecutiveFailures++;
                continue;
              }

              // Reset failure counter on valid item source
              consecutiveFailures = 0;

              // Use cached route if available, otherwise find new route
              let route = queueEntry.cachedRoute;
              let destinationKey = queueEntry.lastDestination;

              if (!route || route.length === 0 || !destinationKey) {
                // Need to find route
                if (inputQueueSearchBudget <= 0) {
                  // Out of search budget - break to allow other prisms to process
                  break;
                }

                const pathfindStart = Date.now();
                let pathResult = null;

                try {
                  pathResult = findPathForInput(prismKey, nowTick);

                  const pathfindTime = Date.now() - pathfindStart;
                  if (pathfindTime > 50 || ((nowTick % 200) === 0 && nowTick > 0)) {
                    sendDiagnosticMessage(
                      "[PERF] Pathfind (queue): " + pathfindTime + "ms for " + prismKey,
                      "transfer"
                    );
                  }

                  // EMERGENCY: If pathfinding takes too long, abort and skip
                  if (pathfindTime > 100) {
                    sendDiagnosticMessage(
                      "[PERF] ⚠ Pathfind TIMEOUT (queue): " + pathfindTime + "ms - aborting for " + prismKey,
                      "transfer"
                    );
                    inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
                    consecutiveFailures++;
                    continue;
                  }
                } catch (err) {
                  const pathfindTime = Date.now() - pathfindStart;
                  sendDiagnosticMessage(
                    "[PERF] Pathfind ERROR (queue) after " +
                      pathfindTime +
                      "ms: " +
                      ((err && err.message) ? String(err.message) : String(err)),
                    "transfer"
                  );
                  inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
                  consecutiveFailures++;
                  continue;
                }

                if (!pathResult || !Array.isArray(pathResult) || pathResult.length === 0) {
                  // No route found - invalidate entry and try next
                  inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
                  consecutiveFailures++;
                  continue;
                }

                // Reset failure counter on route found
                consecutiveFailures = 0;

                const pickStart = Date.now();

                // Pick a destination from the path results (prioritize filtered prisms that match this item)
                const pick = pickWeightedRandomWithBias(pathResult, (opt) => {
                  const type = opt?.outputType || "prism";
                  if (isFluxTypeId(itemSource.stack.typeId) && type === "crystal") return CRYSTAL_FLUX_WEIGHT;

                  // Prioritize filtered prisms that match this item (20x weight)
                  if (type === "prism" && opt?.outputKey) {
                    const targetInfo = resolveBlockInfo(opt.outputKey);
                    if (targetInfo?.block && isPrismBlock(targetInfo.block)) {
                      const targetFilter = getFilterForBlock(targetInfo.block);
                      const targetFilterSet = targetFilter
                        ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter))
                        : null;

                      if (
                        targetFilterSet &&
                        targetFilterSet.size > 0 &&
                        targetFilterSet.has(itemSource.stack.typeId)
                      ) {
                        return 20.0;
                      }
                    }
                  }

                  return 1.0;
                });

                const pickTime = Date.now() - pickStart;
                if (pickTime > 20) {
                  sendDiagnosticMessage(
                    "[PERF] Pick destination (queue): " +
                      pickTime +
                      "ms (" +
                      pathResult.length +
                      " candidates)",
                    "transfer"
                  );
                }

                if (pick && Array.isArray(pick.path) && pick.path.length > 0) {
                  route = pick.path;
                  destinationKey = pick.outputKey;

                  inputQueuesManager.setCachedRoute(prismKey, queueEntry.itemTypeId, route);
                  queueEntry.lastDestination = destinationKey;
                } else {
                  // No valid pick - invalidate and try next entry
                  inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
                  consecutiveFailures++;
                  continue;
                }

                inputQueueSearchBudget--;
              }

              // Get destination info
              const destInfo = resolveBlockInfo(destinationKey);
              if (!destInfo || !destInfo.block) {
                // Destination invalid - clear route and try next entry
                queueEntry.cachedRoute = null;
                queueEntry.lastDestination = null;
                consecutiveFailures++;
                continue;
              }

              // Reset failure counter on valid destination
              consecutiveFailures = 0;

              // Attempt transfer using the queue entry
              const transferStart = Date.now();
              let transferResult;

              try {
                transferResult = attemptPushTransferWithDestination(
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
              } catch (err) {
                // ALWAYS log errors - these are important
                const errorMsg = (err && err.message) ? String(err.message) : String(err || "unknown error");
                sendDiagnosticMessage(
                  "[Queue] Transfer ERROR: prism=" +
                    prismKey +
                    ", item=" +
                    queueEntry.itemTypeId +
                    ", error=" +
                    errorMsg,
                  "transfer"
                );
                transferResult = { ...makeResult(false, "transfer_error"), amount: 0, searchesUsed: 0 };
              }

              const transferTime = Date.now() - transferStart;

              const entryTime = Date.now() - entryStart;
              if (entryTime > inputQueueMaxEntryTime) inputQueueMaxEntryTime = entryTime;

              if (entryTime > 50 || transferTime > 30) {
                sendDiagnosticMessage(
                  "[PERF] Queue Entry: " + entryTime + "ms total (transfer: " + transferTime + "ms)",
                  "transfer"
                );
              }

              if (transferResult.ok) {
                inputQueueTransfersThisTick++;
                inputQueueTransferBudget--;
                inputQueueSearchBudget -= transferResult.searchesUsed || 0;

                // Update queue entry with transferred amount
                inputQueuesManager.updateQueueEntry(
                  prismKey,
                  queueEntry.itemTypeId,
                  transferResult.amount || 1
                );

                inputQueueProcessed++;
                entriesProcessedThisPrism++;
                consecutiveFailures = 0;

                // Set cooldown for this prism based on tier and filter status
                nextQueueTransferAllowed.set(prismKey, nowTick + effectiveInterval);

                // For filtered prisms, continue trying next entry
              } else {
                inputQueueSearchBudget -= transferResult.searchesUsed || 0;
                consecutiveFailures++;

                // Aggregate failures for summary logging (reduce spam)
                const reason = transferResult.reason || "unknown";
                const failureKey = reason + ":" + queueEntry.itemTypeId;
                failureCounts.set(failureKey, (failureCounts.get(failureKey) || 0) + 1);

                // Only log transfer_error immediately (these are critical)
                if (reason === "transfer_error") {
                  sendDiagnosticMessage(
                    "[Queue] Transfer ERROR: reason=" + reason + ", item=" + queueEntry.itemTypeId,
                    "transfer"
                  );
                }

                // Unfiltered prisms: process one entry per tick, or too many failures
                if (!isFilteredPrism || consecutiveFailures >= maxConsecutiveFailures) {
                  break;
                }
              }
            } // End while (entries per prism)

            const prismQueueTime = Date.now() - prismQueueStart;
            if (prismQueueTime > 100) {
              sendDiagnosticMessage(
                "[PERF] Prism Queue (" + prismKey + "): " + prismQueueTime + "ms (" + entriesProcessedThisPrism + " entries)",
                "transfer"
              );
            }
          } // End for (prismKey)
        } // End if (prismKeys.length > 0)
      } // End if (totalQueueSize > 0)
      // Summary: Log queue processing results only when significant changes occur (reduced frequency)
      if (totalQueueSize > 0) {
        const finalQueueSize = inputQueuesManager.getTotalQueueSize();

        // Log summary only every 200 ticks, or if queue size changed significantly (>75% reduction)
        const shouldLogSummary =
          ((nowTick % 200) === 0) ||
          (inputQueueTransfersThisTick > 0 &&
            (totalQueueSize - finalQueueSize) > (totalQueueSize * 0.75));

        if (shouldLogSummary) {
          // Simplified summary - only show essential info
          sendDiagnosticMessage(
            "[Queue] " + finalQueueSize + " remaining (" + inputQueueTransfersThisTick + " transferred)",
            "transfer"
          );
          failureCounts.clear(); // Clear for next summary period
        }
      }
    } else {
      // Don't log when no queues exist - too spammy (only extended debug if needed)
      // if ((nowTick % 100) === 0) {
      //   sendDiagnosticMessage("[Queue] No active queues", "transfer");
      // }
    }

    const inputQueueTime = Date.now() - inputQueueStart;
    if (debugEnabled) {
      debugState.msInputQueues = (debugState.msInputQueues || 0) + inputQueueTime;
    }

    if (inputQueueTime > 100 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage(
        "[PERF] InputQueues Total: " +
          inputQueueTime +
          "ms (" +
          inputQueueTotalEntries +
          " entries, max entry: " +
          inputQueueMaxEntryTime +
          "ms, transfers: " +
          inputQueueTransfersThisTick +
          ")",
        "transfer"
      );
    }

    // --- SCAN phase ---
    // PHASE 4: Lazy scanning - only scan when input queues are empty (or dirty prisms exist)
    const scanStart = Date.now();
    let scanTotalTime = 0; // Initialize to avoid undefined if we return early

    const prismKeys = getPrismKeys();

    // Fast exit: no prisms => no scan possible; still persist + post-debug
    if (prismKeys.length === 0) {
      scanTotalTime = Date.now() - scanStart;

      const timeBeforePersist = Date.now() - tickStart;
      const shouldSkipSaves = timeBeforePersist > 80;

      // --- PERSIST phase (early-exit path) ---
      const persistStart = Date.now();
      let inflightSaveTime = 0;
      let levelsSaveTime = 0;
      let outputLevelsSaveTime = 0;
      let prismLevelsSaveTime = 0;

      if (!shouldSkipSaves) {
        const inflightSaveStart = Date.now();
        persistInflightIfNeeded();
        inflightSaveTime = Date.now() - inflightSaveStart;
        if (inflightSaveTime > 30) {
          sendDiagnosticMessage("[PERF] persistInflightIfNeeded: " + inflightSaveTime + "ms", "transfer");
        }

        const levelsSaveStart = Date.now();
        persistLevelsIfNeeded();
        levelsSaveTime = Date.now() - levelsSaveStart;
        if (levelsSaveTime > 30) {
          sendDiagnosticMessage("[PERF] persistLevelsIfNeeded: " + levelsSaveTime + "ms", "transfer");
        }

        const outputLevelsSaveStart = Date.now();
        persistOutputLevelsIfNeeded();
        outputLevelsSaveTime = Date.now() - outputLevelsSaveStart;
        if (outputLevelsSaveTime > 30) {
          sendDiagnosticMessage("[PERF] persistOutputLevelsIfNeeded: " + outputLevelsSaveTime + "ms", "transfer");
        }

        const prismLevelsSaveStart = Date.now();
        persistPrismLevelsIfNeeded();
        prismLevelsSaveTime = Date.now() - prismLevelsSaveStart;
        if (prismLevelsSaveTime > 30) {
          sendDiagnosticMessage("[PERF] persistPrismLevelsIfNeeded: " + prismLevelsSaveTime + "ms", "transfer");
        }
      } else {
        sendDiagnosticMessage(
          "[PERF] ⚠ SKIPPING SAVES: Tick already at " + timeBeforePersist + "ms (>80ms threshold)",
          "transfer"
        );
      }

      const persistTime = Date.now() - persistStart;

      // --- POST DEBUG phase (early-exit path) ---
      if (debugEnabled) {
        debugState.msPersist += persistTime;
        debugState.msTotal += (Date.now() - tickStart);

        try {
          postDebugStats(prismKeys.length);
        } catch (err) {
          sendInitMessage(
            "§c[Chaos Transfer] Error in postDebugStats: " +
              ((err && err.message) ? String(err.message) : String(err))
          );
        }
      }

      if (persistTime > 50 || ((nowTick % 200) === 0 && nowTick > 0)) {
        sendDiagnosticMessage(
          "[PERF] Persist Total: " +
            persistTime +
            "ms (Inflight: " +
            inflightSaveTime +
            "ms | InputLevels: " +
            levelsSaveTime +
            "ms | OutputLevels: " +
            outputLevelsSaveTime +
            "ms | PrismLevels: " +
            prismLevelsSaveTime +
            "ms)",
          "transfer"
        );
      }

      if (persistTime > 100) {
        sendDiagnosticMessage(
          "[PERF] ⚠⚠⚠ WATCHDOG RISK: Persistence took " + persistTime + "ms (>100ms)",
          "transfer"
        );
      }

      const tickTotalTime = Date.now() - tickStart;

      if (tickTotalTime > 80 || ((nowTick % 200) === 0 && nowTick > 0)) {
        sendDiagnosticMessage(
          "[PERF] ⚠ TICK TOTAL: " +
            tickTotalTime +
            "ms (Cache: " +
            cacheTime +
            "ms | Queues+Inflight: " +
            queuesTotalTime +
            "ms | VirtualInv: " +
            virtualInvTime +
            "ms | InputQueues: " +
            inputQueueTime +
            "ms | Scan: " +
            scanTotalTime +
            "ms | Persist: " +
            persistTime +
            "ms)",
          "transfer"
        );
      }

      if (tickTotalTime > 100) {
        sendDiagnosticMessage(
          "[PERF] ⚠⚠⚠ WATCHDOG RISK: Tick took " + tickTotalTime + "ms (>100ms threshold)",
          "transfer"
        );
      }

      return;
    }
        // --- SCAN phase ---
    // Always scan to discover new items, but throttle scanning when queues are active.

    // Get fresh queue size for scanning decision
    const scanQueueSize =
      (inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function")
        ? inputQueuesManager.getTotalQueueSize()
        : 0;

    const hasActiveQueues = scanQueueSize > 0;

    // Get dirty prisms (if virtual inventory supports it)
    let dirtyPrisms = null;
    let dirtyPrismsCount = 0;

    if (virtualInventoryManager && typeof virtualInventoryManager.getDirtyPrisms === "function") {
      dirtyPrisms = virtualInventoryManager.getDirtyPrisms();
      dirtyPrismsCount = dirtyPrisms ? dirtyPrisms.size : 0;
    }

    // Reduce scan budget if queues are active (prioritize queue processing)
    // But still allow some scanning to discover new items.
    const baseScanLimit = Math.max(1, cfg.maxPrismsScannedPerTick | 0);
    const scanLimitWhenQueuesActive = Math.max(1, Math.floor(baseScanLimit * 0.3)); // 30% when queues active

    // Only log scan start occasionally to reduce clutter (every 200 ticks or first 3 ticks)
    if (nowTick <= 3 || (nowTick % 200) === 0) {
      sendDiagnosticMessage(
        "[Scan] queues=" + scanQueueSize + ", dirty=" + dirtyPrismsCount + ", activeQueues=" + hasActiveQueues,
        "transfer"
      );
    }

    // Prioritize dirty prisms if they exist, otherwise scan normally.
    const scanDirtyOnly = dirtyPrismsCount > 0;

    // NOTE: When scanning only dirty prisms, cap budget to both config + dirty count.
    const dirtyScanBudget = scanDirtyOnly
      ? Math.min((cfg.maxPrismsScannedPerTick || 8), dirtyPrismsCount)
      : Infinity;

    if (cursor >= prismKeys.length) cursor = 0;

    let scanned = 0;
    let transferBudget = cfg.maxTransfersPerTick;
    let searchBudget = cfg.maxSearchesPerTick;
    let transfersThisTick = 0;

    // Determine scan limit and which prisms to scan
    let prismsToScan = null;
    let scanLimit = 0;

    if (scanDirtyOnly && dirtyPrisms && dirtyPrisms.size > 0) {
      // Scan only dirty prisms (prioritize them)
      prismsToScan = Array.from(dirtyPrisms);
      scanLimit = Math.min(dirtyScanBudget, prismsToScan.length);
    } else {
      // Scan all prisms, but reduce limit if queues are active (to prioritize queue processing)
      prismsToScan = prismKeys;

      const effectiveScanLimit = hasActiveQueues ? scanLimitWhenQueuesActive : baseScanLimit;
      scanLimit = Math.min(prismKeys.length, Math.max(1, effectiveScanLimit));
    }

    let scanLoopMaxPrismTime = 0;
    const scanLoopStart = Date.now();

    while (
      (transferBudget > 0 || searchBudget > 0) &&
      scanned < scanLimit &&
      scanned < prismsToScan.length
    ) {
      const prismKey = prismsToScan[scanDirtyOnly ? scanned : (cursor % prismsToScan.length)];

      if (!scanDirtyOnly) {
        cursor = (cursor + 1) % prismsToScan.length;
      }

      scanned++;

      // Clear dirty flag after scanning (if virtual inventory supports it)
      if (
        scanDirtyOnly &&
        virtualInventoryManager &&
        typeof virtualInventoryManager.clearPrismDirty === "function"
      ) {
        virtualInventoryManager.clearPrismDirty(prismKey);
      }

      const allowedAt = nextAllowed.has(prismKey) ? nextAllowed.get(prismKey) : 0;
      if (nowTick < allowedAt) {
        continue;
      }

      // Process multiple items from the same prism - continue until no more items or budgets exhausted
      // This ensures prisms continue balancing items after finishing one transfer
      let itemsProcessedFromPrism = 0;
      const maxItemsPerPrismPerTick = 5; // Process up to 5 items per prism per scan cycle

      let consecutiveFailuresForPrism = 0;
      const maxConsecutiveFailuresForPrism = 3; // Move to next prism after 3 consecutive failures

      const prismStart = Date.now();
      // Helper: compute per-prism interval (with getSpeed fallback)
      function getPrismIntervalTicksForKey(prismKeyLocal) {
        const info = resolveBlockInfo(prismKeyLocal);
        let interval = cfg.perPrismIntervalTicks;

        if (info && info.block) {
          const s = getSpeed(info.block);
          interval = Math.max(
            1,
            (s && s.intervalTicks) ? s.intervalTicks : cfg.perPrismIntervalTicks
          );
        }

        return interval;
      }

      while (
        itemsProcessedFromPrism < maxItemsPerPrismPerTick &&
        (transferBudget > 0 || searchBudget > 0) &&
        consecutiveFailuresForPrism < maxConsecutiveFailuresForPrism
      ) {
        // Attempt transfer with budgeted searches
        const transferForPrismStart = Date.now();
        const result = attemptTransferForPrism(prismKey, searchBudget);
        const transferForPrismTime = Date.now() - transferForPrismStart;

        if (transferForPrismTime > 100 || (itemsProcessedFromPrism === 0 && (nowTick % 200) === 0)) {
          sendDiagnosticMessage(
            "[PERF] attemptTransferForPrism (" +
              prismKey +
              "): " +
              transferForPrismTime +
              "ms (" +
              ((result && result.searchesUsed) ? result.searchesUsed : 0) +
              " searches, item #" +
              (itemsProcessedFromPrism + 1) +
              ")",
            "transfer"
          );
        }

        const searchesUsed = (result && result.searchesUsed) ? result.searchesUsed : 0;
        searchBudget -= searchesUsed;

        const didTransfer = !!(result && result.ok);
        if (didTransfer) {
          transfersThisTick++;
          transferBudget--;
          itemsProcessedFromPrism++;
          consecutiveFailuresForPrism = 0;

          // Clear backoff on successful transfer
          clearBackoff(prismKey);

          // Continue scanning this prism to find more items (cooldown set after loop)
        } else {
          consecutiveFailuresForPrism++;

          const reason = result ? result.reason : undefined;

          // On failure, check reason to decide if we should continue or move on
          if (reason === "all_items_already_queued") {
            // Normal/expected: queue processing handles these items
            consecutiveFailuresForPrism = Math.max(0, consecutiveFailuresForPrism - 1);

            // Minimal cooldown - allow checking for new items soon
            nextAllowed.set(prismKey, nowTick + 1);
            break;
          }

          if (reason === "no_item" || reason === "no_transfer") {
            // No items found - set cooldown with backoff and move on
            let interval = getPrismIntervalTicksForKey(prismKey);

            const level = bumpBackoff(prismKey);
            interval += getBackoffTicks(level);

            nextAllowed.set(prismKey, nowTick + interval);
            break;
          }

          if (reason === "full" || reason === "no_options" || reason === "no_search_budget") {
            // Temporary failures - retry until failure limit
            if (consecutiveFailuresForPrism >= maxConsecutiveFailuresForPrism) {
              let interval = getPrismIntervalTicksForKey(prismKey);

              const level = bumpBackoff(prismKey);
              interval += getBackoffTicks(level);

              nextAllowed.set(prismKey, nowTick + interval);
              break;
            }

            // Otherwise continue trying this prism (budgets permitting)
          } else if (reason === "pathfind_timeout" || reason === "pathfind_error") {
            // Pathfinding failed - short cooldown and move on
            nextAllowed.set(prismKey, nowTick + 10);
            break;
          } else {
            // Unknown failure - minimal cooldown and keep trying (do not break)
            // (No cooldown set here; handled after loop if still unset.)
          }
        }

        // If budgets exhausted, break from inner loop
        if (transferBudget <= 0 && searchBudget <= 0) break;
      }

      // After processing items from this prism, set cooldown based on results
      // CRITICAL FIX: If items were successfully processed/queued, use minimal cooldown (1 tick)
      if (itemsProcessedFromPrism > 0) {
        // Successful processing => minimal cooldown so balancing continues continuously
        nextAllowed.set(prismKey, nowTick + 1);

        if ((nowTick % 50) === 0) {
          sendDiagnosticMessage(
            "[Scan] Prism " +
              prismKey +
              ": processed " +
              itemsProcessedFromPrism +
              " item(s), cooldown=1 tick (continuous processing)",
            "transfer"
          );
        }
      } else if (!nextAllowed.has(prismKey)) {
        // No items processed and no cooldown set - set normal cooldown
        const interval = getPrismIntervalTicksForKey(prismKey);
        nextAllowed.set(prismKey, nowTick + interval);
      }
      // If cooldown was already set (from failure above), keep it

      const prismTime = Date.now() - prismStart;
      if (prismTime > scanLoopMaxPrismTime) {
        scanLoopMaxPrismTime = prismTime;
      }

      if (itemsProcessedFromPrism > 0) {
        if (nowTick <= 3 || (nowTick % 100) === 0) {
          sendDiagnosticMessage(
            "[Scan] Prism " + prismKey + ": processed " + itemsProcessedFromPrism + " item(s)",
            "transfer"
          );
        }
      }

      // If we're out of budgets, stop scanning
      if (transferBudget <= 0 && searchBudget <= 0) break;
    }

    const scanLoopTime = Date.now() - scanLoopStart;
    if (scanLoopTime > 200 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage(
        "[PERF] Scan Loop: " +
          scanLoopTime +
          "ms (" +
          scanned +
          " prisms, max prism: " +
          scanLoopMaxPrismTime +
          "ms, transfers: " +
          transfersThisTick +
          ")",
        "transfer"
      );
    }
    scanTotalTime = Date.now() - scanStart;

    if (debugEnabled) {
      debugState.inputsScanned += scanned;
      debugState.transfersStarted += transfersThisTick;
      debugState.msScan += scanTotalTime;
    }

    if (scanTotalTime > 200 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage(
        "[PERF] Scan Total: " + scanTotalTime + "ms (" + scanned + " prisms)",
        "transfer"
      );
    }

    // Check if we're already over time budget before attempting saves.
    // Skip non-critical saves if tick is taking too long to avoid watchdog.
    const timeBeforePersist = Date.now() - tickStart;
    const shouldSkipSaves = timeBeforePersist > 80; // Skip saves if already over 80ms

    const persistStart = Date.now();
    let inflightSaveTime = 0;
    let levelsSaveTime = 0;
    let outputLevelsSaveTime = 0;
    let prismLevelsSaveTime = 0;

    if (!shouldSkipSaves) {
      const inflightSaveStart = Date.now();
      persistInflightIfNeeded();
      inflightSaveTime = Date.now() - inflightSaveStart;
      if (inflightSaveTime > 30) {
        sendDiagnosticMessage("[PERF] persistInflightIfNeeded: " + inflightSaveTime + "ms", "transfer");
      }

      const levelsSaveStart = Date.now();
      persistLevelsIfNeeded();
      levelsSaveTime = Date.now() - levelsSaveStart;
      if (levelsSaveTime > 30) {
        sendDiagnosticMessage("[PERF] persistLevelsIfNeeded: " + levelsSaveTime + "ms", "transfer");
      }

      const outputLevelsSaveStart = Date.now();
      persistOutputLevelsIfNeeded();
      outputLevelsSaveTime = Date.now() - outputLevelsSaveStart;
      if (outputLevelsSaveTime > 30) {
        sendDiagnosticMessage("[PERF] persistOutputLevelsIfNeeded: " + outputLevelsSaveTime + "ms", "transfer");
      }

      const prismLevelsSaveStart = Date.now();
      persistPrismLevelsIfNeeded();
      prismLevelsSaveTime = Date.now() - prismLevelsSaveStart;
      if (prismLevelsSaveTime > 30) {
        sendDiagnosticMessage("[PERF] persistPrismLevelsIfNeeded: " + prismLevelsSaveTime + "ms", "transfer");
      }
    } else {
      // Tick already taking too long - skip saves to avoid watchdog
      sendDiagnosticMessage(
        "[PERF] ⚠ SKIPPING SAVES: Tick already at " + timeBeforePersist + "ms (>80ms threshold)",
        "transfer"
      );
    }

    const persistTime = Date.now() - persistStart;

    if (debugEnabled) {
      debugState.msPersist += persistTime;
      debugState.msTotal += (Date.now() - tickStart);

      // Always try to post debug stats (it will check interval internally)
      try {
        postDebugStats(prismKeys.length);
      } catch (err) {
        sendInitMessage(
          "§c[Chaos Transfer] Error in postDebugStats: " +
            ((err && err.message) ? String(err.message) : String(err))
        );
      }
    }

    if (persistTime > 50 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage(
        "[PERF] Persist Total: " +
          persistTime +
          "ms (Inflight: " +
          inflightSaveTime +
          "ms | InputLevels: " +
          levelsSaveTime +
          "ms | OutputLevels: " +
          outputLevelsSaveTime +
          "ms | PrismLevels: " +
          prismLevelsSaveTime +
          "ms)",
        "transfer"
      );
    }

    if (persistTime > 100) {
      sendDiagnosticMessage(
        "[PERF] ⚠⚠⚠ WATCHDOG RISK: Persistence took " + persistTime + "ms (>100ms)",
        "transfer"
      );
    }

    // Overall tick timing - warn if tick is taking too long (watchdog threshold is usually around 50-100ms)
    const tickTotalTime = Date.now() - tickStart;
    lastTickEndTime = Date.now();

    if (tickTotalTime > 80 || ((nowTick % 200) === 0 && nowTick > 0)) {
      sendDiagnosticMessage(
        "[PERF] ⚠ TICK TOTAL: " +
          tickTotalTime +
          "ms (Cache: " +
          cacheTime +
          "ms | Queues+Inflight: " +
          queuesTotalTime +
          "ms | VirtualInv: " +
          virtualInvTime +
          "ms | InputQueues: " +
          inputQueueTime +
          "ms | Scan: " +
          scanTotalTime +
          "ms | Persist: " +
          persistTime +
          "ms)",
        "transfer"
      );
    }

    if (tickTotalTime > 100) {
      consecutiveLongTicks++;

      sendDiagnosticMessage(
        "[PERF] ⚠⚠⚠ WATCHDOG RISK: Tick took " +
          tickTotalTime +
          "ms (>100ms threshold) [Consecutive: " +
          consecutiveLongTicks +
          "]",
        "transfer"
      );

      // If we're consistently hitting 100ms+, we need to be more aggressive
      if (consecutiveLongTicks > 3) {
        sendDiagnosticMessage(
          "[PERF] ⚠⚠⚠ CRITICAL: " +
            consecutiveLongTicks +
            " consecutive ticks >100ms - system may be overloaded",
          "transfer"
        );
      }
    } else {
      consecutiveLongTicks = 0; // Reset if tick was normal
    }

    // EMERGENCY: If tick took way too long, disable system temporarily
    if (tickTotalTime > 150) {
      emergencyDisableTicks = 60; // Disable for 3 seconds (60 ticks)

      sendDiagnosticMessage(
        "[PERF] ⚠⚠⚠ EMERGENCY: Tick took " +
          tickTotalTime +
          "ms (>150ms) - Transfer disabled for 60 ticks",
        "transfer"
      );

      try {
        const players = world.getAllPlayers();
        for (const player of players) {
          if (player && typeof player.sendMessage === "function") {
            player.sendMessage(
              "§c[PERF] ⚠⚠⚠ CRITICAL: Transfer system disabled for 60 ticks due to " +
                tickTotalTime +
                "ms tick time"
            );
            break;
          }
        }
      } catch {}
    }

    // Reset consecutive counter if tick was reasonable
    if (tickTotalTime < 80) {
      consecutiveLongTicks = 0;
    }
  }
  function getPrismKeys() {
    // Cache prism keys by network stamp when available.
    // Only return actual prism blocks (not inputs/outputs/etc).
    try {
      if (typeof getNetworkStamp === "function") {
        const stamp = getNetworkStamp();
        if (cachedInputKeys && cachedInputsStamp === stamp) return cachedInputKeys;

        const map = loadBeamsMap(world);
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
      // ignore and fall through
    }

    // Fallback: no stamp available / failed
    const map = loadBeamsMap(world);
    const allKeys = Object.keys(map || {});
    const prismKeys = [];

    for (const k of allKeys) {
      const info = cacheManager.resolveBlockInfoCached(k);
      if (info && info.block && isPrismBlock(info.block)) {
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
    if (!prismInfo) return { ok: false, reason: "no_prism", searchesUsed: searchesUsed };

    const dim = prismInfo.dim;
    const prismBlock = prismInfo.block;
    if (!prismBlock || !isPrismBlock(prismBlock)) {
      return { ok: false, reason: "no_prism", searchesUsed: searchesUsed };
    }

    // Get all adjacent inventories (multi-inventory support)
    const inventories = cacheManager.getPrismInventoriesCached(prismKey, prismBlock, dim);
    if (!inventories || inventories.length === 0) {
      return { ok: false, reason: "no_container", searchesUsed: searchesUsed };
    }

    // Get filter for this prism (attunement)
    const filter = getFilterForBlock(prismBlock);
    const filterSet = filter ? (filter instanceof Set ? filter : getFilterSet(filter)) : null;
    const hasFilter = !!(filterSet && filterSet.size > 0);

    // TRY PUSH: Extract items from inventories and send to network
    // - If unattuned: push random items
    // - If attuned: push items NOT in filter
    //
    // PHASE 1: If input queues enabled, queue items instead of transferring immediately
    // Queue non-filtered items when scanning finds them.
    // Filtered items are skipped here and will be routed via prioritized push instead.

    if (inputQueuesManager && typeof inputQueuesManager.hasQueueForPrism === "function") {
      // CRITICAL FIX: Check existing queue BEFORE doing expensive operations.
      const existingQueue = inputQueuesManager.getQueuesForPrism(prismKey);

      const queuedItemTypes = new Set();
      if (existingQueue && Array.isArray(existingQueue)) {
        for (const e of existingQueue) {
          if (e && e.itemTypeId) queuedItemTypes.add(e.itemTypeId);
        }
      }

      const hasActiveQueue = queuedItemTypes.size > 0;

      // Scan for items (but filter out already-queued types before any expensive routing)
      const allItems = [];

      for (let invIndex = 0; invIndex < inventories.length; invIndex++) {
        const inv = inventories[invIndex];
        if (!inv || !inv.container) continue;

        const size = inv.container.size;
        for (let slot = 0; slot < size; slot++) {
          const item = inv.container.getItem(slot);
          if (!item || item.amount <= 0) continue;

          // Skip filtered items here (they're handled elsewhere)
          if (hasFilter && filterSet.has(item.typeId)) continue;

          allItems.push({
            container: inv.container,
            slot: slot,
            stack: item,
            inventoryIndex: invIndex,
            entity: inv.entity,
            block: inv.block,
          });
        }
      }

      // CRITICAL FIX: Filter out items that are already queued BEFORE doing expensive pathfinding.
      const newItems = allItems.filter((it) => !queuedItemTypes.has(it.stack.typeId));

      // Log item discovery occasionally
      if (allItems.length > 0 && (nowTick <= 3 || (nowTick % 200) === 0)) {
        const itemCount = allItems.length;
        const newItemCount = newItems.length;

        if (hasActiveQueue && newItemCount === 0) {
          // All items already queued - skip pathfinding entirely
          return { ok: false, reason: "all_items_already_queued", searchesUsed: 0 };
        }

        if (hasActiveQueue) {
          sendDiagnosticMessage(
            "[Scan] Found " +
              itemCount +
              " type(s) at " +
              prismKey +
              ", " +
              newItemCount +
              " new (" +
              (itemCount - newItemCount) +
              " already queued)",
            "transfer"
          );
        } else {
          sendDiagnosticMessage(
            "[Scan] Found " + itemCount + " type(s) at " + prismKey,
            "transfer"
          );
        }
      }
            // CRITICAL FIX: Only do pathfinding for NEW items (not already queued)
      // This prevents watchdog exceptions while maintaining continuous processing.
      if (newItems.length > 0 && searchBudget > 0) {
        // Find routes for NEW item types only (expensive operation).
        searchesUsed = 1;

        const pathfindStart = Date.now();
        let pathResult = null;

        try {
          pathResult = findPathForInput(prismKey, nowTick);

          const pathfindTime = Date.now() - pathfindStart;
          if (pathfindTime > 50) {
            sendDiagnosticMessage(
              "[PERF] Pathfind (scan): " +
                pathfindTime +
                "ms for " +
                prismKey +
                " (" +
                newItems.length +
                " new items)",
              "transfer"
            );
          }

          // EMERGENCY: If pathfinding takes too long, abort.
          if (pathfindTime > 100) {
            sendDiagnosticMessage(
              "[PERF] ⚠ Pathfind TIMEOUT (scan): " + pathfindTime + "ms - aborting for " + prismKey,
              "transfer"
            );
            try { if (typeof invalidateInput === "function") invalidateInput(prismKey); } catch {}
            return { ok: false, reason: "pathfind_timeout", searchesUsed: searchesUsed };
          }
        } catch (err) {
          const pathfindTime = Date.now() - pathfindStart;
          const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
          sendDiagnosticMessage(
            "[PERF] Pathfind ERROR (scan) after " + pathfindTime + "ms: " + errMsg,
            "transfer"
          );
          try { if (typeof invalidateInput === "function") invalidateInput(prismKey); } catch {}
          return { ok: false, reason: "pathfind_error", searchesUsed: searchesUsed };
        }

        if (pathResult && Array.isArray(pathResult) && pathResult.length > 0) {
          // Build a unique list of NEW item typeIds (so we pick at most one route per type).
          const newTypeIds = [];
          {
            const seen = new Set();
            for (const it of newItems) {
              const tid = it && it.stack ? it.stack.typeId : null;
              if (!tid) continue;
              if (seen.has(tid)) continue;
              seen.add(tid);
              newTypeIds.push(tid);
            }
          }

          // Pick a route for each NEW typeId
          const routesByType = new Map(); // Map<typeId, { path, outputKey }>
          for (let i = 0; i < newTypeIds.length; i++) {
            const typeId = newTypeIds[i];

            // Bias function: preserve your exact logic
            const pick = pickWeightedRandomWithBias(pathResult, (opt) => {
              const outType = (opt && opt.outputType) ? opt.outputType : "prism";

              if (isFluxTypeId(typeId) && outType === "crystal") return CRYSTAL_FLUX_WEIGHT;

              // Prioritize filtered prisms that match this item (20x weight)
              if (outType === "prism" && opt && opt.outputKey) {
                const targetInfo = resolveBlockInfo(opt.outputKey);
                if (targetInfo && targetInfo.block && isPrismBlock(targetInfo.block)) {
                  const targetFilter = getFilterForBlock(targetInfo.block);
                  const targetFilterSet = targetFilter
                    ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter))
                    : null;

                  if (targetFilterSet && targetFilterSet.size > 0 && targetFilterSet.has(typeId)) {
                    return 20.0;
                  }
                }
              }

              return 1.0;
            });

            if (pick && Array.isArray(pick.path) && pick.path.length > 0) {
              routesByType.set(typeId, { path: pick.path, outputKey: pick.outputKey });
            }
          }

          // Queue only NEW items that actually got a route
          if (routesByType.size > 0) {
            const routedNewItems = [];
            for (const it of newItems) {
              const tid = it && it.stack ? it.stack.typeId : null;
              if (!tid) continue;
              if (routesByType.has(tid)) routedNewItems.push(it);
            }

            // Convert routes to just paths for enqueue (store outputKey separately)
            const routesMap = new Map(); // Map<typeId, path[]>
            for (const [typeId, routeInfo] of routesByType.entries()) {
              routesMap.set(typeId, routeInfo.path);
            }

            // Only log queue creation occasionally to reduce clutter
            if (nowTick <= 3 || (nowTick % 100) === 0) {
              const msg =
                "[Queue] Queued " +
                routedNewItems.length +
                " new type(s) at " +
                prismKey +
                (hasActiveQueue ? " (" + queuedItemTypes.size + " already queued)" : "");
              sendDiagnosticMessage(msg, "transfer");
            }

            // Enqueue only the routable new items
            inputQueuesManager.enqueueInputStacks(prismKey, routedNewItems, routesMap);

            // Store outputKeys in queue entries (do a single queue fetch)
            const queue = inputQueuesManager.getQueuesForPrism(prismKey);
            if (queue && Array.isArray(queue) && queue.length > 0) {
              // Map for O(1) lookup
              const entryByType = new Map();
              for (const e of queue) {
                if (e && e.itemTypeId) entryByType.set(e.itemTypeId, e);
              }

              for (const [typeId, routeInfo] of routesByType.entries()) {
                const entry = entryByType.get(typeId);
                if (entry) entry.lastDestination = routeInfo.outputKey;
              }
            }

            // Success - new items queued
            return { ok: true, reason: "queued", searchesUsed: searchesUsed };
          }

          // DIAGNOSTIC: No routes for new types
          sendDiagnosticMessage(
            "[Queue] ⚠ No routes found for new items: prism=" + prismKey + ", newItems=" + newItems.length,
            "transfer"
          );
        } else {
          // New items exist but no routing candidates
          sendDiagnosticMessage(
            "[Queue] ⚠ No routes available: prism=" + prismKey + ", newItems=" + newItems.length,
            "transfer"
          );
        }
      } else if (newItems.length === 0 && hasActiveQueue) {
        // All items already queued - normal, return early without expensive work
        return { ok: false, reason: "all_items_already_queued", searchesUsed: 0 };
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

    // Filtered items are routed via prioritized push (no pull system)
    return { ok: false, reason: "no_transfer", searchesUsed: searchesUsed };
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

    // SOURCE is a filtered prism (extracting non-filtered items) => skip balance
    const isFilteredSource = !!(filterSet && filterSet.size > 0);

    // Determine output type
    let outputType = "prism";
    if (outBlock.typeId === CRYSTALLIZER_ID) {
      outputType = "crystal";
    } else if (!isPrismBlock(outBlock)) {
      return { ok: false, reason: "invalid_destination", amount: 0 };
    }

    // Get target inventories
    let outInventories = null;
    let containerKey = null;

    const destKey = destInfo.key || destInfo.outputKey || "";

    if (outputType === "crystal") {
      const outContainerInfo = getAttachedInventoryInfo(outBlock, destInfo.dim);
      if (!outContainerInfo || !outContainerInfo.container) {
        return { ok: false, reason: "no_container", amount: 0 };
      }
      outInventories = [
        { container: outContainerInfo.container, block: outContainerInfo.block, entity: outContainerInfo.entity },
      ];
      containerKey = null; // Crystallizers don't use container keys
    } else {
      outInventories = cacheManager.getPrismInventoriesCached(destKey, outBlock, destInfo.dim);
      if (!outInventories || outInventories.length === 0) {
        return { ok: false, reason: "no_container", amount: 0 };
      }

      // Find first valid container for containerKey
      for (const inv of outInventories) {
        if (inv && inv.container) {
          containerKey = getContainerKey(inv.entity || inv.block);
          break;
        }
      }
    }

   // Check capacity and calculate transfer amount (same logic as attemptPushTransfer)
const targetFilter = getFilterForBlock(outBlock);
const targetFilterSet = targetFilter
  ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter))
  : null;

const isFilteredDestination = !!(targetFilterSet && targetFilterSet.size > 0);

const targetInv = outInventories[0];
if (!targetInv?.container) {
  return { ...makeResult(false, "no_container"), amount: 0 };
}

const targetContainerKey = getContainerKey(targetInv.entity || targetInv.block);
const sourceContainerKey = getContainerKey(
  inventories[itemSource.inventoryIndex].entity || inventories[itemSource.inventoryIndex].block
);

if (sourceContainerKey && targetContainerKey === sourceContainerKey) {
  return { ...makeResult(false, "same_container"), amount: 0 };
}

const queueState = queuesManager.getState();
if (queueState.fullContainers.has(targetContainerKey)) {
  return { ...makeResult(false, "full"), amount: 0 };
}

const virtualCapacity = cacheManager.getInsertCapacityCached(
  targetContainerKey,
  targetInv.container,
  sourceStack.typeId,
  sourceStack
);

const previewLevel = levelsManager ? levelsManager.getNextInputLevel(prismKey) : 1;

    let desiredAmount = 1;

if (isFilteredDestination) {
  // FILTERED DESTINATION: Fill to capacity completely (skip balance calculation)
  // Only insert filtered items, fill container as much as possible
  if (targetFilterSet && targetFilterSet.has(sourceStack.typeId)) {
    // This item matches the filter - fill to capacity
    desiredAmount = Math.min(virtualCapacity, sourceStack.amount);

    // Use level-based amount if available, but don't exceed capacity
    if (levelsManager && typeof levelsManager.getTransferAmount === "function") {
      const levelAmount = levelsManager.getTransferAmount(previewLevel, sourceStack);
      desiredAmount = Math.min(levelAmount, virtualCapacity, sourceStack.amount);
    }

    // Ensure at least 1 item if capacity allows
    if (desiredAmount < 1 && virtualCapacity > 0 && sourceStack.amount > 0) {
      desiredAmount = 1;
    }
  } else {
    // Item doesn't match filter - shouldn't reach here, but skip if it does
    return { ...makeResult(false, "filter_mismatch"), amount: 0 };
  }
} else if (isFilteredSource) {
  // FILTERED SOURCE: Extracting non-filtered items - skip balance, extract everything
  // Extract all non-filtered items from filtered prisms without balance restrictions
  desiredAmount = Math.min(virtualCapacity, sourceStack.amount);

  // Use level-based amount if available, but don't exceed capacity
  if (levelsManager && typeof levelsManager.getTransferAmount === "function") {
    const levelAmount = levelsManager.getTransferAmount(previewLevel, sourceStack);
    desiredAmount = Math.min(levelAmount, virtualCapacity, sourceStack.amount);
  }

  // Ensure at least 1 item if capacity allows
  if (desiredAmount < 1 && virtualCapacity > 0 && sourceStack.amount > 0) {
    desiredAmount = 1;
  }
} else {
  // UNFILTERED SOURCE: Normal balance calculation (50/50 distribution)
  if (cfg.useBalanceDistribution !== false) {
    const sourceCount = getTotalCountForType(sourceContainer, sourceStack.typeId);
    const destCount = getTotalCountForType(targetInv.container, sourceStack.typeId);

    if (!sourceCount || sourceCount <= 0) {
      desiredAmount =
        (levelsManager && typeof levelsManager.getTransferAmount === "function")
          ? levelsManager.getTransferAmount(previewLevel, sourceStack)
          : 1;
    } else {
      let adjustedSourceCount = sourceCount;
      let adjustedDestCount = destCount;

      if (
        virtualInventoryManager &&
        typeof virtualInventoryManager.getPendingForContainer === "function"
      ) {
        const sourcePending =
          virtualInventoryManager.getPendingForContainer(sourceContainerKey, sourceStack.typeId) || 0;
        const destPending =
          virtualInventoryManager.getPendingForContainer(targetContainerKey, sourceStack.typeId) || 0;

        adjustedSourceCount = Math.max(0, sourceCount - sourcePending);
        adjustedDestCount = destCount + destPending;
      }

      const maxTransfer =
        (cfg.balanceCapByLevel &&
          levelsManager &&
          typeof levelsManager.getTransferAmount === "function")
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
        // For queue-based transfers, be more lenient - transfer if capacity allows
        // Queue entries exist because items were found and should be moved
        if (queueEntry) {
          // Queue-based transfer: allow transfer if we have capacity, even if balanced
          if (virtualCapacity > 0 && sourceStack.amount > 0) {
            const minTransfer = cfg.balanceMinTransfer || 1;
            const levelAmount =
              (levelsManager && typeof levelsManager.getTransferAmount === "function")
                ? levelsManager.getTransferAmount(previewLevel, sourceStack)
                : 1;

            desiredAmount = Math.min(
              levelAmount,
              virtualCapacity,
              sourceStack.amount,
              maxTransfer || Infinity
            );

            // Ensure we transfer at least minTransfer if possible
            if (
              desiredAmount < minTransfer &&
              virtualCapacity >= minTransfer &&
              sourceStack.amount >= minTransfer
            ) {
              desiredAmount = minTransfer;
            }

            // If balance cancelled but we have capacity, still transfer
            if (desiredAmount <= 0) {
              return { ...makeResult(false, "no_capacity"), amount: 0 };
            }
          } else {
            return { ...makeResult(false, "no_capacity"), amount: 0 };
          }
        } else if (sourceCount > destCount && virtualCapacity > 0 && sourceStack.amount > 0) {
          // Regular transfer: only transfer if source > dest
          desiredAmount =
            (levelsManager && typeof levelsManager.getTransferAmount === "function")
              ? Math.min(
                  levelsManager.getTransferAmount(previewLevel, sourceStack),
                  virtualCapacity,
                  sourceStack.amount
                )
              : Math.min(1, virtualCapacity, sourceStack.amount);
        } else {
          return { ...makeResult(false, "balanced"), amount: 0 };
        }
      } else {
        desiredAmount = balanceResult.amount;
      }
    }
  } else {
    desiredAmount =
      (levelsManager && typeof levelsManager.getTransferAmount === "function")
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

    if (!validatePathStart(dim, route)) {
      return { ...makeResult(false, "invalid_path"), amount: 0 };
    }

    const prismPos = (() => {
      if (prismBlock?.location) {
        return { x: prismBlock.location.x, y: prismBlock.location.y, z: prismBlock.location.z, dimId: dim.id };
      }
      const info = resolveBlockInfo(prismKey);
      if (!info?.pos) return null;
      return { x: info.pos.x, y: info.pos.y, z: info.pos.z, dimId: info.dim?.id || dim.id };
    })();


    if (!prismPos) {
      return { ...makeResult(false, "no_prism_pos"), amount: 0 };
    }

    const nodePath = buildNodePathSegments(dim, route, prismPos);
    const travelPath = nodePath?.points || route;
    const segmentLengths = nodePath?.lengths || null;

    try {
      const remaining = sourceStack.amount - transferAmount;

      if (remaining > 0) {
        const newStack = sourceStack.clone();
        newStack.amount = remaining;
        sourceContainer.setItem(sourceSlot, newStack);
      } else {
        sourceContainer.setItem(sourceSlot, null);
      }
    } catch {
      return { ...makeResult(false, "no_item"), amount: 0 };
    }

    const pathPrismKey = findFirstPrismKeyInPath(dim, prismPos.dimId, route);

    if (levelsManager && typeof levelsManager.notePrismPassage === "function") {
      levelsManager.notePrismPassage(prismKey, prismBlock);
    }

    const prismTier = isPrismBlock(prismBlock) ? getPrismTier(prismBlock) : 1;
    const baseStepTicks =
      (levelsManager && typeof levelsManager.getOrbStepTicks === "function")
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


        // Queue inflight transfer
    const refinedItems =
      (outputType === "crystal" && isFluxTypeId(sourceStack.typeId))
        ? [{ typeId: sourceStack.typeId, amount: transferAmount }]
        : null;

    inflight.push({
      dimId: prismPos.dimId,
      itemTypeId: sourceStack.typeId,
      amount: transferAmount,

      path: travelPath,
      stepIndex: 0,
      stepTicks: baseStepTicks,
      speedScale: 1.0,
      ticksUntilStep: 0,

      outputKey: destKey,
      outputType,
      suppressOrb,
      containerKey,

      prismKey: pathPrismKey,
      startPos: { x: prismPos.x, y: prismPos.y, z: prismPos.z },
      startTick: debugEnabled ? nowTick : null,

      level: previewLevel,
      segmentLengths,

      refinedItems,
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

    // Add timeout protection for pathfinding
    const pathfindStart = Date.now();
    let options = null;

    try {
      options = findPathForInput(prismKey, nowTick);

      const pathfindTime = Date.now() - pathfindStart;
      if (pathfindTime > 50) {
        sendDiagnosticMessage(`[PERF] Pathfind (scan) SLOW: ${pathfindTime}ms for ${prismKey}`, "transfer");
      }

      // EMERGENCY: If pathfinding takes too long, abort
      if (pathfindTime > 100) {
        sendDiagnosticMessage(
          `[PERF] ⚠ Pathfind TIMEOUT (scan): ${pathfindTime}ms - aborting for ${prismKey}`,
          "transfer"
        );
        if (typeof invalidateInput === "function") invalidateInput(prismKey);
        return { ...makeResult(false, "pathfind_timeout"), searchesUsed };
      }
    } catch (err) {
      const pathfindTime = Date.now() - pathfindStart;
      sendDiagnosticMessage(
        `[PERF] Pathfind ERROR (scan) after ${pathfindTime}ms: ${err?.message || String(err)}`,
        "transfer"
      );
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "pathfind_error"), searchesUsed };
    }

    if (!Array.isArray(options) || options.length === 0) {
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "no_options"), searchesUsed };
    }
    // Filter options to prioritize prisms that want this item (matching filters)
    const filteredOptions = [];
    const itemTypeId = sourceStack.typeId;

    for (const opt of options) {
      const outputKey = opt?.outputKey;
      if (!outputKey) continue;

      const targetInfo = resolveBlockInfo(outputKey);
      const targetBlock = targetInfo?.block;
      if (!targetBlock) continue;

      // Crystallizers can always accept flux
      if (targetBlock.typeId === CRYSTALLIZER_ID) {
        if (isFluxTypeId(itemTypeId)) filteredOptions.push(opt);
        continue;
      }

      // Prisms - require inventory + optional filter match
      if (!isPrismBlock(targetBlock)) continue;

      const targetInventories = cacheManager.getPrismInventoriesCached(outputKey, targetBlock, targetInfo.dim);
      if (!targetInventories || targetInventories.length === 0) continue;

      const targetFilter = getFilterForBlock(targetBlock);
      const targetFilterSet = targetFilter
        ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter))
        : null;

      // If target has filter, only include if item matches
      // If target has no filter, include (accepts any)
      if (!targetFilterSet || targetFilterSet.size === 0 || targetFilterSet.has(itemTypeId)) {
        filteredOptions.push(opt);
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

    const isFlux = isFluxTypeId(itemTypeId);

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
    if (candidates.length === 0) {
      return { ...makeResult(false, "no_options"), searchesUsed };
    }

    const available = sourceStack.amount;

    // Weighted pick: heavily favor prisms that explicitly filter for this item
    const getPickWeight = (opt) => {
      const type = opt?.outputType || "prism";
      if (isFlux && type === "crystal") return CRYSTAL_FLUX_WEIGHT;

      if (type !== "prism") return 1.0;

      const outputKey = opt?.outputKey;
      if (!outputKey) return 1.0;

      const tInfo = resolveBlockInfo(outputKey);
      const tBlock = tInfo?.block;
      if (!tBlock || !isPrismBlock(tBlock)) return 1.0;

      const tFilter = getFilterForBlock(tBlock);
      const tSet = tFilter ? (tFilter instanceof Set ? tFilter : getFilterSet(tFilter)) : null;

      // If prism has a filter and it matches this item, strongly prioritize it
      if (tSet && tSet.size > 0 && tSet.has(itemTypeId)) return 20.0;

      return 1.0;
    };

    while (candidates.length > 0) {
      const pick = pickWeightedRandomWithBias(candidates, getPickWeight);

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

        const desiredAmount =
          (levelsManager && typeof levelsManager.getTransferAmount === "function")
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

      const pickOutputKey = pick.outputKey;

      // Compute once (inner loop uses it repeatedly)
      const sourceInv = inventories[itemSource.inventoryIndex];
      const sourceContainerKey = getContainerKey(sourceInv?.entity || sourceInv?.block);

      // Check if we can insert into any of the target inventories
      let foundTarget = false;

      // Destination filter (filtered = fill, unfiltered = balance)
      const targetFilter = getFilterForBlock(info.block);
      const targetFilterSet = targetFilter ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter)) : null;
      const isFilteredDestination = !!(targetFilterSet && targetFilterSet.size > 0);

      // SOURCE is a filtered prism? (extracting non-filtered items - skip balance)
      const isFilteredSource = !!(filterSet && filterSet.size > 0);

      for (const targetInv of targetInventories) {
        const targetContainer = targetInv?.container;
        if (!targetContainer) continue;

        const targetContainerKey = getContainerKey(targetInv.entity || targetInv.block);
        if (!targetContainerKey) continue;

        // Skip if same container
        if (sourceContainerKey && targetContainerKey === sourceContainerKey) continue;

        const queueState = queuesManager.getState();
        if (queueState.fullContainers.has(targetContainerKey)) {
          sawFull = true;
          continue;
        }

        // Get available capacity (accounting for virtual inventory)
        // This accounts for in-flight items and queued items to prevent overbooking
        const virtualCapacity = cacheManager.getInsertCapacityCached(
          targetContainerKey,
          targetContainer,
          sourceStack.typeId,
          sourceStack
        );

        // Calculate desired transfer amount based on destination type
        let desiredAmount = 1;
        if (isFilteredDestination) {
          // FILTERED DESTINATION: only accept matching items, fill (cap by level if available)
          if (!targetFilterSet || !targetFilterSet.has(sourceStack.typeId)) {
            // Item doesn't match filter - skip this destination
            candidates.splice(candidates.indexOf(pick), 1);
            continue;
          }

          desiredAmount = Math.min(virtualCapacity, sourceStack.amount);

          if (levelsManager && typeof levelsManager.getTransferAmount === "function") {
            const levelAmount = levelsManager.getTransferAmount(previewLevel, sourceStack);
            desiredAmount = Math.min(levelAmount, virtualCapacity, sourceStack.amount);
          }

          // Ensure at least 1 item if capacity allows
          if (desiredAmount < 1 && virtualCapacity > 0 && sourceStack.amount > 0) {
            desiredAmount = 1;
          }
        } else if (isFilteredSource) {
          // FILTERED SOURCE: extracting non-filtered items - skip balance, extract (cap by level if available)
          desiredAmount = Math.min(virtualCapacity, sourceStack.amount);

          if (levelsManager && typeof levelsManager.getTransferAmount === "function") {
            const levelAmount = levelsManager.getTransferAmount(previewLevel, sourceStack);
            desiredAmount = Math.min(levelAmount, virtualCapacity, sourceStack.amount);
          }

          // Ensure at least 1 item if capacity allows
          if (desiredAmount < 1 && virtualCapacity > 0 && sourceStack.amount > 0) {
            desiredAmount = 1;
          }
        } else {
          // UNFILTERED SOURCE: 50/50 balance distribution (if enabled)
          if (cfg.useBalanceDistribution !== false) {
            const sourceContainer = itemSource.container;
            const typeId = sourceStack.typeId;

            const sourceCount = getTotalCountForType(sourceContainer, typeId);
            const destCount = getTotalCountForType(targetInv.container, typeId);

            // Safety: if source count is invalid, fall back to level-based amount
            if (!sourceCount || sourceCount <= 0) {
              desiredAmount =
                (levelsManager && typeof levelsManager.getTransferAmount === "function")
                  ? levelsManager.getTransferAmount(previewLevel, sourceStack)
                  : 1;
            } else {
              // Account for pending items in balance calculation (if virtual inventory manager available)
              let adjustedSourceCount = sourceCount;
              let adjustedDestCount = destCount;

              if (virtualInventoryManager && typeof virtualInventoryManager.getPendingForContainer === "function") {
                const sourcePending =
                  virtualInventoryManager.getPendingForContainer(sourceContainerKey, typeId) || 0;
                const destPending =
                  virtualInventoryManager.getPendingForContainer(targetContainerKey, typeId) || 0;

                // Items leaving vs arriving
                adjustedSourceCount = Math.max(0, sourceCount - sourcePending);
                adjustedDestCount = destCount + destPending;
              }

              const maxTransfer =
                (cfg.balanceCapByLevel && levelsManager && typeof levelsManager.getTransferAmount === "function")
                  ? levelsManager.getTransferAmount(previewLevel, sourceStack)
                  : Infinity;

              const balanceResult = calculateBalancedTransferAmount(
                adjustedSourceCount,
                adjustedDestCount,
                sourceStack.amount, // available in source stack
                virtualCapacity,     // available capacity in destination
                {
                  minTransfer: cfg.balanceMinTransfer || 1,
                  maxTransfer,
                }
              );

              if (balanceResult.cancelled) {
                // If source has more than dest, still transfer at least 1 (or level-based amount)
                if (sourceCount > destCount && virtualCapacity > 0 && sourceStack.amount > 0) {
                  desiredAmount =
                    (levelsManager && typeof levelsManager.getTransferAmount === "function")
                      ? Math.min(levelsManager.getTransferAmount(previewLevel, sourceStack), virtualCapacity, sourceStack.amount)
                      : Math.min(1, virtualCapacity, sourceStack.amount);

                  if (debugEnabled) {
                    debugState.balanceCancelled = (debugState.balanceCancelled || 0) + 1;
                    debugState.balanceCancelReason = balanceResult.reason;
                    debugState.balanceFallback = (debugState.balanceFallback || 0) + 1;
                  }
                } else {
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
            }
          } else {
            // Balance distribution disabled - use level-based amounts
            desiredAmount =
              (levelsManager && typeof levelsManager.getTransferAmount === "function")
                ? levelsManager.getTransferAmount(previewLevel, sourceStack)
                : 1;
          }
        }
        // Check virtual capacity before attempting insertion
        if (virtualCapacity < desiredAmount) {
          sawFull = true;
          continue; // Container doesn't have enough virtual capacity (accounting for pending items)
        }

        // DO NOT insert here — selection must be non-mutating.
        // We already checked virtualCapacity above, so if desiredAmount fits, we can accept this target.
        if (desiredAmount > 0) {
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
    try {
      const remaining = current.amount - transferAmount;

      if (remaining > 0) {
        const newStack = current.clone();
        newStack.amount = remaining;
        sourceContainer.setItem(sourceSlot, newStack);
      } else {
        sourceContainer.setItem(sourceSlot, null);
      }
    } catch {
      return { ...makeResult(false, "no_item"), searchesUsed };
    }

    const suppressOrb = (outputType === "crystal" && isFluxTypeId(sourceStack.typeId));

    const prismPos = prismInfo.pos;
    const firstStep = pathInfo.path[0];
    const firstBlock =
      cacheManager.getBlockCached(prismPos.dimId, firstStep) ||
      dim.getBlock({ x: firstStep.x, y: firstStep.y, z: firstStep.z });

    const nodePath = buildNodePathSegments(dim, pathInfo.path, prismPos);
    const travelPath = nodePath?.points || pathInfo.path;
    const segmentLengths = nodePath?.lengths || null;

    const pathPrismKey = findFirstPrismKeyInPath(dim, prismPos.dimId, pathInfo.path);

    // Note that this prism started a transfer (counts toward prism leveling)
    if (levelsManager && typeof levelsManager.notePrismPassage === "function") {
      levelsManager.notePrismPassage(prismKey, prismBlock);
    }

    // Get level from prism block for orb step ticks (prisms now use tier block IDs, not state)
    const prismTier = isPrismBlock(prismBlock) ? getPrismTier(prismBlock) : 1;
    const baseStepTicks =
      (levelsManager && typeof levelsManager.getOrbStepTicks === "function")
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

    const refinedItems =
      (outputType === "crystal" && isFluxTypeId(sourceStack.typeId))
        ? [{ typeId: sourceStack.typeId, amount: transferAmount }]
        : null;

    inflight.push({
      dimId: prismPos.dimId,
      itemTypeId: sourceStack.typeId,
      amount: transferAmount,

      path: travelPath,
      stepIndex: 0,
      stepTicks: baseStepTicks,
      speedScale: 1.0,
      ticksUntilStep: 0,

      outputKey: pathInfo.outputKey,
      outputType,
      suppressOrb,
      containerKey,

      prismKey: pathPrismKey,
      startPos: { x: prismPos.x, y: prismPos.y, z: prismPos.z },
      startTick: debugEnabled ? nowTick : null,

      level: previewLevel,
      segmentLengths,

      refinedItems,
    });

    if (containerKey) {
      reserveContainerSlot(containerKey, sourceStack.typeId, transferAmount);
    }

    inflightDirty = true;
    return { ...makeResult(true, "ok"), searchesUsed };
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

    // Simplified stats: Only show essential info (active transfers, queues, timing)
    // Calculate input queue size
    let inputQueueSize = 0;
    if (inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function") {
      inputQueueSize = inputQueuesManager.getTotalQueueSize();
    }
    
    // Build simplified stats message - only essential info
    const msg =
      `Transfer | xfer=${debugState.transfersStarted} inflight=${inflight.length} ` +
      `queues=${inputQueueSize} outputQ=${queuedContainers}/${queuedItems} ` +
      `| ${timingBreakdown}`;

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
    if (!levelsManager) return;

    // New world: prisms handle leveling via levelsManager.notePrismPassage
    if (isPrismBlock(block)) {
      if (typeof levelsManager.notePrismPassage === "function") {
        levelsManager.notePrismPassage(outputKey, block);
      }
      return;
    }

    // Legacy output blocks (if any)
    if (typeof levelsManager.getMinCountForLevel !== "function") return;
    if (typeof levelsManager.getLevelForCount !== "function") return;

    const perm = block?.permutation;
    const blockLevel = (perm?.getState("chaos:level") | 0) || 1;

    const minCount = levelsManager.getMinCountForLevel(blockLevel, cfg.levelStep);
    const stored = outputCounts.has(outputKey) ? (outputCounts.get(outputKey) | 0) : 0;
    const storedLevel = levelsManager.getLevelForCount(stored, cfg.levelStep, cfg.maxLevel);

    // If stored level somehow exceeds block level, snap to minCount baseline for this block level
    const currentCount = (storedLevel > blockLevel) ? minCount : Math.max(stored, minCount);
    const nextCount = currentCount + 1;

    outputCounts.set(outputKey, nextCount);
    outputLevelsDirty = true;

    const newLevel = levelsManager.getLevelForCount(nextCount, cfg.levelStep, cfg.maxLevel);

    try {
      if (perm) {
        const currentLevel = perm.getState("chaos:level");
        if ((currentLevel | 0) !== (newLevel | 0)) {
          block.setPermutation(perm.withState("chaos:level", newLevel));
          if (fxManager && typeof fxManager.spawnLevelUpBurst === "function") {
            fxManager.spawnLevelUpBurst(block);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  function rebuildReservationsFromInflight() {
    // Rebuild virtual reservations from inflight jobs (best-effort)
    try {
      clearReservations();
      if (!Array.isArray(inflight)) return;

      for (const job of inflight) {
        const containerKey = job?.containerKey;
        const itemTypeId = job?.itemTypeId;
        if (!containerKey || !itemTypeId) continue;

        const amt = Math.max(1, job.amount | 0);
        reserveContainerSlot(containerKey, itemTypeId, amt);
      }
    } catch {
      // If rebuilding fails, just clear reservations and continue
      try { clearReservations(); } catch {}
    }
  }

  function dropItemAt(dim, loc, typeId, amount) {
    try {
      const dropLoc = findDropLocation(dim, loc);

      let remaining = Math.max(1, amount | 0);
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
