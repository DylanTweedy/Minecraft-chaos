// scripts/chaos/features/links/transfer/core/inflightProcessor.js
import { isPrismId } from "../config.js";
import { isFluxTypeId } from "../../../../flux.js";
import { isPathBlock } from "../routing/path.js";
import { releaseContainerSlot } from "../inventory/reservations.js";
import { key } from "../keys.js";
import { buildHybridPath } from "../runtime/hybrid/jobFactory.js";

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
    linkGraph,
  } = deps;

  function isPrismBlockFast(block) {
    return !!block && isPrismId(block.typeId);
  }

  function isHybridJob(job) {
    return !!job && typeof job.mode === "string" && job.mode.startsWith("hybrid");
  }

  function ensureHybridPath(job) {
    if (!job) return false;
    if (Array.isArray(job.path) && job.path.length > 0) return true;
    if (!isHybridJob(job)) return false;
    const sourceKey = job.currentPrismKey || job.sourcePrismKey;
    const destKey = job.destPrismKey;
    if (!sourceKey || !destKey) return false;
    const path = buildHybridPath(sourceKey, destKey);
    if (!Array.isArray(path) || path.length === 0) return false;
    job.path = path;
    let stepIndex = job.stepIndex | 0;
    if (stepIndex < 0) stepIndex = 0;
    if (stepIndex >= path.length) stepIndex = path.length - 1;
    job.stepIndex = stepIndex;
    return true;
  }

  /**
   * Process regular in-flight transfer jobs
   */
  function tickInFlight(inflight, nowTick) {
    if (inflight.length === 0) return { inflightDirty: false, inflightStepDirty: false };

    let inflightDirty = false;
    let inflightStepDirty = false;

    for (let i = inflight.length - 1; i >= 0; i--) {
      const job = inflight[i];
      if (!ensureHybridPath(job)) {
        inflight.splice(i, 1);
        inflightDirty = true;
        continue;
      }
      job.ticksUntilStep--;
      if (job.ticksUntilStep > 0) continue;

      const nextIdx = job.stepIndex + 1;
      if (nextIdx >= job.path.length) {
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

      if (Array.isArray(job.edgeEpochs) && job.edgeEpochs.length > job.stepIndex && linkGraph && typeof linkGraph.getEdgeBetweenKeys === "function") {
        const curKey = key(job.dimId, cur.x, cur.y, cur.z);
        const nextKey = key(job.dimId, next.x, next.y, next.z);
        const edge = linkGraph.getEdgeBetweenKeys(curKey, nextKey);
        const expectedEpoch = job.edgeEpochs[job.stepIndex] | 0;
        if (!edge || (edge.epoch | 0) !== expectedEpoch) {
          dropItemAt(dim, cur, job.itemTypeId, job.amount);
          releaseContainerSlot(job.containerKey, job.itemTypeId, job.amount);
          inflight.splice(i, 1);
          inflightDirty = true;
          continue;
        }
      }

      const curBlock =
        cacheManager.getBlockCached(job.dimId, cur) ||
        dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });

      const nextBlock =
        cacheManager.getBlockCached(job.dimId, next) ||
        dim.getBlock({ x: next.x, y: next.y, z: next.z });

      if (isPrismBlockFast(curBlock) && job.refineOnPrism && isFluxTypeId(job.itemTypeId)) {
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
        if (isPrismBlockFast(curBlock)) {
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

      if (
        !job.suppressOrb &&
        isPathBlock(curBlock) &&
        (nextIdx >= job.path.length || isPathBlock(nextBlock))
      ) {
        const logicalTicks = totalTicksForSegment;
        fxManager.spawnOrbStep(
          dim,
          cur,
          next,
          job.level,
          curBlock,
          nextBlock,
          job.itemTypeId,
          segLen,
          logicalTicks,
          job.speedScale || 1.0
        );
      }

      job.stepIndex = nextIdx;
      job.ticksUntilStep = totalTicksForSegment;
      inflightStepDirty = true;
    }

    return { inflightDirty, inflightStepDirty };
  }

  /**
   * Process flux FX in-flight transfer jobs
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

      const curBlock =
        cacheManager.getBlockCached(job.dimId, cur) ||
        dim.getBlock({ x: cur.x, y: cur.y, z: cur.z });

      const nextBlock =
        cacheManager.getBlockCached(job.dimId, next) ||
        dim.getBlock({ x: next.x, y: next.y, z: next.z });

      if (Array.isArray(job.edgeEpochs) && job.edgeEpochs.length > job.stepIndex && linkGraph && typeof linkGraph.getEdgeBetweenKeys === "function") {
        const curKey = key(job.dimId, cur.x, cur.y, cur.z);
        const nextKey = key(job.dimId, next.x, next.y, next.z);
        const edge = linkGraph.getEdgeBetweenKeys(curKey, nextKey);
        const expectedEpoch = job.edgeEpochs[job.stepIndex] | 0;
        if (!edge || (edge.epoch | 0) !== expectedEpoch) {
          fluxFxInflight.splice(i, 1);
          continue;
        }
      }

      if (isPrismBlockFast(curBlock)) {
        refinementManager.applyPrismSpeedBoost(job, curBlock);
        if (job.refineOnPrism && isFluxTypeId(job.itemTypeId)) {
          refinementManager.applyPrismRefineToFxJob(job, curBlock, debugState, debugEnabled);
        }
      }

      const segLen = job.segmentLengths?.[job.stepIndex] || 1;
      const baseTicks = job.stepTicks || cfg.orbStepTicks;
      const stepTicks = Math.max(1, Math.floor(baseTicks / Math.max(0.1, job.speedScale || 1)));
      const totalTicksForSegment = stepTicks * Math.max(1, segLen | 0);

      if (
        fxManager.spawnOrbStep(
          dim,
          cur,
          next,
          job.level,
          curBlock,
          nextBlock,
          job.itemTypeId,
          segLen,
          totalTicksForSegment,
          job.speedScale || 1.0
        ) &&
        debugEnabled &&
        debugState
      ) {
        debugState.fluxFxSpawns++;
      }

      job.stepIndex = nextIdx;
      job.ticksUntilStep = totalTicksForSegment;
    }
  }

  return { tickInFlight, tickFluxFxInFlight };
}
