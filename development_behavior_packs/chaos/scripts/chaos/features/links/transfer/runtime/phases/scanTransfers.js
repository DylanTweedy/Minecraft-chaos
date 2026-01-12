// scripts/chaos/features/links/transfer/runtime/phases/scanTransfers.js

import { ok, phaseStep } from "../helpers/result.js";

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
    getNowTick,
    getCursor,
    setCursor,
    persistAndReport,
  } = deps || {};

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

    if (typeof setCursor === "function") setCursor(cursor);
    return { ...ok(), prismKeys, scanTotalTime, transfersThisTick, scanned };
  };
}
