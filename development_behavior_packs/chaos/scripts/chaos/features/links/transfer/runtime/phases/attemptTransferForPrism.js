// scripts/chaos/features/links/transfer/runtime/phases/attemptTransferForPrism.js

import { ok, phaseStep } from "../../util/result.js";

export function createAttemptTransferForPrismPhase(deps) {
  const handler = createAttemptTransferForPrismHandler(deps);

  return {
    name: "attemptTransferForPrism",
    handler,
    run(ctx) {
      phaseStep(ctx, "attemptTransferForPrism");
      return handler(ctx);
    },
  };
}

function createAttemptTransferForPrismHandler(deps) {
  const {
    cfg,
    cacheManager,
    levelsManager,
    queuesManager,
    inputQueuesManager,
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
    tryGenerateFluxOnTransfer,
    tryRefineFluxInTransfer,
    getFluxTier,
    isFluxTypeId,
    addFluxForItem,
    getFluxValueForItem,
    fxFluxGenerate,
    queueFxParticle,
    key,
    parseKey,
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
    debugEnabled,
    debugState,
    inputBackoff,
    nextAllowed,
    nextQueueTransferAllowed,
    inflight,
    fluxFxInflight,
    orbFxBudgetUsed,
    cachedInputKeys,
    cachedInputsStamp,
    inputCounts,
    outputCounts,
    prismCounts,
    queueByContainer,
    fullContainers,
    nowTick,
    cursor,
    makeResult,
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
    noteGlobalPathfind,
  } = deps || {};

  function summarizeNeighborInventoryVc(inventories) {
    const fallbackTypeId =
      Array.isArray(inventories) && inventories.length > 0
        ? inventories[0]?.block?.typeId || null
        : null;
    const defaultEvidence = {
      neighborTypeId: fallbackTypeId,
    };
    if (!Array.isArray(inventories) || inventories.length === 0) {
      return { vc: 0, reason: "vc_container_missing", evidence: defaultEvidence };
    }
    for (const inv of inventories) {
      const container = inv?.container;
      const block = inv?.block;
      const neighborTypeId = block?.typeId || fallbackTypeId || null;
      if (!container) continue;
      const size = Number(container.size) || 0;
      let emptySlots = 0;
      let nonEmptySlots = 0;
      for (let slot = 0; slot < size; slot++) {
        const item = container.getItem(slot);
        if (!item || item.amount <= 0) {
          emptySlots++;
        } else {
          nonEmptySlots++;
        }
      }
      const evidence = {
        neighborTypeId,
        size,
        emptySlots,
        nonEmptySlots,
      };
      if (size <= 0) {
        return { vc: 0, reason: "vc_no_slots", evidence };
      }
      if (emptySlots === 0 && nonEmptySlots === 0) {
        return { vc: 0, reason: "vc_no_items", evidence };
      }
      return { vc: 1, reason: null, evidence };
    }
    return { vc: 0, reason: "vc_container_missing", evidence: defaultEvidence };
  }

  const driftMemory = new Map();
  const scanCandidateSlots = Math.max(1, Number(cfg?.scanCandidateSlotsPerInventory) || 18);
  const scanMaxItemTypes = Math.max(1, Number(cfg?.scanMaxItemTypesPerPrism) || 6);
  const lockTtlTicks = Math.max(1, Number(cfg?.scanLockTtlTicks) || 80);
  const driftStickyTtlTicks = Math.max(1, Number(cfg?.scanDriftStickyDestTtlTicks) || 40);

  function getInventoryContainerKey(inv) {
    if (!inv) return null;
    const reference = inv.block || inv.entity;
    if (!reference) return null;
    if (typeof getContainerKey === "function") {
      return getContainerKey(reference);
    }
    return null;
  }

  function collectSourceCandidates(inventories, filterSet, queuedTypes) {
    const candidates = new Map();
    let sawAny = false;
    let sawFiltered = false;
    const slotLimit = Math.max(1, scanCandidateSlots);
    const typeLimit = Math.max(1, scanMaxItemTypes);
    for (let invIndex = 0; invIndex < (inventories?.length || 0); invIndex++) {
      const inv = inventories[invIndex];
      if (!inv || !inv.container) continue;
      const size = Math.max(0, Number(inv.container.size) || 0);
      const limit = Math.min(size, slotLimit);
      for (let slot = 0; slot < limit; slot++) {
        const stack = inv.container.getItem(slot);
        if (!stack || stack.amount <= 0) continue;
        sawAny = true;
        const typeId = stack.typeId;
        if (!typeId) continue;
        if (filterSet && filterSet.has(typeId)) {
          sawFiltered = true;
          continue;
        }
        if (queuedTypes?.has(typeId)) continue;
        if (candidates.has(typeId)) continue;
        candidates.set(typeId, {
          container: inv.container,
          slot,
          stack,
          inventoryIndex: invIndex,
          entity: inv.entity,
          block: inv.block,
        });
        if (candidates.size >= typeLimit) {
          return { candidates, sawAny, sawFiltered };
        }
      }
    }
    return { candidates, sawAny, sawFiltered };
  }

  function cleanupDriftMemory(nowTickLocal) {
    if (!Number.isFinite(nowTickLocal)) return;
    for (const [prism, map] of driftMemory.entries()) {
      for (const [typeId, info] of map.entries()) {
        if (!info || info.expiresAt <= nowTickLocal) {
          map.delete(typeId);
        }
      }
      if (map.size === 0) {
        driftMemory.delete(prism);
      }
    }
  }

  function getDriftDestination(prismKeyLocal, typeId, nowTickLocal) {
    if (!prismKeyLocal || !typeId) return null;
    const map = driftMemory.get(prismKeyLocal);
    if (!map) return null;
    const info = map.get(typeId);
    if (!info) return null;
    if (info.expiresAt <= nowTickLocal) {
      map.delete(typeId);
      if (map.size === 0) driftMemory.delete(prismKeyLocal);
      return null;
    }
    return info.destKey || null;
  }

  function setDriftDestination(prismKeyLocal, typeId, destKey, nowTickLocal) {
    if (!prismKeyLocal || !typeId || !destKey) return;
    const map = driftMemory.get(prismKeyLocal) || new Map();
    map.set(typeId, {
      destKey,
      expiresAt: nowTickLocal + driftStickyTtlTicks,
    });
    driftMemory.set(prismKeyLocal, map);
  }

  function computeDestinationCapacity(targetInventories, typeId, fullContainers) {
    if (!Array.isArray(targetInventories) || targetInventories.length === 0) {
      return 0;
    }
    let total = 0;
    for (const inv of targetInventories) {
      if (!inv || !inv.container) continue;
      const containerKey = getInventoryContainerKey(inv);
      if (fullContainers && containerKey && fullContainers.has(containerKey)) continue;
      const previewStack = { typeId, amount: 1 };
      try {
        const capacity = cacheManager.getInsertCapacityCached(
          containerKey,
          inv.container,
          typeId,
          previewStack
        );
        total += Math.max(0, Number(capacity) || 0);
      } catch (e) {
        continue;
      }
    }
    return total;
  }

  function findDestinationCandidate(
    prismInfoLocal,
    typeId,
    pathOptions,
    { requireSink = false, allowDrift = false, fullContainers = null, nowTickLocal = 0 }
  ) {
    let best = null;
    for (const option of pathOptions || []) {
      if (!option || !option.path || option.path.length === 0) continue;
      if (option.outputKey === prismKey) continue;
      if (option.path.length > MAX_STEPS) continue;
      if (!validatePathStart(prismInfoLocal.dim, option.path)) continue;
      const destInfo = resolveBlockInfo(option.outputKey);
      if (!destInfo || !destInfo.block) continue;
      if (!isPrismBlock(destInfo.block)) continue;
      const targetFilter = getFilterForBlock(destInfo.block);
      const targetFilterSet = targetFilter
        ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter))
        : null;
      const isSink = !!(targetFilterSet && targetFilterSet.has(typeId));
      if (requireSink && !isSink) continue;
      if (!allowDrift && !isSink) continue;
      const targetInventories =
        cacheManager.getPrismInventoriesCached(option.outputKey, destInfo.block, destInfo.dim);
      const capacity = computeDestinationCapacity(targetInventories, typeId, fullContainers);
      if (capacity <= 0) continue;
      if (allowDrift && !isSink) {
        const lastDrift = getDriftDestination(prismKey, typeId, nowTickLocal);
        if (lastDrift && lastDrift === option.outputKey) {
          continue;
        }
      }
      const pathLength = option.path.length;
      const score = capacity * 1000 - pathLength * 5 + Math.random();
      if (!best || score > best.score) {
        best = {
          outputKey: option.outputKey,
          path: option.path,
          capacity,
          isSink,
          targetFilterSet,
          score,
        };
      }
    }
    return best;
  }
  function attemptTransferForPrism(prismKey, searchBudget) {
    const nowTick = typeof deps?.getNowTick === "function" ? deps.getNowTick() : 0;
    let searchesUsed = 0;
    const noteScan = (result, note) => {
      if (typeof traceNoteScan === "function") traceNoteScan(prismKey, result, nowTick, note);
    };
    const noteResult = (result) => {
      if (typeof traceNoteTransferResult === "function") traceNoteTransferResult(prismKey, result, nowTick);
    };
    const notePathfind = (ms, status = "ok") => {
      if (typeof traceNotePathfind === "function") traceNotePathfind(prismKey, ms, nowTick, "scan");
      if (typeof noteGlobalPathfind === "function") noteGlobalPathfind(ms, status);
    };

    const prismInfo = resolveBlockInfo(prismKey);
    if (!prismInfo) {
      noteScan("no_prism");
      noteResult("no_prism");
      return { ok: false, reason: "no_prism", searchesUsed: searchesUsed };
    }

    const dim = prismInfo.dim;
    const prismBlock = prismInfo.block;
    if (!prismBlock || !isPrismBlock(prismBlock)) {
      noteScan("no_prism");
      noteResult("no_prism");
      return { ok: false, reason: "no_prism", searchesUsed: searchesUsed };
    }

    // Get all adjacent inventories (multi-inventory support)
  const inventories = cacheManager.getPrismInventoriesCached(prismKey, prismBlock, dim);
  if (typeof traceNoteNeighborInventories === "function") {
    traceNoteNeighborInventories(prismKey, Array.isArray(inventories) && inventories.length > 0);
  }
  if (
    typeof traceNoteVirtualCapacity === "function" ||
    typeof traceNoteVirtualCapacityReason === "function"
  ) {
    const vcSummary = summarizeNeighborInventoryVc(inventories);
    if (typeof traceNoteVirtualCapacity === "function") {
      traceNoteVirtualCapacity(prismKey, vcSummary.vc, vcSummary.vc <= 0);
    }
    if (typeof traceNoteVirtualCapacityReason === "function") {
      traceNoteVirtualCapacityReason(prismKey, vcSummary.reason, vcSummary.evidence);
    }
  }
  if (!inventories || inventories.length === 0) {
      noteScan("no_container");
      noteResult("no_container");
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
            dim: inv.dim,
          });
        }
      }

      // CRITICAL FIX: Filter out items that are already queued BEFORE doing expensive pathfinding.
      const newItems = allItems.filter((it) => !queuedItemTypes.has(it.stack.typeId));

      if (hasActiveQueue && newItems.length === 0) {
        // All items already queued - skip pathfinding entirely
        noteScan("queued", "all_items_queued");
        noteResult("queued");
        noteScan("queued", "all_items_queued");
        noteResult("queued");
        return { ok: false, reason: "all_items_already_queued", searchesUsed: 0 };
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
          notePathfind(pathfindTime, "ok");

          // EMERGENCY: If pathfinding takes too long, abort.
          if (pathfindTime > 100) {
            notePathfind(pathfindTime, "timeout");
            noteResult("pathfind_timeout");
            try { if (typeof invalidateInput === "function") invalidateInput(prismKey); } catch (e) {}
            return { ok: false, reason: "pathfind_timeout", searchesUsed: searchesUsed };
          }
        } catch (err) {
          const pathfindTime = Date.now() - pathfindStart;
          const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
          notePathfind(pathfindTime, "error");
          if (typeof traceNoteError === "function") traceNoteError(prismKey, errMsg, nowTick);
          noteResult("pathfind_error");
          try { if (typeof invalidateInput === "function") invalidateInput(prismKey); } catch (e) {}
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

            noteScan("queued", "new_types=" + routedNewItems.length);
            noteResult("queued");

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
          noteScan("no_route", "newItems=" + newItems.length);
          noteResult("no_route");
        } else {
          // New items exist but no routing candidates
          noteScan("no_route", "newItems=" + newItems.length);
          noteResult("no_route");
        }
      } else if (newItems.length === 0 && hasActiveQueue) {
        // All items already queued - normal, return early without expensive work
        noteScan("queued", "all_items_queued");
        noteResult("queued");
        return { ok: false, reason: "all_items_already_queued", searchesUsed: 0 };
      }
    }

    // Fallback: If no queue manager or queue already exists, use old immediate transfer
    const randomItem = getRandomItemFromInventories(inventories, filterSet);
    if (randomItem && searchBudget > 0) {
      const result = attemptPushTransfer(prismKey, prismBlock, dim, inventories, randomItem, filterSet, searchBudget);
      if (result.ok) {
        noteResult("pushed");
        return result;
      }
      searchesUsed += result.searchesUsed || 0;
      searchBudget -= result.searchesUsed || 0;
      noteResult(result.reason || "no_transfer");
    }

    // Filtered items are routed via prioritized push (no pull system)
    noteResult("no_transfer");
    return { ok: false, reason: "no_transfer", searchesUsed: searchesUsed };
  }
  return attemptTransferForPrism;
}

