// scripts/chaos/features/links/transfer/runtime/hybrid/jobFactory.js
// Option B: drift jobs are prism->prism hops with explicit segment length + edge epoch.

import { parsePrismKey } from "../../keys.js";

let HYBRID_JOB_COUNTER = 0;

export function createHybridJobId() {
  HYBRID_JOB_COUNTER++;
  return `hybrid-${HYBRID_JOB_COUNTER}`;
}

function hopPathFromKeys(fromKey, toKey) {
  const a = parsePrismKey(fromKey);
  const b = parsePrismKey(toKey);
  if (!a || !b) return null;
  return [
    { x: a.x, y: a.y, z: a.z },
    { x: b.x, y: b.y, z: b.z },
  ];
}

function normalizeHopMeta(meta) {
  const segLenRaw =
    meta && meta.segmentLength != null
      ? meta.segmentLength
      : Array.isArray(meta?.segmentLengths)
        ? meta.segmentLengths[0]
        : null;
  const epochRaw =
    meta && meta.edgeEpoch != null
      ? meta.edgeEpoch
      : Array.isArray(meta?.edgeEpochs)
        ? meta.edgeEpochs[0]
        : null;

  const segLen = Math.max(1, Number(segLenRaw) || 1) | 0;
  const epoch = (epochRaw | 0) || 0;

  return {
    segmentLengths: [segLen],
    edgeEpochs: [epoch],
  };
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

  if (!id || !itemTypeId || !dimId || !sourcePrismKey || !destPrismKey) return null;

  const path =
    Array.isArray(params.path) && params.path.length >= 2
      ? params.path
      : hopPathFromKeys(sourcePrismKey, destPrismKey);

  if (!Array.isArray(path) || path.length < 2) return null;

  const meta = normalizeHopMeta(params);

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
    stepTicks: Math.max(1, stepTicks | 0),
    edgeEpochs: meta.edgeEpochs,
    segmentLengths: meta.segmentLengths,
    hops: Math.max(0, hops | 0),
    reroutes: Math.max(0, reroutes | 0),
    cooldownTicks: 0,
    createdTick: startTick || 0,
    refineOnPrism: true,
  };
}

export function refreshHybridJobForNextHop(job, destPrismKey, stepTicks = 16, hopMeta = null) {
  if (!job || !destPrismKey) return false;

  const fromKey = job.currentPrismKey || job.sourcePrismKey;
  const path = hopPathFromKeys(fromKey, destPrismKey);
  if (!Array.isArray(path) || path.length < 2) return false;

  const meta = normalizeHopMeta(hopMeta || {});

  job.destPrismKey = destPrismKey;
  job.path = path;
  job.segmentLengths = meta.segmentLengths;
  job.edgeEpochs = meta.edgeEpochs;
  job.stepIndex = 0;
  job.ticksUntilStep = 0;
  job.stepTicks = Math.max(1, stepTicks | 0);
  job.cooldownTicks = 0;
  return true;
}
