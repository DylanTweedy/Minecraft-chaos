// scripts/chaos/features/links/transfer/runtime/controller.js

// Minecraft API
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
} from "../config.js";

// Core orchestration
import { createTransferPipeline } from "../core/pipeline.js";
import { createAdjacentPrismDirtyMarker } from "../core/dirtyPrisms.js";
import { subscribeTransferDirtyEvents } from "../core/transferEvents.js";
import { createCacheManager } from "../core/cache.js";
import { createFinalizeManager } from "../core/finalize.js";
import { createQueuesManager } from "../core/queues.js";
import { createInflightProcessorManager } from "../core/inflightProcessor.js";
import { createVirtualInventoryManager } from "../core/virtualInventory.js";
import { createInputQueuesManager } from "../core/inputQueues.js";

// Systems
import { createLevelsManager } from "../systems/levels.js";
import { createFxManager } from "../systems/fx.js";
import { createRefinementManager } from "../systems/refinement.js";

// Utilities
import { mergeCfg, runTransferPipeline } from "../utils.js";
import { key, parseKey, getContainerKey, getContainerKeyFromInfo } from "../keys.js";
import {
  createTickContext,
  createBeginTickPhase,
  createTickGuardsPhase,
  createRefreshPrismRegistryPhase,
  createScanDiscoveryPhase,
  createPushTransfersPhase,
  createAttemptTransferForPrismPhase,
  createProcessQueuesPhase,
  createUpdateVirtualStatePhase,
  createProcessInputQueuesPhase,
  createPersistAndReportPhase,
  createScanTransfersPhase,
} from "./index.js";
import { initManagers } from "./bootstrap/initManagers.js";
import { createTransferStartup } from "./bootstrap/startup.js";
import { createGetSpeed } from "./helpers/speed.js";

// Persistence
import {
  loadBeamsMap,
  loadInputLevels,
  saveInputLevels,
  loadOutputLevels,
  saveOutputLevels,
  loadPrismLevels,
  savePrismLevels,
} from "../persistence/storage.js";
import { loadInflightStateFromWorld, persistInflightStateToWorld } from "../persistence/inflight.js";

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
} from "../inventory/inventory.js";
import { getFilterContainer, getFilterSet } from "../inventory/filters.js";
import {
  getInsertCapacityWithReservations,
  getReservedForContainer,
  reserveContainerSlot,
  releaseContainerSlot,
  clearReservations,
} from "../inventory/reservations.js";
import { calculateBalancedTransferAmount } from "../inventory/balance.js";

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
} from "../pathfinding/path.js";
import { findOutputRouteFromNode, findCrystallizerRouteFromPrism } from "../pathfinding/routes.js";

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
} from "../../../../core/trace.js";

// Cross-feature filters
import { getFilterSetForBlock } from "../../shared/filters.js";

// Flux / crystallizer / FX (chaos root is 3 levels up)
import { tryGenerateFluxOnTransfer, tryRefineFluxInTransfer, getFluxTier, isFluxTypeId } from "../../../../flux.js";
import { addFluxForItem, getFluxValueForItem } from "../../../../crystallizer.js";
import { fxFluxGenerate, queueFxParticle } from "../../../../fx/fx.js";

