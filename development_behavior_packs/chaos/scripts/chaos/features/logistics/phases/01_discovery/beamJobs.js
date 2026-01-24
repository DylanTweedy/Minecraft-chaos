// scripts/chaos/features/logistics/phases/01_discovery/beamJobs.js
import { tickBeamJobs } from "../../network/beams/jobs.js";

export function runBeamJobs(ctx) {
  const cfg = ctx.cfg || {};
  const world = ctx.world;
  const buildBudget = Math.max(0, Number(cfg.beamBuildBlocksPerTick || 8) | 0);
  const collapseBudget = Math.max(0, Number(cfg.beamCollapseBlocksPerTick || 8) | 0);
  return tickBeamJobs(world, { buildBudget, collapseBudget });
}

