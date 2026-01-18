// scripts/chaos/features/links/transfer/runtime/phases/scanTransfers.js

import { ok, phaseStep } from "../../util/result.js";

export function createScanTransfersPhase(deps) {
  const handler = createScanTransfersHandler(deps);

  return {
    name: "scanTransfers",
    run(ctx) {
      phaseStep(ctx, "scanTransfers");
      return handler(ctx);
    },
  };
}

function createScanTransfersHandler(deps) {
  const {
    cfg,
    inputQueuesManager,
    cacheManager,
    getPrismKeys,
    resolveBlockInfo,
    getSpeed,
    attemptTransferForPrism,
    clearBackoff,
    bumpBackoff,
    getBackoffTicks,
    nextAllowed,
    debugEnabled,
    debugState,
    getNowTick,
    getCursor,
    setCursor,
    persistAndReport,
    traceNoteScan,
    traceNoteTransferResult,
    noteGlobalPerf,
    getFilterForBlock,
    getFilterSet,
    findPathForInput,
    noteGlobalPathfind,
    traceNoteNeighborInventories,
    traceNoteVirtualCapacity,
    traceNoteVirtualCapacityReason,
    traceNotePathfind,
    isPrismBlock,
    validatePathStart,
    MAX_STEPS,
  } = deps || {};

  const autoScanSlotsPerInventory = Math.max(
    1,
    Number(cfg?.autoScanSlotsPerInventory) || 16
  );
  const autoScanMaxTypes = Math.max(1, Number(cfg?.autoScanMaxTypes) || 6);
  const autoScanMaxCandidates = Math.max(
    1,
    Number(cfg?.autoScanMaxCandidates) || 1
  );

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

  function updateInventoryTraces(prismKey, inventories) {
    const hasNeighbors = Array.isArray(inventories) && inventories.length > 0;
    if (typeof traceNoteNeighborInventories === "function") {
      traceNoteNeighborInventories(prismKey, hasNeighbors);
    }
    if (!hasNeighbors) {
      return;
    }
    const vcSummary = summarizeNeighborInventoryVc(inventories);
    if (typeof traceNoteVirtualCapacity === "function") {
      const targetFull = vcSummary.vc <= 0;
      traceNoteVirtualCapacity(prismKey, vcSummary.vc, targetFull);
    }
    if (typeof traceNoteVirtualCapacityReason === "function") {
      traceNoteVirtualCapacityReason(
        prismKey,
        vcSummary.reason,
        vcSummary.evidence
      );
    }
  }

  function collectCandidateItemSources(inventories, filterSet) {
    const sources = new Map();
    let seenAny = false;
    const maxSlots = autoScanSlotsPerInventory;
    for (let invIndex = 0; invIndex < (inventories?.length || 0); invIndex++) {
      const inv = inventories[invIndex];
      if (!inv || !inv.container) continue;
      const size = Math.max(0, Number(inv.container.size) || 0);
      const limit = Math.min(size, maxSlots);
      for (let slot = 0; slot < limit; slot++) {
        const item = inv.container.getItem(slot);
        if (!item || item.amount <= 0) continue;
        seenAny = true;
        const typeId = item.typeId;
        if (!typeId) continue;
        if (filterSet && filterSet.has(typeId)) continue;
        if (sources.has(typeId)) continue;
        sources.set(typeId, {
          container: inv.container,
          slot,
          stack: item,
          inventoryIndex: invIndex,
          entity: inv.entity,
          block: inv.block,
          dim: inv.dim,
        });
        if (sources.size >= autoScanMaxTypes) {
          return { sources, hasAny: seenAny, hasUnfiltered: true };
        }
      }
    }
    return {
      sources,
      hasAny: seenAny,
      hasUnfiltered: sources.size > 0,
    };
  }

  function mapResultToScanOutcome(result) {
    if (!result) return { status: "skip", reason: "no_result" };
    if (result.ok) return { status: "ready", reason: "candidate_found" };
    switch (result.reason) {
      case "no_prism":
        return { status: "skip", reason: "scan_skip_no_registry" };
      case "no_container":
        return { status: "idle", reason: "scan_skip_no_neighbor" };
      case "no_item":
      case "no_transfer":
        return { status: "no_transfer", reason: "scan_skip_no_items" };
      case "all_items_already_queued":
        return { status: "idle", reason: "scan_idle_already_queued" };
      case "no_route":
      case "no_options":
      case "pathfind_timeout":
      case "pathfind_error":
        return { status: "no_transfer", reason: "scan_skip_no_path" };
      default:
        return {
          status: "no_transfer",
          reason: result.reason || "scan_no_transfer",
        };
    }
  }

  function mapAutoScanOutcome(autoResult) {
    if (!autoResult) return null;
    if (autoResult.ok) {
      return { status: "ready", reason: autoResult.reason || "candidate_found" };
    }
    switch (autoResult.reason) {
      case "scan_ready_sink_found":
      case "scan_ready_drift_chosen":
        return { status: "ready", reason: autoResult.reason };
      case "scan_idle_budget":
      case "scan_idle_queue_exists":
        return { status: "idle", reason: autoResult.reason };
      case "scan_skip_no_neighbor":
      case "scan_skip_blacklist_only":
      case "scan_skip_no_items":
      case "scan_skip_no_dest":
      case "scan_skip_no_queue_mgr":
      case "scan_skip_pathfind_timeout":
      case "scan_skip_pathfind_error":
      case "scan_skip_no_path":
        return { status: "no_transfer", reason: autoResult.reason };
      default:
        return {
          status: "no_transfer",
          reason: autoResult.reason || "scan_no_transfer",
        };
    }
  }

  function mergeScanOutcomes(result, autoResult) {
    const base = mapResultToScanOutcome(result);
    const auto = mapAutoScanOutcome(autoResult);
    return auto || base;
  }

  function runAutoScanCandidate(
    prismKey,
    prismInfo,
    inventories,
    filterSet,
    searchBudgetValue,
    nowTick
  ) {
    if (
      !prismInfo ||
      !prismInfo.block ||
      !prismInfo.dim ||
      !Array.isArray(inventories) ||
      inventories.length === 0
    ) {
      return { ok: false, reason: "scan_skip_no_neighbor", searchesUsed: 0 };
    }
    if (
      !inputQueuesManager ||
      typeof inputQueuesManager.hasQueueForPrism !== "function" ||
      typeof inputQueuesManager.enqueueInputStacks !== "function"
    ) {
      return { ok: false, reason: "scan_skip_no_queue_mgr", searchesUsed: 0 };
    }
    if (typeof findPathForInput !== "function") {
      return { ok: false, reason: "scan_skip_no_path", searchesUsed: 0 };
    }
    if (inputQueuesManager.hasQueueForPrism(prismKey)) {
      return { ok: false, reason: "scan_idle_queue_exists", searchesUsed: 0 };
    }

    const candidates = collectCandidateItemSources(inventories, filterSet);
    if (!candidates.hasAny) {
      return { ok: false, reason: "scan_skip_no_items", searchesUsed: 0 };
    }
    if (!candidates.hasUnfiltered) {
      return { ok: false, reason: "scan_skip_blacklist_only", searchesUsed: 0 };
    }
    if (searchBudgetValue <= 0) {
      return { ok: false, reason: "scan_idle_budget", searchesUsed: 0 };
    }

    const pathfindStart = Date.now();
    let options = null;
    let searchesUsed = 0;
    try {
      searchesUsed = 1;
      options = findPathForInput(prismKey, nowTick);
      const pathfindTime = Date.now() - pathfindStart;
      if (typeof traceNotePathfind === "function") {
        traceNotePathfind(prismKey, pathfindTime, nowTick, "scan");
      }
      if (typeof noteGlobalPathfind === "function") {
        noteGlobalPathfind(pathfindTime, "ok");
      }
      if (pathfindTime > 100) {
        if (typeof noteGlobalPathfind === "function") {
          noteGlobalPathfind(pathfindTime, "timeout");
        }
        return { ok: false, reason: "scan_skip_pathfind_timeout", searchesUsed };
      }
    } catch (err) {
      const pathfindTime = Date.now() - pathfindStart;
      if (typeof traceNotePathfind === "function") {
        traceNotePathfind(prismKey, pathfindTime, nowTick, "scan");
      }
      if (typeof noteGlobalPathfind === "function") {
        noteGlobalPathfind(pathfindTime, "error");
      }
      return { ok: false, reason: "scan_skip_pathfind_error", searchesUsed: 1 };
    }

    if (!Array.isArray(options) || options.length === 0) {
      return { ok: false, reason: "scan_skip_no_path", searchesUsed };
    }

    const attempts = Array.from(candidates.sources.entries()).slice(0, autoScanMaxCandidates);
    for (const [typeId, itemSource] of attempts) {
      for (const option of options) {
        if (!option || !Array.isArray(option.path) || option.path.length === 0) continue;
        if (option.path.length > MAX_STEPS) continue;
        if (!validatePathStart(prismInfo.dim, option.path)) continue;
        const destInfo = resolveBlockInfo(option.outputKey);
        if (!destInfo || !destInfo.block) continue;
        if (!isPrismBlock(destInfo.block)) continue;
        const targetFilter = getFilterForBlock(destInfo.block);
        const targetFilterSet =
          targetFilter instanceof Set ? targetFilter : targetFilter ? getFilterSet(targetFilter) : null;
        const isSink = !!(targetFilterSet && targetFilterSet.size > 0 && targetFilterSet.has(typeId));
        const targetInventories =
          cacheManager?.getPrismInventoriesCached(option.outputKey, destInfo.block, destInfo.dim);
        if (!Array.isArray(targetInventories) || targetInventories.length === 0) continue;
        const routesMap = new Map([[typeId, option.path]]);
        inputQueuesManager.enqueueInputStacks(prismKey, [itemSource], routesMap);
        const queueEntries = inputQueuesManager.getQueuesForPrism(prismKey);
        if (Array.isArray(queueEntries)) {
          for (const entry of queueEntries) {
            if (entry && entry.itemTypeId === typeId) {
              entry.lastDestination = option.outputKey;
              break;
            }
          }
        }
        return {
          ok: true,
          reason: isSink ? "scan_ready_sink_found" : "scan_ready_drift_chosen",
          searchesUsed,
        };
      }
    }

    return { ok: false, reason: "scan_skip_no_dest", searchesUsed };
  }

  return function runScanTransfers(ctx) {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    const tickStart = ctx?.tickStart || 0;
    const cacheTime = ctx?.cacheTime || 0;
    const queuesTotalTime = ctx?.queuesTotalTime || 0;
    const virtualInvTime = ctx?.virtualInvTime || 0;
    const inputQueueTime = ctx?.inputQueueTime || 0;
    let cursor = typeof getCursor === "function" ? getCursor() : 0;

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

      // ============================
      // PHASE: PERSIST
      // ============================
      // --- PERSIST + REPORT phase (early-exit path) ---
      ctx.timeBeforePersist = timeBeforePersist;
      ctx.shouldSkipSaves = shouldSkipSaves;
      ctx.prismCount = prismKeys.length;
      ctx.scanTotalTime = scanTotalTime;
      ctx.cacheTime = cacheTime;
      ctx.queuesTotalTime = queuesTotalTime;
      ctx.virtualInvTime = virtualInvTime;
      ctx.inputQueueTime = inputQueueTime;
      if (typeof persistAndReport === "function") {
        persistAndReport(ctx);
      }
      if (typeof setCursor === "function") setCursor(cursor);
      return { ...ok(), stop: true, prismKeys, scanTotalTime };
    }

    // --- SCAN phase ---
    // Always scan to discover new items, but throttle scanning when queues are active.

    // Get fresh queue size for scanning decision
    const scanQueueSize =
      (inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function")
        ? inputQueuesManager.getTotalQueueSize()
        : 0;

    const hasActiveQueues = scanQueueSize > 0;

    // Dirty-prism scanning was previously driven by the legacy virtual inventory manager.
    // With the inventory adapter + reservations, we scan normally and rely on budgets.
    const dirtyPrisms = null;
    const dirtyPrismsCount = 0;

    // Reduce scan budget if queues are active (prioritize queue processing)
    // But still allow some scanning to discover new items.
    const baseScanLimit = Math.max(1, cfg.maxPrismsScannedPerTick | 0);
    const scanLimitWhenQueuesActive = Math.max(1, Math.floor(baseScanLimit * 0.3)); // 30% when queues active

    const scanDirtyOnly = false;

    if (cursor >= prismKeys.length) cursor = 0;

    let scanned = 0;
    let transferBudget = cfg.maxTransfersPerTick;
    let searchBudget = cfg.maxSearchesPerTick;
    let transfersThisTick = 0;

    // Determine scan limit and which prisms to scan
    let prismsToScan = null;
    let scanLimit = 0;

    // Scan all prisms, but reduce limit if queues are active (to prioritize queue processing)
    prismsToScan = prismKeys;
    const effectiveScanLimit = hasActiveQueues ? scanLimitWhenQueuesActive : baseScanLimit;
    scanLimit = Math.min(prismKeys.length, Math.max(1, effectiveScanLimit));

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

      // (dirty-prism scanning removed)

      const allowedAt = nextAllowed.has(prismKey) ? nextAllowed.get(prismKey) : 0;
      if (nowTick < allowedAt) {
        continue;
      }

      const prismInfo = resolveBlockInfo(prismKey);
      const prismBlock = prismInfo?.block;
      const prismDim = prismInfo?.dim;
      let inventories = [];
      if (cacheManager && prismBlock && prismDim) {
        inventories = cacheManager.getPrismInventoriesCached(prismKey, prismBlock, prismDim);
      }
      updateInventoryTraces(prismKey, inventories);
      const filter = prismBlock ? getFilterForBlock(prismBlock) : null;
      const filterSet = filter
        ? (filter instanceof Set ? filter : getFilterSet(filter))
        : null;
      const hasFilter = !!(filterSet && filterSet.size > 0);
      const hasNeighborInventory = Array.isArray(inventories) && inventories.length > 0;

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

      let handledAutoScan = false;

      while (
        itemsProcessedFromPrism < maxItemsPerPrismPerTick &&
        (transferBudget > 0 || searchBudget > 0) &&
        consecutiveFailuresForPrism < maxConsecutiveFailuresForPrism
      ) {
        const transferForPrismStart = Date.now();
        const result = attemptTransferForPrism(prismKey, searchBudget);
        const transferForPrismTime = Date.now() - transferForPrismStart;
        if (typeof noteGlobalPerf === "function") {
          noteGlobalPerf("scan", transferForPrismTime);
        }
        if (typeof traceNoteTransferResult === "function") {
          const statusLabel = result?.ok ? "ok" : "no_transfer";
          const reasonLabel = result?.reason || (result?.ok ? "ok" : "unknown");
          traceNoteTransferResult(prismKey, { status: statusLabel, reason: reasonLabel }, nowTick);
        }

        const searchesUsed = (result && result.searchesUsed) ? result.searchesUsed : 0;
        searchBudget -= searchesUsed;

        let autoScanOutcome = null;
        if (
          !handledAutoScan &&
          !result?.ok &&
          !hasFilter &&
          searchBudget > 0 &&
          hasNeighborInventory &&
          inputQueuesManager &&
          typeof inputQueuesManager.hasQueueForPrism === "function" &&
          !inputQueuesManager.hasQueueForPrism(prismKey)
        ) {
          autoScanOutcome = runAutoScanCandidate(
            prismKey,
            prismInfo,
            inventories,
            filterSet,
            searchBudget,
            nowTick
          );
          if (autoScanOutcome?.searchesUsed) {
            searchBudget -= autoScanOutcome.searchesUsed;
          }
          if (autoScanOutcome?.ok) {
            handledAutoScan = true;
          }
        }

        const scanOutcome = mergeScanOutcomes(result, autoScanOutcome);
        if (typeof traceNoteScan === "function") {
          traceNoteScan(prismKey, { status: scanOutcome.status, reason: scanOutcome.reason }, nowTick);
        }

        const didTransfer = !!(result && result.ok);
        if (didTransfer) {
          transfersThisTick++;
          transferBudget--;
          itemsProcessedFromPrism++;
          consecutiveFailuresForPrism = 0;
          clearBackoff(prismKey);
        } else if (autoScanOutcome?.ok) {
          itemsProcessedFromPrism++;
          consecutiveFailuresForPrism = 0;
          clearBackoff(prismKey);
          nextAllowed.set(prismKey, nowTick + 1);
          break;
        } else {
          consecutiveFailuresForPrism++;
          const reason = result ? result.reason : autoScanOutcome?.reason;
          if (reason === "all_items_already_queued") {
            consecutiveFailuresForPrism = Math.max(0, consecutiveFailuresForPrism - 1);
            nextAllowed.set(prismKey, nowTick + 1);
            break;
          }
          if (reason === "no_item" || reason === "no_transfer" || reason === "filtered_blacklist_all") {
            let interval = getPrismIntervalTicksForKey(prismKey);
            const level = bumpBackoff(prismKey);
            interval += getBackoffTicks(level);
            nextAllowed.set(prismKey, nowTick + interval);
            break;
          }
          if (reason === "full" || reason === "no_options" || reason === "no_search_budget") {
            if (consecutiveFailuresForPrism >= maxConsecutiveFailuresForPrism) {
              let interval = getPrismIntervalTicksForKey(prismKey);
              const level = bumpBackoff(prismKey);
              interval += getBackoffTicks(level);
              nextAllowed.set(prismKey, nowTick + interval);
              break;
            }
          } else if (
            reason === "pathfind_timeout" ||
            reason === "pathfind_error" ||
            reason === "no_path"
          ) {
            nextAllowed.set(prismKey, nowTick + 10);
            break;
          }
        }

        if (transferBudget <= 0 && searchBudget <= 0) break;
      }

      // After processing items from this prism, set cooldown based on results
      // CRITICAL FIX: If items were successfully processed/queued, use minimal cooldown (1 tick)
      if (itemsProcessedFromPrism > 0 || handledAutoScan) {
        // Successful processing => minimal cooldown so balancing continues continuously
        nextAllowed.set(prismKey, nowTick + 1);
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

      // If we're out of budgets, stop scanning
      if (transferBudget <= 0 && searchBudget <= 0) break;
    }

    const scanLoopTime = Date.now() - scanLoopStart;
    if (typeof noteGlobalPerf === "function") {
      noteGlobalPerf("scan", scanLoopTime);
    }
    scanTotalTime = Date.now() - scanStart;

    if (debugEnabled) {
      debugState.inputsScanned += scanned;
      debugState.transfersStarted += transfersThisTick;
      debugState.msScan += scanTotalTime;
    }

    if (typeof noteGlobalPerf === "function") {
      noteGlobalPerf("scan", scanTotalTime);
    }

    if (typeof setCursor === "function") setCursor(cursor);
    return { ...ok(), prismKeys, scanTotalTime, transfersThisTick, scanned };
  };
}
