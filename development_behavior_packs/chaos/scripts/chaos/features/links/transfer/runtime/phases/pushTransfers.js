// scripts/chaos/features/links/transfer/runtime/phases/pushTransfers.js

import { ok, phaseStep } from "../helpers/result.js";

export function createPushTransfersPhase(deps) {
  const services = deps?.services || {};
  const cfg = deps?.cfg || services.cfg || {};
  const handlers = createPushTransferHandlers({ cfg, services });

  return {
    name: "pushTransfers",
    handlers,
    run(ctx) {
      phaseStep(ctx, "pushTransfers ready");
      return ok();
    },
  };
}

function createPushTransferHandlers(deps) {
  const services = deps?.services || {};
  const cfg = deps?.cfg || services.cfg || {};
  const {
    cacheManager,
    levelsManager,
    virtualInventoryManager,
    getFilterForBlock,
    getFilterSet,
    getContainerKey,
    getAttachedInventoryInfo,
    getQueueState,
    getTotalCountForType,
    calculateBalancedTransferAmount,
    validatePathStart,
    resolveBlockInfo,
    buildNodePathSegments,
    findFirstPrismKeyInPath,
    reserveContainerSlot,
    inflight,
    setInflightDirty,
    debugEnabled,
    debugState,
    getNowTick,
    sendDiagnosticMessage,
    findPathForInput,
    invalidateInput,
    pickWeightedRandomWithBias,
    isPrismBlock,
    getPrismTier,
    CRYSTALLIZER_ID,
    CRYSTAL_FLUX_WEIGHT,
    MAX_STEPS,
    isFluxTypeId,
    makeResult: makeResultFromServices,
  } = services;
  const makeResult = makeResultFromServices || ((ok, reason) => ({ ok: !!ok, reason: reason || (ok ? "ok" : "fail") }));

  // Helper: Attempt transfer with known destination and route (used by queue processing)
  function attemptPushTransferWithDestination(
    prismKey,
    prismBlock,
    dim,
    inventories,
    itemSource,
    destInfo,
    route,
    filterSet,
    queueEntry
  ) {
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

    const queueState = getQueueState();
    const fullContainers = queueState ? queueState.fullContainers : null;
    if (fullContainers && fullContainers.has(targetContainerKey)) {
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

    const suppressOrb = (outputType === "crystal" && isFluxTypeId(sourceStack.typeId));

    const prismTier = isPrismBlock(prismBlock) ? getPrismTier(prismBlock) : 1;
    const baseStepTicks =
      (levelsManager && typeof levelsManager.getOrbStepTicks === "function")
        ? levelsManager.getOrbStepTicks(prismTier)
        : cfg.orbStepTicks;

    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;

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

    if (typeof setInflightDirty === "function") {
      setInflightDirty(true);
    }
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

    const nowTick = typeof getNowTick === "function" ? getNowTick() : 0;

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

        const queueState = getQueueState();
        const fullContainers = queueState ? queueState.fullContainers : null;
        if (fullContainers && fullContainers.has(targetContainerKey)) {
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

        // DO NOT insert here - selection must be non-mutating.
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

    if (typeof setInflightDirty === "function") {
      setInflightDirty(true);
    }
    return { ...makeResult(true, "ok"), searchesUsed };
  }

  return {
    attemptPushTransferWithDestination,
    attemptPushTransfer,
  };
}

