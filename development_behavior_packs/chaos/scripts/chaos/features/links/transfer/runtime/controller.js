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
import { canonicalizePrismKey, key, parseKey, getContainerKey, getContainerKeyFromInfo } from "../keys.js";
import {
  createTickContext,
  createBeginTickPhase,
  createTickGuardsPhase,
  createRefreshPrismRegistryPhase,
  createScanDiscoveryPhase,
  createValidateLinksPhase,
  createUpdateBeamsPhase,
  createHandleBeamBreaksPhase,
  createPushTransfersPhase,
  createAttemptTransferForPrismPhase,
  createProcessQueuesPhase,
  createUpdateVirtualStatePhase,
  createProcessInputQueuesPhase,
  createPersistAndReportPhase,
  createScanTransfersPhase,
  createHybridTransfersPhase,
} from "./index.js";
import { initManagers } from "./bootstrap/initManagers.js";
import { createTransferStartup } from "./bootstrap/startup.js";
import { createGetSpeed } from "./helpers/speed.js";
import { createPrismRegistry } from "./registry/prismRegistry.js";
import { createLinkGraph } from "./registry/linkGraph.js";
import { subscribeLinkEvents } from "./events/linkEvents.js";

// Persistence
import {
  loadInputLevels,
  saveInputLevels,
  loadOutputLevels,
  saveOutputLevels,
  loadPrismLevels,
  savePrismLevels,
  loadPrismRegistry,
  savePrismRegistry,
  loadLinkGraph,
  saveLinkGraph,
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
import { createTransferPathfinder } from "../pathfinding/pathfinder.js";

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
  emitTrace,
  emitInsightError,
  markDirty as traceMarkDirty,
  clearDirty as traceClearDirty,
  noteScan as traceNoteScan,
  noteError as traceNoteError,
  noteQueueSize as traceNoteQueueSize,
  notePathfind as traceNotePathfind,
  noteTransferResult as traceNoteTransferResult,
  noteNeighborInventories as traceNoteNeighborInventories,
  noteVirtualCapacity as traceNoteVirtualCapacity,
  noteVirtualCapacityReason as traceNoteVirtualCapacityReason,
  noteCooldown as traceNoteCooldown,
} from "../../../../core/insight/trace.js";
import { noteDuration, noteCount } from "../../../../core/insight/perf.js";
import { noteWatchdog } from "../../../../core/insight/transferStats.js";

// Cross-feature filters
import { getFilterSetForBlock } from "../../shared/filters.js";

// Flux / crystallizer / FX (chaos root is 3 levels up)
import { tryGenerateFluxOnTransfer, tryRefineFluxInTransfer, getFluxTier, isFluxTypeId } from "../../../../flux.js";
import { addFluxForItem, getFluxValueForItem } from "../../../../crystallizer.js";
import { fxFluxGenerate, queueFxParticle } from "../../../../fx/fx.js";


function createDirtyTracker(keys) {
  const known = new Set(Array.isArray(keys) ? keys : []);
  const dirty = new Set();

  function hasKey(key) {
    return known.size === 0 || known.has(key);
  }

  return {
    mark(key) {
      if (!hasKey(key)) return;
      dirty.add(key);
    },
    clear(key) {
      dirty.delete(key);
    },
    set(key, value) {
      if (!hasKey(key)) return;
      if (value) dirty.add(key);
      else dirty.delete(key);
    },
    isDirty(key) {
      return dirty.has(key);
    },
    any() {
      return dirty.size > 0;
    },
    shouldSave(key, nowTick, lastSaveTick, interval) {
      if (!dirty.has(key)) return false;
      if (!Number.isFinite(interval)) return true;
      return (nowTick - lastSaveTick) >= interval;
    },
  };
}

const DIRTY = {
  INF: "inflight",
  INF_STEP: "inflightStep",
  LEVELS: "levels",
  OUT: "outputLevels",
  PRISM: "prismLevels",
};

