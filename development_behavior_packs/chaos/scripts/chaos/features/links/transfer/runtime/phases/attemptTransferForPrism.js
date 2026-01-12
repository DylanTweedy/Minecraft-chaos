// scripts/chaos/features/links/transfer/runtime/phases/attemptTransferForPrism.js

import { ok, phaseStep } from "../helpers/result.js";

export function createAttemptTransferForPrismPhase(deps) {
  const handler = createAttemptTransferForPrismHandler(deps);

  return {
    name: "attemptTransferForPrism",
    handler,
    run(ctx) {
      phaseStep(ctx, "attemptTransferForPrism ready");
      return ok();
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
    hasExtendedDebug,
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
  } = deps || {};
  function attemptTransferForPrism(prismKey, searchBudget) {
    const nowTick = typeof deps?.getNowTick === "function" ? deps.getNowTick() : 0;
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
  return attemptTransferForPrism;
}

