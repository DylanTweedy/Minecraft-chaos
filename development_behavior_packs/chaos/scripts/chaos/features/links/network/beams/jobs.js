// scripts/chaos/features/links/beam/jobs.js
import { BlockPermutation } from "@minecraft/server";
import { BEAM_ID } from "./config.js";
import { axisForDir, beamAxisMatchesDir } from "./axis.js";

const buildJobs = [];
const buildJobsSet = new Set();

const collapseJobs = [];
const collapseJobsSet = new Set();

let debugLog = null;

export function setBeamJobsDebugLog(fn) {
  debugLog = typeof fn === "function" ? fn : null;
}

function jobKey(fromKey, toKey) {
  return `${String(fromKey || "")}->${String(toKey || "")}`;
}

function getPrismTierFromId(typeId) {
  const m = /_(\d+)$/.exec(String(typeId || ""));
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, n | 0));
}

function getBeamTier(block) {
  try {
    const level = block?.permutation?.getState("chaos:level");
    if (Number.isFinite(level)) return Math.max(1, Math.min(5, level | 0));
  } catch (e) {
    // ignore
  }
  return 1;
}

function clampTier(tier) {
  const n = Number(tier) || 1;
  return Math.max(1, Math.min(5, n | 0));
}

export function enqueueBuildJob(job) {
  const key = jobKey(job?.fromKey, job?.toKey);
  if (!job?.fromKey || !job?.toKey) return false;
  if (buildJobsSet.has(key)) return false;
  buildJobsSet.add(key);
  buildJobs.push({
    ...job,
    step: Math.max(1, Number(job?.step) || 1),
    len: Math.max(0, Number(job?.len) || 0),
  });

  if (debugLog) {
    try {
      debugLog(`[Beam] Build job queued: ${key}`);
    } catch (e) {
      // ignore
    }
  }

  return true;
}

export function enqueueCollapseJob(job) {
  const key = jobKey(job?.fromKey, job?.toKey);
  if (!job?.fromKey || !job?.toKey) return false;
  if (collapseJobsSet.has(key)) return false;
  collapseJobsSet.add(key);
  const len = Math.max(0, Number(job?.len) || 0);
  collapseJobs.push({
    ...job,
    len,
    step: Math.max(0, Number(job?.step) || Math.max(0, len - 1)),
  });

  if (debugLog) {
    try {
      debugLog(`[Beam] Collapse job queued: ${key}`);
    } catch (e) {
      // ignore
    }
  }

  return true;
}

export function hasPendingBeamJobs() {
  return buildJobs.length > 0 || collapseJobs.length > 0;
}

export function getBeamJobCounts() {
  return { build: buildJobs.length, collapse: collapseJobs.length };
}

function placeBeamBlock(block, axis, tier) {
  const safeAxis = axis || "x";
  const safeTier = clampTier(tier);
  const perm = BlockPermutation.resolve(BEAM_ID, { "chaos:axis": safeAxis, "chaos:level": safeTier });
  block.setPermutation(perm);
}

function stepBuildJob(world, job) {
  if (!job || job.len <= 1) return true;
  if (job.step >= job.len) return true;

  const dim = world?.getDimension?.(job.dimId);
  if (!dim) return true;

  const x = job.from.x + job.dir.dx * job.step;
  const y = job.from.y + job.dir.dy * job.step;
  const z = job.from.z + job.dir.dz * job.step;
  const b = dim.getBlock({ x, y, z });
  if (!b) return true;

  const axis = axisForDir(job.dir.dx, job.dir.dy, job.dir.dz);
  const tier = clampTier(job.tier || 1);

  if (b.typeId === "minecraft:air") {
    try {
      placeBeamBlock(b, axis, tier);
    } catch (e) {
      return true;
    }
    job.step += 1;
    return job.step >= job.len;
  }

  if (b.typeId === BEAM_ID) {
    if (!beamAxisMatchesDir(b, job.dir.dx, job.dir.dy, job.dir.dz)) return true;
    const curTier = getBeamTier(b);
    const newTier = Math.max(curTier, tier);
    if (newTier !== curTier) {
      try {
        b.setPermutation(b.permutation.withState("chaos:level", newTier));
      } catch (e) {
        return true;
      }
    }
    job.step += 1;
    return job.step >= job.len;
  }

  return true;
}

function stepCollapseJob(world, job) {
  if (!job || job.len <= 1) return true;
  if (job.step <= 0) return true;

  const dim = world?.getDimension?.(job.dimId);
  if (!dim) return true;

  const x = job.from.x + job.dir.dx * job.step;
  const y = job.from.y + job.dir.dy * job.step;
  const z = job.from.z + job.dir.dz * job.step;
  const b = dim.getBlock({ x, y, z });

  if (b?.typeId === BEAM_ID) {
    if (beamAxisMatchesDir(b, job.dir.dx, job.dir.dy, job.dir.dz)) {
      try {
        b.setType("minecraft:air");
      } catch (e) {
        return true;
      }
    }
  }

  job.step -= 1;
  return job.step <= 0;
}

function finishBuildJob(job) {
  const key = jobKey(job?.fromKey, job?.toKey);
  buildJobsSet.delete(key);
}

function finishCollapseJob(job) {
  const key = jobKey(job?.fromKey, job?.toKey);
  collapseJobsSet.delete(key);
}

export function tickBeamJobs(world, { buildBudget = 0, collapseBudget = 0 } = {}) {
  let buildProcessed = 0;
  let collapseProcessed = 0;

  while (buildProcessed < buildBudget && buildJobs.length > 0) {
    const job = buildJobs[0];
    const done = stepBuildJob(world, job);
    buildProcessed++;
    if (done) {
      buildJobs.shift();
      finishBuildJob(job);
    }
  }

  while (collapseProcessed < collapseBudget && collapseJobs.length > 0) {
    const job = collapseJobs[0];
    const done = stepCollapseJob(world, job);
    collapseProcessed++;
    if (done) {
      collapseJobs.shift();
      finishCollapseJob(job);
    }
  }

  if ((buildProcessed > 0 || collapseProcessed > 0) && debugLog) {
    try {
      debugLog(`[Beam] Jobs ticked: build=${buildProcessed} collapse=${collapseProcessed}`);
    } catch (e) {
      // ignore
    }
  }

  return { buildProcessed, collapseProcessed };
}

export function getPrismTierForBlock(block) {
  if (!block) return 1;
  if (block.typeId === BEAM_ID) return getBeamTier(block);
  return getPrismTierFromId(block.typeId);
}
