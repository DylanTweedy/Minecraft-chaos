// scripts/chaos/features/links/transfer/core/inflightProcessor.js
import { isPrismBlock } from "../config.js";
import { isFluxTypeId } from "../../../../flux.js";
import { isPathBlock } from "../pathfinding/path.js";
import { releaseContainerSlot } from "../inventory/reservations.js";
import { key } from "../keys.js";

/**
 * Creates an inflight processor manager for processing in-flight transfer jobs
 * @param {Object} cfg - Configuration object
 * @param {Object} deps - Dependencies object
 * @returns {Object} Inflight processor manager with processing methods
 */
export function createInflightProcessorManager(cfg, deps) {
  const {
    cacheManager,
    dropItemAt,
    levelsManager,
    refinementManager,
    fxManager,
    finalizeManager,
    debugEnabled,
    debugState,
  } = deps;

  /**
   * Process regular in-flight transfer jobs
   * @param {Array} inflight - Array of in-flight jobs
   * @param {number} nowTick - Current tick number
   * @returns {Object} Object with inflightDirty and inflightStepDirty flags
   */
  function tickInFlight(inflight, nowTick) {
    if (inflight.length === 0) return { inflightDirty: false, inflightStepDirty: false };

    let inflightDirty = false;
    let inflightStepDirty = false;

    for (let i = inflight.length - 1; i >= 0; i--) {
      const job = inflight[i];
      job.ticksUntilStep--;
      if (job.ticksUntilStep > 0) continue;

      const nextIdx = job.stepIndex + 1;
      if (nextIdx >= job.path.length) {
        // Track transfer completion time
        if (debugEnabled && debugState && job.startTick != null) {
          const transferDuration = nowTick - job.startTick;
          debugState.transferCompleteTicks.push(transferDuration);
        }
        finalizeManager.finalizeJob(job);
        inflight.splice(i, 1);
        inflightDirty = true;
        continue;
      }

      const cur = job.path[job.stepIndex];
      const next = job.path[nextIdx];
      const dim = cacheManager.getDimensionCached(job.dimId);
      if (!dim) continue;

      const curBlock = cacheManager.getBlockCached(job.dimId, cur) || dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });
      const nextBlock = cacheManager.getBlockCached(job.dimId, next) || dim.getBlock({ x: next.x, y: next.y, z: next.z });
      if (isPrismBlock(curBlock) && job.refineOnPrism && isFluxTypeId(job.itemTypeId)) {
        refinementManager.applyPrismRefineToFxJob(job, curBlock, debugState, debugEnabled);
      }
      if (job.stepIndex < job.path.length - 1) {
        if (!isPathBlock(curBlock)) {
          dropItemAt(dim, cur, job.itemTypeId, job.amount);
          releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
          inflight.splice(i, 1);
          inflightDirty = true;
          continue;
        }
      }

      if (nextIdx < job.path.length - 1) {
        if (!isPathBlock(nextBlock)) {
          dropItemAt(dim, cur, job.itemTypeId, job.amount);
          releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
          inflight.splice(i, 1);
          inflightDirty = true;
          continue;
        }
      }

      if (job.stepIndex < job.path.length - 1) {
        if (isPrismBlock(curBlock)) {
          levelsManager.notePrismPassage(key(job.dimId, cur.x, cur.y, cur.z), curBlock);
          refinementManager.applyPrismSpeedBoost(job, curBlock);
          if (isFluxTypeId(job.itemTypeId)) {
            refinementManager.applyPrismRefineToJob(job, curBlock, debugState, debugEnabled);
          }
        }
      }

      const segLen = job.segmentLengths?.[job.stepIndex] || 1;
      const baseTicks = job.stepTicks || cfg.orbStepTicks;
      const stepTicks = Math.max(1, Math.floor(baseTicks / Math.max(0.1, job.speedScale || 1)));
      const totalTicksForSegment = stepTicks * Math.max(1, segLen | 0);
      
      // Spawn orb only if we have valid blocks and the path is still valid
      if (!job.suppressOrb && isPathBlock(curBlock) && (nextIdx >= job.path.length || isPathBlock(nextBlock))) {
        // FX manager expects: (dim, from, to, level, fromBlock, toBlock, itemTypeId, lengthSteps, logicalTicks, speedScale)
        const logicalTicks = totalTicksForSegment; // Total ticks for entire segment
        fxManager.spawnOrbStep(dim, cur, next, job.level, curBlock, nextBlock, job.itemTypeId, segLen, logicalTicks, job.speedScale || 1.0);
      }
      
      job.stepIndex = nextIdx;
      job.ticksUntilStep = totalTicksForSegment;
      inflightStepDirty = true;
    }

    return { inflightDirty, inflightStepDirty };
  }

  /**
   * Process flux FX in-flight transfer jobs
   * @param {Array} fluxFxInflight - Array of flux FX in-flight jobs
   * @param {Object} debugState - Optional debug state object
   */
  function tickFluxFxInFlight(fluxFxInflight, debugState = null) {
    if (fluxFxInflight.length === 0) return;
    for (let i = fluxFxInflight.length - 1; i >= 0; i--) {
      const job = fluxFxInflight[i];
      job.ticksUntilStep--;
      if (job.ticksUntilStep > 0) continue;

      const nextIdx = job.stepIndex + 1;
      if (nextIdx >= job.path.length) {
        finalizeManager.finalizeFluxFxJob(job);
        fluxFxInflight.splice(i, 1);
        continue;
      }

      const dim = cacheManager.getDimensionCached(job.dimId);
      if (!dim) {
        fluxFxInflight.splice(i, 1);
        continue;
      }

      const cur = job.path[job.stepIndex];
      const next = job.path[nextIdx];
      const curBlock = cacheManager.getBlockCached(job.dimId, cur) || dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });
      const nextBlock = cacheManager.getBlockCached(job.dimId, next) || dim.getBlock({ x: next.x, y: next.y, z: next.z });
      if (isPrismBlock(curBlock)) {
        refinementManager.applyPrismSpeedBoost(job, curBlock);
        if (job.refineOnPrism && isFluxTypeId(job.itemTypeId)) {
          refinementManager.applyPrismRefineToFxJob(job, curBlock, debugState, debugEnabled);
        }
      }
      const segLen = job.segmentLengths?.[job.stepIndex] || 1;
      const baseTicks = job.stepTicks || cfg.orbStepTicks;
      const stepTicks = Math.max(1, Math.floor(baseTicks / Math.max(0.1, job.speedScale || 1)));
      const totalTicksForSegment = stepTicks * Math.max(1, segLen | 0);
      if (fxManager.spawnOrbStep(dim, cur, next, job.level, curBlock, nextBlock, job.itemTypeId, segLen, totalTicksForSegment, job.speedScale || 1.0) && debugEnabled && debugState) {
        debugState.fluxFxSpawns++;
      }
      job.stepIndex = nextIdx;
      job.ticksUntilStep = totalTicksForSegment;
    }
  }

  return {
    tickInFlight,
    tickFluxFxInFlight,
  };
}
