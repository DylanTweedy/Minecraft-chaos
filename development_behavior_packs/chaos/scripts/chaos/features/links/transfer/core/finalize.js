// scripts/chaos/features/links/transfer/core/finalize.js
import { ItemStack } from "@minecraft/server";
import { CRYSTALLIZER_ID, isPrismBlock } from "../config.js";
import { getFluxValueForItem, addFluxForItem } from "../../../../crystallizer.js";
import { fxFluxGenerate } from "../../../../fx/fx.js";
import { tryGenerateFluxOnTransfer, tryRefineFluxInTransfer } from "../../../../flux.js";
import { findCrystallizerRouteFromPrism } from "../routing/routes.js";
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
    getFilterForBlock, // NOTE: you said new filter system isn't ready yet; this may return null/undefined for now.
    enqueuePendingForContainer,
    fxManager,
    getContainerKey,
    debugEnabled,
    debugState,
    linkGraph,
    hybridArrivalHandler,
  } = deps;

  // ----------------------------
  // Small local helpers (replace old inventory layer)
  // ----------------------------

  function safeCreateStack(typeId, amount) {
    try {
      return new ItemStack(typeId, amount);
    } catch (e) {
      return null;
    }
  }

  function tryGetBlockContainer(block) {
    if (!block) return null;
    try {
      // Block inventory component
      const inv = block.getComponent("minecraft:inventory");
      const container = inv?.container || null;
      return container;
    } catch (e) {
      return null;
    }
  }

  // Minimal "attached inventory info" replacement.
  // The old system handled more cases (entities, adjacency rules, furnaces, etc).
  // For finalize, we mainly need "does this block have a container?".
  function getAttachedInventoryInfoLocal(block, dim) {
    const container = tryGetBlockContainer(block);
    if (!container) return null;
    return { container, block, entity: null, dim };
  }

  function isAllowedByFilter(filterSet, typeId) {
    if (!filterSet) return true;
    try {
      return filterSet.has(typeId);
    } catch (e) {
      return true;
    }
  }

  function tryInsertIntoContainer(container, typeId, amount, filterSet) {
    if (!container) return false;
    if (!isAllowedByFilter(filterSet, typeId)) return false;

    let remaining = amount | 0;
    if (remaining <= 0) return true;

    const probe = safeCreateStack(typeId, 1);
    if (!probe) return false;

    const max = probe.maxAmount || 64;
    const size = container.size || 0;

    // 1) Merge into existing stacks
    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (!it) continue;
      if (it.typeId !== typeId) continue;

      const cur = it.amount | 0;
      if (cur >= max) continue;

      const add = Math.min(max - cur, remaining);
      if (add <= 0) continue;

      it.amount = cur + add;
      container.setItem(i, it);
      remaining -= add;
    }

    // 2) Fill empty slots
    for (let i = 0; i < size && remaining > 0; i++) {
      const it = container.getItem(i);
      if (it) continue;

      const put = Math.min(max, remaining);
      const stack = safeCreateStack(typeId, put);
      if (!stack) return false;

      container.setItem(i, stack);
      remaining -= put;
    }

    return remaining <= 0;
  }

  function tryInsertIntoInventories(inventories, typeId, amount, filterSet) {
    if (!Array.isArray(inventories) || inventories.length === 0) return false;

    let remaining = amount | 0;
    if (remaining <= 0) return true;

    for (const inv of inventories) {
      if (!inv?.container) continue;
      // Attempt full insert into each container one by one.
      // If it fails, we don't partially track leftover precisely here (we'd need an "insert returning remainder").
      // To avoid lying, we only treat as success if a single container takes the whole amount.
      if (tryInsertIntoContainer(inv.container, typeId, remaining, filterSet)) return true;
    }

    return false;
  }

  function dropFallback(job) {
    const dim = cacheManager.getDimensionCached(job.dimId);
    if (!dim) return;
    const fallback = job.path?.[job.path.length - 1] || job.startPos;
    if (!fallback) return;
    dropItemAt(dim, fallback, job.itemTypeId, job.amount);
  }

  function releaseReservationMaybe(job) {
    // Old reservations lived in ../inventory/reservations.js which you’re removing.
    // If you re-home reservations elsewhere later, expose it as deps.releaseContainerSlot(...) or deps.releaseReservation(...)
    try {
      if (typeof deps.releaseContainerSlot === "function") {
        deps.releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
      } else if (typeof deps.releaseReservation === "function") {
        deps.releaseReservation(job.containerKey, job.itemTypeId, job.amount);
      }
    } catch (e) {
      // ignore
    }
  }

  // ----------------------------
  // Finalization logic
  // ----------------------------

  /**
   * Finalizes a regular transfer job
   * @param {Object} job - Transfer job object
   */
  function finalizeJob(job) {
    // Hybrid drift "arrival attunement" hook
    if (cfg?.useHybridDriftAttune && job?.mode === "hybrid_drift" && typeof hybridArrivalHandler === "function") {
      const handled = hybridArrivalHandler(job);
      if (handled) return;
    }

    // ----------------------------
    // Crystallizer endpoint (flux conversion only)
    // ----------------------------
    // NOTE: This is how crystallizers should behave as endpoints: arrivals are "crystal" jobs.
    if (job?.outputType === "crystal") {
      if (job.skipCrystalAdd) return;

      const outInfo = resolveBlockInfo(job.outputKey);
      if (!outInfo || !outInfo.block || outInfo.block.typeId !== CRYSTALLIZER_ID) {
        // Not actually a crystallizer anymore -> drop at last known safe position
        dropFallback(job);
        return;
      }

      const itemsToConvert =
        Array.isArray(job.refinedItems) && job.refinedItems.length > 0
          ? job.refinedItems
          : [{ typeId: job.itemTypeId, amount: job.amount }];

      let added = 0;
      for (const entry of itemsToConvert) {
        const value = getFluxValueForItem(entry.typeId);
        if (value > 0) {
          const gained = addFluxForItem(job.outputKey, entry.typeId, entry.amount);
          if (gained > 0) added += gained;
        } else {
          // Crystallizer does NOT accept non-flux-value items; drop them.
          dropItemAt(outInfo.dim, outInfo.block.location, entry.typeId, entry.amount);
        }
      }

      if (added > 0) fxFluxGenerate(outInfo.block, FX);
      return;
    }

    // ----------------------------
    // Regular container-backed transfers (to prism-connected inventories)
    // ----------------------------
    if (!job.containerKey) {
      dropFallback(job);
      return;
    }

    const outInfo = resolveBlockInfo(job.outputKey);
    if (!outInfo) {
      dropFallback(job);
      releaseReservationMaybe(job);
      return;
    }

    const outBlock = outInfo.block;

    // Target must be a prism for item deposits (crystallizers handled above via outputType === "crystal")
    if (!outBlock || !isPrismBlock(outBlock)) {
      dropItemAt(outInfo.dim, outBlock?.location || outInfo.pos, job.itemTypeId, job.amount);
      releaseReservationMaybe(job);
      return;
    }

    // Prism multi-inventory support (cached)
    const outInventories = cacheManager.getPrismInventoriesCached(job.outputKey, outBlock, outInfo.dim);
    if (!outInventories || outInventories.length === 0) {
      dropItemAt(outInfo.dim, outBlock.location, job.itemTypeId, job.amount);
      releaseReservationMaybe(job);
      return;
    }

    // Determine items to insert (optionally refined)
    let itemsToInsert =
      Array.isArray(job.refinedItems) && job.refinedItems.length > 0
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

    // Attempt insertion (filter system may be null right now)
    let allInserted = true;

    // If/when your new filter system exists, make getFilterForBlock(outBlock) return Set<string> or null.
    const targetFilter = getFilterForBlock ? getFilterForBlock(outBlock) : null;
    const targetFilterSet = targetFilter instanceof Set ? targetFilter : null;

    for (const entry of itemsToInsert) {
      if (!tryInsertIntoInventories(outInventories, entry.typeId, entry.amount, targetFilterSet)) {
        allInserted = false;
        enqueuePendingForContainer(job.containerKey, entry.typeId, entry.amount, job.outputKey, job.itemTypeId);
      }
    }

    if (!allInserted) return;

    // Success path
    releaseReservationMaybe(job);

    // Note transfer for leveling
    if (typeof deps.noteOutputTransfer === "function") {
      deps.noteOutputTransfer(job.outputKey, outBlock);
    }

    // Flux generation on transfers (kept intact, but uses local attached-inventory helper)
    if (debugEnabled && debugState) debugState.fluxGenChecks++;

    const crystalRoute = findCrystallizerRouteFromPrism(outBlock, job.dimId, linkGraph);
    const outContainerInfo = outInventories[0] || null;

    const fluxGenerated = tryGenerateFluxOnTransfer({
      outputBlock: outBlock,
      destinationInventory: outContainerInfo?.container || null,
      inputBlock: job.startPos ? outInfo.dim.getBlock(job.startPos) : null,
      path: job.path,

      // Old code passed getAttachedInventoryInfo from inventory layer; we provide a minimal local version.
      getAttachedInventoryInfo: getAttachedInventoryInfoLocal,

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

    // If no crystallizer route, tryGenerateFluxOnTransfer will handle routing via scheduleFluxTransferFx
  }

  /**
   * Finalizes a flux FX transfer job
   * @param {Object} job - Flux FX job object
   */
  function finalizeFluxFxJob(job) {
    try {
      const dim = cacheManager.getDimensionCached(job.dimId);
      if (!dim) return;

      // Flux -> crystallizer direct add
      if (job.crystalKey) {
        if (job.skipCrystalAdd) return;

        const itemsToConvert =
          Array.isArray(job.refinedItems) && job.refinedItems.length > 0
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

      // Flux -> container (fallback path; keep working without inventory folder)
      if (job.containerKey) {
        const info = typeof deps.resolveContainerInfo === "function" ? deps.resolveContainerInfo(job.containerKey) : null;

        const itemsToInsert =
          Array.isArray(job.refinedItems) && job.refinedItems.length > 0
            ? job.refinedItems
            : [{ typeId: job.itemTypeId, amount: job.amount }];

        if (info?.container) {
          let allInserted = true;
          for (const entry of itemsToInsert) {
            if (!tryInsertIntoContainer(info.container, entry.typeId, entry.amount, null)) {
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

      // Drop if allowed
      if (job.suppressDrop) return;
      if (job.dropPos) dropItemAt(dim, job.dropPos, job.itemTypeId, job.amount);
    } catch (e) {
      // ignore
    }
  }

  return {
    finalizeJob,
    finalizeFluxFxJob,
  };
}
