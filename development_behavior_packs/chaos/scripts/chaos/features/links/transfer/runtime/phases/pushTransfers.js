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
    linkGraph,
    reserveContainerSlot,
    inflight,
    setInflightDirty,
    debugEnabled,
    debugState,
    getNowTick,
    traceNotePathfind,
    noteGlobalPathfind,
    traceNoteVirtualCapacity,
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
  const makeResult = makeResultFromServices || ((okResult, reason) => ({ ok: !!okResult, reason: reason || (okResult ? "ok" : "fail") }));

  const getCurrentTick = () => {
    const tick = typeof getNowTick === "function" ? getNowTick() : null;
    return typeof tick === "number" ? tick : 0;
  };

  function normalizeInventoryWrappers(inventories) {
    if (!Array.isArray(inventories)) return [];
    return inventories.map((wrapper) => {
      const reference = wrapper?.entity || wrapper?.block;
      const containerKey =
        reference && typeof getContainerKey === "function" ? getContainerKey(reference) : null;
      return {
        container: wrapper?.container,
        block: wrapper?.block,
        entity: wrapper?.entity,
        containerKey,
      };
    });
  }

  function resolvePrismPosition(prismBlock, prismKey, dim) {
    if (prismBlock?.location) {
      return { x: prismBlock.location.x, y: prismBlock.location.y, z: prismBlock.location.z, dimId: dim.id };
    }
    const info = resolveBlockInfo(prismKey);
    if (!info?.pos) return null;
    return { x: info.pos.x, y: info.pos.y, z: info.pos.z, dimId: info.dim?.id || dim.id };
  }

  function validateDestinationAndInventories(destInfo, dim) {
    if (!destInfo?.block) {
      return { ok: false, reason: "invalid_destination" };
    }
    const outBlock = destInfo.block;
    const destDim = destInfo.dim || dim;
    const destKey = destInfo.key || destInfo.outputKey || "";
    if (outBlock.typeId === CRYSTALLIZER_ID) {
      const attached = getAttachedInventoryInfo(outBlock, destDim);
      if (!attached?.container) {
        return { ok: false, reason: "no_container" };
      }
      return {
        ok: true,
        block: outBlock,
        inventories: [
          { container: attached.container, block: attached.block, entity: attached.entity },
        ],
        outputType: "crystal",
        outputKey: destInfo.outputKey || destKey,
      };
    }
    if (!isPrismBlock(outBlock)) {
      return { ok: false, reason: "invalid_destination" };
    }
    const outInventories = cacheManager.getPrismInventoriesCached(destKey, outBlock, destDim);
    if (!Array.isArray(outInventories) || outInventories.length === 0) {
      return { ok: false, reason: "no_container" };
    }
    return {
      ok: true,
      block: outBlock,
      inventories: outInventories,
      outputType: "prism",
      outputKey: destInfo.outputKey || destKey,
    };
  }

  function debugRecordBalanceCancelled(balanceResult, countFallback) {
    if (!debugEnabled || !debugState || !balanceResult) return;
    debugState.balanceCancelled = (debugState.balanceCancelled || 0) + 1;
    debugState.balanceCancelReason = balanceResult.reason;
    if (countFallback) {
      debugState.balanceFallback = (debugState.balanceFallback || 0) + 1;
    }
  }

  function debugRecordBalanceSuccess(amount) {
    if (!debugEnabled || !debugState) return;
    debugState.balanceTransfers = (debugState.balanceTransfers || 0) + 1;
    debugState.balanceAmount = (debugState.balanceAmount || 0) + amount;
  }

  function buildTravelPath(dim, route, prismPos) {
    if (typeof buildNodePathSegments !== "function") {
      return { travelPath: route, segmentLengths: null, edgeEpochs: null };
    }
    const nodePath = buildNodePathSegments(dim, route, prismPos);
    const travelPath = nodePath?.points || route;
    const segmentLengths = nodePath?.lengths || null;
    const edgeEpochs = (() => {
      if (!nodePath?.keys || !linkGraph) return null;
      const epochs = [];
      for (let i = 0; i < nodePath.keys.length - 1; i++) {
        const edge = linkGraph.getEdgeBetweenKeys(nodePath.keys[i], nodePath.keys[i + 1]);
        epochs.push(edge?.epoch || 0);
      }
      return epochs;
    })();
    return { travelPath, segmentLengths, edgeEpochs };
  }

  function computeTransferAmount(params) {
    const {
      sourceStack,
      sourceContainer,
      sourceContainerKey,
      targetInv,
      targetContainerKey,
      virtualCapacity,
      previewLevel,
      filterSet,
      targetFilterSet,
      queueEntry,
    } = params;
    if (!sourceStack || sourceStack.amount <= 0) {
      return { ok: false, reason: "no_item" };
    }
    if (virtualCapacity <= 0) {
      return { ok: false, reason: "no_capacity" };
    }
    const isFilteredDestination = !!(targetFilterSet && targetFilterSet.size > 0);
    const isFilteredSource = !!(filterSet && filterSet.size > 0);
    const getLevelAmount = () =>
      (levelsManager && typeof levelsManager.getTransferAmount === "function")
        ? levelsManager.getTransferAmount(previewLevel, sourceStack)
        : 1;
    const ensureMinimum = (amount) => {
      if (amount < 1 && virtualCapacity > 0 && sourceStack.amount > 0) {
        return 1;
      }
      return amount;
    };
    const finalizeAmount = (desiredAmount) => {
      if (virtualCapacity < desiredAmount) {
        return { ok: false, reason: "full" };
      }
      const transferAmount = Math.min(desiredAmount, sourceStack.amount, virtualCapacity);
      if (transferAmount <= 0) {
        return { ok: false, reason: "no_amount" };
      }
      return { ok: true, amount: transferAmount };
    };
    if (isFilteredDestination) {
      if (!targetFilterSet?.has(sourceStack.typeId)) {
        return { ok: false, reason: "filter_mismatch" };
      }
      let desiredAmount = Math.min(virtualCapacity, sourceStack.amount);
      desiredAmount = Math.min(desiredAmount, getLevelAmount());
      desiredAmount = ensureMinimum(desiredAmount);
      if (desiredAmount <= 0) {
        return { ok: false, reason: "no_amount" };
      }
      return finalizeAmount(desiredAmount);
    }
    if (isFilteredSource) {
      let desiredAmount = Math.min(virtualCapacity, sourceStack.amount);
      desiredAmount = Math.min(desiredAmount, getLevelAmount());
      desiredAmount = ensureMinimum(desiredAmount);
      if (desiredAmount <= 0) {
        return { ok: false, reason: "no_amount" };
      }
      return finalizeAmount(desiredAmount);
    }
    const transferStrategy = cfg.transferStrategy || "hybrid";
    const queueBalance = !!(queueEntry?.metadata?.forceBalance);
    const allowBalance =
      cfg.useBalanceDistribution !== false && (transferStrategy === "balance" || queueBalance);
    if (allowBalance) {
      const typeId = sourceStack.typeId;
      const sourceCount = getTotalCountForType(sourceContainer, typeId);
      const destCount = targetInv ? getTotalCountForType(targetInv.container, typeId) : 0;
      if (!sourceCount || sourceCount <= 0) {
        return finalizeAmount(getLevelAmount());
      }
      let adjustedSourceCount = sourceCount;
      let adjustedDestCount = destCount;
      if (virtualInventoryManager?.getPendingForContainer) {
        const sourcePending =
          virtualInventoryManager.getPendingForContainer(sourceContainerKey, typeId) || 0;
        const destPending =
          virtualInventoryManager.getPendingForContainer(targetContainerKey, typeId) || 0;
        adjustedSourceCount = Math.max(0, sourceCount - sourcePending);
        adjustedDestCount = destCount + destPending;
      }
      const maxTransfer =
        cfg.balanceCapByLevel && levelsManager && typeof levelsManager.getTransferAmount === "function"
          ? levelsManager.getTransferAmount(previewLevel, sourceStack)
          : Infinity;
      const balanceResult = calculateBalancedTransferAmount(
        adjustedSourceCount,
        adjustedDestCount,
        sourceStack.amount,
        virtualCapacity,
        {
          minTransfer: cfg.balanceMinTransfer || 1,
          maxTransfer,
        }
      );
      if (balanceResult.cancelled) {
        if (queueEntry) {
          if (virtualCapacity > 0 && sourceStack.amount > 0) {
            const minTransfer = cfg.balanceMinTransfer || 1;
            let desiredAmount = Math.min(
              getLevelAmount(),
              virtualCapacity,
              sourceStack.amount,
              maxTransfer || Infinity
            );
            if (
              desiredAmount < minTransfer &&
              virtualCapacity >= minTransfer &&
              sourceStack.amount >= minTransfer
            ) {
              desiredAmount = minTransfer;
            }
            debugRecordBalanceCancelled(balanceResult, false);
            if (desiredAmount <= 0) {
              return { ok: false, reason: "no_capacity" };
            }
            return finalizeAmount(desiredAmount);
          }
          return { ok: false, reason: "no_capacity" };
        }
        if (sourceCount > destCount && virtualCapacity > 0 && sourceStack.amount > 0) {
          debugRecordBalanceCancelled(balanceResult, true);
          const desiredAmount = Math.min(getLevelAmount(), virtualCapacity, sourceStack.amount);
          return finalizeAmount(desiredAmount);
        }
        debugRecordBalanceCancelled(balanceResult, false);
        return { ok: false, reason: "balance_cancelled" };
      }
      debugRecordBalanceSuccess(balanceResult.amount);
      return finalizeAmount(balanceResult.amount);
    }
    return finalizeAmount(getLevelAmount());
  }

  function buildTransferPlan(params) {
    const {
      prismKey,
      prismBlock,
      prismPos,
      dim,
      route,
      travelPath,
      segmentLengths,
      edgeEpochs,
      outputKey,
      outputType,
      containerKey,
      amount,
      sourceStack,
      previewLevel,
      prismTier,
      baseStepTicks,
      suppressOrb,
      refinedItems,
    } = params;
    const pathPrismKey = findFirstPrismKeyInPath(dim, prismPos.dimId, route);
    return {
      prismKey,
      prismBlock,
      prismPos,
      outputKey,
      outputType,
      itemTypeId: sourceStack.typeId,
      amount,
      path: route,
      travelPath,
      segmentLengths,
      edgeEpochs,
      containerKey,
      suppressOrb,
      refinedItems,
      previewLevel,
      prismTier,
      baseStepTicks,
      dim,
      pathPrismKey,
      startPos: { x: prismPos.x, y: prismPos.y, z: prismPos.z },
    };
  }

  function commitSourceExtraction(plan, itemSource) {
    const container = itemSource?.container;
    const slot = itemSource?.slot;
    if (!container || slot === undefined || !plan) return false;
    const current = container.getItem(slot);
    if (!current || current.typeId !== plan.itemTypeId || current.amount < plan.amount) {
      return false;
    }
    try {
      const remaining = current.amount - plan.amount;
      if (remaining > 0) {
        const newStack = current.clone();
        newStack.amount = remaining;
        container.setItem(slot, newStack);
      } else {
        container.setItem(slot, null);
      }
      return true;
    } catch {
      return false;
    }
  }

  function debugNoteTransfer(plan, nowTick) {
    if (!debugEnabled || !debugState || !plan) return;
    debugState.transferStartTicks.push(nowTick);
    debugState.stepTicksTotal += plan.baseStepTicks;
    debugState.stepTicksCount++;
    if (plan.baseStepTicks < debugState.stepTicksMin) debugState.stepTicksMin = plan.baseStepTicks;
    if (plan.baseStepTicks > debugState.stepTicksMax) debugState.stepTicksMax = plan.baseStepTicks;
    if (plan.segmentLengths && plan.segmentLengths.length > 0) {
      debugState.segmentStepsTotal += plan.segmentLengths.length;
      debugState.segmentStepsCount++;
    }
  }

  function enqueueInflight(plan) {
    const nowTick = getCurrentTick();
    if (levelsManager && typeof levelsManager.notePrismPassage === "function") {
      levelsManager.notePrismPassage(plan.prismKey, plan.prismBlock);
    }
    debugNoteTransfer(plan, nowTick);
    inflight.push({
      dimId: plan.prismPos.dimId,
      itemTypeId: plan.itemTypeId,
      amount: plan.amount,
      path: plan.travelPath,
      stepIndex: 0,
      stepTicks: plan.baseStepTicks,
      speedScale: 1.0,
      ticksUntilStep: 0,
      outputKey: plan.outputKey,
      outputType: plan.outputType,
      suppressOrb: plan.suppressOrb,
      containerKey: plan.containerKey,
      prismKey: plan.pathPrismKey,
      startPos: plan.startPos,
      startTick: debugEnabled ? nowTick : null,
      level: plan.previewLevel,
      segmentLengths: plan.segmentLengths,
      edgeEpochs: plan.edgeEpochs,
      refinedItems: plan.refinedItems,
    });
  }

  function commitReservations(plan) {
    if (plan.containerKey && typeof reserveContainerSlot === "function") {
      reserveContainerSlot(plan.containerKey, plan.itemTypeId, plan.amount);
    }
    if (typeof setInflightDirty === "function") {
      setInflightDirty(true);
    }
  }

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
    const normalizedInventories = normalizeInventoryWrappers(inventories);
    const sourceInventory = normalizedInventories[itemSource.inventoryIndex];
    const sourceContainerKey = sourceInventory?.containerKey;
    const sourceContainer = itemSource?.container;
    const sourceStack = itemSource?.stack;
    if (!sourceStack) {
      return { ...makeResult(false, "no_item"), amount: 0 };
    }

    const targetValidation = validateDestinationAndInventories(destInfo, dim);
    if (!targetValidation.ok) {
      return { ok: false, reason: targetValidation.reason, amount: 0 };
    }
    const { block: outBlock, inventories: targetInventories, outputType, outputKey } = targetValidation;
    const targetWrapper = normalizeInventoryWrappers(targetInventories)[0];
    if (!targetWrapper?.container) {
      return { ...makeResult(false, "no_container"), amount: 0 };
    }
    const targetContainerKey = targetWrapper.containerKey;
    if (sourceContainerKey && targetContainerKey && sourceContainerKey === targetContainerKey) {
      return { ...makeResult(false, "same_container"), amount: 0 };
    }
    const queueState = getQueueState();
    const fullContainers = queueState?.fullContainers;
    if (fullContainers && targetContainerKey && fullContainers.has(targetContainerKey)) {
      if (typeof traceNoteVirtualCapacity === "function") {
        traceNoteVirtualCapacity(prismKey, 0, true);
      }
      return { ...makeResult(false, "full"), amount: 0 };
    }
    const virtualCapacity = cacheManager.getInsertCapacityCached(
      targetContainerKey,
      targetWrapper.container,
      sourceStack.typeId,
      sourceStack
    );
    if (typeof traceNoteVirtualCapacity === "function") {
      const isFullCapacity = virtualCapacity <= 0;
      traceNoteVirtualCapacity(prismKey, virtualCapacity, isFullCapacity);
    }
    const previewLevel = levelsManager?.getNextInputLevel?.(prismKey) ?? 1;
    const targetFilter = getFilterForBlock(outBlock);
    const targetFilterSet = targetFilter
      ? targetFilter instanceof Set
        ? targetFilter
        : getFilterSet(targetFilter)
      : null;
    const hasTargetFilter = targetFilterSet?.size > 0;
    if (outputType === "prism" && hasTargetFilter && !targetFilterSet.has(sourceStack.typeId)) {
      return { ...makeResult(false, "filter_mismatch"), amount: 0 };
    }
    const computeResult = computeTransferAmount({
      sourceStack,
      sourceContainer,
      sourceContainerKey,
      targetInv: targetWrapper,
      targetContainerKey,
      virtualCapacity,
      previewLevel,
      filterSet,
      targetFilterSet,
      queueEntry,
    });
    if (!computeResult.ok) {
      return { ...makeResult(false, computeResult.reason), amount: 0 };
    }
    if (!validatePathStart(dim, route)) {
      return { ...makeResult(false, "invalid_path"), amount: 0 };
    }
    const prismPos = resolvePrismPosition(prismBlock, prismKey, dim);
    if (!prismPos) {
      return { ...makeResult(false, "no_prism_pos"), amount: 0 };
    }
    const { travelPath, segmentLengths, edgeEpochs } = buildTravelPath(dim, route, prismPos);
    const prismTier = isPrismBlock(prismBlock) ? getPrismTier(prismBlock) : 1;
    const baseStepTicks =
      levelsManager && typeof levelsManager.getOrbStepTicks === "function"
        ? levelsManager.getOrbStepTicks(prismTier)
        : cfg.orbStepTicks;
    const suppressOrb = outputType === "crystal" && isFluxTypeId(sourceStack.typeId);
    const refinedItems =
      outputType === "crystal" && isFluxTypeId(sourceStack.typeId)
        ? [{ typeId: sourceStack.typeId, amount: computeResult.amount }]
        : null;
    const plan = buildTransferPlan({
      prismKey,
      prismBlock,
      prismPos,
      dim,
      route,
      travelPath,
      segmentLengths,
      edgeEpochs,
      outputKey,
      outputType,
      containerKey: targetContainerKey,
      amount: computeResult.amount,
      sourceStack,
      previewLevel,
      prismTier,
      baseStepTicks,
      suppressOrb,
      refinedItems,
    });
    if (!commitSourceExtraction(plan, itemSource)) {
      return { ...makeResult(false, "no_item"), amount: 0 };
    }
    enqueueInflight(plan);
    commitReservations(plan);
    return { ...makeResult(true, "ok") };
  }

  function attemptPushTransfer(
    prismKey,
    prismBlock,
    dim,
    inventories,
    itemSource,
    filterSet,
    searchBudget
  ) {
    const normalizedInventories = normalizeInventoryWrappers(inventories);
    const sourceInventory = normalizedInventories[itemSource.inventoryIndex];
    const sourceContainerKey = sourceInventory?.containerKey;
    const sourceContainer = itemSource?.container;
    const sourceStack = itemSource?.stack;
    if (!sourceStack) {
      return { ...makeResult(false, "no_item"), searchesUsed: 0 };
    }
    if (!levelsManager || typeof levelsManager.getNextInputLevel !== "function") {
      return { ...makeResult(false, "no_levels_manager"), searchesUsed: 0 };
    }
    const previewLevel = levelsManager.getNextInputLevel(prismKey);
    const nowTick = getCurrentTick();
    const pathfindStart = Date.now();
    let searchesUsed = 0;
    let options = null;
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
        if (typeof invalidateInput === "function") invalidateInput(prismKey);
        return { ...makeResult(false, "pathfind_timeout"), searchesUsed };
      }
    } catch (err) {
      const pathfindTime = Date.now() - pathfindStart;
      if (typeof noteGlobalPathfind === "function") {
        noteGlobalPathfind(pathfindTime, "error");
      }
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "pathfind_error"), searchesUsed };
    }
    if (!Array.isArray(options) || options.length === 0) {
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, "no_options"), searchesUsed };
    }
    const filteredOptions = [];
    const itemTypeId = sourceStack.typeId;
    for (const opt of options) {
      const outputKey = opt?.outputKey;
      if (!outputKey) continue;
      const targetInfo = resolveBlockInfo(outputKey);
      const targetBlock = targetInfo?.block;
      if (!targetBlock) continue;
      if (targetBlock.typeId === CRYSTALLIZER_ID) {
        if (isFluxTypeId(itemTypeId)) filteredOptions.push(opt);
        continue;
      }
      if (!isPrismBlock(targetBlock)) continue;
      const targetInventories = cacheManager.getPrismInventoriesCached(outputKey, targetBlock, targetInfo.dim);
      if (!targetInventories || targetInventories.length === 0) continue;
      const targetFilter = getFilterForBlock(targetBlock);
      const targetFilterSet = targetFilter
        ? targetFilter instanceof Set
          ? targetFilter
          : getFilterSet(targetFilter)
        : null;
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
    let candidates = filteredOptions.slice();
    if (!isFlux) {
      candidates = candidates.filter((c) => (c?.outputType || "prism") !== "crystal");
    }
    if (candidates.length === 0) {
      return { ...makeResult(false, "no_options"), searchesUsed };
    }
    const available = sourceStack.amount;
    const getPickWeight = (opt) => {
      const type = opt?.outputType || "prism";
      if (isFlux && type === "crystal") return CRYSTAL_FLUX_WEIGHT;
      if (type !== "prism") return 1.0;
      const tInfo = resolveBlockInfo(opt.outputKey);
      const tBlock = tInfo?.block;
      if (!tBlock || !isPrismBlock(tBlock)) return 1.0;
      const tFilter = getFilterForBlock(tBlock);
      const tSet = tFilter ? (tFilter instanceof Set ? tFilter : getFilterSet(tFilter)) : null;
      if (tSet && tSet.size > 0 && tSet.has(itemTypeId)) return 20.0;
      return 1.0;
    };
    const prismPos = resolvePrismPosition(prismBlock, prismKey, dim);
    if (!prismPos) {
      return { ...makeResult(false, "no_prism_pos"), searchesUsed };
    }
    const prismTier = isPrismBlock(prismBlock) ? getPrismTier(prismBlock) : 1;
    const baseStepTicks =
      levelsManager && typeof levelsManager.getOrbStepTicks === "function"
        ? levelsManager.getOrbStepTicks(prismTier)
        : cfg.orbStepTicks;
    let foundTarget = false;
    let selectedPath = null;
    let selectedOutputKey = null;
    let sawFull = false;
    let transferAmount = 0;
    let containerKey = null;
    let outputType = "prism";
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
        selectedPath = pick.path;
        selectedOutputKey = pick.outputKey;
        transferAmount = amount;
        outputType = "crystal";
        foundTarget = true;
        break;
      }
      if (!isPrismBlock(info.block)) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }
      const targetInventories = cacheManager.getPrismInventoriesCached(pick.outputKey, info.block, info.dim);
      if (!targetInventories || targetInventories.length === 0) {
        candidates.splice(candidates.indexOf(pick), 1);
        continue;
      }
      const targetFilter = getFilterForBlock(info.block);
      const targetFilterSet = targetFilter
        ? targetFilter instanceof Set
          ? targetFilter
          : getFilterSet(targetFilter)
        : null;
      for (const targetInv of targetInventories) {
        const normalizedTarget = normalizeInventoryWrappers([targetInv])[0];
        if (!normalizedTarget?.container) continue;
        const targetContainerKey = normalizedTarget.containerKey;
        if (sourceContainerKey && targetContainerKey && sourceContainerKey === targetContainerKey) continue;
        const queueState = getQueueState();
        const fullContainers = queueState?.fullContainers;
        if (fullContainers && targetContainerKey && fullContainers.has(targetContainerKey)) {
          if (typeof traceNoteVirtualCapacity === "function") {
            traceNoteVirtualCapacity(prismKey, 0, true);
          }
          sawFull = true;
          continue;
        }
        const virtualCapacity = cacheManager.getInsertCapacityCached(
          targetContainerKey,
          normalizedTarget.container,
          sourceStack.typeId,
          sourceStack
        );
        if (typeof traceNoteVirtualCapacity === "function") {
          const isFullCapacity = virtualCapacity <= 0;
          traceNoteVirtualCapacity(prismKey, virtualCapacity, isFullCapacity);
        }
        const computeResult = computeTransferAmount({
          sourceStack,
          sourceContainer,
          sourceContainerKey,
          targetInv: normalizedTarget,
          targetContainerKey,
          virtualCapacity,
          previewLevel,
          filterSet,
          targetFilterSet,
          queueEntry: null,
        });
        if (!computeResult.ok) {
          if (computeResult.reason === "full") {
            sawFull = true;
          }
          continue;
        }
        containerKey = targetContainerKey;
        transferAmount = computeResult.amount;
        outputType = "prism";
        selectedPath = pick.path;
        selectedOutputKey = pick.outputKey;
        foundTarget = true;
        break;
      }
      if (foundTarget) break;
      candidates.splice(candidates.indexOf(pick), 1);
    }
    if (!foundTarget || !selectedPath) {
      if (typeof invalidateInput === "function") invalidateInput(prismKey);
      return { ...makeResult(false, sawFull ? "full" : "no_options"), searchesUsed };
    }
    const { travelPath, segmentLengths, edgeEpochs } = buildTravelPath(dim, selectedPath, prismPos);
    const suppressOrb = outputType === "crystal" && isFluxTypeId(sourceStack.typeId);
    const refinedItems =
      outputType === "crystal" && isFluxTypeId(sourceStack.typeId)
        ? [{ typeId: sourceStack.typeId, amount: transferAmount }]
        : null;
    const plan = buildTransferPlan({
      prismKey,
      prismBlock,
      prismPos,
      dim,
      route: selectedPath,
      travelPath,
      segmentLengths,
      edgeEpochs,
      outputKey: selectedOutputKey,
      outputType,
      containerKey,
      amount: transferAmount,
      sourceStack,
      previewLevel,
      prismTier,
      baseStepTicks,
      suppressOrb,
      refinedItems,
    });
    if (!commitSourceExtraction(plan, itemSource)) {
      return { ...makeResult(false, "no_item"), searchesUsed };
    }
    enqueueInflight(plan);
    commitReservations(plan);
    return { ...makeResult(true, "ok"), searchesUsed };
  }

  return {
    attemptPushTransferWithDestination,
    attemptPushTransfer,
  };
}
