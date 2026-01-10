// scripts/chaos/features/links/transfer/core/finalize.js
import { CRYSTALLIZER_ID, isPrismBlock } from "../config.js";
import { getFluxValueForItem, addFluxForItem } from "../../../../crystallizer.js";
import { fxFluxGenerate } from "../../../../fx/fx.js";
import { tryGenerateFluxOnTransfer, tryRefineFluxInTransfer, isFluxTypeId } from "../../../../flux.js";
import { findCrystallizerRouteFromPrism } from "../pathfinding/routes.js";
import { getAttachedInventoryInfo, tryInsertIntoInventories, tryInsertAmountForContainer } from "../inventory/inventory.js";
import { getFilterSet, getFilterContainer } from "../inventory/filters.js";
import { releaseContainerSlot } from "../inventory/reservations.js";
import { key, parseKey } from "../keys.js";

/**
 * Creates a finalize manager for job finalization operations
 * @param {Object} cfg - Configuration object
 * @param {Object} deps - Dependencies object
 * @returns {Object} Finalize manager with finalization methods
 */
export function createFinalizeManager(cfg, deps) {
  const {
    world,
    FX,
    cacheManager,
    resolveBlockInfo,
    dropItemAt,
    getFilterForBlock,
    enqueuePendingForContainer,
    fxManager,
    getContainerKey,
    debugEnabled,
    debugState,
  } = deps;

  /**
   * Finalizes a regular transfer job
   * @param {Object} job - Transfer job object
   */
  function finalizeJob(job) {
    if (job?.outputType === "crystal") {
      if (job.skipCrystalAdd) return;
      const outInfo = resolveBlockInfo(job.outputKey);
      if (!outInfo || !outInfo.block || outInfo.block.typeId !== CRYSTALLIZER_ID) {
        const dim = cacheManager.getDimensionCached(job.dimId);
        if (dim) {
          const fallback = job.path[job.path.length - 1] || job.startPos;
          if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
        }
        return;
      }

      const itemsToConvert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
        ? job.refinedItems
        : [{ typeId: job.itemTypeId, amount: job.amount }];

      let added = 0;
      for (const entry of itemsToConvert) {
        const value = getFluxValueForItem(entry.typeId);
        if (value > 0) {
          const gained = addFluxForItem(job.outputKey, entry.typeId, entry.amount);
          if (gained > 0) added += gained;
        } else {
          dropItemAt(outInfo.dim, outInfo.block.location, entry.typeId, entry.amount);
        }
      }
      if (added > 0) fxFluxGenerate(outInfo.block, FX);
      return;
    }

    if (!job.containerKey) {
      const dim = cacheManager.getDimensionCached(job.dimId);
      if (dim) {
        const fallback = job.path[job.path.length - 1] || job.startPos;
        if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
      }
      return;
    }
    const outInfo = resolveBlockInfo(job.outputKey);
    if (!outInfo) {
      const dim = cacheManager.getDimensionCached(job.dimId);
      if (dim) {
        const fallback = job.path[job.path.length - 1] || job.startPos;
        if (fallback) dropItemAt(dim, fallback, job.itemTypeId, job.amount);
      }
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      return;
    }

    const outBlock = outInfo.block;
    // Target is now a prism (or crystallizer)
    if (!outBlock || (!isPrismBlock(outBlock) && outBlock.typeId !== CRYSTALLIZER_ID)) {
      dropItemAt(outInfo.dim, outBlock?.location || outInfo.pos, job.itemTypeId, job.amount);
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      return;
    }

    // For prisms, use multi-inventory support (use cached version)
    let outInventories = null;
    if (isPrismBlock(outBlock)) {
      outInventories = cacheManager.getPrismInventoriesCached(job.outputKey, outBlock, outInfo.dim);
      if (!outInventories || outInventories.length === 0) {
        dropItemAt(outInfo.dim, outBlock.location, job.itemTypeId, job.amount);
        releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
        return;
      }
    } else {
      // Crystallizer - use old method for now
      const outContainerInfo = getAttachedInventoryInfo(outBlock, outInfo.dim);
      if (!outContainerInfo || !outContainerInfo.container) {
        dropItemAt(outInfo.dim, outBlock.location, job.itemTypeId, job.amount);
        releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
        return;
      }
      outInventories = [{ container: outContainerInfo.container, block: outContainerInfo.block, entity: outContainerInfo.entity }];
    }

    let itemsToInsert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    if (!job.refinedItems && job.prismKey) {
      const prismInfo = resolveBlockInfo(job.prismKey);
      if (debugEnabled && debugState) debugState.fluxRefineCalls++;
      const refined = tryRefineFluxInTransfer({
        prismBlock: prismInfo?.block,
        itemTypeId: job.itemTypeId,
        amount: job.amount,
        FX: FX,
      });
      if (debugEnabled && debugState && refined) {
        debugState.fluxRefined += Math.max(0, refined.refined | 0);
        debugState.fluxMutated += Math.max(0, refined.mutated | 0);
      }
      if (refined?.items?.length) itemsToInsert = refined.items;
    }

    let allInserted = true;
    for (const entry of itemsToInsert) {
      // Use multi-inventory insert for prisms
      if (isPrismBlock(outBlock)) {
        // Get filter for target prism to determine if it wants this item
        const targetFilter = getFilterForBlock(outBlock);
        const targetFilterSet = targetFilter ? (targetFilter instanceof Set ? targetFilter : getFilterSet(targetFilter)) : null;
        if (!tryInsertIntoInventories(outInventories, entry.typeId, entry.amount, targetFilterSet)) {
          allInserted = false;
          enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, job.outputKey, job.itemTypeId);
        }
      } else {
        // Crystallizer - use old method
        const outContainerInfo = { container: outInventories[0].container, block: outInventories[0].block, entity: outInventories[0].entity };
        if (!tryInsertAmountForContainer(outContainerInfo.container, outContainerInfo.block || null, entry.typeId, entry.amount)) {
          allInserted = false;
          enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, job.outputKey, job.itemTypeId);
        }
      }
    }

    if (allInserted) {
      releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      if (isPrismBlock(outBlock)) {
        // For prisms, note transfer for leveling
        deps.noteOutputTransfer(job.outputKey, outBlock);
      }
      if (debugEnabled && debugState) debugState.fluxGenChecks++;
      const crystalRoute = findCrystallizerRouteFromPrism(outBlock, job.dimId);
      const outContainerInfo = outInventories[0] || null;
      
      const fluxGenerated = tryGenerateFluxOnTransfer({
        outputBlock: outBlock,
        destinationInventory: outContainerInfo?.container || null,
        inputBlock: job.startPos ? outInfo.dim.getBlock(job.startPos) : null,
        path: job.path,
        getAttachedInventoryInfo,
        getBlockAt: (pos, dim) => {
          if (!pos) return null;
          const dimId = dim?.id || job.dimId;
          return cacheManager.getBlockCached(dimId, pos);
        },
        scheduleFluxTransferFx: fxManager.enqueueFluxTransferFx.bind(fxManager),
        scheduleFluxTransferFxPositions: fxManager.enqueueFluxTransferFxPositions.bind(fxManager),
        getContainerKey,
        transferLevel: job.level,
        transferStepTicks: job.stepTicks || cfg.orbStepTicks,
        transferSpeedScale: 1.0,
        FX: FX,
        consumeFluxOutput: !!crystalRoute, // Only consume if crystallizer route exists
      });
      if (debugEnabled && debugState && fluxGenerated > 0) debugState.fluxGenHits++;
      // If crystallizer route exists, route flux directly to crystallizer
      if (fluxGenerated > 0 && crystalRoute) {
        if (typeof fxManager.enqueueFluxTransferFxPositions === "function") {
          fxManager.enqueueFluxTransferFxPositions(
            crystalRoute.path,
            crystalRoute.outputIndex,
            crystalRoute.targetIndex,
            "chaos:flux_1",
            job.level,
            {
              amount: fluxGenerated,
              dimId: job.dimId,
              suppressDrop: true,
              refineOnPrism: true,
              crystalKey: key(job.dimId, crystalRoute.crystalPos.x, crystalRoute.crystalPos.y, crystalRoute.crystalPos.z),
              stepTicks: job.stepTicks || cfg.orbStepTicks,
              speedScale: 1.0,
            }
          );
        }
      }
      // If no crystallizer route, tryGenerateFluxOnTransfer will handle routing to available inventory via scheduleFluxTransferFx
      return;
    }
  }

  /**
   * Finalizes a flux FX transfer job
   * @param {Object} job - Flux FX job object
   */
  function finalizeFluxFxJob(job) {
    try {
      const dim = cacheManager.getDimensionCached(job.dimId);
      if (!dim) return;

      if (job.crystalKey) {
        if (job.skipCrystalAdd) return;
        const itemsToConvert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
          ? job.refinedItems
          : [{ typeId: job.itemTypeId, amount: job.amount }];
        let added = 0;
        for (const entry of itemsToConvert) {
          const value = getFluxValueForItem(entry.typeId);
          if (value > 0) {
            const gained = addFluxForItem(job.crystalKey, entry.typeId, entry.amount);
            if (gained > 0) added += gained;
          } else {
            dropItemAt(dim, job.dropPos || { x: 0, y: 0, z: 0 }, entry.typeId, entry.amount);
          }
        }
        if (added > 0) {
          const p = parseKey(job.crystalKey);
          if (p) {
            const block = dim.getBlock({ x: p.x, y: p.y, z: p.z });
            if (block) fxFluxGenerate(block, FX);
          }
        }
        return;
      }

      if (job.containerKey) {
        const info = deps.resolveContainerInfo(job.containerKey);
        const itemsToInsert = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
          ? job.refinedItems
          : [{ typeId: job.itemTypeId, amount: job.amount }];
        if (info?.container) {
          let allInserted = true;
          for (const entry of itemsToInsert) {
            if (!tryInsertAmountForContainer(info.container, info.block || null, entry.typeId, entry.amount)) {
              allInserted = false;
              enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, null, entry.typeId);
            }
          }
          if (allInserted) return;
        } else {
          for (const entry of itemsToInsert) {
            enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, null, entry.typeId);
          }
        }
        return;
      }

      if (job.suppressDrop) return;
      if (job.dropPos) {
        dropItemAt(dim, job.dropPos, job.itemTypeId, job.amount);
      }
    } catch {
      // ignore
    }
  }

  return {
    finalizeJob,
    finalizeFluxFxJob,
  };
}
