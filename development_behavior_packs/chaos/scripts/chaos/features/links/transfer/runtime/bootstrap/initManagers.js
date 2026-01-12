// scripts/chaos/features/links/transfer/runtime/bootstrap/initManagers.js

import { createGetFilterForBlock } from "../helpers/filters.js";
import { createDropItemAt } from "../helpers/items.js";
import { createResolvePrismKeysFromWorld } from "../helpers/prismKeys.js";
export function initManagers(deps) {
  const {
    cfg,
    world,
    FX,
    debugEnabled,
    debugState,
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
    getNetworkStamp,
    getSpeed,
    attemptTransferForPrism,
    attemptPushTransferWithDestination,
    attemptPushTransfer,
    makeMarkAdjacentPrismsDirty,
    _perfLogIfNeeded,
    getNowTick,
    debugInterval,
    getLastDebugTick,
    setLastDebugTick,
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
    getInflightDirty,
    getInflightStepDirty,
    setInflightDirty,
    setInflightStepDirty,
    getInflightLastSaveTick,
    setInflightLastSaveTick,
    getLevelsDirty,
    setLevelsDirty,
    getLevelsLastSaveTick,
    setLevelsLastSaveTick,
    getOutputLevelsDirty,
    setOutputLevelsDirty,
    getOutputLevelsLastSaveTick,
    setOutputLevelsLastSaveTick,
    getPrismLevelsDirty,
    setPrismLevelsDirty,
    getPrismLevelsLastSaveTick,
    setPrismLevelsLastSaveTick,
    getCachedInputKeys,
    getCachedInputsStamp,
    setCachedInputKeys,
    setCachedInputsStamp,
  } = deps || {};

  // ============================
  // PHASE: INIT (Managers)
  // ============================
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
    sendInitMessage("§a[Init] ? virtualInventoryManager created");
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
    sendInitMessage("§a[Init] ? cacheManager created");
  } catch (err) {
    handleManagerCreationError("cacheManager", err);
  }

  function resolveBlockInfo(inputKey) {
    return cacheManager.resolveBlockInfoCached(inputKey);
  }

  const markAdjacentPrismsDirty =
    (typeof makeMarkAdjacentPrismsDirty === "function")
      ? makeMarkAdjacentPrismsDirty({
          virtualInventoryManager,
          invalidateInput,
          cacheManager,
        })
      : () => {};

  const dropItemAt = createDropItemAt({
    findDropLocation,
  });

  const resolvePrismKeysFromWorld = createResolvePrismKeysFromWorld({
    getNetworkStamp,
    getCachedInputKeys,
    getCachedInputsStamp,
    setCachedInputKeys,
    setCachedInputsStamp,
    loadBeamsMap,
    world,
    cacheManager,
    isPrismBlock,
    debugEnabled,
    debugState,
  });

  const getFilterForBlock = createGetFilterForBlock({
    world,
    getFilterContainer,
    getFilterSetForBlock,
  });

   function createOrFail(stepLabel, managerName, factoryFn) {
    try {
      const manager = factoryFn();
      if (!manager) throw new Error(managerName + " factory returned null/undefined");
      sendInitMessage("§a[Init] ? " + stepLabel);
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
          prismLevelsDirty: { set: (v) => { if (typeof setPrismLevelsDirty === "function") { setPrismLevelsDirty(v); } } },
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
          prismLevelsDirty: { set: (v) => { if (typeof setPrismLevelsDirty === "function") { setPrismLevelsDirty(v); } } },
        },
        { spawnLevelUpBurst }
      );
    }
  );

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
    if (typeof setOutputLevelsDirty === "function") {
      setOutputLevelsDirty(true);
    }

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

  const services = {
    cacheManager,
    queuesManager,
    inputQueuesManager,
    virtualInventoryManager,
    levelsManager,
    fxManager,
    refinementManager,
    inflightProcessorManager,
    sendDiagnosticMessage,
    resolveBlockInfo,
    getFilterForBlock,
    getFilterSet,
    getContainerKey,
    getAttachedInventoryInfo,
    getQueueState,
    getTotalCountForType,
    calculateBalancedTransferAmount,
    validatePathStart,
    buildNodePathSegments,
    findFirstPrismKeyInPath,
    reserveContainerSlot,
    inflight,
    setInflightDirty: (v) => {
      if (v) inflightDirty = true;
    },
    debugEnabled,
    debugState,
    getNowTick: () => nowTick,
    findPathForInput,
    invalidateInput,
    pickWeightedRandomWithBias,
    isPrismBlock,
    getPrismTier,
    CRYSTALLIZER_ID,
    CRYSTAL_FLUX_WEIGHT,
    MAX_STEPS,
    isFluxTypeId,
    makeResult: (ok, reason) => ({ ok: !!ok, reason: reason || (ok ? "ok" : "fail") }),
    resolvePrismKeys: resolvePrismKeysFromWorld,
  };

  const beginTickPhase = createBeginTickPhase({
    cfg,
    services,
  });

  const refreshPrismPhase = createRefreshPrismRegistryPhase({
    services,
  });

  const scanDiscoveryPhase = createScanDiscoveryPhase({
    services,
  });

  const pushTransfersPhase = createPushTransfersPhase({
    cfg,
    services,
  });

  const pushTransferHandlers = pushTransfersPhase.handlers || {};

  const attemptTransferForPrismPhase = createAttemptTransferForPrismPhase({
    cfg,
    cacheManager,
    levelsManager,
    queuesManager,
    inputQueuesManager,
    virtualInventoryManager,
    getFilterForBlock,
    getFilterSet,
    getContainerKey,
    getContainerKeyFromInfo,
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
    getInsertCapacityWithReservations,
    getReservedForContainer,
    reserveContainerSlot,
    releaseContainerSlot,
    clearReservations,
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
    getFilterSetForBlock,
    isPrismBlock,
    getPrismTier,
    CRYSTALLIZER_ID,
    CRYSTAL_FLUX_WEIGHT,
    MAX_STEPS,
    SPEED_SCALE_MAX,
    PRISM_SPEED_BOOST_BASE,
    PRISM_SPEED_BOOST_PER_TIER,
    getSpeedForInput,
    findPathForInput,
    invalidateInput,
    getPathStats,
    getNetworkStamp,
    loadInflightStateFromWorld,
    persistInflightStateToWorld,
    loadInputLevels,
    saveInputLevels,
    loadOutputLevels,
    saveOutputLevels,
    loadPrismLevels,
    savePrismLevels,
    sendDiagnosticMessage,
    sendInitMessage,
    logError,
    debugEnabled,
    debugState,
    inputBackoff,
    nextAllowed,
    nextQueueTransferAllowed,
    inflight,
    fluxFxInflight,
    orbFxBudgetUsed,
    outputCounts,
    prismCounts,
    queueByContainer,
    fullContainers,
    getQueueState,
    resolveBlockInfo,
    resolvePrismKeysFromWorld,
    attemptPushTransferWithDestination,
    attemptPushTransfer,
    noteOutputTransfer,
    dropItemAt,
    markAdjacentPrismsDirty,
    fxManager,
    refinementManager,
    getNowTick: () => nowTick,
    makeResult: (ok, reason) => ({ ok: !!ok, reason: reason || (ok ? "ok" : "fail") }),
  });

  const attemptTransferForPrismHandler = attemptTransferForPrismPhase.handler;

  const processQueuesPhase = createProcessQueuesPhase({
    queuesManager,
    inflightProcessorManager,
    inflight,
    fluxFxInflight,
    debugEnabled,
    debugState,
    getNowTick: () => nowTick,
    sendDiagnosticMessage,
    runTransferPipeline,
    perfLogIfNeeded: _perfLogIfNeeded,
    setInflightDirty: (v) => {
      inflightDirty = inflightDirty || !!v;
    },
    setInflightStepDirty: (v) => {
      inflightStepDirty = inflightStepDirty || !!v;
    },
  });

  const updateVirtualStatePhase = createUpdateVirtualStatePhase({
    virtualInventoryManager,
    inputQueuesManager,
    getPrismKeys,
    getQueueState,
    inflight,
    debugEnabled,
    debugState,
    getNowTick: () => nowTick,
    sendDiagnosticMessage,
    sendInitMessage,
  });

  const processInputQueuesPhase = createProcessInputQueuesPhase({
    cfg,
    cacheManager,
    inputQueuesManager,
    getPrismKeys,
    resolveBlockInfo,
    isPrismBlock,
    getPrismTier,
    getFilterForBlock,
    getFilterSet,
    getContainerKey,
    attemptPushTransferWithDestination,
    attemptPushTransfer,
    findPathForInput,
    sendDiagnosticMessage,
    debugEnabled,
    debugState,
    nextQueueTransferAllowed,
    getNowTick: () => nowTick,
  });

  const tickGuardsPhase = createTickGuardsPhase({
    world,
    getNowTick: () => nowTick,
    getLastTickEndTime: () => lastTickEndTime,
    setLastTickEndTime: (v) => {
      lastTickEndTime = v;
    },
    getConsecutiveLongTicks: () => consecutiveLongTicks,
    setConsecutiveLongTicks: (v) => {
      consecutiveLongTicks = v;
    },
  });
  const persistAndReportPhase = createPersistAndReportPhase({
    cfg,
    world,
    inflight,
    persistInflightStateToWorld,
    getInflightDirty,
    getInflightStepDirty,
    setInflightDirty,
    setInflightStepDirty,
    getInflightLastSaveTick,
    setInflightLastSaveTick,
    transferCounts,
    outputCounts,
    prismCounts,
    saveInputLevels,
    saveOutputLevels,
    savePrismLevels,
    getLevelsDirty,
    setLevelsDirty,
    getLevelsLastSaveTick,
    setLevelsLastSaveTick,
    getOutputLevelsDirty,
    setOutputLevelsDirty,
    getOutputLevelsLastSaveTick,
    setOutputLevelsLastSaveTick,
    getPrismLevelsDirty,
    setPrismLevelsDirty,
    getPrismLevelsLastSaveTick,
    setPrismLevelsLastSaveTick,
    sendDiagnosticMessage,
    sendInitMessage,
    debugEnabled,
    debugState,
    debugInterval,
    getLastDebugTick,
    setLastDebugTick,
    inputQueuesManager,
    getQueueState,
    hasInsight,
    getNowTick: () => nowTick,
    getLastTickEndTime: () => lastTickEndTime,
    setLastTickEndTime: (v) => {
      lastTickEndTime = v;
    },
    getConsecutiveLongTicks: () => consecutiveLongTicks,
    setConsecutiveLongTicks: (v) => {
      consecutiveLongTicks = v;
    },
    setEmergencyDisableTicks: (v) => {
      emergencyDisableTicks = v;
    },
  });

  const scanTransfersPhase = createScanTransfersPhase({
    cfg,
    inputQueuesManager,
    virtualInventoryManager,
    getPrismKeys,
    resolveBlockInfo,
    getSpeed,
    attemptTransferForPrism,
    clearBackoff,
    bumpBackoff,
    getBackoffTicks,
    nextAllowed,
    sendDiagnosticMessage,
    debugEnabled,
    debugState,
    getNowTick: () => nowTick,
    getCursor: () => cursor,
    setCursor: (v) => {
      cursor = v;
    },
    persistAndReport: (ctx) => persistAndReportPhase.run(ctx),
  });


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
    sendInitMessage("§a[Init] ? inputQueuesManager created");
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
    sendInitMessage("§a[Init] ? refinementManager created");
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
    sendInitMessage("§a[Init] ? finalizeManager created");
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
    sendInitMessage("§a[Init] ? inflightProcessorManager created");
  } catch (err) {
    handleManagerCreationError("inflightProcessorManager", err);
  }

  // INIT DEBUG: All managers created
  sendInitMessage("§a[Init] ? All managers created! Controller ready.");
  return {
    virtualInventoryManager,
    cacheManager,
    levelsManager,
    fxManager,
    queuesManager,
    inputQueuesManager,
    refinementManager,
    finalizeManager,
    inflightProcessorManager,
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
  };
  }