// Debug UX
import { hasInsight, hasExtendedDebug } from "../../../../core/debugGroups.js";
import { isHoldingLens } from "../../../../items/insightLens.js";
import { isWearingGoggles } from "../../../../items/insightGoggles.js";

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
  let activeTickContext = null;

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

  // Debug status is now only shown when debug groups are enabled (via Insight menu)
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

  // Helper function to send diagnostic messages (basic debug visibility)
  function sendDiagnosticMessage(message, group) {
    try {
      const msgStr = message != null ? String(message) : "";
      if (!msgStr) return;

      let players;
      try {
        if (!world || typeof world.getAllPlayers !== "function") return;
        players = world.getAllPlayers();
      } catch {
        return;
      }

      const groupName = group != null ? String(group) : "";
      for (const player of players) {
        try {
          if (!player) continue;

          const hasBasic =
            hasInsight(player) ||
            (typeof isHoldingLens === "function" && isHoldingLens(player)) ||
            (typeof isWearingGoggles === "function" && isWearingGoggles(player));

          if (!hasBasic) continue;
          if (groupName && !hasExtendedDebug(player, groupName)) continue;

          if (typeof player.sendMessage === "function") {
            player.sendMessage(msgStr);
          }
        } catch {
          // ignore per-player failures
        }
      }
    } catch {
      // ignore all diagnostic send failures
    }
  }


  function logError(message, err) {
    safeInitLog("§c[Chaos Transfer]", message, err);
  }

  function handleManagerCreationError(managerName, err) {
    logError("Failed to create " + managerName, err);
    throw err;
  }

  function getLastDebugTick() {
    return lastDebugTick;
  }

  function setLastDebugTick(v) {
    lastDebugTick = v;
  }

  function getBackoffTicks(level) {
    const base = Math.max(1, cfg.backoffBaseTicks | 0);
    const max = Math.max(base, cfg.backoffMaxTicks | 0);
    const lvl = Math.max(0, level | 0);
    const ticks = base * (2 ** lvl);
    return Math.min(max, ticks | 0);
  }

  function bumpBackoff(prismKey) {
    const max = Math.max(0, cfg.backoffMaxLevel | 0);
    const prev = inputBackoff.has(prismKey) ? (inputBackoff.get(prismKey) | 0) : 0;
    const next = Math.min(max, prev + 1);
    inputBackoff.set(prismKey, next);
    return next;
  }

  function clearBackoff(prismKey) {
    inputBackoff.delete(prismKey);
  }

  function getQueueState() {
    return {
      queueByContainer,
      fullContainers,
      queueCursor,
      fullCursor,
      setQueueCursor: (v) => {
        queueCursor = v | 0;
      },
      setFullCursor: (v) => {
        fullCursor = v | 0;
      },
    };
  }

  function getCachedInputKeys() {
    return cachedInputKeys;
  }

  function getCachedInputsStamp() {
    return cachedInputsStamp;
  }

  function setCachedInputKeys(v) {
    cachedInputKeys = v;
  }

  function setCachedInputsStamp(v) {
    cachedInputsStamp = v;
  }

  function setLevelsDirty(v) {
    levelsDirty = v;
  }

  function setOutputLevelsDirty(v) {
    outputLevelsDirty = v;
  }

  function setPrismLevelsDirty(v) {
    prismLevelsDirty = v;
  }

  const getSpeed = createGetSpeed({
    cfg,
    getSpeedForInput,
    isPrismBlock,
    getPrismTier,
  });

  let virtualInventoryManager = null;
  let cacheManager = null;
  let levelsManager = null;
  let queuesManager = null;
  let inputQueuesManager = null;
  let finalizeManager = null;
  let resolveBlockInfo = null;
  let dropItemAt = null;
  let resolvePrismKeysFromWorld = null;
  let getFilterForBlock = null;
  let noteOutputTransfer = null;
  let services = null;
  let beginTickPhase = null;
  let refreshPrismPhase = null;
  let scanDiscoveryPhase = null;
  let pushTransfersPhase = null;
  let pushTransferHandlers = {};
  let attemptTransferForPrismPhase = null;
  let attemptTransferForPrismHandler = null;
  let processQueuesPhase = null;
  let updateVirtualStatePhase = null;
  let processInputQueuesPhase = null;
  let persistAndReportPhase = null;
  let scanTransfersPhase = null;
  let tickGuardsPhase = null;
  let markAdjacentPrismsDirty = null;

  const managers = initManagers({
    cfg,
    world,
    system,
    FX,
    debugEnabled,
    debugState,
    debugInterval,
    getLastDebugTick,
    setLastDebugTick,
    sendInitMessage,
    sendDiagnosticMessage,
    logError,
    handleManagerCreationError,
    createVirtualInventoryManager,
    createCacheManager,
    createLevelsManager,
    createFxManager,
    createQueuesManager,
    createInputQueuesManager,
    createRefinementManager,
    createFinalizeManager,
    createInflightProcessorManager,
    createBeginTickPhase,
    createRefreshPrismRegistryPhase,
    createScanDiscoveryPhase,
    createPushTransfersPhase,
    createAttemptTransferForPrismPhase,
    createProcessQueuesPhase,
    createUpdateVirtualStatePhase,
    createProcessInputQueuesPhase,
    createPersistAndReportPhase,
    createScanTransfersPhase,
    createTickGuardsPhase,
    runTransferPipeline,
    getContainerKey,
    getContainerKeyFromInfo,
    getAttachedInventoryInfo,
    getAllAdjacentInventories,
    getInventoryContainer,
    getFurnaceSlots,
    isFurnaceBlock,
    getFilterContainer,
    getFilterSet,
    getFilterSetForBlock,
    getReservedForContainer,
    getInsertCapacityWithReservations,
    reserveContainerSlot,
    releaseContainerSlot,
    clearReservations,
    getTotalCountForType,
    getRandomItemFromInventories,
    findInputSlotForContainer,
    decrementInputSlotSafe,
    decrementInputSlotsForType,
    calculateBalancedTransferAmount,
    validatePathStart,
    isPathBlock,
    isNodeBlock,
    findFirstPrismKeyInPath,
    buildNodePathSegments,
    buildFluxFxSegments,
    findDropLocation,
    pickWeightedRandomWithBias,
    findOutputRouteFromNode,
    findCrystallizerRouteFromPrism,
    getTraceKey,
    isTracing,
    traceMarkDirty,
    traceClearDirty,
    traceNoteScan,
    traceNoteError,
    traceNoteQueueSize,
    traceNoteCooldown,
    tryGenerateFluxOnTransfer,
    tryRefineFluxInTransfer,
    getFluxTier,
    isFluxTypeId,
    addFluxForItem,
    getFluxValueForItem,
    fxFluxGenerate,
    queueFxParticle,
    hasInsight,
    isHoldingLens,
    isWearingGoggles,
    key,
    parseKey,
    loadBeamsMap,
    loadInflightStateFromWorld,
    persistInflightStateToWorld,
    loadInputLevels,
    saveInputLevels,
    loadOutputLevels,
    saveOutputLevels,
    loadPrismLevels,
    savePrismLevels,
    getSpeedForInput,
    findPathForInput,
    invalidateInput,
    getPathStats,
    getNetworkStamp,
    getSpeed,
    attemptTransferForPrism,
    attemptPushTransferWithDestination,
    attemptPushTransfer,
    makeMarkAdjacentPrismsDirty: (deps) => createAdjacentPrismDirtyMarker(deps),
    _perfLogIfNeeded,
    getNowTick: () => nowTick,
    clearBackoff,
    bumpBackoff,
    getBackoffTicks,
    inputBackoff,
    nextAllowed,
    nextQueueTransferAllowed,
    inflight,
    fluxFxInflight,
    orbFxBudgetUsed,
    outputCounts,
    prismCounts,
    transferCounts,
    queueByContainer,
    fullContainers,
    getQueueState,
    isPrismBlock,
    getPrismTier,
    CRYSTALLIZER_ID,
    CRYSTAL_FLUX_WEIGHT,
    MAX_STEPS,
    SPEED_SCALE_MAX,
    PRISM_SPEED_BOOST_BASE,
    PRISM_SPEED_BOOST_PER_TIER,
    setPrismLevelsDirty,
    setOutputLevelsDirty,
    getCachedInputKeys,
    getCachedInputsStamp,
    setCachedInputKeys,
    setCachedInputsStamp,
    getInflightDirty: () => inflightDirty,
    getInflightStepDirty: () => inflightStepDirty,
    setInflightDirty: (v) => {
      inflightDirty = !!v;
    },
    setInflightStepDirty: (v) => {
      inflightStepDirty = !!v;
    },
    getInflightLastSaveTick: () => lastSaveTick,
    setInflightLastSaveTick: (v) => {
      lastSaveTick = v;
    },
    getLevelsDirty: () => levelsDirty,
    setLevelsDirty,
    getLevelsLastSaveTick: () => lastLevelsSaveTick,
    setLevelsLastSaveTick: (v) => {
      lastLevelsSaveTick = v;
    },
    getOutputLevelsDirty: () => outputLevelsDirty,
    setOutputLevelsDirty,
    getOutputLevelsLastSaveTick: () => lastOutputLevelsSaveTick,
    setOutputLevelsLastSaveTick: (v) => {
      lastOutputLevelsSaveTick = v;
    },
    getPrismLevelsDirty: () => prismLevelsDirty,
    setPrismLevelsDirty,
    getPrismLevelsLastSaveTick: () => lastPrismLevelsSaveTick,
    setPrismLevelsLastSaveTick: (v) => {
      lastPrismLevelsSaveTick = v;
    },
  });

  if (managers) {
    ({
      virtualInventoryManager,
      cacheManager,
      levelsManager,
      queuesManager,
      inputQueuesManager,
      finalizeManager,
      resolveBlockInfo,
      dropItemAt,
      resolvePrismKeysFromWorld,
      getFilterForBlock,
      noteOutputTransfer,
      services,
      beginTickPhase,
      refreshPrismPhase,
      scanDiscoveryPhase,
      pushTransfersPhase,
      pushTransferHandlers,
      attemptTransferForPrismPhase,
      attemptTransferForPrismHandler,
      processQueuesPhase,
      updateVirtualStatePhase,
      processInputQueuesPhase,
      persistAndReportPhase,
      scanTransfersPhase,
      tickGuardsPhase,
      markAdjacentPrismsDirty,
    } = managers);
  } else {
    safeInitLog("§c[Chaos Transfer]", "initManagers returned null");
  }

  function wrapPhase(phase) {
    if (!phase || typeof phase.run !== "function") {
      return { name: "missingPhase", run: () => ({ ok: false, stop: true, reason: "missing_phase" }) };
    }

    return {
      name: phase.name || "phase",
      warnMs: phase.warnMs,
      hardStopMs: phase.hardStopMs,
      run(ctx) {
        const result = phase.run(ctx);
        if (result && typeof result === "object") {
          for (const [k, v] of Object.entries(result)) {
            if (k === "ok" || k === "stop" || k === "reason") continue;
            if (v !== undefined) ctx[k] = v;
          }
        }
        return result;
      },
    };
  }

  const pipeline = createTransferPipeline({
    name: "TransferPipeline",
    phases: [
      wrapPhase(beginTickPhase),
      wrapPhase(refreshPrismPhase),
      wrapPhase(scanDiscoveryPhase),
      wrapPhase(pushTransfersPhase),
      wrapPhase(attemptTransferForPrismPhase),
      wrapPhase(processQueuesPhase),
      wrapPhase(updateVirtualStatePhase),
      wrapPhase(processInputQueuesPhase),
      wrapPhase(scanTransfersPhase),
      wrapPhase(persistAndReportPhase),
    ],
  });

  const startup = createTransferStartup({
    system,
    world,
    getTickId: () => tickId,
    setTickId: (v) => {
      tickId = v;
    },
    onTick,
    levelsManager,
    inflight,
    fluxFxInflight,
    cacheManager,
    getInventoryContainer,
    isFurnaceBlock,
    markAdjacentPrismsDirty,
    loadInflightState,
    loadLevelsState,
    loadOutputLevelsState,
    loadPrismLevelsState,
    sendInitMessage,
    logError,
  });

  unsubscribeEvents = subscribeTransferDirtyEvents({
    world,
    cacheManager,
    markAdjacentPrismsDirty,
    getInventoryContainer,
    isFurnaceBlock,
    logError,
    debugLog: (msg) => sendDiagnosticMessage(String(msg || ""), "transfer"),
    state: controllerState,
  });

  function start() {
    startup.start();
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

  function _perfLogIfNeeded(label, ms, extra) {
    if (ms > 10 || ((nowTick % 200) === 0 && nowTick > 0)) {
      if (extra) {
        sendDiagnosticMessage("[PERF] " + label + ": " + ms + "ms (" + extra + ")", "transfer");
      } else {
        sendDiagnosticMessage("[PERF] " + label + ": " + ms + "ms", "transfer");
      }
    }
  }

  // Track tick timing to detect watchdog issues

  function onTick() {
    nowTick++;

    // ============================
    // PHASE: TICK (Begin)
    // ============================
    // EMERGENCY SAFEGUARD: Check if previous tick was too long - skip this tick if so
    const guardResult = tickGuardsPhase.run({ nowTick, sendDiagnosticMessage });
    if (guardResult?.stop) {
      return; // Skip entire tick to avoid watchdog
    }
    // Optional startup ping (only visible to players with lens/goggles + extended debug group "transfer")
    if (nowTick <= 5) {
      sendDiagnosticMessage("[Init] onTick() running (tick=" + nowTick + ")", "transfer");
    }

    const ctx = createTickContext({
      nowTick,
      cfg,
      world,
      system,
      sendDiagnosticMessage,
      debugEnabled,
      debugState,
      services,
      managers: {
        cacheManager,
        queuesManager,
        inputQueuesManager,
        virtualInventoryManager,
      },
    });

    activeTickContext = ctx;

    orbFxBudgetUsed.value = 0;

    try {
      runTransferPipeline(pipeline, ctx);
    } finally {
      activeTickContext = null;
    }
  }

  function getPrismKeys() {
    if (activeTickContext?.prismKeys) return activeTickContext.prismKeys;
    return resolvePrismKeysFromWorld();
  }

  function makeResult(ok, reason) {
    return { ok: !!ok, reason: reason || (ok ? "ok" : "fail") };
  }

  // Unified push/pull transfer for prisms
  function attemptTransferForPrism(prismKey, searchBudget) {
    if (typeof attemptTransferForPrismHandler !== "function") {
      return { ok: false, reason: "no_attempt_handler", searchesUsed: 0 };
    }
    return attemptTransferForPrismHandler(prismKey, searchBudget);
  }

  // Legacy function name
  function attemptTransferOne(inputKey) {
    const result = attemptTransferForPrism(inputKey, cfg.maxSearchesPerTick);
    return makeResult(result.ok, result.reason);
  }

  // Helper: Attempt transfer with known destination and route (used by queue processing)
  function attemptPushTransferWithDestination(prismKey, prismBlock, dim, inventories, itemSource, destInfo, route, filterSet, queueEntry) {
    const fn = pushTransferHandlers.attemptPushTransferWithDestination;
    if (typeof fn !== "function") {
      return { ...makeResult(false, "no_push_handler"), amount: 0 };
    }
    return fn(prismKey, prismBlock, dim, inventories, itemSource, destInfo, route, filterSet, queueEntry);
  }

  // Push transfer: extract items from this prism's inventories and send to other prisms
  function attemptPushTransfer(prismKey, prismBlock, dim, inventories, itemSource, filterSet, searchBudget) {
    const fn = pushTransferHandlers.attemptPushTransfer;
    if (typeof fn !== "function") {
      return { ...makeResult(false, "no_push_handler"), searchesUsed: 0 };
    }
    return fn(prismKey, prismBlock, dim, inventories, itemSource, filterSet, searchBudget);
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

  function getCacheManager() {
    return cacheManager || null;
  }

  return { start, stop, getCacheManager };
}





























































