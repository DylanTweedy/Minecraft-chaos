// scripts/chaos/features/links/transfer/runtime/hybrid/jobFactory.js

import { parsePrismKey } from "../../keys.js";

let HYBRID_JOB_COUNTER = 0;

export function createHybridJobId() {
  HYBRID_JOB_COUNTER++;
  return `hybrid-${HYBRID_JOB_COUNTER}`;
}

function buildAxisStep(start, end) {
  if (start === end) return 0;
  return Math.sign(end - start) || 0;
}

export function buildHybridPath(sourceKey, destKey) {
  const source = parsePrismKey(sourceKey);
  const dest = parsePrismKey(destKey);
  if (!source || !dest) return null;

  const dx = buildAxisStep(source.x, dest.x);
  const dy = buildAxisStep(source.y, dest.y);
  const dz = buildAxisStep(source.z, dest.z);

  const totalSteps = Math.max(
    Math.abs(dest.x - source.x),
    Math.abs(dest.y - source.y),
    Math.abs(dest.z - source.z)
  );
  if (totalSteps <= 0) return [{ x: source.x, y: source.y, z: source.z }];

  const path = [];
  let cursor = { x: source.x, y: source.y, z: source.z };
  path.push({ ...cursor });

  for (let step = 0; step < totalSteps; step++) {
    cursor = { x: cursor.x + dx, y: cursor.y + dy, z: cursor.z + dz };
    path.push({ ...cursor });
  }

  return path;
}

export function createHybridJob(params = {}) {
  const {
    id,
    itemTypeId,
    amount,
    dimId,
    sourcePrismKey,
    destPrismKey,
    stepTicks = 16,
    startTick = 0,
    mode = "hybrid_drift",
    hops = 0,
    reroutes = 0,
  } = params;

  if (!id || !itemTypeId || !sourcePrismKey || !destPrismKey) return null;
  const path = buildHybridPath(sourcePrismKey, destPrismKey);
  if (!Array.isArray(path) || path.length === 0) return null;

  return {
    id,
    itemTypeId,
    amount: Math.max(1, amount || 1),
    mode,
    dimId,
    sourcePrismKey,
    currentPrismKey: sourcePrismKey,
    prevPrismKey: null,
    destPrismKey,
    path,
    stepIndex: 0,
    ticksUntilStep: 0,
    stepTicks,
    edgeEpochs: null,
    segmentLengths: null,
    hops: Math.max(0, hops | 0),
    reroutes: Math.max(0, reroutes | 0),
    cooldownTicks: 0,
    createdTick: startTick || 0,
  };
}

export function refreshHybridJobForNextHop(job, destPrismKey, stepTicks = 16) {
  if (!job || !destPrismKey) return false;
  const path = buildHybridPath(job.currentPrismKey, destPrismKey);
  if (!Array.isArray(path) || path.length === 0) return false;

  job.destPrismKey = destPrismKey;
  job.path = path;
  job.stepIndex = 0;
  job.ticksUntilStep = 0;
  job.stepTicks = stepTicks;
  job.cooldownTicks = 0;
  return true;
}
