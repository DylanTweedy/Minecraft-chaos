// scripts/chaos/features/links/transfer/systems/refinement.js
// TEMPORARILY COMMENTED OUT FOR DEBUGGING
// import { isFluxTypeId, tryRefineFluxInTransfer } from "../../../../flux.js";
// Stub functions to replace flux imports during debugging
function isFluxTypeId(typeId) { return false; }
function tryRefineFluxInTransfer(ctx) { return null; }
import { SPEED_SCALE_MAX, PRISM_SPEED_BOOST_BASE, PRISM_SPEED_BOOST_PER_TIER, isPrismBlock, CRYSTALLIZER_ID } from "../config.js";
import { findOutputRouteFromNode } from "../routing/routes.js";
import { getAttachedInventoryInfo, tryInsertAmountForContainer } from "../util/inventoryAdapter.js";
import { getContainerKeyFromInfo } from "../keys.js";
import { isFurnaceBlock } from "../util/inventoryAdapter.js";

/**
 * Creates a refinement manager for prism refinement operations
 * @param {Object} cfg - Configuration object
 * @param {Object} deps - Dependencies object
 * @returns {Object} Refinement manager with refinement methods
 */
export function createRefinementManager(cfg, deps) {
  const { FX, cacheManager, resolveBlockInfo, dropItemAt, fxManager, enqueuePendingForContainer, linkGraph } = deps;

  /**
   * Finds all prism blocks in a path
   * @param {Array} path - Array of position objects {x, y, z}
   * @param {string} dimId - Dimension ID
   * @returns {Array} Array of prism block objects
   */
  function findPrismsInPath(path, dimId) {
    try {
      if (!Array.isArray(path) || path.length === 0) return [];
      const prisms = [];
      for (const p of path) {
        if (!p) continue;
        const b = cacheManager.getBlockCached(dimId, p);
        if (isPrismBlock(b)) prisms.push(b);
      }
      return prisms;
    } catch (e) {
      return [];
    }
  }

  /**
   * Applies refinement chain to items through prism blocks
   * @param {Array} items - Array of items {typeId, amount}
   * @param {Array} prismBlocks - Array of prism block objects
   * @param {number} speedScale - Speed scale multiplier
   * @param {Object} debugState - Optional debug state object for tracking
   * @param {boolean} debugEnabled - Whether debug tracking is enabled
   * @returns {Array} Refined items array
   */
  function applyPrismRefineChain(items, prismBlocks, speedScale, debugState = null, debugEnabled = false) {
    let list = Array.isArray(items) ? items.slice() : [];
    if (!prismBlocks || prismBlocks.length === 0) return list;
    const scale = Math.max(0.1, Number(speedScale) || 1.0);
    for (const prismBlock of prismBlocks) {
      if (!prismBlock) continue;
      const next = [];
      for (const entry of list) {
        if (!entry || !isFluxTypeId(entry.typeId)) {
          next.push(entry);
          continue;
        }
        if (debugEnabled && debugState) debugState.fluxRefineCalls++;
        const refined = tryRefineFluxInTransfer({
          prismBlock,
          itemTypeId: entry.typeId,
          amount: entry.amount,
          FX: FX,
          speedScale: scale,
        });
        if (debugEnabled && debugState && refined) {
          debugState.fluxRefined += Math.max(0, refined.refined | 0);
          debugState.fluxMutated += Math.max(0, refined.mutated | 0);
        }
        if (refined?.items?.length) next.push(...refined.items);
        else next.push(entry);
      }
      list = next;
    }
    return list;
  }

  /**
   * Applies refinement to a job when passing through a prism
   * @param {Object} job - Transfer job object
   * @param {Object} prismBlock - Prism block object
   * @param {Object} debugState - Optional debug state object
   * @param {boolean} debugEnabled - Whether debug tracking is enabled
   */
  function applyPrismRefineToJob(job, prismBlock, debugState = null, debugEnabled = false) {
    const items = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    let refined = applyPrismRefineChain(items, [prismBlock], job.speedScale, debugState, debugEnabled);
    if (job.outputType === "crystal") {
      const exotics = [];
      const filtered = [];
      for (const entry of refined) {
        if (!entry) continue;
        if (isFluxTypeId(entry.typeId)) {
          filtered.push(entry);
        } else {
          exotics.push(entry);
        }
      }
      if (exotics.length > 0) sendExoticsToOutput(prismBlock, job, exotics);
      refined = filtered;
      job.skipCrystalAdd = refined.length === 0;
    }
    job.refinedItems = refined;
    if (refined && refined.length > 0 && refined[0]?.typeId) {
      job.itemTypeId = refined[0].typeId;
    }
  }

  /**
   * Applies refinement to an FX job when passing through a prism
   * @param {Object} job - FX transfer job object
   * @param {Object} prismBlock - Prism block object
   * @param {Object} debugState - Optional debug state object
   * @param {boolean} debugEnabled - Whether debug tracking is enabled
   */
  function applyPrismRefineToFxJob(job, prismBlock, debugState = null, debugEnabled = false) {
    const items = Array.isArray(job.refinedItems) && job.refinedItems.length > 0
      ? job.refinedItems
      : [{ typeId: job.itemTypeId, amount: job.amount }];
    let refined = applyPrismRefineChain(items, [prismBlock], job.speedScale, debugState, debugEnabled);
    if (job.crystalKey) {
      const exotics = [];
      const filtered = [];
      for (const entry of refined) {
        if (!entry) continue;
        if (isFluxTypeId(entry.typeId)) {
          filtered.push(entry);
        } else {
          exotics.push(entry);
        }
      }
      if (exotics.length > 0) sendExoticsToOutput(prismBlock, job, exotics);
      refined = filtered;
      job.skipCrystalAdd = refined.length === 0;
    }
    job.refinedItems = refined;
    if (refined && refined.length > 0 && refined[0]?.typeId) {
      job.itemTypeId = refined[0].typeId;
    }
  }

  /**
   * Applies speed boost from a prism block to a job
   * @param {Object} job - Transfer job object
   * @param {Object} prismBlock - Prism block object
   */
  function applyPrismSpeedBoost(job, prismBlock) {
    try {
      const level = (prismBlock?.permutation?.getState("chaos:level") | 0) || 1;
      const boost = PRISM_SPEED_BOOST_BASE + ((Math.max(1, level) - 1) * PRISM_SPEED_BOOST_PER_TIER);
      const current = Math.max(0.1, Number(job.speedScale) || 1.0);
      job.speedScale = Math.min(SPEED_SCALE_MAX, current * boost);
    } catch (e) {
      // ignore
    }
  }

  /**
   * Sends exotic (non-flux) items to output route
   * @param {Object} prismBlock - Prism block object
   * @param {Object} job - Transfer job object
   * @param {Array} exotics - Array of exotic items {typeId, amount}
   */
  function sendExoticsToOutput(prismBlock, job, exotics) {
    try {
      if (!prismBlock || !job || !Array.isArray(exotics) || exotics.length === 0) return;
      const route = findOutputRouteFromNode(
        prismBlock,
        job.dimId,
        cacheManager.getPrismInventoriesCached.bind(cacheManager),
        linkGraph
      );
      if (!route) {
        for (const entry of exotics) {
          dropItemAt(prismBlock.dimension, prismBlock.location, entry.typeId, entry.amount);
        }
        return;
      }

      const outInfo = resolveBlockInfo(route.outputKey);
      const outBlock = outInfo?.block;
      const cInfo = outBlock ? getAttachedInventoryInfo(outBlock, outInfo.dim) : null;
      const containerKey = getContainerKeyFromInfo(cInfo);

      for (const entry of exotics) {
        let scheduled = false;
        if (containerKey && typeof fxManager.enqueueFluxTransferFxPositions === "function") {
          fxManager.enqueueFluxTransferFxPositions(
            route.path,
            route.startIndex,
            route.endIndex,
            entry.typeId,
            job.level || 1,
            {
              amount: entry.amount,
              dimId: job.dimId,
              containerKey,
              dropPos: outBlock?.location || prismBlock.location,
            }
          );
          scheduled = true;
        }
        if (!scheduled) {
          if (cInfo?.container && containerKey) {
            if (!tryInsertAmountForContainer(cInfo.container, cInfo.block || null, entry.typeId, entry.amount)) {
              enqueuePendingForContainer(containerKey, entry.typeId, entry.amount, route.outputKey, entry.typeId);
            }
          } else {
            dropItemAt(prismBlock.dimension, prismBlock.location, entry.typeId, entry.amount);
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return {
    findPrismsInPath,
    applyPrismRefineChain,
    applyPrismRefineToJob,
    applyPrismRefineToFxJob,
    applyPrismSpeedBoost,
    sendExoticsToOutput,
  };
}
