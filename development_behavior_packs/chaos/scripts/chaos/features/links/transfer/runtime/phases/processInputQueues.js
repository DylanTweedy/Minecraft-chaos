// scripts/chaos/features/links/transfer/runtime/phases/processInputQueues.js

import { ok, phaseStep } from "../helpers/result.js";

export function createProcessInputQueuesPhase(deps) {
  const handler = createProcessInputQueuesHandler(deps);

  return {
    name: "processInputQueues",
    run(ctx) {
      phaseStep(ctx, "processInputQueues");
      return handler(ctx);
    },
  };
}

function createProcessInputQueuesHandler(deps) {
  const {
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
    debugEnabled,
    debugState,
    nextQueueTransferAllowed,
    getNowTick,
    traceNoteQueueSize,
    traceNoteError,
    traceNotePathfind,
    traceNoteTransferResult,
    noteGlobalPathfind,
    noteGlobalPerf,
    inflightLockManager,
  } = deps || {};

  return function runProcessInputQueues() {
    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;
    const inputQueueStart = Date.now();
    let inputQueueProcessed = 0;
    let inputQueueTransferBudget = cfg.maxTransfersPerTick;
    let inputQueueSearchBudget = cfg.maxSearchesPerTick;
    let inputQueueTransfersThisTick = 0;
    let inputQueueMaxEntryTime = 0; // Track max time for a single queue entry processing
    let inputQueueTotalEntries = 0; // Count total entries processed

    if (inputQueuesManager && typeof inputQueuesManager.getTotalQueueSize === "function") {
      const totalQueueSize = inputQueuesManager.getTotalQueueSize();

      // Process input queues if they exist
      if (totalQueueSize > 0) {
        const prismKeys = getPrismKeys();
        if (prismKeys.length > 0) {
          // Process queues for prisms that have them
          for (const prismKey of prismKeys) {
            if (inputQueueTransferBudget <= 0 && inputQueueSearchBudget <= 0) {
              break;
            }

            if (!inputQueuesManager.hasQueueForPrism(prismKey)) continue;

            const queueEntries = inputQueuesManager.getQueuesForPrism(prismKey);
            if (typeof traceNoteQueueSize === "function") {
              traceNoteQueueSize(prismKey, queueEntries.length);
            }

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
                  if (typeof traceNotePathfind === "function") {
                    traceNotePathfind(prismKey, pathfindTime, nowTick, "queue");
                  }
                  if (typeof noteGlobalPathfind === "function") {
                    noteGlobalPathfind(pathfindTime, "ok");
                  }

                  // EMERGENCY: If pathfinding takes too long, abort and skip
                  if (pathfindTime > 100) {
                    if (typeof noteGlobalPathfind === "function") {
                      noteGlobalPathfind(pathfindTime, "timeout");
                    }
                    inputQueuesManager.invalidateInputQueue(prismKey, queueEntry.containerKey);
                    consecutiveFailures++;
                    continue;
                  }
                } catch (err) {
                  const pathfindTime = Date.now() - pathfindStart;
                  if (typeof noteGlobalPathfind === "function") {
                    noteGlobalPathfind(pathfindTime, "error");
                  }
                  if (typeof traceNoteError === "function") {
                    const errMsg = (err && err.message) ? String(err.message) : String(err || "unknown");
                    traceNoteError(prismKey, errMsg, nowTick);
                  }
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
                void pickTime;

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
                const errorMsg = (err && err.message) ? String(err.message) : String(err || "unknown error");
                if (typeof traceNoteError === "function") {
                  traceNoteError(prismKey, errorMsg, nowTick);
                }
                transferResult = { ...makeResult(false, "transfer_error"), amount: 0, searchesUsed: 0 };
              }

              const transferTime = Date.now() - transferStart;

              const entryTime = Date.now() - entryStart;
              if (entryTime > inputQueueMaxEntryTime) inputQueueMaxEntryTime = entryTime;

              if (entryTime > 50 || transferTime > 30) {
                if (typeof noteGlobalPerf === "function") {
                  noteGlobalPerf("inputQueues", entryTime);
                }
              }

              if (typeof traceNoteTransferResult === "function") {
                const statusLabel = transferResult.ok ? "ok" : "no_transfer";
                const reasonLabel = transferResult.reason || (transferResult.ok ? "ok" : "unknown");
                traceNoteTransferResult(prismKey, { status: statusLabel, reason: reasonLabel }, nowTick);
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

              if (inflightLockManager && typeof inflightLockManager.release === "function") {
                inflightLockManager.release(prismKey, queueEntry.itemTypeId);
              }

                inputQueueProcessed++;
                entriesProcessedThisPrism++;
                consecutiveFailures = 0;

                // Set cooldown for this prism based on tier and filter status
                nextQueueTransferAllowed.set(prismKey, nowTick + effectiveInterval);

                // For filtered prisms, continue trying next entry
              } else {
                inputQueueSearchBudget -= transferResult.searchesUsed || 0;
                consecutiveFailures++;

                const reason = transferResult.reason || "unknown";

                // Unfiltered prisms: process one entry per tick, or too many failures
                if (!isFilteredPrism || consecutiveFailures >= maxConsecutiveFailures) {
                  break;
                }
              }
            } // End while (entries per prism)

            const prismQueueTime = Date.now() - prismQueueStart;
            if (typeof noteGlobalPerf === "function") {
              noteGlobalPerf("inputQueues", prismQueueTime);
            }
          } // End for (prismKey)
        } // End if (prismKeys.length > 0)
      } // End if (totalQueueSize > 0)
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

    if (typeof noteGlobalPerf === "function") {
      noteGlobalPerf("inputQueues", inputQueueTime);
    }

    return { ...ok(), inputQueueTransfersThisTick, inputQueueTotalEntries, inputQueueMaxEntryTime, inputQueueTime };
  };
}