export function createNetworkTransferController(deps = {}, opts) {
  // Deps (keep names identical)
  const {
    world,
    system,
    FX,
    getSpeedForInput,
    getLastDebugTick = () => 0,
    setLastDebugTick = () => {},
    debugInterval: injectedDebugInterval,
    debugEnabled: injectedDebugEnabled,
    debugState: injectedDebugState = null,
    getCursor = () => null,
    setCursor = () => {},
    logError: injectedLogError,
    handleManagerCreationError: injectedHandleManagerCreationError,
  } = deps || {};

  const cfg = mergeCfg(DEFAULTS, opts);
  let activeTickContext = null;

  const prismRegistry = createPrismRegistry({ world, cfg, emitInsightError });
  const linkGraph = createLinkGraph({ world, cfg });
  const pathfinder = createTransferPathfinder(
    { world, linkGraph, getNetworkStamp: () => linkGraph.getGraphStamp() },
    cfg
  );
  const findPathForInput = pathfinder.findPathForInput;
  const invalidateInput = pathfinder.invalidateInput;
  const getPathStats = pathfinder.getAndResetStats;
  const getNetworkStamp = () => linkGraph.getGraphStamp();

  const linkEvents = subscribeLinkEvents({
    world,
    system,
    prismRegistry,
    linkGraph,
    debugLog: () => {},
  });
  const getBeamBreaks = () =>
    linkEvents?.drainBeamBreaks?.(Math.max(1, Number(cfg.beamBreaksPerTick || 32) | 0)) || [];

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
  let lastSaveTick = 0;

  // Levels / stats persistence state
  const transferCounts = new Map();
  let lastLevelsSaveTick = 0;

  const outputCounts = new Map();
  let lastOutputLevelsSaveTick = 0;

  const prismCounts = new Map();
  let lastPrismLevelsSaveTick = 0;

  // Queues
  const queueByContainer = new Map();
  const fullContainers = new Set();
  let fullCursor = 0;
  let queueCursor = 0;
  function getQueueState() {
    return {
      queueByContainer,
      fullContainers,
    };
  }
  function clearBackoff(prismKey) {
    if (!prismKey) return;
    try {
      inputBackoff.delete(prismKey);
    } catch {}
    try {
      nextAllowed.delete(prismKey);
    } catch {}
    try {
      nextQueueTransferAllowed.delete(prismKey);
    } catch {}
  }
  function bumpBackoff(prismKey) {
    if (!prismKey) return 0;
    const prev = inputBackoff.has(prismKey) ? (inputBackoff.get(prismKey) | 0) : 0;
    const maxLevel = Math.max(0, cfg.backoffMaxLevel | 0);
    const level = Math.max(0, Math.min(maxLevel, prev + 1));
    inputBackoff.set(prismKey, level);
    return level;
  }
  function getBackoffTicks(level) {
    const lvl = Math.max(0, level | 0);
    if (lvl <= 0) return 0;
    const base = Math.max(1, cfg.backoffBaseTicks | 0);
    const maxTicks = Math.max(base, cfg.backoffMaxTicks | 0);
    const ticks = base * (2 ** lvl);
    return Math.min(maxTicks, Math.max(base, ticks | 0));
  }
  function getCachedInputKeys() {
    return cachedInputKeys;
  }
  function setCachedInputKeys(value) {
    cachedInputKeys = value;
  }
  function getCachedInputsStamp() {
    return cachedInputsStamp;
  }
  function setCachedInputsStamp(value) {
    cachedInputsStamp = value;
  }

  // Debug config & state
  // Force debug enabled if config says so (don't let FX override it)
  const defaultDebugEnabled = !!(cfg.debugTransferStats === true || FX?.debugTransferStats === true);
  const debugEnabled =
    typeof injectedDebugEnabled === "boolean" ? injectedDebugEnabled : defaultDebugEnabled;
  const defaultDebugInterval = Math.max(
    20,
    Number(cfg.debugTransferStatsIntervalTicks || FX?.debugTransferStatsIntervalTicks) || 100
  );
  const debugInterval =
    Number.isFinite(injectedDebugInterval) ? injectedDebugInterval : defaultDebugInterval;

  // Debug stats are surfaced via Insight v2 when enhanced mode is active.
  const debugState =
    injectedDebugState ||
    {
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
    phaseMs: Object.create(null),
    phaseRuns: Object.create(null),
    phaseLastMs: Object.create(null),
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
  function defaultLogError(message, err) {
    safeInitLog("§c[Chaos Transfer]", message, err);
  }
  function defaultHandleManagerCreationError(managerName, err) {
    defaultLogError("Failed to create " + managerName, err);
    throw err;
  }
  const logError =
    typeof injectedLogError === "function" ? injectedLogError : defaultLogError;
  const handleManagerCreationError =
    typeof injectedHandleManagerCreationError === "function"
      ? injectedHandleManagerCreationError
      : defaultHandleManagerCreationError;
  function guardDebugDependencies() {
    if (!debugEnabled) return;
    const missing = [];
    if (!world || typeof world.getAllPlayers !== "function") {
      missing.push("world.getAllPlayers");
    }
    if (!system || typeof system.runInterval !== "function") {
      missing.push("system.runInterval");
    }
    if (missing.length === 0) return;
    const msg = "Debug dependencies missing: " + missing.join(", ");
    safeInitLog("§e[Chaos Transfer]", msg);
    logError(msg);
  }
  guardDebugDependencies();
    const dirty = createDirtyTracker(Object.values(DIRTY));

  function setLevelsDirty(v) {
    dirty.set(DIRTY.LEVELS, !!v);
  }

  function setOutputLevelsDirty(v) {
    dirty.set(DIRTY.OUT, !!v);
  }

  function setPrismLevelsDirty(v) {
    dirty.set(DIRTY.PRISM, !!v);
  }

  function getLevelsDirty() {
    return dirty.isDirty(DIRTY.LEVELS);
  }

  function getOutputLevelsDirty() {
    return dirty.isDirty(DIRTY.OUT);
  }

  function getPrismLevelsDirty() {
    return dirty.isDirty(DIRTY.PRISM);
  }

  function getInflightDirty() {
    return dirty.isDirty(DIRTY.INF);
  }

  function setInflightDirty(v) {
    dirty.set(DIRTY.INF, !!v);
  }

  function getInflightStepDirty() {
    return dirty.isDirty(DIRTY.INF_STEP);
  }

  function setInflightStepDirty(v) {
    dirty.set(DIRTY.INF_STEP, !!v);
  }

  let runtimeReady = false;

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
  let validateLinksPhase = null;
  let handleBeamBreaksPhase = null;
  let updateBeamsPhase = null;
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
  let hybridTransfersPhase = null;
  let tickGuardsPhase = null;
  let markAdjacentPrismsDirty = null;

  const runtime = {
    core: {
      cfg,
      world,
      system,
      FX,
      debug: {
      enabled: debugEnabled,
      interval: debugInterval,
      state: debugState,
      getLastTick: getLastDebugTick,
      setLastTick: setLastDebugTick,
      sendInitMessage,
      logError,
      handleManagerCreationError,
      },
      state: {
      tick: {
        getNowTick: () => nowTick,
      },
      cursor: {
        get: getCursor,
        set: setCursor,
      },
      queues: {
        queueByContainer,
        fullContainers,
        getQueueState,
      },
      backoff: {
        inputBackoff,
        nextAllowed,
        nextQueueTransferAllowed,
        clearBackoff,
        bumpBackoff,
        getBackoffTicks,
      },
      inflight: {
        list: inflight,
        fluxFxInflight,
        orbFxBudgetUsed,
        getDirty: getInflightDirty,
        setDirty: setInflightDirty,
        getStepDirty: getInflightStepDirty,
        setStepDirty: setInflightStepDirty,
        getLastSaveTick: () => lastSaveTick,
        setLastSaveTick: (v) => {
          lastSaveTick = v;
        },
      },
      levels: {
        transferCounts,
        outputCounts,
        prismCounts,
        getDirty: getLevelsDirty,
        setDirty: setLevelsDirty,
        getLastSaveTick: () => lastLevelsSaveTick,
        setLastSaveTick: (v) => {
          lastLevelsSaveTick = v;
        },
        getOutputDirty: getOutputLevelsDirty,
        setOutputDirty: setOutputLevelsDirty,
        getOutputLastSaveTick: () => lastOutputLevelsSaveTick,
        setOutputLastSaveTick: (v) => {
          lastOutputLevelsSaveTick = v;
        },
        getPrismDirty: getPrismLevelsDirty,
        setPrismDirty: setPrismLevelsDirty,
        getPrismLastSaveTick: () => lastPrismLevelsSaveTick,
        setPrismLastSaveTick: (v) => {
          lastPrismLevelsSaveTick = v;
        },
      },
      dirty: {
        shouldSave: (key, nowTick, lastSaveTick, interval) =>
          dirty.shouldSave(key, nowTick, lastSaveTick, interval),
        keys: DIRTY,
      },
      cachedInputs: {
        getCachedInputKeys,
        getCachedInputsStamp,
        setCachedInputKeys,
        setCachedInputsStamp,
      },
      ready: false,
      },
      constants: {
        CRYSTALLIZER_ID,
        CRYSTAL_FLUX_WEIGHT,
        MAX_STEPS,
        SPEED_SCALE_MAX,
        PRISM_SPEED_BOOST_BASE,
        PRISM_SPEED_BOOST_PER_TIER,
      },
      helpers: {
        getContainerKey,
        getContainerKeyFromInfo,
        key,
        parseKey,
      },
      events: {
        getBeamBreaks,
      },
    },
    factories: {
      createVirtualInventoryManager,
      createCacheManager,
      createLevelsManager,
      createFxManager,
      createQueuesManager,
      createInputQueuesManager,
      createRefinementManager,
      createFinalizeManager,
      createInflightProcessorManager,
    },
    phases: {
      createBeginTickPhase,
      createRefreshPrismRegistryPhase,
      createScanDiscoveryPhase,
      createValidateLinksPhase,
      createUpdateBeamsPhase,
      createHandleBeamBreaksPhase,
      createPushTransfersPhase,
      createAttemptTransferForPrismPhase,
      createProcessQueuesPhase,
      createUpdateVirtualStatePhase,
      createProcessInputQueuesPhase,
      createPersistAndReportPhase,
      createScanTransfersPhase,
      createHybridTransfersPhase,
      createTickGuardsPhase,
    },
    adapters: {
      registry: {
        prismRegistry,
        linkGraph,
      },
      inventory: {
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
      },
      filters: {
      getFilterContainer,
      getFilterSet,
      getFilterSetForBlock,
      },
      reservations: {
      getInsertCapacityWithReservations,
      getReservedForContainer,
      reserveContainerSlot,
      releaseContainerSlot,
      clearReservations,
      },
      persistence: {
        loadInflightStateFromWorld,
        persistInflightStateToWorld,
        loadInputLevels,
        saveInputLevels,
        loadOutputLevels,
        saveOutputLevels,
        loadPrismLevels,
        savePrismLevels,
        loadPrismRegistry,
        savePrismRegistry,
        loadLinkGraph,
        saveLinkGraph,
      },
      flux: {
      tryGenerateFluxOnTransfer,
      tryRefineFluxInTransfer,
      getFluxTier,
      isFluxTypeId,
      addFluxForItem,
      getFluxValueForItem,
      fxFluxGenerate,
      queueFxParticle,
      },
      transfer: {
      getSpeedForInput,
      findPathForInput,
      invalidateInput,
      getPathStats,
      getNetworkStamp,
      getSpeed,
      },
      prism: {
      isPrismBlock,
      getPrismTier,
    },
    },
    algorithms: {
      balance: {
        calculateBalancedTransferAmount,
      },
      routing: {
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
      },
      tracing: {
        traceMarkDirty,
        traceClearDirty,
        traceNoteScan,
        traceNoteError,
        traceNoteQueueSize,
        traceNotePathfind,
        traceNoteNeighborInventories,
        traceNoteVirtualCapacity,
        traceNoteVirtualCapacityReason,
        traceNoteTransferResult,
        traceNoteCooldown,
      },
    },
    functions: {
      getPrismKeys: () => {
        if (activeTickContext?.prismKeys) return activeTickContext.prismKeys;
        if (resolvePrismKeysFromWorld) return resolvePrismKeysFromWorld();
        return [];
      },
      attemptTransferForPrism: (prismKey, searchBudget) =>
        (runtimeReady && typeof attemptTransferForPrismHandler === "function")
          ? attemptTransferForPrism(prismKey, searchBudget)
          : ({ ok: false, reason: "not_ready", searchesUsed: 0 }),
      attemptPushTransferWithDestination: (
        prismKey,
        prismBlock,
        dim,
        inventories,
        itemSource,
        destInfo,
        route,
        filterSet,
        queueEntry
      ) =>
        (runtimeReady && typeof pushTransferHandlers.attemptPushTransferWithDestination === "function")
          ? attemptPushTransferWithDestination(
              prismKey,
              prismBlock,
              dim,
              inventories,
              itemSource,
              destInfo,
              route,
              filterSet,
              queueEntry
            )
          : ({ ok: false, reason: "not_ready", amount: 0 }),
      attemptPushTransfer: (prismKey, prismBlock, dim, inventories, itemSource, filterSet, searchBudget) =>
        (runtimeReady && typeof pushTransferHandlers.attemptPushTransfer === "function")
          ? attemptPushTransfer(prismKey, prismBlock, dim, inventories, itemSource, filterSet, searchBudget)
          : ({ ok: false, reason: "not_ready", searchesUsed: 0 }),
      makeMarkAdjacentPrismsDirty: (deps) => createAdjacentPrismDirtyMarker(deps),
      _perfLogIfNeeded,
      runTransferPipeline,
    },
  };

  const managers = initManagers(runtime);

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
      validateLinksPhase,
      handleBeamBreaksPhase,
      updateBeamsPhase,
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
      hybridTransfersPhase,
      tickGuardsPhase,
      markAdjacentPrismsDirty,
    } = managers);
    runtimeReady = true;
    runtime.core.state.ready = true;
  } else {
    safeInitLog("§c[Chaos Transfer]", "initManagers returned null");
  }

  function wrapPhase(phase, debugStateRef) {
    if (!phase || typeof phase.run !== "function") {
      return { name: "missingPhase", run: () => ({ ok: false, stop: true, reason: "missing_phase" }) };
    }

    return {
      name: phase.name || "phase",
      warnMs: phase.warnMs,
      hardStopMs: phase.hardStopMs,
      run(ctx) {
        const start = Date.now();
        const result = phase.run(ctx);
        const elapsed = Date.now() - start;
        const name = phase.name || "phase";
        if (Number.isFinite(elapsed)) {
          noteDuration("transfer", name, elapsed);
        }
        if (debugEnabled && debugStateRef && Number.isFinite(elapsed)) {
          debugStateRef.phaseMs[name] = (debugStateRef.phaseMs[name] || 0) + elapsed;
          debugStateRef.phaseRuns[name] = (debugStateRef.phaseRuns[name] || 0) + 1;
          debugStateRef.phaseLastMs[name] = elapsed;
        }
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

  const transferPhases = [
    wrapPhase(beginTickPhase, debugState),
    wrapPhase(refreshPrismPhase, debugState),
    wrapPhase(handleBeamBreaksPhase, debugState),
    wrapPhase(validateLinksPhase, debugState),
    wrapPhase(updateBeamsPhase, debugState),
    wrapPhase(scanDiscoveryPhase, debugState),
  ];

  if (cfg?.useHybridDriftAttune) {
    transferPhases.push(wrapPhase(hybridTransfersPhase, debugState));
  } else {
    transferPhases.push(
      wrapPhase(pushTransfersPhase, debugState),
      wrapPhase(attemptTransferForPrismPhase, debugState),
      wrapPhase(processQueuesPhase, debugState),
      wrapPhase(updateVirtualStatePhase, debugState),
      wrapPhase(processInputQueuesPhase, debugState),
      wrapPhase(scanTransfersPhase, debugState)
    );
  }

  transferPhases.push(wrapPhase(persistAndReportPhase, debugState));

  const pipeline = createTransferPipeline({
    name: "TransferPipeline",
    phases: transferPhases,
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
    prismRegistry,
    linkGraph,
  });

  unsubscribeEvents = subscribeTransferDirtyEvents({
    world,
    cacheManager,
    markAdjacentPrismsDirty,
    getInventoryContainer,
    isFurnaceBlock,
    logError,
    debugLog: (msg) => {
      const text = msg != null ? String(msg) : "";
      if (!text) return;
      emitTrace(null, "transfer", { text, category: "transfer", dedupeKey: text });
    },
    state: controllerState,
    linkGraph,
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
      dirty.clear(DIRTY.INF);
      dirty.clear(DIRTY.INF_STEP);
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
      dirty.clear(DIRTY.INF);
      dirty.clear(DIRTY.INF_STEP);
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
        const canonical = canonicalizePrismKey(k);
        if (!canonical) continue;
        countsMap.set(canonical, n | 0);
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
        dirty.set(DIRTY.LEVELS, !!v);
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
        dirty.set(DIRTY.OUT, !!v);
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
        dirty.set(DIRTY.PRISM, !!v);
      },
      (v) => {
        lastPrismLevelsSaveTick = v;
      }
    );
  }

  function _perfLogIfNeeded(label, ms, extra) {
    if (ms > 10 || ((nowTick % 200) === 0 && nowTick > 0)) {
      if (extra) {
        noteWatchdog("PERF", label + ": " + ms + "ms (" + extra + ")", nowTick);
      } else {
        noteWatchdog("PERF", label + ": " + ms + "ms", nowTick);
      }
    }
  }

  // Track tick timing to detect watchdog issues

  function onTick() {
    nowTick++;
    noteCount("transfer", "ticks", 1);

    // ============================
    // PHASE: TICK (Begin)
    // ============================
    // EMERGENCY SAFEGUARD: Check if previous tick was too long - skip this tick if so
    const guardResult = tickGuardsPhase.run({ nowTick, emitTrace, noteWatchdog });
    if (guardResult?.stop) {
      return; // Skip entire tick to avoid watchdog
    }

    const ctx = createTickContext({
      nowTick,
      cfg,
      world,
      system,
      emitTrace,
      noteWatchdog,
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

    const tickStart = Date.now();
    try {
      runTransferPipeline(pipeline, ctx);
    } finally {
      const elapsed = Date.now() - tickStart;
      if (Number.isFinite(elapsed)) {
        noteDuration("transfer", "tick", elapsed);
      }
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

































































